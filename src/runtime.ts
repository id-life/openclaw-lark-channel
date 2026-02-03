/**
 * Lark Runtime State Management
 * 
 * Manages the runtime state for the Lark channel plugin,
 * including the OpenClaw plugin API reference.
 */

import type { LarkRuntimeState } from './types.js';

// ─── Types ───────────────────────────────────────────────────────

// Full plugin runtime interface matching OpenClaw's createPluginRuntime()
export interface LarkPluginRuntime {
  channel: {
    text: {
      chunkMarkdownText: (text: string, limit: number) => string[];
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: Record<string, unknown>;
        cfg: Record<string, unknown>;
        dispatcherOptions: {
          responsePrefix?: string;
          responsePrefixContextProvider?: () => Record<string, unknown>;
          deliver: (payload: { text?: string; mediaUrl?: string }, info: { kind: string }) => Promise<void>;
          onSkip?: (payload: unknown, info: { reason: string }) => void;
          onError?: (err: Error, info: { kind: string }) => void;
          onReplyStart?: () => void;
        };
        replyOptions?: {
          skillFilter?: unknown;
          onPartialReply?: (payload: { text?: string }) => void;
          onReasoningStream?: (payload: { text?: string }) => void;
          disableBlockStreaming?: boolean;
          onModelSelected?: (ctx: { provider: string; model: string; thinkLevel?: string }) => void;
        };
      }) => Promise<{ queuedFinal?: boolean }>;
      finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
      createReplyDispatcherWithTyping: (options: unknown) => unknown;
    };
    routing: {
      resolveAgentRoute: (params: {
        cfg: Record<string, unknown>;
        channel: string;
        accountId?: string;
        peer?: { kind: 'group' | 'dm'; id: string };
      }) => {
        sessionKey: string;
        mainSessionKey: string;
        agentId: string;
        accountId?: string;
      };
    };
    session: {
      resolveStorePath: () => string | null;
      recordInboundSession: (params: {
        storePath: string | null;
        sessionKey: string;
        ctx: Record<string, unknown>;
        updateLastRoute?: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId?: string;
        };
        onRecordError?: (err: Error) => void;
      }) => Promise<void>;
    };
  };
  config: {
    loadConfig: () => Record<string, unknown>;
    writeConfigFile: (cfg: unknown) => Promise<void>;
  };
  logging: {
    shouldLogVerbose: () => boolean;
  };
}

// ─── State ───────────────────────────────────────────────────────

let runtime: LarkPluginRuntime | null = null;

const accountRuntimes = new Map<string, LarkRuntimeState>();

// ─── Runtime Access ──────────────────────────────────────────────

export function setLarkRuntime(api: LarkPluginRuntime): void {
  runtime = api;
}

export function getLarkRuntime(): LarkPluginRuntime {
  if (!runtime) {
    throw new Error('Lark runtime not initialized');
  }
  return runtime;
}

// ─── Account Runtime ─────────────────────────────────────────────

export function getAccountRuntime(accountId: string): LarkRuntimeState | undefined {
  return accountRuntimes.get(accountId);
}

export function setAccountRuntime(accountId: string, state: Partial<LarkRuntimeState>): void {
  const existing = accountRuntimes.get(accountId);
  const newState: LarkRuntimeState = {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    webhookServer: null,
    consumersRunning: false,
    ...existing,
    ...state,
  };
  accountRuntimes.set(accountId, newState);
}

export function clearAccountRuntime(accountId: string): void {
  accountRuntimes.delete(accountId);
}

export function listAccountRuntimes(): Map<string, LarkRuntimeState> {
  return new Map(accountRuntimes);
}

// ─── Default Runtime State ───────────────────────────────────────

export function createDefaultRuntimeState(accountId: string): LarkRuntimeState {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    webhookServer: null,
    consumersRunning: false,
  };
}
