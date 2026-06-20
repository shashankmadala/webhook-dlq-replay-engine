import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import { buildServer } from '../../src/api/server';
import { db, getRecordById, insertRecord } from '../../src/db/client';
import type { DeadLetterRecord, RetryBackoffConfig } from '../../src/types';

const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

function createRecord(id: string): DeadLetterRecord {
  const now = new Date().toISOString();

  return {
    id,
    event: {
      id,
      targetUrl: 'https://example.com/webhook',
      method: 'POST',
      headers: {},
      body: JSON.stringify({ event: 'test' }),
      receivedAt: now,
    },
    status: 'PENDING',
    attemptCount: 0,
    retryPolicy: { kind: 'bounded', maxAttempts: 3 },
    retryBackoff: DEFAULT_RETRY_BACKOFF,
    nextRetryAt: null,
    lastAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
  };
}

function createDeadRecord(
  id: string,
  targetUrl = 'https://example.com/webhook',
): DeadLetterRecord {
  const record = createRecord(id);
  const now = new Date().toISOString();

  return {
    ...record,
    event: {
      ...record.event,
      targetUrl,
    },
    status: 'DEAD',
    attemptCount: 3,
    nextRetryAt: now,
    lastAttemptAt: now,
    lastError: {
      code: 'MAX_ATTEMPTS',
      message: 'Exceeded max attempts',
      retryable: false,
      occurredAt: now,
    },
    finalizedAt: now,
  };
}

describe('API server', () => {
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    db.exec('DELETE FROM dead_letter_records');
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('POST /webhooks/ingest', () => {
    it('returns 202 with id and PENDING status for valid body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/ingest',
        payload: {
          endpoint_url: 'https://example.com/webhook',
          http_method: 'POST',
          payload: { event: 'test' },
          retry_policy: { kind: 'bounded', maxAttempts: 3 },
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        id: expect.any(String),
        status: 'PENDING',
      });
    });

    it('returns 400 VALIDATION_FAILED for missing endpoint_url', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/ingest',
        payload: {
          http_method: 'POST',
          payload: { event: 'test' },
          retry_policy: { kind: 'bounded', maxAttempts: 3 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'VALIDATION_FAILED',
      });
    });
  });

  describe('GET /health', () => {
    it('returns 200 with ok status and connected db', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'ok',
        db: 'connected',
      });
    });
  });

  describe('POST /webhooks/replay/bulk', () => {
    it('requeues matching DEAD records up to limit', async () => {
      insertRecord(createDeadRecord('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
      insertRecord(createDeadRecord('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/replay/bulk',
        payload: {
          limit: 1,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        requeued: 1,
        ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      });

      const requeued = getRecordById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(requeued?.status).toBe('PENDING');
      expect(requeued?.nextRetryAt).toBeNull();
      expect(requeued?.lastError).toBeNull();
    });

    it('filters by endpoint_url using LIKE match', async () => {
      insertRecord(
        createDeadRecord(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'https://example.com/webhook',
        ),
      );
      insertRecord(
        createDeadRecord(
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'https://other.example.com/webhook',
        ),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/replay/bulk',
        payload: {
          filter: {
            endpoint_url: 'https://example.com/webhook',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        requeued: 1,
        ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      });
    });
  });

  describe('POST /webhooks/replay/:id', () => {
    it('returns 200 RETRYING for an existing record', async () => {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      insertRecord(createRecord(id));

      const response = await server.inject({
        method: 'POST',
        url: `/webhooks/replay/${id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id,
        status: 'RETRYING',
        message: 'Record queued for immediate replay',
      });
    });

    it('returns 404 NOT_FOUND for unknown id', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/replay/00000000-0000-4000-8000-000000000000',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'NOT_FOUND' });
    });
  });
});
