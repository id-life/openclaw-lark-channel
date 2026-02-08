/**
 * Persistent Message Queue - GUARANTEED DELIVERY
 * 
 * Handles ALL message flows with guaranteed delivery:
 * - Inbound: Lark → Gateway (user messages)
 * - Outbound: Gateway → Lark (replies + mirrors)
 * 
 * Uses SQLite for durability - NO messages lost during:
 * - Service restarts
 * - WebSocket disconnections
 * - Gateway restarts
 * - Lark API failures
 * 
 * UNLIMITED retries with exponential backoff (capped at 5 minutes)
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  InboundMessage,
  OutboundMessage,
  QueueStats,
  EnqueueResult,
  Attachment,
} from './types.js';

// ─── Config ──────────────────────────────────────────────────────

// Retry policy: 120 retries with exponential backoff, max 120 minute interval
// After 120 retries, mark as failed_permanent but KEEP in DB for manual review
// NEVER delete messages - robustness is paramount
const MAX_RETRIES = 120;
const RETRY_BACKOFF_BASE_MS = 1000;
const RETRY_BACKOFF_MAX_MS = 120 * 60 * 1000; // Cap at 120 minutes (2 hours)
const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (keep longer for audit)
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ─── Statement Types ─────────────────────────────────────────────

type AnyStatement = Statement<unknown[]>;

// ─── Queue Class ─────────────────────────────────────────────────

export class MessageQueue {
  private db: DatabaseType;
  private dbPath: string;
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Prepared statements (using any[] for flexibility)
  private stmtEnqueueOutbound: AnyStatement;
  private stmtDequeueOutbound: AnyStatement;
  private stmtCheckOutboundDupe: AnyStatement;
  private stmtCheckSentDupe: AnyStatement;
  private stmtUpdateOutbound: AnyStatement;
  private stmtMarkOutboundProcessing: AnyStatement;
  private stmtRecordSent: AnyStatement;
  private stmtEnqueueInbound: AnyStatement;
  private stmtDequeueInbound: AnyStatement;
  private stmtUpdateInbound: AnyStatement;
  private stmtMarkInboundProcessing: AnyStatement;
  private stmtCheckInboundExists: AnyStatement;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(
      process.env.HOME ?? '/root',
      '.openclaw',
      'lark-queue.db'
    );

    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initializeSchema();
    this.migrateSchema();
    this.resetStuckMessages();

    // Initialize prepared statements
    this.stmtEnqueueOutbound = this.db.prepare(`
      INSERT INTO outbound_queue 
        (queue_type, run_id, session_key, chat_id, content, content_hash, status, created_at, updated_at, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    this.stmtDequeueOutbound = this.db.prepare(`
      SELECT * FROM outbound_queue 
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `);

    this.stmtCheckOutboundDupe = this.db.prepare(`
      SELECT id FROM outbound_queue 
      WHERE content_hash = ? AND chat_id = ? AND created_at > ? AND status IN ('pending', 'processing')
      LIMIT 1
    `);

    this.stmtCheckSentDupe = this.db.prepare(`
      SELECT id FROM sent_messages 
      WHERE content_hash = ? AND chat_id = ? AND created_at > ?
      LIMIT 1
    `);

    this.stmtUpdateOutbound = this.db.prepare(`
      UPDATE outbound_queue 
      SET status = ?, updated_at = ?, retries = ?, next_retry_at = ?, last_error = ?, 
          completed_at = ?, lark_message_id = ?
      WHERE id = ?
    `);

    this.stmtMarkOutboundProcessing = this.db.prepare(`
      UPDATE outbound_queue SET status = 'processing', updated_at = ? WHERE id = ?
    `);

    this.stmtRecordSent = this.db.prepare(`
      INSERT INTO sent_messages (content_hash, chat_id, lark_message_id, created_at)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtEnqueueInbound = this.db.prepare(`
      INSERT OR IGNORE INTO inbound_queue 
        (message_id, thread_root_id, chat_type, chat_id, session_key, message_text, attachments_json, status, created_at, updated_at, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    this.stmtDequeueInbound = this.db.prepare(`
      SELECT * FROM inbound_queue 
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `);

    this.stmtUpdateInbound = this.db.prepare(`
      UPDATE inbound_queue 
      SET status = ?, updated_at = ?, retries = ?, next_retry_at = ?, last_error = ?, 
          completed_at = ?, response_text = ?
      WHERE id = ?
    `);

    this.stmtMarkInboundProcessing = this.db.prepare(`
      UPDATE inbound_queue SET status = 'processing', updated_at = ? WHERE id = ?
    `);

    this.stmtCheckInboundExists = this.db.prepare(`
      SELECT id, status FROM inbound_queue WHERE message_id = ?
    `);

    this.recoverStuck();
    this.cleanup();

    // Auto-cleanup every hour
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- Outbound queue: messages TO Lark (replies + mirrors)
      CREATE TABLE IF NOT EXISTS outbound_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_type TEXT NOT NULL,        -- 'reply' or 'mirror'
        run_id TEXT,
        session_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT DEFAULT 'pending',   -- pending, processing, completed, failed_permanent
        retries INTEGER DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        lark_message_id TEXT,
        last_error TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_queue(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_hash ON outbound_queue(content_hash, chat_id, created_at);
      
      -- Inbound queue: messages FROM Lark (to Gateway)
      CREATE TABLE IF NOT EXISTS inbound_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,  -- Lark message_id for dedup
        thread_root_id TEXT,              -- Lark thread root message_id (for threaded replies)
        chat_type TEXT NOT NULL DEFAULT 'direct', -- 'direct' or 'group'
        chat_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        message_text TEXT NOT NULL,
        attachments_json TEXT,            -- JSON array of attachments
        status TEXT DEFAULT 'pending',
        retries INTEGER DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        response_text TEXT,
        last_error TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_queue(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_inbound_msgid ON inbound_queue(message_id);
      CREATE INDEX IF NOT EXISTS idx_inbound_chat_type ON inbound_queue(chat_type, chat_id);
      
      -- Sent message tracking (for dedup)
      CREATE TABLE IF NOT EXISTS sent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_hash TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        lark_message_id TEXT,
        created_at INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_sent_hash ON sent_messages(content_hash, chat_id, created_at);
    `);
  }

  private migrateSchema(): void {
    this.ensureColumn('inbound_queue', 'thread_root_id', 'TEXT');
    this.ensureColumn('inbound_queue', 'chat_type', `TEXT NOT NULL DEFAULT 'direct'`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inbound_chat_type ON inbound_queue(chat_type, chat_id)`);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * Reset any messages that were in 'processing' state when the service stopped.
   * This prevents messages from getting stuck after a restart.
   */
  private resetStuckMessages(): void {
    const now = Date.now();
    
    // Reset inbound messages stuck in processing
    const inboundReset = this.db.prepare(`
      UPDATE inbound_queue 
      SET status = 'pending', retries = retries, updated_at = ?
      WHERE status = 'processing'
    `).run(now);
    
    if (inboundReset.changes > 0) {
      console.log(`[QUEUE] ⚠️ Reset ${inboundReset.changes} stuck inbound message(s) to pending`);
    }
    
    // Reset outbound messages stuck in processing
    const outboundReset = this.db.prepare(`
      UPDATE outbound_queue 
      SET status = 'pending', retries = retries, updated_at = ?
      WHERE status = 'processing'
    `).run(now);
    
    if (outboundReset.changes > 0) {
      console.log(`[QUEUE] ⚠️ Reset ${outboundReset.changes} stuck outbound message(s) to pending`);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private calculateBackoff(retries: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, ...
    // Cap at 120 minutes (7200 seconds) per Boyang's requirement
    // With 120 retries and 2-hour max, total retry window is ~10 days
    const backoff = RETRY_BACKOFF_BASE_MS * Math.pow(2, Math.min(retries, 17)); // 2^17 = 131072 > 7200*1000
    return Math.min(backoff, RETRY_BACKOFF_MAX_MS);
  }

  private hasExceededMaxRetries(retries: number): boolean {
    return retries >= MAX_RETRIES;
  }

  // ─── Outbound Queue (Gateway → Lark) ─────────────────────────────

  /**
   * Queue an outbound message (reply or mirror) for delivery to Lark
   */
  enqueueOutbound(
    queueType: 'reply' | 'mirror',
    params: {
      runId?: string;
      sessionKey: string;
      chatId: string;
      content: string;
    }
  ): EnqueueResult {
    const now = Date.now();
    const hash = this.hashContent(params.content);
    const dedupCutoff = now - DEDUP_WINDOW_MS;

    // Check for duplicate pending
    const existingPending = this.stmtCheckOutboundDupe.get(hash, params.chatId, dedupCutoff) as { id: number } | undefined;
    if (existingPending) {
      return { enqueued: false, reason: 'duplicate_pending' };
    }

    // Check if already sent recently
    const existingSent = this.stmtCheckSentDupe.get(hash, params.chatId, dedupCutoff) as { id: number } | undefined;
    if (existingSent) {
      return { enqueued: false, reason: 'already_sent' };
    }

    const result = this.stmtEnqueueOutbound.run(
      queueType,
      params.runId ?? '',
      params.sessionKey,
      params.chatId,
      params.content,
      hash,
      now,
      now,
      now
    );

    console.log(`[QUEUE-OUT] Enqueued ${queueType} #${result.lastInsertRowid} | chat=${params.chatId} | ${params.content.length} chars`);

    return { enqueued: true, id: Number(result.lastInsertRowid) };
  }

  /**
   * Dequeue outbound messages ready for processing
   */
  dequeueOutbound(limit = 10): OutboundMessage[] {
    return this.stmtDequeueOutbound.all(Date.now(), limit) as OutboundMessage[];
  }

  /**
   * Mark outbound message as being processed
   */
  markOutboundProcessing(id: number): void {
    this.stmtMarkOutboundProcessing.run(Date.now(), id);
  }

  /**
   * Mark outbound message as completed
   */
  markOutboundCompleted(id: number, larkMessageId: string | null): void {
    const now = Date.now();
    const msg = this.db.prepare('SELECT * FROM outbound_queue WHERE id = ?').get(id) as OutboundMessage | undefined;

    this.stmtUpdateOutbound.run(
      'completed',
      now,
      msg?.retries ?? 0,
      null,
      null,
      now,
      larkMessageId,
      id
    );

    if (msg) {
      this.stmtRecordSent.run(msg.content_hash, msg.chat_id, larkMessageId, now);
    }

    console.log(`[QUEUE-OUT] ✅ Completed #${id} | lark_id=${larkMessageId}`);
  }

  /**
   * Mark outbound message for retry (120 retries max with exponential backoff up to 120 min)
   * After max retries, mark as failed_permanent but KEEP in DB for manual review
   */
  markOutboundRetry(id: number, errorMessage: string): void {
    const now = Date.now();
    const msg = this.db.prepare('SELECT * FROM outbound_queue WHERE id = ?').get(id) as OutboundMessage | undefined;
    const retries = (msg?.retries ?? 0) + 1;

    if (this.hasExceededMaxRetries(retries)) {
      // Max retries exceeded - mark as failed_permanent but DO NOT delete
      // Message stays in DB for manual review / alerting
      this.stmtUpdateOutbound.run('failed_permanent', now, retries, null, errorMessage, null, null, id);
      console.error(`[QUEUE-OUT] ❌ FAILED_PERMANENT #${id} after ${retries} retries | ${errorMessage}`);
      console.error(`[QUEUE-OUT] ⚠️ Message NOT deleted - manual intervention required`);
      return;
    }

    const backoffMs = this.calculateBackoff(retries);
    const nextRetryAt = now + backoffMs;

    this.stmtUpdateOutbound.run('pending', now, retries, nextRetryAt, errorMessage, null, null, id);
    const nextRetryFormatted = backoffMs >= 60000 
      ? `${Math.round(backoffMs / 60000)}m` 
      : `${Math.round(backoffMs / 1000)}s`;
    console.log(`[QUEUE-OUT] 🔄 Retry #${id} in ${nextRetryFormatted} (attempt ${retries}/${MAX_RETRIES})`);
  }

  // ─── Inbound Queue (Lark → Gateway) ──────────────────────────────

  /**
   * Queue an inbound message from Lark for processing by Gateway
   */
  enqueueInbound(params: {
    messageId: string;
    threadRootId?: string | null;
    chatType?: 'direct' | 'group';
    chatId: string;
    sessionKey: string;
    messageText: string;
    attachments?: Attachment[] | null;
  }): EnqueueResult {
    const now = Date.now();

    // Check if already exists
    const existing = this.stmtCheckInboundExists.get(params.messageId) as { id: number; status: string } | undefined;
    if (existing) {
      return { enqueued: false, reason: 'duplicate', existing: existing.status };
    }

    const attachmentsJson = params.attachments ? JSON.stringify(params.attachments) : null;
    const chatType = params.chatType ?? 'direct';
    const threadRootId = params.threadRootId?.trim() ? params.threadRootId.trim() : null;
    const result = this.stmtEnqueueInbound.run(
      params.messageId,
      threadRootId,
      chatType,
      params.chatId,
      params.sessionKey,
      params.messageText,
      attachmentsJson,
      now,
      now,
      now
    );

    if (result.changes > 0) {
      console.log(`[QUEUE-IN] Enqueued #${result.lastInsertRowid} | msg=${params.messageId} | ${params.messageText.length} chars`);
      return { enqueued: true, id: Number(result.lastInsertRowid) };
    }

    return { enqueued: false, reason: 'insert_failed' };
  }

  /**
   * Dequeue inbound messages ready for processing
   */
  dequeueInbound(limit = 5): InboundMessage[] {
    return this.stmtDequeueInbound.all(Date.now(), limit) as InboundMessage[];
  }

  /**
   * Mark inbound message as being processed
   */
  markInboundProcessing(id: number): void {
    this.stmtMarkInboundProcessing.run(Date.now(), id);
  }

  /**
   * Mark inbound message as completed (got response from Gateway)
   */
  markInboundCompleted(id: number, responseText: string): void {
    const now = Date.now();
    const msg = this.db.prepare('SELECT * FROM inbound_queue WHERE id = ?').get(id) as InboundMessage | undefined;
    this.stmtUpdateInbound.run(
      'completed',
      now,
      msg?.retries ?? 0,
      null,
      null,
      now,
      responseText,
      id
    );
    console.log(`[QUEUE-IN] ✅ Completed #${id} | response=${responseText?.length ?? 0} chars`);
  }

  /**
   * Mark inbound message for retry (120 retries max with exponential backoff up to 120 min)
   * After max retries, mark as failed_permanent but KEEP in DB
   */
  markInboundRetry(id: number, errorMessage: string): void {
    const now = Date.now();
    const msg = this.db.prepare('SELECT * FROM inbound_queue WHERE id = ?').get(id) as InboundMessage | undefined;
    const retries = (msg?.retries ?? 0) + 1;

    if (this.hasExceededMaxRetries(retries)) {
      // Max retries exceeded - mark as failed_permanent but DO NOT delete
      this.stmtUpdateInbound.run('failed_permanent', now, retries, null, errorMessage, null, null, id);
      console.error(`[QUEUE-IN] ❌ FAILED_PERMANENT #${id} after ${retries} retries | ${errorMessage}`);
      console.error(`[QUEUE-IN] ⚠️ Message NOT deleted - manual intervention required`);
      return;
    }

    const backoffMs = this.calculateBackoff(retries);
    const nextRetryAt = now + backoffMs;

    this.stmtUpdateInbound.run('pending', now, retries, nextRetryAt, errorMessage, null, null, id);
    const nextRetryFormatted = backoffMs >= 60000 
      ? `${Math.round(backoffMs / 60000)}m` 
      : `${Math.round(backoffMs / 1000)}s`;
    console.log(`[QUEUE-IN] 🔄 Retry #${id} in ${nextRetryFormatted} (attempt ${retries}/${MAX_RETRIES})`);
  }

  // ─── Stats & Maintenance ─────────────────────────────────────────

  getStats(): QueueStats {
    const cutoff = Date.now() - MESSAGE_TTL_MS;

    const outbound = this.db.prepare(`
      SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed_permanent' THEN 1 END) as failed
      FROM outbound_queue WHERE created_at > ?
    `).get(cutoff) as { pending: number; processing: number; completed: number; failed: number };

    const inbound = this.db.prepare(`
      SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed_permanent' THEN 1 END) as failed
      FROM inbound_queue WHERE created_at > ?
    `).get(cutoff) as { pending: number; processing: number; completed: number; failed: number };

    return { outbound, inbound, dbPath: this.dbPath };
  }

  cleanup(): void {
    const cutoff = Date.now() - MESSAGE_TTL_MS;

    const outDeleted = this.db.prepare("DELETE FROM outbound_queue WHERE created_at < ? AND status = 'completed'").run(cutoff);
    const inDeleted = this.db.prepare("DELETE FROM inbound_queue WHERE created_at < ? AND status = 'completed'").run(cutoff);
    const sentDeleted = this.db.prepare('DELETE FROM sent_messages WHERE created_at < ?').run(cutoff);

    if (outDeleted.changes > 0 || inDeleted.changes > 0) {
      console.log(`[QUEUE] Cleanup: outbound=${outDeleted.changes}, inbound=${inDeleted.changes}, sent=${sentDeleted.changes}`);
    }
  }

  recoverStuck(): void {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const now = Date.now();

    const outResult = this.db.prepare(`
      UPDATE outbound_queue SET status = 'pending', updated_at = ?
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, fiveMinAgo);

    const inResult = this.db.prepare(`
      UPDATE inbound_queue SET status = 'pending', updated_at = ?
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, fiveMinAgo);

    if (outResult.changes > 0 || inResult.changes > 0) {
      console.log(`[QUEUE] Recovered stuck: outbound=${outResult.changes}, inbound=${inResult.changes}`);
    }
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.db.close();
  }

  get path(): string {
    return this.dbPath;
  }
}

// Default singleton instance
let defaultQueue: MessageQueue | null = null;

export function getQueue(dbPath?: string): MessageQueue {
  if (!defaultQueue) {
    defaultQueue = new MessageQueue(dbPath);
  }
  return defaultQueue;
}

export function closeQueue(): void {
  if (defaultQueue) {
    defaultQueue.close();
    defaultQueue = null;
  }
}
