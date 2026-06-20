import { describe, it, expect } from 'vitest';

import { webhookPayloadSchema } from '../../src/validators/webhookPayload';

describe('webhookPayloadSchema', () => {
  describe('valid cases', () => {
    it('accepts standard POST payload', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'https://example.com/webhook',
        http_method: 'POST',
        payload: { event: 'order.created' },
        retry_policy: { kind: 'bounded', maxAttempts: 3 },
      });

      expect(result.success).toBe(true);
    });

    it('accepts PUT with custom headers', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'https://example.com/webhook',
        http_method: 'PUT',
        payload: { id: 1 },
        headers: { 'X-Custom-Header': 'value' },
        retry_policy: { kind: 'ttl', expiresAt: new Date().toISOString() },
      });

      expect(result.success).toBe(true);
    });

    it('accepts bounded retry policy with maxAttempts 5', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'https://example.com/webhook',
        http_method: 'PATCH',
        payload: {},
        retry_policy: { kind: 'bounded', maxAttempts: 5 },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.retry_policy).toEqual({
          kind: 'bounded',
          maxAttempts: 5,
        });
      }
    });
  });

  describe('invalid cases', () => {
    it('rejects missing endpoint_url', () => {
      const result = webhookPayloadSchema.safeParse({
        http_method: 'POST',
        payload: {},
        retry_policy: { kind: 'bounded', maxAttempts: 3 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid URL format', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'not-a-url',
        http_method: 'POST',
        payload: {},
        retry_policy: { kind: 'bounded', maxAttempts: 3 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid http_method enum value', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'https://example.com/webhook',
        http_method: 'DELETE',
        payload: {},
        retry_policy: { kind: 'bounded', maxAttempts: 3 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects missing retry_policy', () => {
      const result = webhookPayloadSchema.safeParse({
        endpoint_url: 'https://example.com/webhook',
        http_method: 'POST',
        payload: {},
      });

      expect(result.success).toBe(false);
    });
  });
});
