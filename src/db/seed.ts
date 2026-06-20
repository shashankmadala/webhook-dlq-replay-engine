import { v4 as uuidv4 } from 'uuid';

import type { DeadLetterRecord, RetryBackoffConfig, RetryPolicy } from '../types';
import { insertRecord } from './client';

const RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

const BOUNDED_POLICY: RetryPolicy = { kind: 'bounded', maxAttempts: 3 };

function createRecord(
  targetUrl: string,
  retryPolicy: RetryPolicy,
): DeadLetterRecord {
  const id = uuidv4();
  const now = new Date().toISOString();

  return {
    id,
    event: {
      id,
      targetUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: true }),
      receivedAt: now,
    },
    status: 'PENDING',
    attemptCount: 0,
    retryPolicy,
    retryBackoff: RETRY_BACKOFF,
    nextRetryAt: null,
    lastAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
  };
}

const records: DeadLetterRecord[] = [
  ...Array.from({ length: 5 }, () =>
    createRecord('http://localhost:9999/dead-end', BOUNDED_POLICY),
  ),
  ...Array.from({ length: 3 }, () =>
    createRecord('https://httpbin.org/status/429', BOUNDED_POLICY),
  ),
  ...Array.from({ length: 2 }, () =>
    createRecord('http://localhost:9999/dead-end', {
      kind: 'ttl',
      expiresAt: new Date(Date.now() + 10_000),
    }),
  ),
];

for (const record of records) {
  insertRecord(record);
}

console.log(`Seeded ${records.length} dead letter records.`);
