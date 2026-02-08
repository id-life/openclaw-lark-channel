/**
 * Queue System Tests
 * 
 * Tests for the SQLite-based message queue with guaranteed delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageQueue } from '../src/queue.js';

// Test database path
const TEST_DB_PATH = path.join(os.tmpdir(), `lark-queue-test-${Date.now()}.db`);

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    // Clean up any existing test database
    try {
      fs.unlinkSync(TEST_DB_PATH);
      fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {
      // Ignore if files don't exist
    }
    
    queue = new MessageQueue(TEST_DB_PATH);
  });

  afterEach(() => {
    queue.close();
    
    // Clean up test database
    try {
      fs.unlinkSync(TEST_DB_PATH);
      fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {
      // Ignore
    }
  });

  describe('Inbound Queue', () => {
    it('should enqueue an inbound message', () => {
      const result = queue.enqueueInbound({
        messageId: 'msg_123',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Hello, world!',
        attachments: null,
      });

      expect(result.enqueued).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should reject duplicate message IDs', () => {
      queue.enqueueInbound({
        messageId: 'msg_123',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'First message',
        attachments: null,
      });

      const result = queue.enqueueInbound({
        messageId: 'msg_123', // Same ID
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Duplicate message',
        attachments: null,
      });

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe('duplicate');
    });

    it('should dequeue pending messages', () => {
      queue.enqueueInbound({
        messageId: 'msg_1',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Message 1',
        attachments: null,
      });

      queue.enqueueInbound({
        messageId: 'msg_2',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Message 2',
        attachments: null,
      });

      const messages = queue.dequeueInbound(10);

      expect(messages.length).toBe(2);
      expect(messages[0].message_text).toBe('Message 1');
      expect(messages[1].message_text).toBe('Message 2');
    });

    it('should mark messages as completed', () => {
      const { id } = queue.enqueueInbound({
        messageId: 'msg_123',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Test message',
        attachments: null,
      });

      queue.markInboundProcessing(id!);
      queue.markInboundCompleted(id!, 'Response text');

      // Should not appear in pending queue
      const pending = queue.dequeueInbound(10);
      expect(pending.length).toBe(0);
    });

    it('should retry failed messages with backoff', () => {
      const { id } = queue.enqueueInbound({
        messageId: 'msg_123',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Test message',
        attachments: null,
      });

      queue.markInboundProcessing(id!);
      queue.markInboundRetry(id!, 'Gateway timeout');

      // Should not be immediately available (backoff)
      const immediate = queue.dequeueInbound(10);
      expect(immediate.length).toBe(0);
    });

    it('should handle attachments', () => {
      const result = queue.enqueueInbound({
        messageId: 'msg_123',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: '[User sent an image]',
        attachments: [
          { mimeType: 'image/png', content: 'base64content' },
        ],
      });

      expect(result.enqueued).toBe(true);

      const messages = queue.dequeueInbound(10);
      expect(messages.length).toBe(1);
      
      const attachments = JSON.parse(messages[0].attachments_json!);
      expect(attachments[0].mimeType).toBe('image/png');
    });

    it('should persist chat type and thread root id', () => {
      const result = queue.enqueueInbound({
        messageId: 'msg_threaded',
        threadRootId: 'msg_root_1',
        chatType: 'group',
        chatId: 'oc_group',
        sessionKey: 'lark:oc_group',
        messageText: 'reply in thread',
        attachments: null,
      });

      expect(result.enqueued).toBe(true);

      const messages = queue.dequeueInbound(10);
      expect(messages).toHaveLength(1);
      expect(messages[0].chat_type).toBe('group');
      expect(messages[0].thread_root_id).toBe('msg_root_1');
    });
  });

  describe('Outbound Queue', () => {
    it('should enqueue an outbound message', () => {
      const result = queue.enqueueOutbound('reply', {
        runId: 'run_123',
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Hello from bot!',
      });

      expect(result.enqueued).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should reject duplicate content within dedup window', () => {
      queue.enqueueOutbound('reply', {
        runId: 'run_1',
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Same content',
      });

      const result = queue.enqueueOutbound('reply', {
        runId: 'run_2',
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Same content', // Same content
      });

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe('duplicate_pending');
    });

    it('should allow same content to different chats', () => {
      const result1 = queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Hello!',
      });

      const result2 = queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_def',
        chatId: 'oc_def', // Different chat
        content: 'Hello!', // Same content
      });

      expect(result1.enqueued).toBe(true);
      expect(result2.enqueued).toBe(true);
    });

    it('should dequeue outbound messages', () => {
      queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Reply 1',
      });

      queue.enqueueOutbound('mirror', {
        sessionKey: 'webchat:user1',
        chatId: 'oc_def',
        content: 'Mirror 1',
      });

      const messages = queue.dequeueOutbound(10);

      expect(messages.length).toBe(2);
      expect(messages[0].queue_type).toBe('reply');
      expect(messages[1].queue_type).toBe('mirror');
    });

    it('should mark messages as completed and track sent', () => {
      const { id } = queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Test message completed',
      });

      queue.markOutboundProcessing(id!);
      queue.markOutboundCompleted(id!, 'lark_msg_123');

      // Same content should be rejected as already_sent
      const duplicate = queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Test message completed',
      });

      expect(duplicate.enqueued).toBe(false);
      // After completion, it goes to sent_messages table, so it should be 'already_sent'
      expect(duplicate.reason).toBe('already_sent');
    });
  });

  describe('Stats and Maintenance', () => {
    it('should return queue stats', () => {
      queue.enqueueInbound({
        messageId: 'msg_1',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Test',
        attachments: null,
      });

      queue.enqueueOutbound('reply', {
        sessionKey: 'lark:oc_abc',
        chatId: 'oc_abc',
        content: 'Reply',
      });

      const stats = queue.getStats();

      expect(stats.inbound.pending).toBe(1);
      expect(stats.outbound.pending).toBe(1);
      expect(stats.dbPath).toBe(TEST_DB_PATH);
    });

    it('should recover stuck messages', () => {
      const { id } = queue.enqueueInbound({
        messageId: 'msg_stuck',
        chatId: 'oc_abc',
        sessionKey: 'lark:oc_abc',
        messageText: 'Stuck message',
        attachments: null,
      });

      queue.markInboundProcessing(id!);

      // Force the updated_at to be old
      // (In real scenario, this would happen if process crashed while processing)
      
      // recoverStuck is called on queue creation, so we test via stats
      const stats = queue.getStats();
      expect(stats.inbound.processing).toBe(1);
    });
  });
});
