/**
 * Lark Channel Plugin
 * 
 * First-class OpenClaw channel plugin for Lark (Feishu) with:
 * - Guaranteed message delivery (SQLite persistence)
 * - Unlimited retries with exponential backoff
 * - Full bidirectional messaging support
 * - Interactive cards with rich formatting
 * - Image upload/download support
 */

import fs from 'node:fs';
import type {
  LarkChannelConfig,
  ResolvedLarkAccount,
  LarkRuntimeState,
  LarkProbeResult,
} from './types.js';
import { MessageQueue, getQueue, closeQueue } from './queue.js';
import { LarkClient, getLarkClient, setLarkClient } from './client.js';
import { buildCard, selectMessageType } from './card-builder.js';
import { WebhookHandler } from './webhook.js';
import {
  setAccountRuntime,
  createDefaultRuntimeState,
  getLarkRuntime,
} from './runtime.js';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk';
import { LarkConfigSchema } from './config-schema.js';

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_WEBHOOK_PORT = 3000;
const CONSUMER_INTERVAL_MS = 500;

// ─── Config Helpers ──────────────────────────────────────────────

function resolveUserPath(p: string): string {
  return p.replace(/^~/, process.env.HOME ?? '/root');
}

function readSecretFile(filePath: string): string | null {
  try {
    const resolved = resolveUserPath(filePath);
    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, 'utf8').trim();
    }
  } catch {
    // Ignore
  }
  return null;
}

// ─── Account Resolution ──────────────────────────────────────────

export function resolveLarkAccount(params: {
  cfg: { channels?: { lark?: LarkChannelConfig } };
  accountId?: string;
}): ResolvedLarkAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const larkConfig = params.cfg.channels?.lark ?? {};

  // Get account-specific config or use base config
  const accountConfig = accountId !== DEFAULT_ACCOUNT_ID
    ? larkConfig.accounts?.[accountId] ?? {}
    : {};

  // Merge configs (account overrides base)
  const merged: LarkChannelConfig = { ...larkConfig, ...accountConfig };

  // Resolve app secret
  let appSecret = merged.appSecret ?? '';
  let tokenSource: 'config' | 'file' | 'env' | 'none' = 'none';

  if (merged.appSecretFile) {
    const secret = readSecretFile(merged.appSecretFile);
    if (secret) {
      appSecret = secret;
      tokenSource = 'file';
    }
  } else if (merged.appSecret) {
    tokenSource = 'config';
  } else if (process.env.FEISHU_APP_SECRET) {
    appSecret = process.env.FEISHU_APP_SECRET;
    tokenSource = 'env';
  }

  // Resolve app ID
  const appId = merged.appId ?? process.env.FEISHU_APP_ID ?? '';

  return {
    accountId,
    name: merged.name ?? 'Lark',
    enabled: merged.enabled !== false,
    appId,
    appSecret,
    encryptKey: merged.encryptKey ?? process.env.FEISHU_ENCRYPT_KEY ?? '',
    webhookPort: merged.webhookPort ?? DEFAULT_WEBHOOK_PORT,
    domain: merged.domain ?? 'lark',
    config: merged,
    tokenSource,
  };
}

export function listLarkAccountIds(cfg: { channels?: { lark?: LarkChannelConfig } }): string[] {
  const larkConfig = cfg.channels?.lark;
  if (!larkConfig) {
    return [];
  }

  const ids = [DEFAULT_ACCOUNT_ID];
  if (larkConfig.accounts) {
    ids.push(...Object.keys(larkConfig.accounts).filter((id) => id !== DEFAULT_ACCOUNT_ID));
  }
  return ids;
}

// ─── Channel Meta ────────────────────────────────────────────────

const larkChannelMeta = {
  id: 'lark',
  label: 'Lark',
  selectionLabel: 'Lark (Feishu)',
  detailLabel: 'Lark / Feishu',
  docsPath: '/channels/lark',
  blurb: 'Connect to Lark (Feishu) messaging platform',
  order: 15,
  aliases: ['feishu'],
  quickstartAllowFrom: true,
};

// ─── Consumer Functions ──────────────────────────────────────────

let inboundConsumerRunning = false;
let outboundConsumerRunning = false;
let inboundInterval: NodeJS.Timeout | null = null;
let outboundInterval: NodeJS.Timeout | null = null;

// ⚡ CRITICAL FIX: Use dispatchReplyWithBufferedBlockDispatcher like Telegram
// This ensures session info, usage footer, reasoning blocks all work correctly.
// The WebSocket agent method bypasses the dispatch system which is why it was broken.

async function processInboundQueue(
  queue: MessageQueue,
  _gatewayToken: string,
  _gatewayPort: number,
  _agentId: string
): Promise<void> {
  if (!inboundConsumerRunning) return;

  const messages = queue.dequeueInbound(3);

  for (const msg of messages) {
    queue.markInboundProcessing(msg.id);

    try {
      console.log(`[INBOUND] Processing #${msg.id} | attempt ${msg.retries + 1}`);

      // Get the plugin runtime with dispatch system
      const pluginRuntime = getLarkRuntime();
      const cfg = pluginRuntime.config.loadConfig() as Record<string, unknown>;
      
      // Derive chat type from chat_id pattern (og_ = group, oc_ = DM)
      const isGroup = msg.chat_id.startsWith('og_');
      const chatType: 'direct' | 'group' = isGroup ? 'group' : 'direct';
      
      // Resolve routing - use same signature as Telegram
      const route = pluginRuntime.channel.routing.resolveAgentRoute({
        cfg,
        channel: 'lark',
        accountId: 'default',
        peer: {
          kind: isGroup ? 'group' : 'dm',
          id: msg.chat_id,
        },
      });

      // Build context like Telegram does - THIS IS THE KEY
      const ctx = pluginRuntime.channel.reply.finalizeInboundContext({
        Body: msg.message_text,
        BodyForAgent: msg.message_text,
        BodyForCommands: msg.message_text,
        RawBody: msg.message_text,
        CommandBody: msg.message_text,
        SessionKey: route.sessionKey,
        Provider: 'lark',
        Surface: 'lark',
        // ⚡ CRITICAL: These two fields enable session info routing
        OriginatingChannel: 'lark',
        OriginatingTo: msg.chat_id,
        ChatType: chatType,
        CommandAuthorized: true,
        MessageSid: msg.message_id,
        SenderId: msg.chat_id,
        From: msg.chat_id,
      });

      // Record session metadata
      const storePath = pluginRuntime.channel.session.resolveStorePath();
      await pluginRuntime.channel.session.recordInboundSession({
        storePath,
        sessionKey: route.sessionKey,
        ctx,
        updateLastRoute: chatType !== 'group' ? {
          sessionKey: route.mainSessionKey,
          channel: 'lark',
          to: msg.chat_id,
          accountId: route.accountId,
        } : undefined,
        onRecordError: (err) => {
          console.error('[INBOUND] Failed to record session:', err.message);
        },
      });

      // Get the Lark client for delivery
      const client = getLarkClient();

      // Use the dispatch system - SAME AS TELEGRAM
      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== 'final') return;
            
            const text = payload.text?.trim();
            if (!text) return;

            console.log(`[DISPATCH] Delivering ${info.kind}: ${text.length} chars`);
            
            // Send to Lark
            await sendToLark(client, msg.chat_id, text, route.sessionKey);
          },
          onError: (err, info) => {
            console.error(`[DISPATCH] ${info.kind} error:`, err.message);
          },
        },
        replyOptions: {
          disableBlockStreaming: true,
        },
      });

      queue.markInboundCompleted(msg.id, 'delivered');
    } catch (err) {
      console.error(`[INBOUND] Failed #${msg.id}:`, (err as Error).message);
      queue.markInboundRetry(msg.id, (err as Error).message);
    }
  }
}

async function processOutboundQueue(
  queue: MessageQueue,
  client: LarkClient
): Promise<void> {
  if (!outboundConsumerRunning) return;

  const messages = queue.dequeueOutbound(5);

  for (const msg of messages) {
    queue.markOutboundProcessing(msg.id);

    try {
      console.log(`[OUTBOUND] Processing #${msg.id} (${msg.queue_type}) | attempt ${msg.retries + 1}`);

      const result = await sendToLark(client, msg.chat_id, msg.content, msg.session_key);

      if (result.skipped) {
        queue.markOutboundCompleted(msg.id, null);
      } else if (result.messageId) {
        queue.markOutboundCompleted(msg.id, result.messageId);
      } else {
        throw new Error(result.error ?? 'Unknown error');
      }
    } catch (err) {
      console.error(`[OUTBOUND] Failed #${msg.id}:`, (err as Error).message);
      queue.markOutboundRetry(msg.id, (err as Error).message);
    }
  }
}

function startConsumers(
  queue: MessageQueue,
  client: LarkClient,
  gatewayToken: string,
  gatewayPort: number,
  agentId: string
): void {
  if (!inboundConsumerRunning) {
    inboundConsumerRunning = true;
    console.log('[CONSUMER] 🚀 Starting INBOUND consumer (Lark → Gateway)');
    inboundInterval = setInterval(
      () => processInboundQueue(queue, gatewayToken, gatewayPort, agentId),
      CONSUMER_INTERVAL_MS
    );
    processInboundQueue(queue, gatewayToken, gatewayPort, agentId);
  }

  if (!outboundConsumerRunning) {
    outboundConsumerRunning = true;
    console.log('[CONSUMER] 🚀 Starting OUTBOUND consumer (Gateway → Lark)');
    outboundInterval = setInterval(
      () => processOutboundQueue(queue, client),
      CONSUMER_INTERVAL_MS
    );
    processOutboundQueue(queue, client);
  }
}

function stopConsumers(): void {
  inboundConsumerRunning = false;
  outboundConsumerRunning = false;

  if (inboundInterval) {
    clearInterval(inboundInterval);
    inboundInterval = null;
  }
  if (outboundInterval) {
    clearInterval(outboundInterval);
    outboundInterval = null;
  }
}

// ─── Send to Lark ────────────────────────────────────────────────

// Direct send retries: Also use 120 retries with exponential backoff up to 120 min
// This is for the outbound.sendText calls from gateway's dispatch system
const SEND_MAX_RETRIES = 120;
const SEND_RETRY_BASE_MS = 1000;
const SEND_RETRY_MAX_MS = 120 * 60 * 1000; // 120 minutes max backoff

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff for direct sends
 * Caps at 120 minutes per Boyang's requirement
 */
function calculateSendBackoff(attempt: number): number {
  const backoff = SEND_RETRY_BASE_MS * Math.pow(2, Math.min(attempt - 1, 17));
  return Math.min(backoff, SEND_RETRY_MAX_MS);
}

async function sendToLarkWithRetry(
  client: LarkClient,
  chatId: string,
  content: string,
  sessionKey?: string
): Promise<{ skipped?: boolean; messageId?: string; error?: string }> {
  const msgType = selectMessageType(content);

  if (msgType === 'skip') {
    return { skipped: true };
  }

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= SEND_MAX_RETRIES; attempt++) {
    try {
      let result: { success: boolean; messageId?: string; error?: string };

      if (msgType === 'text') {
        result = await client.sendText(chatId, content);
      } else {
        // Interactive card
        const card = buildCard({ text: content, sessionKey });
        result = await client.sendCard(chatId, card);
      }

      if (result.success) {
        console.log(`[LARK-SENT] ${msgType}: ${result.messageId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        return { messageId: result.messageId };
      }

      lastError = result.error ?? 'Unknown error';
      console.warn(`[LARK-SEND] Attempt ${attempt}/${SEND_MAX_RETRIES} failed: ${lastError}`);
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`[LARK-SEND] Attempt ${attempt}/${SEND_MAX_RETRIES} threw: ${lastError}`);
    }

    // Exponential backoff before retry (cap at 120 minutes)
    if (attempt < SEND_MAX_RETRIES) {
      const backoffMs = calculateSendBackoff(attempt);
      const backoffFormatted = backoffMs >= 60000 
        ? `${Math.round(backoffMs / 60000)}m` 
        : `${Math.round(backoffMs / 1000)}s`;
      console.log(`[LARK-SEND] Next retry in ${backoffFormatted}`);
      await sleep(backoffMs);
    }
  }

  console.error(`[LARK-SEND] ❌ FAILED after ${SEND_MAX_RETRIES} attempts: ${lastError}`);
  return { error: lastError };
}

// Alias for backward compatibility
const sendToLark = sendToLarkWithRetry;

// ─── Channel Plugin Interface ────────────────────────────────────

interface ChannelPluginContext {
  cfg: { channels?: { lark?: LarkChannelConfig }; gateway?: { port?: number; auth?: { token?: string } } };
  account: ResolvedLarkAccount;
  runtime?: LarkRuntimeState;
  abortSignal?: AbortSignal;
  log?: { info: (msg: string) => void; debug?: (msg: string) => void };
}

export const larkPlugin = {
  id: 'lark',
  meta: {
    ...larkChannelMeta,
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ['direct', 'group'] as const,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },

  reload: { configPrefixes: ['channels.lark'] },

  configSchema: buildChannelConfigSchema(LarkConfigSchema),

  config: {
    listAccountIds: (cfg: { channels?: { lark?: LarkChannelConfig } }) => listLarkAccountIds(cfg),
    resolveAccount: (cfg: { channels?: { lark?: LarkChannelConfig } }, accountId?: string) =>
      resolveLarkAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: ResolvedLarkAccount) => Boolean(account.appId && account.appSecret),
    describeAccount: (account: ResolvedLarkAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }: { cfg: { channels?: { lark?: LarkChannelConfig } }; accountId?: string }) =>
      (resolveLarkAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }: { allowFrom: string[] }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(lark|feishu):/i, ''))
        .map((entry) => entry.toLowerCase()),
  },

  security: {
    resolveDmPolicy: ({ accountId, account }: { cfg: { channels?: { lark?: LarkChannelConfig } }; accountId?: string; account: ResolvedLarkAccount }) => {
      const basePath = accountId !== DEFAULT_ACCOUNT_ID
        ? `channels.lark.accounts.${accountId}.`
        : 'channels.lark.';
      return {
        policy: account.config.dmPolicy ?? 'pairing',
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: 'Use /allow lark:<userId> to approve',
        normalizeEntry: (raw: string) => raw.replace(/^(lark|feishu):/i, ''),
      };
    },
    collectWarnings: ({ account }: { account: ResolvedLarkAccount; cfg: { channels?: { lark?: LarkChannelConfig } } }) => {
      const groupPolicy = account.config.groupPolicy ?? 'allowlist';
      if (groupPolicy === 'open') {
        const groupsConfigured = account.config.groups && Object.keys(account.config.groups).length > 0;
        if (!groupsConfigured) {
          return [
            '- Lark groups: groupPolicy="open" with no channels.lark.groups allowlist; any group can trigger. Consider setting groupPolicy="allowlist".',
          ];
        }
      }
      return [];
    },
  },

  messaging: {
    normalizeTarget: (target: string) => {
      const trimmed = target.trim();
      if (/^oc_[a-f0-9]+$/i.test(trimmed)) {
        return trimmed;
      }
      return trimmed.replace(/^(lark|feishu):/i, '');
    },
    targetResolver: {
      looksLikeId: (target: string) => /^oc_[a-f0-9]+$/i.test(target),
      hint: '<chatId> (e.g., oc_abc123...)',
    },
  },

  outbound: {
    deliveryMode: 'direct' as const,
    chunker: (text: string, limit: number) => {
      // Simple chunker - split by newlines first, then by length
      const chunks: string[] = [];
      let current = '';

      for (const line of text.split('\n')) {
        if (current.length + line.length + 1 > limit) {
          if (current) chunks.push(current);
          current = line;
        } else {
          current = current ? `${current}\n${line}` : line;
        }
      }

      if (current) chunks.push(current);
      return chunks;
    },
    chunkerMode: 'markdown' as const,
    textChunkLimit: 30000,

    sendText: async ({ to, text }: { to: string; text: string; accountId?: string }) => {
      const client = getLarkClient();
      const result = await sendToLark(client, to, text);
      return { channel: 'lark' as const, ...result };
    },

    sendMedia: async ({ to, text, mediaUrl }: { to: string; text?: string; mediaUrl: string; accountId?: string }) => {
      const client = getLarkClient();

      // Upload image
      const uploadResult = await client.uploadImageFromUrl(mediaUrl);
      if (!uploadResult.success || !uploadResult.imageKey) {
        return { channel: 'lark' as const, error: uploadResult.error ?? 'Failed to upload image' };
      }

      // Send card with image
      const card = buildCard({
        text: text ?? '',
        sessionKey: undefined,
      });

      // Add image to card
      card.elements = [
        {
          tag: 'img',
          img_key: uploadResult.imageKey,
          alt: { tag: 'plain_text', content: 'Image' },
        },
        ...(card.elements ?? []),
      ];

      const result = await client.sendCard(to, card);
      return { channel: 'lark' as const, messageId: result.messageId, error: result.error };
    },
  },

  status: {
    defaultRuntime: createDefaultRuntimeState(DEFAULT_ACCOUNT_ID),

    // NOTE: collectStatusIssues receives SNAPSHOTS from buildAccountSnapshot, NOT ResolvedLarkAccount!
    // So we must check `configured` (boolean), not `appId`/`appSecret` (which aren't in snapshots)
    collectStatusIssues: (accounts: Array<{ accountId?: string; configured?: boolean; enabled?: boolean }>) => {
      const issues: Array<{ channel: string; accountId: string; kind?: string; message: string; fix?: string }> = [];

      if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
        issues.push({
          channel: 'lark',
          accountId: 'default',
          kind: 'config',
          message: 'No Lark accounts configured',
          fix: 'Add channels.lark section with appId, appSecret, and encryptKey',
        });
        return issues;
      }

      for (const account of accounts) {
        const accountId = String(account.accountId ?? 'default');
        const enabled = account.enabled !== false;
        const configured = account.configured === true;

        // Skip disabled or properly configured accounts
        if (!enabled || configured) {
          continue;
        }

        issues.push({
          channel: 'lark',
          accountId,
          kind: 'config',
          message: 'Missing appId or appSecret configuration',
          fix: 'Set channels.lark.appId and channels.lark.appSecret in config (or via FEISHU_APP_ID/FEISHU_APP_SECRET env vars)',
        });
      }

      return issues;
    },

    buildChannelSummary: ({ snapshot }: { snapshot: LarkRuntimeState & { configured?: boolean; tokenSource?: string; probe?: LarkProbeResult } }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? 'none',
      running: snapshot.running ?? false,
      mode: 'webhook' as const,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
    }),

    probeAccount: async ({ account, timeoutMs }: { account: ResolvedLarkAccount; timeoutMs?: number }) => {
      if (!account.appId || !account.appSecret) {
        return { ok: false, error: 'Not configured' };
      }

      const client = new LarkClient({
        appId: account.appId,
        appSecret: account.appSecret,
        domain: account.domain,
      });

      return client.probe(timeoutMs ?? 5000);
    },

    buildAccountSnapshot: ({ account, runtime, probe }: {
      account: ResolvedLarkAccount;
      cfg: { channels?: { lark?: LarkChannelConfig } };
      runtime?: LarkRuntimeState;
      probe?: LarkProbeResult;
    }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: 'webhook',
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx: ChannelPluginContext) => {
      const { account, cfg, abortSignal, log } = ctx;

      if (!account.appId || !account.appSecret) {
        throw new Error('Lark not configured (missing appId/appSecret)');
      }

      log?.info(`[${account.accountId}] Starting Lark channel`);

      // Initialize client
      const client = new LarkClient({
        appId: account.appId,
        appSecret: account.appSecret,
        domain: account.domain,
      });
      setLarkClient(client);

      // Probe
      const probe = await client.probe();
      if (probe.ok) {
        log?.info(`[${account.accountId}] Connected to bot: ${probe.bot?.name ?? 'unknown'}`);
      } else {
        log?.info(`[${account.accountId}] Probe failed: ${probe.error}`);
      }

      // Initialize queue
      const queuePath = account.config.queueDbPath ?? undefined;
      const queue = getQueue(queuePath);

      // Build group allowlist
      const groupAllowlist = account.config.groups
        ? new Set(Object.keys(account.config.groups))
        : undefined;

      // Start webhook
      const webhook = new WebhookHandler({
        port: account.webhookPort,
        encryptKey: account.encryptKey,
        queue,
        client,
        sessionKeyPrefix: 'lark',
        groupRequireMention: true,
        groupAllowlist,
      });

      await webhook.start();

      // Get gateway config
      const gatewayPort = cfg.gateway?.port ?? 18789;
      const gatewayToken = cfg.gateway?.auth?.token ?? '';
      const agentId = 'main';

      // Start consumers
      startConsumers(queue, client, gatewayToken, gatewayPort, agentId);

      // Update runtime state - clear any previous error
      setAccountRuntime(account.accountId, {
        running: true,
        lastStartAt: Date.now(),
        lastError: null,  // Clear previous errors on successful start
        webhookServer: webhook,
        consumersRunning: true,
      });

      // Handle abort signal
      abortSignal?.addEventListener('abort', () => {
        log?.info(`[${account.accountId}] Stopping Lark channel`);
        webhook.stop();
        stopConsumers();
        closeQueue();
        setAccountRuntime(account.accountId, {
          running: false,
          lastStopAt: Date.now(),
          webhookServer: null,
          consumersRunning: false,
        });
      });

      console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║            Lark Channel Plugin v1.0.0                             ║
╠═══════════════════════════════════════════════════════════════════╣
║  🔒 ALL messages persisted to SQLite                              ║
║  ♾️  UNLIMITED retries with exponential backoff                   ║
║  ⚡ NO MESSAGE LOSS - EVER                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Webhook: http://0.0.0.0:${String(account.webhookPort).padEnd(41)}║
║  Queue:   ${queue.path.padEnd(52)}║
╚═══════════════════════════════════════════════════════════════════╝
`);
    },
  },
};

export type LarkPlugin = typeof larkPlugin;
