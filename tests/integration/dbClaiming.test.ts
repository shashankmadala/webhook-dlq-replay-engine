import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import {
  claimDueRecords,
  db,
  getRecordById,
  insertRecord,
  requeueRecordForReplay,
  updateClaimedStatus,
} from '../../src/db/client';
import type { DeadLetterRecord, RetryBackoffConfig } from '../../src/types';

const RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
      receivedAt: now,
    },
    status: 'PENDING',
    attemptCount: 0,
    retryPolicy: { kind: 'bounded', maxAttempts: 5 },
    retryBackoff: RETRY_BACKOFF,
    nextRetryAt: null,
    claimToken: null,
    claimedAt: null,
    lastAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
  };
}

describe('DB replay claiming', () => {
  beforeEach(() => {
    const schemaSql = fs.readFileSync(
      path.join(__dirname, '../../src/db/schema.sql'),
      'utf8',
    );
    db.exec(schemaSql);
    db.exec('DELETE FROM dead_letter_records');
  });

  it('allows only one claim token to own a due record', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    insertRecord(createRecord(id));

    const firstClaim = claimDueRecords(
      1,
      'claim-token-1',
      '1970-01-01T00:00:00.000Z',
    );
    const secondClaim = claimDueRecords(
      1,
      'claim-token-2',
      '1970-01-01T00:00:00.000Z',
    );

    expect(firstClaim.map((record) => record.id)).toEqual([id]);
    expect(secondClaim).toEqual([]);

    const record = getRecordById(id);
    expect(record?.status).toBe('RETRYING');
    expect(record?.claimToken).toBe('claim-token-1');
    expect(record?.claimedAt).not.toBeNull();
  });

  it('guards completion by claim token', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    insertRecord(createRecord(id));
    claimDueRecords(1, 'owner-token', '1970-01-01T00:00:00.000Z');

    const wrongOwnerUpdated = updateClaimedStatus(
      id,
      'wrong-token',
      'DELIVERED',
      { lastAttemptAt: new Date().toISOString() },
    );
    expect(wrongOwnerUpdated).toBe(false);
    expect(getRecordById(id)?.status).toBe('RETRYING');

    const ownerUpdated = updateClaimedStatus(id, 'owner-token', 'DELIVERED', {
      lastAttemptAt: new Date().toISOString(),
    });
    const record = getRecordById(id);

    expect(ownerUpdated).toBe(true);
    expect(record?.status).toBe('DELIVERED');
    expect(record?.claimToken).toBeNull();
    expect(record?.claimedAt).toBeNull();
  });

  it('recovers stale claims for a new owner', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const record = createRecord(id);
    record.status = 'RETRYING';
    record.claimToken = 'stale-token';
    record.claimedAt = '2026-01-01T00:00:00.000Z';
    insertRecord(record);

    const freshClaim = claimDueRecords(
      1,
      'fresh-token',
      '2026-01-01T00:00:01.000Z',
    );

    expect(freshClaim.map((claimedRecord) => claimedRecord.id)).toEqual([id]);
    expect(getRecordById(id)?.claimToken).toBe('fresh-token');
  });

  it('does not manually requeue an actively claimed record', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    insertRecord(createRecord(id));
    claimDueRecords(1, 'active-token', '1970-01-01T00:00:00.000Z');

    const requeued = requeueRecordForReplay(id, '1970-01-01T00:00:00.000Z');

    expect(requeued).toBe(false);
    expect(getRecordById(id)?.claimToken).toBe('active-token');
  });
});
