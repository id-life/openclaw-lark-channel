/**
 * Lark Channel Config Schema
 * 
 * Zod schema for Lark channel configuration.
 * Used by buildChannelConfigSchema to generate JSON Schema for the dashboard.
 */

import { z } from 'zod';

// Group config schema
const LarkGroupConfigSchema = z.object({
  requireMention: z.boolean().optional().describe('Require @mention to respond in this group'),
  name: z.string().optional().describe('Friendly name for this group'),
  enabled: z.boolean().optional().describe('Enable bot in this group'),
});

// Account config schema (subset of main config, non-recursive)
const LarkAccountConfigSchema = z.object({
  enabled: z.boolean().optional().describe('Enable this account'),
  appId: z.string().optional().describe('Lark application ID'),
  appSecret: z.string().optional().describe('Lark application secret'),
  appSecretFile: z.string().optional().describe('Path to file containing the app secret'),
  encryptKey: z.string().optional().describe('Encryption key for webhook events'),
  webhookPort: z.number().optional().describe('Port for webhook HTTP server'),
  domain: z.enum(['lark', 'feishu']).optional().describe('Lark domain'),
  name: z.string().optional().describe('Display name for this account'),
});

// Main Lark config schema - matches LarkChannelConfig interface
export const LarkConfigSchema = z.object({
  enabled: z.boolean().optional().default(true).describe('Enable or disable the Lark channel'),
  
  appId: z.string().optional().describe('Lark application ID'),
  appSecret: z.string().optional().describe('Lark application secret (prefer appSecretFile for security)'),
  appSecretFile: z.string().optional().describe('Path to file containing the app secret'),
  encryptKey: z.string().optional().describe('Encryption key for webhook events'),
  
  webhookPort: z.number().optional().default(3000).describe('Port for webhook HTTP server'),
  webhookBind: z.string().optional().default('127.0.0.1').describe('Bind address for webhook HTTP server (127.0.0.1 for localhost only, 0.0.0.0 for all interfaces)'),
  
  domain: z.enum(['lark', 'feishu']).optional().default('lark')
    .describe('Lark domain (lark for international, feishu for China)'),
  
  name: z.string().optional().describe('Display name for this account'),
  
  dmPolicy: z.enum(['open', 'pairing', 'allowlist']).optional().default('pairing')
    .describe('Direct message security policy'),
  dmAllowlist: z.array(z.string()).optional()
    .describe('List of allowed chat IDs for DM allowlist policy'),
  replyToMode: z.enum(['off', 'first', 'all']).optional().default('all')
    .describe('Thread reply mode when replying to message threads'),
  allowFrom: z.array(z.string()).optional()
    .describe('List of allowed Lark user IDs (for allowlist policy)'),
  
  groupPolicy: z.enum(['open', 'allowlist', 'deny']).optional().default('allowlist')
    .describe('Group chat security policy'),
  
  groups: z.record(z.string(), LarkGroupConfigSchema).optional()
    .describe('Group-specific configuration'),
  
  queueDbPath: z.string().optional()
    .describe('Path to SQLite queue database'),
  
  accounts: z.record(z.string(), LarkAccountConfigSchema).optional()
    .describe('Additional account configurations'),
});

export type LarkConfigSchemaType = z.infer<typeof LarkConfigSchema>;
