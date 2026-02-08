/**
 * Webhook Handler Tests
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { decryptPayload, shouldAllowDmByPolicy, shouldRespondInGroup } from '../src/webhook.js';

describe('Webhook', () => {
  describe('decryptPayload', () => {
    it('should return null for missing encrypt key', () => {
      expect(decryptPayload('encrypted', '')).toBeNull();
    });

    it('should return null for missing encrypted data', () => {
      expect(decryptPayload('', 'key')).toBeNull();
    });

    // Note: Full encryption test would require a valid encrypted payload
    // which depends on Lark's encryption format
  });

  describe('shouldRespondInGroup', () => {
    it('should respond when mentions exist', () => {
      expect(shouldRespondInGroup('Hello', [{ key: '@_user_1' }], true)).toBe(true);
      expect(shouldRespondInGroup('Hello', [{ key: '@_user_1' }], false)).toBe(true);
    });

    it('should not respond to empty mentions when requireMention is true', () => {
      expect(shouldRespondInGroup('Hello there', [], true)).toBe(false);
    });

    it('should detect questions by punctuation', () => {
      expect(shouldRespondInGroup('What time is it?', [], false)).toBe(true);
      expect(shouldRespondInGroup('这是什么？', [], false)).toBe(true);
    });

    it('should detect English question keywords', () => {
      expect(shouldRespondInGroup('Can you help me with this', [], false)).toBe(true);
      expect(shouldRespondInGroup('How do I do this', [], false)).toBe(true);
      expect(shouldRespondInGroup('What is the answer', [], false)).toBe(true);
      expect(shouldRespondInGroup('Why does this happen', [], false)).toBe(true);
      expect(shouldRespondInGroup('Please explain', [], false)).toBe(true);
    });

    it('should detect Chinese question keywords', () => {
      expect(shouldRespondInGroup('帮我分析一下', [], false)).toBe(true);
      expect(shouldRespondInGroup('请解释这个', [], false)).toBe(true);
      expect(shouldRespondInGroup('能否总结一下', [], false)).toBe(true);
      expect(shouldRespondInGroup('这是什么意思', [], false)).toBe(true);
    });

    it('should not respond to statements', () => {
      expect(shouldRespondInGroup('Just chatting here', [], false)).toBe(false);
      expect(shouldRespondInGroup('Meeting at 3pm', [], false)).toBe(false);
      expect(shouldRespondInGroup('Ok sounds good', [], false)).toBe(false);
    });
  });

  describe('shouldAllowDmByPolicy', () => {
    it('should always allow for open policy', () => {
      expect(shouldAllowDmByPolicy({ policy: 'open', chatId: 'oc_any' })).toBe(true);
    });

    it('should enforce allowlist policy', () => {
      const allowlist = new Set(['oc_allowed']);
      expect(shouldAllowDmByPolicy({ policy: 'allowlist', chatId: 'oc_allowed', dmAllowlist: allowlist })).toBe(true);
      expect(shouldAllowDmByPolicy({ policy: 'allowlist', chatId: 'oc_blocked', dmAllowlist: allowlist })).toBe(false);
      expect(shouldAllowDmByPolicy({ policy: 'allowlist', chatId: 'oc_blocked' })).toBe(false);
    });

    it('should allow pairing policy without allowlist and enforce when provided', () => {
      expect(shouldAllowDmByPolicy({ policy: 'pairing', chatId: 'oc_any' })).toBe(true);

      const allowlist = new Set(['oc_allowed']);
      expect(shouldAllowDmByPolicy({ policy: 'pairing', chatId: 'oc_allowed', dmAllowlist: allowlist })).toBe(true);
      expect(shouldAllowDmByPolicy({ policy: 'pairing', chatId: 'oc_blocked', dmAllowlist: allowlist })).toBe(false);
    });
  });
});
