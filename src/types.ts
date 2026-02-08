/**
 * Lark Channel Plugin - Type Definitions
 * 
 * Core types for the Lark/Feishu channel integration.
 */

// ─── Configuration ───────────────────────────────────────────────

export interface LarkChannelConfig {
  appId?: string;
  appSecret?: string;
  appSecretFile?: string;
  encryptKey?: string;
  webhookPort?: number;
  webhookBind?: string;
  enabled?: boolean;
  dmPolicy?: 'open' | 'pairing' | 'allowlist';
  dmAllowlist?: string[];
  allowFrom?: string[];
  replyToMode?: 'off' | 'first' | 'all';
  groupPolicy?: 'open' | 'allowlist' | 'deny';
  groups?: Record<string, LarkGroupConfig>;
  queueDbPath?: string;
  domain?: 'lark' | 'feishu';
  name?: string;
  accounts?: Record<string, LarkAccountConfig>;
}

export interface LarkGroupConfig {
  requireMention?: boolean;
  name?: string;
  enabled?: boolean;
}

export interface LarkAccountConfig extends LarkChannelConfig {
  enabled?: boolean;
}

export interface ResolvedLarkAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  encryptKey: string;
  webhookPort: number;
  webhookBind: string;
  domain: 'lark' | 'feishu';
  config: LarkChannelConfig;
  tokenSource: 'config' | 'file' | 'env' | 'none';
}

// ─── Queue Types ─────────────────────────────────────────────────

export interface QueueMessage {
  id: number;
  status: 'pending' | 'processing' | 'completed' | 'failed_permanent';
  retries: number;
  next_retry_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_error: string | null;
}

export interface InboundMessage extends QueueMessage {
  message_id: string;
  thread_root_id: string | null;
  chat_type: 'direct' | 'group';
  chat_id: string;
  session_key: string;
  message_text: string;
  attachments_json: string | null;
  response_text: string | null;
}

export interface OutboundMessage extends QueueMessage {
  queue_type: 'reply' | 'mirror';
  run_id: string;
  session_key: string;
  chat_id: string;
  content: string;
  content_hash: string;
  lark_message_id: string | null;
}

export interface QueueStats {
  inbound: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  outbound: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  dbPath: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  reason?: string;
  id?: number;
  existing?: string;
}

// ─── Webhook Types ───────────────────────────────────────────────

export interface LarkWebhookEvent {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
    app_id?: string;
    tenant_key?: string;
  };
  event?: LarkMessageEvent;
  type?: string;
  challenge?: string;
  encrypt?: string;
}

export interface LarkMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: 'p2p' | 'group';
    message_type?: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'sticker';
    content?: string;
    mentions?: LarkMention[];
  };
}

export interface LarkMention {
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
  tenant_key?: string;
}

// ─── Card Types ──────────────────────────────────────────────────

export interface LarkCard {
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
  };
  header?: {
    title?: {
      tag: 'plain_text' | 'lark_md';
      content: string;
    };
    template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey' | 'default';
  };
  elements?: LarkCardElement[];
}

export type LarkCardElement = 
  | LarkCardDiv
  | LarkCardHr
  | LarkCardNote
  | LarkCardAction
  | LarkCardImage;

export interface LarkCardDiv {
  tag: 'div';
  text?: {
    tag: 'plain_text' | 'lark_md';
    content: string;
  };
  fields?: Array<{
    is_short?: boolean;
    text?: {
      tag: 'plain_text' | 'lark_md';
      content: string;
    };
  }>;
}

export interface LarkCardHr {
  tag: 'hr';
}

export interface LarkCardNote {
  tag: 'note';
  elements: Array<{
    tag: 'plain_text' | 'lark_md';
    content: string;
  }>;
}

export interface LarkCardAction {
  tag: 'action';
  actions: Array<{
    tag: 'button';
    text: {
      tag: 'plain_text' | 'lark_md';
      content: string;
    };
    type?: 'default' | 'primary' | 'danger';
    url?: string;
    value?: Record<string, unknown>;
  }>;
}

export interface LarkCardImage {
  tag: 'img';
  img_key: string;
  alt?: {
    tag: 'plain_text';
    content: string;
  };
}

// ─── API Response Types ──────────────────────────────────────────

export interface LarkSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface LarkImageUploadResult {
  success: boolean;
  imageKey?: string;
  error?: string;
}

export interface LarkTokenCache {
  token: string | null;
  expireTime: number;
}

// ─── Attachment Types ────────────────────────────────────────────

/**
 * Image attachment (base64 encoded)
 */
export interface ImageAttachment {
  type?: 'image';
  mimeType: string;
  content?: string;  // base64 (deprecated - use path instead)
  path?: string;     // file path (preferred)
}

/**
 * File attachment (saved to disk)
 */
export interface FileAttachment {
  type: 'file';
  path: string;
  mimeType: string;
  fileName?: string;
}

/**
 * Combined attachment type
 */
export type Attachment = ImageAttachment | FileAttachment;

export interface ParsedPostContent {
  texts: string[];
  imageKeys: string[];
}

// ─── Runtime Types ───────────────────────────────────────────────

export interface LarkRuntimeState {
  accountId: string;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  webhookServer: unknown | null;
  consumersRunning: boolean;
}

export interface LarkProbeResult {
  ok: boolean;
  bot?: {
    id?: string;
    name?: string;
    avatar?: string;
  };
  error?: string;
  elapsedMs?: number;
}
