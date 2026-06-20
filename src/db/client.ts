import fs from 'node:fs';
import path from 'node:path';

import Database, { type Database as DatabaseInstance } from 'better-sqlite3';

import type {
  DeadLetterRecord,
  DeliveryError,
  DLQStatus,
  HttpMethod,
  RetryBackoffConfig,
  RetryPolicy,
} from '../types';

const DB_PATH = process.env.DB_PATH ?? 'dlq.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

interface DbRow {
  id: string;
  endpoint_url: string;
  http_method: string;
  payload: string;
  headers: string;
  status: string;
  retry_policy: string;
  attempt_count: number;
  last_attempted_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  error_log: string | null;
}

interface RetryQueueRow {
  id: string;
  endpoint_url: string;
  http_method: string;
  payload: string;
  headers: string;
  retry_policy: string;
  attempt_count: number;
  next_retry_at: string | null;
}

type SerializedRetryPolicy =
  | { kind: 'bounded'; maxAttempts: number }
  | { kind: 'ttl'; expiresAt: string };

interface StoredRetryPolicy {
  policy: SerializedRetryPolicy;
  backoff: RetryBackoffConfig;
}

const db: DatabaseInstance = new Database(DB_PATH);

const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

const insertRecordStmt = db.prepare(`
  INSERT INTO dead_letter_records (
    id,
    endpoint_url,
    http_method,
    payload,
    headers,
    status,
    retry_policy,
    attempt_count,
    last_attempted_at,
    next_retry_at,
    created_at,
    error_log
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getRetryQueueStmt = db.prepare(`
  SELECT
    id,
    endpoint_url,
    http_method,
    payload,
    headers,
    retry_policy,
    attempt_count,
    next_retry_at
  FROM dead_letter_records
  WHERE (status = 'PENDING' OR status = 'RETRYING')
    AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ORDER BY next_retry_at ASC, created_at ASC
  LIMIT ?
`);

const getDeadLettersStmt = db.prepare(`
  SELECT *
  FROM dead_letter_records
  WHERE status = 'DEAD'
    AND (? IS NULL OR id > ?)
  ORDER BY id ASC
  LIMIT ?
`);

const getBulkReplayTargetsStmt = db.prepare(`
  SELECT *
  FROM dead_letter_records
  WHERE status = ?
    AND (? IS NULL OR endpoint_url LIKE ?)
  ORDER BY created_at ASC
  LIMIT ?
`);

interface MetricsRow {
  total: number;
  pending: number | null;
  retrying: number | null;
  delivered: number | null;
  dead: number | null;
  oldest_pending_at: string | null;
}

const getMetricsStmt = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END) as retrying,
    SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
    SUM(CASE WHEN status = 'DEAD' THEN 1 ELSE 0 END) as dead,
    MIN(CASE WHEN status = 'PENDING' THEN created_at END) as oldest_pending_at
  FROM dead_letter_records
`);

function serializeRetryPolicyValue(
  policy: RetryPolicy,
  backoff: RetryBackoffConfig,
): string {
  const serializedPolicy: SerializedRetryPolicy =
    policy.kind === 'ttl'
      ? {
          kind: 'ttl',
          expiresAt: policy.expiresAt.toISOString(),
        }
      : policy;

  const stored: StoredRetryPolicy = {
    policy: serializedPolicy,
    backoff,
  };

  return JSON.stringify(stored);
}

function serializeRetryPolicy(record: DeadLetterRecord): string {
  return serializeRetryPolicyValue(record.retryPolicy, record.retryBackoff);
}

function reviveRetryPolicy(policy: SerializedRetryPolicy | RetryPolicy): RetryPolicy {
  if (policy.kind === 'ttl') {
    return {
      kind: 'ttl',
      expiresAt:
        policy.expiresAt instanceof Date
          ? policy.expiresAt
          : new Date(policy.expiresAt),
    };
  }

  return policy;
}

function parseRetryPolicy(raw: string): {
  policy: RetryPolicy;
  backoff: RetryBackoffConfig;
} {
  const parsed = JSON.parse(raw) as StoredRetryPolicy | RetryPolicy;

  if ('policy' in parsed && parsed.policy) {
    return {
      policy: reviveRetryPolicy(parsed.policy),
      backoff: parsed.backoff ?? DEFAULT_RETRY_BACKOFF,
    };
  }

  return {
    policy: reviveRetryPolicy(parsed as RetryPolicy),
    backoff: DEFAULT_RETRY_BACKOFF,
  };
}

function parseHeaders(raw: string): DeadLetterRecord['event']['headers'] {
  return JSON.parse(raw) as DeadLetterRecord['event']['headers'];
}

function parseErrorLog(raw: string | null): DeliveryError | null {
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as DeliveryError;
}

function rowToRecord(row: DbRow): DeadLetterRecord {
  const { policy, backoff } = parseRetryPolicy(row.retry_policy);
  const status = row.status as DLQStatus;
  const finalizedAt =
    status === 'DELIVERED' || status === 'DEAD' ? row.last_attempted_at : null;

  return {
    id: row.id,
    event: {
      id: row.id,
      targetUrl: row.endpoint_url,
      method: row.http_method as HttpMethod,
      headers: parseHeaders(row.headers),
      body: row.payload,
      receivedAt: row.created_at,
    },
    status,
    attemptCount: row.attempt_count,
    retryPolicy: policy,
    retryBackoff: backoff,
    nextRetryAt: row.next_retry_at,
    lastAttemptAt: row.last_attempted_at,
    lastError: parseErrorLog(row.error_log),
    createdAt: row.created_at,
    updatedAt: row.created_at,
    finalizedAt,
  };
}

function rowToRecordFromRetryQueue(row: RetryQueueRow): DeadLetterRecord {
  const { policy, backoff } = parseRetryPolicy(row.retry_policy);

  return {
    id: row.id,
    event: {
      id: row.id,
      targetUrl: row.endpoint_url,
      method: row.http_method as HttpMethod,
      headers: parseHeaders(row.headers),
      body: row.payload,
      receivedAt: row.next_retry_at ?? new Date().toISOString(),
    },
    status: 'PENDING',
    attemptCount: row.attempt_count,
    retryPolicy: policy,
    retryBackoff: backoff,
    nextRetryAt: row.next_retry_at,
    lastAttemptAt: null,
    lastError: null,
    createdAt: row.next_retry_at ?? new Date().toISOString(),
    updatedAt: row.next_retry_at ?? new Date().toISOString(),
    finalizedAt: null,
  };
}

export function insertRecord(record: DeadLetterRecord): void {
  insertRecordStmt.run(
    record.id,
    record.event.targetUrl,
    record.event.method,
    record.event.body,
    JSON.stringify(record.event.headers),
    record.status,
    serializeRetryPolicy(record),
    record.attemptCount,
    record.lastAttemptAt,
    record.nextRetryAt,
    record.createdAt,
    record.lastError ? JSON.stringify(record.lastError) : null,
  );
}

export function updateStatus(
  id: string,
  status: DeadLetterRecord['status'],
  patch?: Partial<DeadLetterRecord>,
): void {
  const assignments: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (patch?.attemptCount !== undefined) {
    assignments.push('attempt_count = ?');
    values.push(patch.attemptCount);
  }

  if (patch?.nextRetryAt !== undefined) {
    assignments.push('next_retry_at = ?');
    values.push(patch.nextRetryAt);
  }

  if (patch?.lastAttemptAt !== undefined) {
    assignments.push('last_attempted_at = ?');
    values.push(patch.lastAttemptAt);
  }

  if (patch?.lastError !== undefined) {
    assignments.push('error_log = ?');
    values.push(patch.lastError ? JSON.stringify(patch.lastError) : null);
  }

  if (patch?.retryPolicy !== undefined || patch?.retryBackoff !== undefined) {
    const existing = db
      .prepare('SELECT retry_policy FROM dead_letter_records WHERE id = ?')
      .get(id) as { retry_policy: string } | undefined;

    const stored = existing
      ? parseRetryPolicy(existing.retry_policy)
      : {
          policy: { kind: 'bounded' as const, maxAttempts: 1 },
          backoff: DEFAULT_RETRY_BACKOFF,
        };

    assignments.push('retry_policy = ?');
    values.push(
      serializeRetryPolicyValue(
        patch.retryPolicy ?? stored.policy,
        patch.retryBackoff ?? stored.backoff,
      ),
    );
  }

  if (patch?.event?.targetUrl !== undefined) {
    assignments.push('endpoint_url = ?');
    values.push(patch.event.targetUrl);
  }

  if (patch?.event?.method !== undefined) {
    assignments.push('http_method = ?');
    values.push(patch.event.method);
  }

  if (patch?.event?.body !== undefined) {
    assignments.push('payload = ?');
    values.push(patch.event.body);
  }

  if (patch?.event?.headers !== undefined) {
    assignments.push('headers = ?');
    values.push(JSON.stringify(patch.event.headers));
  }

  values.push(id);

  db.prepare(
    `UPDATE dead_letter_records SET ${assignments.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getRetryQueue(limit = 50): DeadLetterRecord[] {
  const rows = getRetryQueueStmt.all(limit) as RetryQueueRow[];
  return rows.map(rowToRecordFromRetryQueue);
}

export function getDeadLetters(cursor?: string, limit = 50): DeadLetterRecord[] {
  const cursorValue = cursor ?? null;
  const rows = getDeadLettersStmt.all(cursorValue, cursorValue, limit) as DbRow[];
  return rows.map(rowToRecord);
}

export function getBulkReplayTargets(
  status: DLQStatus,
  endpointUrl?: string,
  limit = 50,
): DeadLetterRecord[] {
  const endpointFilter = endpointUrl ?? null;
  const rows = getBulkReplayTargetsStmt.all(
    status,
    endpointFilter,
    endpointFilter,
    limit,
  ) as DbRow[];
  return rows.map(rowToRecord);
}

export function getRecordById(id: string): DeadLetterRecord | null {
  const row = db
    .prepare('SELECT * FROM dead_letter_records WHERE id = ?')
    .get(id) as DbRow | undefined;

  if (!row) {
    return null;
  }

  return rowToRecord(row);
}

export function getMetrics(): {
  summary: {
    total: number;
    pending: number;
    retrying: number;
    delivered: number;
    dead: number;
  };
  oldest_pending_at: string | null;
} {
  const row = getMetricsStmt.get() as MetricsRow;

  return {
    summary: {
      total: row.total,
      pending: row.pending ?? 0,
      retrying: row.retrying ?? 0,
      delivered: row.delivered ?? 0,
      dead: row.dead ?? 0,
    },
    oldest_pending_at: row.oldest_pending_at,
  };
}

export { db };
