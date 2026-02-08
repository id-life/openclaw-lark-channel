/**
 * Lark Webhook Handler
 * 
 * HTTP server for receiving Lark events:
 * - URL verification
 * - Message events (text, post, image)
 * - Encryption/decryption support
 * - Immediate persistence (no message loss)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type {
  LarkWebhookEvent,
  LarkMessageEvent,
  Attachment,
} from './types.js';
import type { MessageQueue } from './queue.js';
import type { LarkClient } from './client.js';

// ─── Encryption ──────────────────────────────────────────────────

/**
 * Decrypt an encrypted Lark event payload
 */
export function decryptPayload(encrypt: string, encryptKey: string): unknown {
  if (!encryptKey || !encrypt) {
    return null;
  }

  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const buf = Buffer.from(encrypt, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, buf.slice(0, 16));

  return JSON.parse(
    decipher.update(buf.slice(16), undefined, 'utf8') + decipher.final('utf8')
  );
}

// ─── Group Chat Filtering ────────────────────────────────────────

/**
 * Check if bot should respond to this group message
 */
export function shouldRespondInGroup(
  text: string,
  mentions: Array<{ key?: string }>,
  requireMention: boolean
): boolean {
  // If mentions exist, always respond
  if (mentions.length > 0) {
    return true;
  }

  // If require mention, don't respond to unmention messages
  if (requireMention) {
    return false;
  }

  // Heuristics for question detection
  const t = text.toLowerCase();

  // Question mark at end
  if (/[？?]$/.test(text)) return true;

  // Question keywords (English)
  if (/\b(why|how|what|help|please|can you|could you)\b/.test(t)) return true;

  // Question keywords (Chinese)
  if (/帮|请|能否|可以|解释|分析|总结|什么|怎么|为什么/.test(text)) return true;

  return false;
}

// ─── Webhook Handler ─────────────────────────────────────────────

export type LarkDmPolicy = 'open' | 'pairing' | 'allowlist';

/**
 * Evaluate whether an inbound DM is allowed.
 * - open: always allow
 * - allowlist: require chat ID in dmAllowlist
 * - pairing: if dmAllowlist exists, enforce it; otherwise allow and defer to gateway pairing flow
 */
export function shouldAllowDmByPolicy(params: {
  policy?: LarkDmPolicy;
  chatId: string;
  dmAllowlist?: Set<string>;
}): boolean {
  const policy = params.policy ?? 'pairing';
  const allowlist = params.dmAllowlist;

  if (policy === 'open') {
    return true;
  }

  if (allowlist && allowlist.size > 0) {
    return allowlist.has(params.chatId);
  }

  return policy === 'pairing';
}

export interface WebhookConfig {
  port: number;
  bind?: string;
  encryptKey?: string;
  queue: MessageQueue;
  client: LarkClient;
  onMessage?: (event: LarkMessageEvent) => void;
  sessionKeyPrefix?: string;
  groupRequireMention?: boolean;
  groupAllowlist?: Set<string>;
  dmPolicy?: LarkDmPolicy;
  dmAllowlist?: Set<string>;
}

export class WebhookHandler {
  private config: WebhookConfig;
  private server: Server | null = null;

  // Directory to save file attachments
  private readonly mediaDir: string;

  constructor(config: WebhookConfig) {
    this.config = config;
    this.mediaDir = path.join(os.homedir(), '.openclaw', 'media', 'lark-inbound');
    
    // Ensure directory exists
    try {
      if (!fs.existsSync(this.mediaDir)) {
        fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Save a file attachment to disk and return the path.
   * This allows the agent to access files via the read tool.
   */
  private saveFileAttachment(base64: string, mimeType: string, fileName?: string): string {
    // Ensure directory exists
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    }

    // Determine extension from mime type or filename
    const mimeExtensions: Record<string, string> = {
      'application/zip': '.zip',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/plain': '.txt',
      'text/csv': '.csv',
      'application/json': '.json',
      'audio/ogg': '.ogg',
      'audio/opus': '.opus',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
    };

    let ext = mimeExtensions[mimeType] ?? '';
    if (!ext && fileName) {
      const match = fileName.match(/\.[^.]+$/);
      if (match) ext = match[0];
    }
    if (!ext) ext = '.bin';

    // Create filename with original name if available
    const timestamp = Date.now();
    let finalName: string;
    if (fileName) {
      const baseName = path.parse(fileName).name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
      finalName = `${baseName}_${timestamp}${ext}`;
    } else {
      finalName = `file_${timestamp}${ext}`;
    }

    const filePath = path.join(this.mediaDir, finalName);
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });

    console.log(`[WEBHOOK] Saved file: ${filePath} (${Math.round(buffer.byteLength / 1024)}KB)`);
    return filePath;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * Start the HTTP server (idempotent - won't fail if already running)
   */
  start(): Promise<void> {
    // Already running - skip
    if (this.server !== null) {
      if (this.server.listening) {
        console.log(`[WEBHOOK] Already running on port ${this.config.port}`);
        return Promise.resolve();
      }
      // Server exists but not listening - close it first
      this.server.close();
      this.server = null;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        // If EADDRINUSE, check if it's our own server from a previous instance
        if (err.code === 'EADDRINUSE') {
          // Try to connect to health endpoint - if it responds with our signature, we're already running
          const http = require('http');
          const req = http.get(`http://127.0.0.1:${this.config.port}/health`, (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
              try {
                const health = JSON.parse(data);
                if (health.guaranteedDelivery === true && health.unlimitedRetries === true) {
                  console.log(`[WEBHOOK] Port ${this.config.port} already has our webhook running (reusing)`);
                  // Don't reject - the webhook is already running from previous instance
                  resolve();
                  return;
                }
              } catch {
                // Not our server
              }
              reject(err);
            });
          });
          req.on('error', () => reject(err));
          req.setTimeout(1000, () => {
            req.destroy();
            reject(err);
          });
          return;
        }
        reject(err);
      });

      const bindAddr = this.config.bind ?? '127.0.0.1';
      this.server.listen(this.config.port, bindAddr, () => {
        console.log(`[WEBHOOK] 🚀 Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      const stats = this.config.queue.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        guaranteedDelivery: true,
        unlimitedRetries: true,
        queue: stats,
      }));
      return;
    }

    // Card callback endpoint - support both old and new URLs (transition period)
    if (req.method === 'POST' && (req.url === '/lark/cards' || req.url === '/webhook/card')) {
      console.log(`[WEBHOOK] Card callback received at ${req.url}`);
      await this.handleCardRequest(req, res);
      return;
    }

    // Message events endpoint - support both old and new URLs (transition period)
    const isMessageEndpoint = req.url === '/lark/events' || req.url === '/webhook';
    if (req.method !== 'POST' || !isMessageEndpoint) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    console.log(`[WEBHOOK] Message event received at ${req.url}`);

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let data: LarkWebhookEvent;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as LarkWebhookEvent;
    } catch {
      res.writeHead(400);
      res.end('Bad JSON');
      return;
    }

    // Handle encryption
    if (data.encrypt && this.config.encryptKey) {
      try {
        data = decryptPayload(data.encrypt, this.config.encryptKey) as LarkWebhookEvent;
      } catch {
        res.writeHead(400);
        res.end('Decrypt fail');
        return;
      }
    }

    // URL verification challenge
    if (data.type === 'url_verification' && data.challenge) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: data.challenge }));
      return;
    }

    // Respond immediately (async processing) for message events
    res.writeHead(200);
    res.end('ok');

    // Handle message events
    if (
      data.schema === '2.0' &&
      data.header?.event_type === 'im.message.receive_v1' &&
      data.event
    ) {
      await this.handleMessageEvent(data.event);
    }
  }

  /**
   * Handle card callback HTTP request (separate endpoint: /webhook/card)
   * This is configured as "Message Card Request URL" in Lark Open Platform
   */
  private async handleCardRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let data: any;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad JSON' }));
      return;
    }

    // Handle encryption if needed
    if (data.encrypt && this.config.encryptKey) {
      try {
        data = decryptPayload(data.encrypt, this.config.encryptKey);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Decrypt fail' }));
        return;
      }
    }

    // URL verification challenge (cards also need this)
    if (data.type === 'url_verification' && data.challenge) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: data.challenge }));
      return;
    }

    // Process card callback and return response
    const cardResponse = await this.handleCardCallback(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cardResponse));
  }

  /**
   * Handle card action callback (button clicks, form submissions)
   * Returns card update or toast to Lark
   */
  private async handleCardCallback(data: any): Promise<any> {
    try {
      // DEBUG: Log full payload first
      console.log(`[WEBHOOK-CARD] Full payload:`, JSON.stringify(data, null, 2));

      // Handle both direct event format and wrapped format
      const event = data.event || data;
      const operator = event.operator || (data.open_id ? { open_id: data.open_id } : {});
      const action = event.action || data.action || {};
      const context = event.context || {};

      const userId = operator?.open_id || data.open_id || data.user_id;
      const chatId = context?.open_chat_id || data.open_chat_id;
      const messageId = context?.open_message_id || data.open_message_id;

      console.log(`[WEBHOOK-CARD] Callback: user=${userId}, chat=${chatId}`);
      console.log(`[WEBHOOK-CARD] Action:`, JSON.stringify(action, null, 2));

      // Extract action info
      const actionValue = action?.value || {};
      const formValue = action?.form_value || {};
      const actionName = actionValue.action || action?.tag || 'unknown';
      
      console.log(`[WEBHOOK-CARD] Extracted actionName=${actionName}, formValue=`, JSON.stringify(formValue));

      // ID Note skill handling
      if (actionName === 'add_entry' || actionName === 'finish' || actionName === 'cancel' || actionName === 'new_session') {
        // Call idnote skill handler
        try {
          const homeDir = process.env.HOME || '/root';
          const idnotePath = `${homeDir}/.openclaw/workspace/skills/idnote/src/index.js`;
          const idnote = await import(idnotePath);
          
          const result = await idnote.handleCardCallback(
            actionName,
            formValue,
            userId,
            chatId,
            messageId
          );

          // Return card update or toast
          if (result.card) {
            return { card: result.card };
          }
          if (result.toast) {
            return { toast: result.toast };
          }
          return {};
        } catch (e) {
          console.error('[WEBHOOK] ID Note handler error:', e);
          return {
            toast: {
              type: 'error',
              content: `处理失败: ${(e as Error).message}`,
            },
          };
        }
      }

      // Unknown action - just acknowledge
      console.log('[WEBHOOK] Unknown card action:', actionName);
      return {};
    } catch (e) {
      console.error('[WEBHOOK] Card callback error:', e);
      return {
        toast: {
          type: 'error',
          content: '处理失败',
        },
      };
    }
  }

  /**
   * Handle a message event
   */
  private async handleMessageEvent(event: LarkMessageEvent): Promise<void> {
    try {
      const message = event.message;
      const chatId = message?.chat_id;
      const messageId = message?.message_id;
      const messageType = message?.message_type;

      if (!chatId || !messageId) {
        return;
      }

      let text = '';
      const attachments: Attachment[] = [];

      // Parse based on message type
      switch (messageType) {
        case 'text': {
          try {
            const content = JSON.parse(message.content ?? '{}') as { text?: string };
            text = (content.text ?? '').trim();
          } catch {
            return;
          }
          break;
        }

        case 'post': {
          const { texts, imageKeys } = this.config.client.parsePostContent(message.content ?? '');
          text = texts.join(' ').trim();

          // Download images and save to disk
          for (const key of imageKeys) {
            const img = await this.config.client.downloadImage(key, messageId);
            if (img && img.content) {
              // Save image to disk AND keep content for gateway compatibility
              const ext = img.mimeType?.includes('png') ? '.png' : '.jpg';
              const imagePath = this.saveFileAttachment(img.content, img.mimeType, `image_${messageId}_${Date.now()}${ext}`);
              attachments.push({
                type: 'image',
                content: img.content,  // REQUIRED: gateway needs base64 content
                path: imagePath,       // Optional: disk path for read tool
                mimeType: img.mimeType,
              });
            }
          }
          break;
        }

        case 'image': {
          try {
            const content = JSON.parse(message.content ?? '{}') as { image_key?: string };
            if (content.image_key) {
              const img = await this.config.client.downloadImage(content.image_key, messageId);
              if (img && img.content) {
                // Save image to disk AND keep content for gateway compatibility
                const ext = img.mimeType?.includes('png') ? '.png' : '.jpg';
                const imagePath = this.saveFileAttachment(img.content, img.mimeType, `image_${messageId}_${Date.now()}${ext}`);
                attachments.push({
                  type: 'image',
                  content: img.content,  // REQUIRED: gateway needs base64 content
                  path: imagePath,       // Optional: disk path for read tool
                  mimeType: img.mimeType,
                });
              }
            }
          } catch {
            // Ignore
          }
          text = '[User sent an image]';
          break;
        }

        case 'file': {
          // File message: { "file_key": "...", "file_name": "example.zip" }
          try {
            const content = JSON.parse(message.content ?? '{}') as { 
              file_key?: string; 
              file_name?: string;
            };
            if (content.file_key) {
              const file = await this.config.client.downloadFile(
                content.file_key, 
                messageId, 
                content.file_name
              );
              if (file) {
                // For files, we save to disk and pass the path
                const filePath = this.saveFileAttachment(file.base64, file.mimeType, file.fileName);
                attachments.push({
                  type: 'file',
                  path: filePath,
                  mimeType: file.mimeType,
                  fileName: file.fileName,
                });
                text = `[User sent a file: ${file.fileName}]`;
              } else {
                text = `[User sent a file: ${content.file_name ?? 'unknown'}] (download failed)`;
              }
            }
          } catch (e) {
            console.error('[WEBHOOK] File parse error:', (e as Error).message);
          }
          break;
        }

        case 'audio': {
          // Audio message: { "file_key": "...", "duration": 1000 }
          try {
            const content = JSON.parse(message.content ?? '{}') as { 
              file_key?: string; 
              duration?: number;
            };
            if (content.file_key) {
              const audio = await this.config.client.downloadAudio(
                content.file_key, 
                messageId, 
                content.duration
              );
              if (audio) {
                // Save audio to disk for transcription
                const audioPath = this.saveFileAttachment(
                  audio.base64, 
                  audio.mimeType, 
                  `voice_${messageId}.ogg`
                );
                attachments.push({
                  type: 'file',
                  path: audioPath,
                  mimeType: audio.mimeType,
                  fileName: `voice_${messageId}.ogg`,
                });
                const durationSec = audio.durationMs ? Math.round(audio.durationMs / 1000) : 0;
                text = `[User sent a voice message: ${durationSec}s]`;
              } else {
                text = '[User sent a voice message] (download failed)';
              }
            }
          } catch (e) {
            console.error('[WEBHOOK] Audio parse error:', (e as Error).message);
          }
          break;
        }

        default:
          // Log unsupported message types for debugging
          console.log(`[WEBHOOK] Unsupported message type: ${messageType}`);
          return;
      }

      // Skip empty messages
      if (!text && attachments.length === 0) {
        return;
      }

      const inboundChatType: 'direct' | 'group' = message.chat_type === 'group' ? 'group' : 'direct';

      // DM filtering (non-group chats)
      if (inboundChatType !== 'group') {
        const allowed = shouldAllowDmByPolicy({
          policy: this.config.dmPolicy,
          chatId,
          dmAllowlist: this.config.dmAllowlist,
        });

        if (!allowed) {
          console.log(`[WEBHOOK] 🚫 Ignoring DM from ${chatId} (blocked by dmPolicy=${this.config.dmPolicy ?? 'pairing'})`);
          return;
        }
      }

      // Group chat filtering
      if (inboundChatType === 'group') {
        const mentions = message.mentions ?? [];

        // Check allowlist
        if (this.config.groupAllowlist && !this.config.groupAllowlist.has(chatId)) {
          console.log(`[WEBHOOK] Ignoring group ${chatId} (not in allowlist)`);
          return;
        }

        // Remove mention markers from text
        text = text.replace(/@_user_\d+\s*/g, '').trim();

        // Check if we should respond
        const requireMention = this.config.groupRequireMention ?? true;
        if (attachments.length === 0 && !shouldRespondInGroup(text, mentions, requireMention)) {
          return;
        }
      }

      // NOTE: Session key is computed by the consumer using resolveAgentRoute()
      // We don't generate it here because the format depends on config (dmScope, identityLinks)
      // The consumer will use chat_id to compute the correct session key at processing time
      // This placeholder is only for queue schema compatibility
      const sessionKey = `lark:${chatId}`;  // Placeholder - consumer ignores this
      const threadRootId =
        inboundChatType === 'group'
          ? (message.root_id?.trim() || message.message_id?.trim() || null)
          : null;
      const messageText = text || '[User sent an image]';

      // ⚡ PERSIST IMMEDIATELY - no message loss
      const result = this.config.queue.enqueueInbound({
        messageId,
        threadRootId,
        chatType: inboundChatType,
        chatId,
        sessionKey,
        messageText,
        attachments: attachments.length > 0 ? attachments : null,
      });

      if (result.enqueued) {
        console.log(`[WEBHOOK] ✅ Queued message ${messageId}`);
      } else {
        console.log(`[WEBHOOK] ⏭️ Skipped: ${result.reason}`);
      }

      // Notify callback
      this.config.onMessage?.(event);
    } catch (e) {
      console.error('[WEBHOOK-ERROR]', e);
    }
  }

  /**
   * Get the underlying HTTP server
   */
  getServer(): Server | null {
    return this.server;
  }
}
