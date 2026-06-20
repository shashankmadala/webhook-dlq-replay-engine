import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupSyncMock = vi.hoisted(() =>
  vi.fn(() => ({ address: '93.184.216.34', family: 4 })),
);

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

vi.mock('node:dns', () => ({
  lookupSync: (...args: unknown[]) => lookupSyncMock(...args),
}));

import { db, getRecordById, insertRecord } from '../../src/db/client';
import { ReplayEngine } from '../../src/engine/replayEngine';
import type { DeadLetterRecord, RetryBackoffConfig } from '../../src/types';

const RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

const URL_2XX = 'https://mock.test/2xx';
const URL_5XX = 'https://mock.test/5xx';
const URL_NETWORK_ERROR = 'https://mock.test/network-error';

function createRecord(id: string, targetUrl: string): DeadLetterRecord {
  const now = new Date().toISOString();

  return {
    id,
    event: {
      id,
      targetUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
      receivedAt: now,
    },
    status: 'PENDING',
    attemptCount: 0,
    retryPolicy: { kind: 'bounded', maxAttempts: 5 },
    retryBackoff: RETRY_BACKOFF,
    nextRetryAt: null,
    lastAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
  };
}

const SEEDED_RECORD_COUNT = 3;

function seedRecords(): {
  id2xx: string;
  id5xx: string;
  idNetwork: string;
} {
  const id2xx = '11111111-1111-4111-8111-111111111111';
  const id5xx = '22222222-2222-4222-8222-222222222222';
  const idNetwork = '33333333-3333-4333-8333-333333333333';

  insertRecord(createRecord(id2xx, URL_2XX));
  insertRecord(createRecord(id5xx, URL_5XX));
  insertRecord(createRecord(idNetwork, URL_NETWORK_ERROR));

  return { id2xx, id5xx, idNetwork };
}

describe('ReplayEngine integration', () => {
  let engine: ReplayEngine;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const schemaSql = fs.readFileSync(
      path.join(__dirname, '../../src/db/schema.sql'),
      'utf8',
    );
    db.exec(schemaSql);
    db.exec('DELETE FROM dead_letter_records');

    lookupSyncMock.mockReturnValue({ address: '93.184.216.34', family: 4 });

    mockFetch = vi.fn(async (url: string) => {
      if (url === URL_2XX) {
        return new Response('ok', { status: 200 });
      }

      if (url === URL_5XX) {
        return new Response('error', { status: 500 });
      }

      if (url === URL_NETWORK_ERROR) {
        throw new TypeError('fetch failed');
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', mockFetch);
    engine = new ReplayEngine(60_000);
  });

  afterEach(() => {
    engine.stop();
    vi.unstubAllGlobals();
    lookupSyncMock.mockReset();
  });

  it('processes 2xx, 5xx, and network error records in one batch', async () => {
    const { id2xx, id5xx, idNetwork } = seedRecords();

    await engine._processBatch();

    const delivered = getRecordById(id2xx);
    expect(delivered?.status).toBe('DELIVERED');

    const serverError = getRecordById(id5xx);
    expect(serverError?.attemptCount).toBe(1);
    expect(serverError?.nextRetryAt).not.toBeNull();

    const networkError = getRecordById(idNetwork);
    expect(networkError?.lastError?.code).toBe('NETWORK_ERROR');
  });

  it('concurrent processing guard: simultaneous batches call fetch N times not 2N', async () => {
    seedRecords();

    await Promise.all([engine._processBatch(), engine._processBatch()]);

    expect(mockFetch).toHaveBeenCalledTimes(SEEDED_RECORD_COUNT);
    expect(mockFetch).not.toHaveBeenCalledTimes(SEEDED_RECORD_COUNT * 2);
  });
});
