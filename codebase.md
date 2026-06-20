# .gitignore

```
node_modules/
dist/
dlq.db
*.js.map

```

# dlq.db

This is a binary file of the type: Binary

# dlq.db-shm

This is a binary file of the type: Binary

# dlq.db-wal

This is a binary file of the type: Binary

# docs/ADR-001-sqlite.md

```md
# ADR-001: Use SQLite as the persistence layer for the Webhook DLQ Replay Engine

## Status

Proposed

## Context

The system must:

- Accept inbound webhook payloads over HTTP
- Persist failed delivery attempts durably
- Track a lifecycle: `PENDING → RETRYING → DELIVERED | DEAD`
- Support configurable retry policies (exponential backoff with jitter)
- Expose replay APIs for manual and automatic re-drive
- Emit structured logs and lifecycle events

We need a store that is durable, queryable, and supports transactional status updates. Candidates: **SQLite**, **Redis**, **PostgreSQL**.

## Decision

Use **SQLite** as the sole persistence layer for DLQ entries, retry metadata, and delivery audit history.

## Rationale

| Criterion | SQLite | Redis | PostgreSQL |
|-----------|--------|-------|------------|
| **Durability** | ACID, WAL mode, crash-safe | Requires AOF/RDB; not a natural fit as primary DLQ | ACID, proven |
| **Operational cost** | Zero external deps; embedded file | Separate service, memory tuning | Separate service, backups, migrations |
| **Query model** | Full SQL: filter by status, age, target, error | Key/value or streams; complex queries need extra design | Full SQL |
| **Consistency** | Single-writer, strong per-transaction | Eventual unless careful locking | Strong, multi-writer |
| **Deployment** | Single binary + `.db` file | Cluster/sentinel for HA | Managed or self-hosted |
| **Throughput fit** | Thousands of events/sec on one node — sufficient for DLQ | High throughput, but DLQ is failure-path, not hot path | High throughput, overkill at small scale |

### Why not Redis?

Redis fits caching and ephemeral queues. A DLQ needs durable, inspectable records with rich querying (e.g. "all `DEAD` entries for endpoint X in the last 7 days"). Redis Streams or lists can approximate this, but:

- Durability depends on persistence config and is weaker than SQLite's transactional model
- Complex filtering and pagination are awkward without a secondary index layer
- DLQ volume is typically low (failures only); Redis's in-memory speed is unnecessary

### Why not PostgreSQL?

Postgres is the right choice when you need:

- Multiple replay workers across machines with concurrent writes
- Centralized DLQ shared by many ingestion nodes
- Very high write volume or HA replication

For a focused replay engine — single Node.js process (or a small number of co-located workers), moderate webhook volume, and a desire for minimal infrastructure — Postgres adds deployment and ops cost without clear benefit at this stage.

### Why SQLite?

- **Embedded**: No separate database server; ideal for a self-contained service
- **ACID transactions**: Status transitions (`PENDING → RETRYING → DELIVERED`) are atomic and auditable
- **Queryable DLQ**: Native support for replay queues, dead-letter inspection, and admin APIs
- **Portable**: Single `.db` file simplifies backup, restore, and local dev
- **Migration path**: If scale demands it, schema and domain model can migrate to Postgres later; the interface layer abstracts storage

## Consequences

### Positive

- Simple deployment (one process + one file)
- Strong durability guarantees for failed events
- Rich SQL for replay scheduling (`WHERE status = 'PENDING' AND next_retry_at <= ?`)
- Easy local development and testing with in-memory or temp-file DB

### Negative

- Single-writer bottleneck; not ideal for many concurrent ingestion nodes writing to one DB
- No built-in HA; failover requires file replication or external tooling
- Must use WAL mode and sensible connection pooling (e.g. `better-sqlite3` or serialized writes via a queue)

### Mitigations

- Enable WAL mode and `busy_timeout`
- Serialize writes through a single repository layer
- Use a background scheduler for retries (not per-request timers in DB)
- Document migration path to Postgres if horizontal scaling is needed

```

# docs/data-flow.md

```md
# Webhook DLQ Replay Engine — Data Flow

\`\`\`
                                    ┌─────────────────────────────────────────────────────────┐
                                    │                    EXTERNAL SYSTEMS                      │
                                    └─────────────────────────────────────────────────────────┘
                                                              │
  Inbound Webhook                                             │
  (POST /webhooks)                                            ▼
       │                                          ┌───────────────────────┐
       │                                          │   Target Endpoint     │
       │                                          │   (downstream URL)    │
       │                                          └───────────▲───────────┘
       │                                                      │
       ▼                                                      │ HTTP POST
┌──────────────────┐                              ┌───────────┴───────────┐
│  INGESTION       │                              │   DELIVERY SERVICE    │
│  LAYER           │                              │   (HTTP client)       │
│                  │                              └───────────▲───────────┘
│  • Validate      │                                          │
│  • Normalize     │         success (2xx)                    │
│  • Attempt       │──────────────────────────────────────────┤
│    delivery      │                                          │
└────────┬─────────┘                                          │
         │                                                    │
         │ failure (timeout,                                   │
         │ 4xx/5xx, network)                                  │
         ▼                                                    │
┌──────────────────┐         read due entries                 │
│   DLQ STORE      │◄─────────────────────────────────────────┤
│   (SQLite)       │                                          │
│                  │         update status                    │
│  • dlq_entries   │──────────────────────────────────────────┤
│  • retry_meta    │                                          │
│  • audit_log     │                                          │
└────────┬─────────┘                                          │
         │                                                    │
         │ enqueue / persist                                  │
         │ status: PENDING                                    │
         ▼                                                    │
┌──────────────────┐         trigger replay                  │
│  REPLAY ENGINE   │──────────────────────────────────────────┘
│                  │
│  • Scheduler     │──────► status: RETRYING
│    (poll due)    │
│  • Manual API    │
│    POST /replay  │
│  • Retry policy  │──────► compute next_retry_at
│    (backoff +    │         (exponential + jitter)
│     jitter)      │
└────────┬─────────┘
         │
         │ outcome
         ├──────────────────► DELIVERED  (2xx from target)
         │
         └──────────────────► DEAD       (max retries exhausted
                                          or non-retryable error)

┌──────────────────────────────────────────────────────────────────────────┐
│  CROSS-CUTTING: Structured Logs + Lifecycle Events                       │
│  PENDING → RETRYING → DELIVERED | DEAD                                     │
│  (emitted on every status transition)                                    │
└──────────────────────────────────────────────────────────────────────────┘
\`\`\`

## Flow summary

1. **Inbound Webhook** hits the ingestion endpoint.
2. **Ingestion Layer** validates and attempts immediate delivery to the target.
3. On failure, a dead letter record is persisted in SQLite with status `PENDING` and `next_retry_at`.
4. **Replay Engine** (scheduler or manual API) picks due entries, sets `RETRYING`, and re-invokes delivery.
5. **Target Endpoint** receives the replayed payload.
6. **Status Update** writes `DELIVERED` or re-queues with backoff; after max retries or TTL expiry, `DEAD`.

## Pipeline

\`\`\`
Inbound Webhook → Ingestion Layer → DLQ Store → Replay Engine → Target Endpoint → Status Update
\`\`\`

```

# package.json

```json
{
  "name": "webhook-dlq",
  "version": "1.0.0",
  "main": "index.js",
  "directories": {
    "doc": "docs"
  },
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/shashankmadala/webhook-dlq-replay-engine.git"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "bugs": {
    "url": "https://github.com/shashankmadala/webhook-dlq-replay-engine/issues"
  },
  "homepage": "https://github.com/shashankmadala/webhook-dlq-replay-engine#readme",
  "description": "",
  "dependencies": {
    "better-sqlite3": "^12.11.1",
    "fastify": "^5.8.5",
    "pino": "^10.3.1",
    "uuid": "^14.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^26.0.0",
    "@types/uuid": "^10.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}

```

# src/api/server.ts

```ts
import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import { db, getDeadLetters, getRecordById, insertRecord, updateStatus } from '../db/client';
import type { DeadLetterRecord, HttpHeaders, RetryBackoffConfig } from '../types';
import { webhookPayloadSchema } from '../validators/webhookPayload';

const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export function buildServer() {
  const server = Fastify({
    logger: true,
  });

  server.post('/webhooks/ingest', async (request, reply) => {
    const parsed = webhookPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        details: parsed.error.issues,
      });
    }

    const payload = parsed.data;
    const id = uuidv4();
    const now = new Date().toISOString();

    const record: DeadLetterRecord = {
      id,
      event: {
        id,
        targetUrl: payload.endpoint_url,
        method: payload.http_method,
        headers: payload.headers as HttpHeaders,
        body: JSON.stringify(payload.payload),
        receivedAt: now,
      },
      status: 'PENDING',
      attemptCount: 0,
      retryPolicy: payload.retry_policy,
      retryBackoff: DEFAULT_RETRY_BACKOFF,
      nextRetryAt: null,
      lastAttemptAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
    };

    insertRecord(record);

    return reply.status(202).send({
      id,
      status: 'PENDING',
    });
  });

  server.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/webhooks/dead-letters', async (request, reply) => {
    const rawLimit = request.query.limit;
    let limit = 50;

    if (rawLimit !== undefined) {
      const parsedLimit = Number.parseInt(rawLimit, 10);
      if (!Number.isNaN(parsedLimit)) {
        limit = Math.min(Math.max(parsedLimit, 1), 200);
      }
    }

    const records = getDeadLetters(request.query.cursor, limit);
    const nextCursor =
      records.length < limit ? null : (records[records.length - 1]?.id ?? null);

    return reply.send({
      records,
      nextCursor,
    });
  });

  server.post<{ Params: { id: string } }>(
    '/webhooks/replay/:id',
    async (request, reply) => {
      const record = getRecordById(request.params.id);

      if (!record) {
        return reply.status(404).send({ error: 'NOT_FOUND' });
      }

      updateStatus(record.id, 'RETRYING', {
        nextRetryAt: new Date().toISOString(),
      });

      return reply.send({
        id: record.id,
        status: 'RETRYING',
        message: 'Record queued for immediate replay',
      });
    },
  );

  server.get('/health', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();

      return reply.send({
        status: 'ok',
        uptime: process.uptime(),
        db: 'connected',
      });
    } catch {
      return reply.status(503).send({
        status: 'degraded',
        db: 'unreachable',
      });
    }
  });

  return server;
}

```

# src/db/client.ts

```ts
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

const DB_PATH = 'dlq.db';
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
    AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
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

export function getRecordById(id: string): DeadLetterRecord | null {
  const row = db
    .prepare('SELECT * FROM dead_letter_records WHERE id = ?')
    .get(id) as DbRow | undefined;

  if (!row) {
    return null;
  }

  return rowToRecord(row);
}

export { db };

```

# src/db/schema.sql

```sql
CREATE TABLE IF NOT EXISTS dead_letter_records (
  id TEXT PRIMARY KEY,
  endpoint_url TEXT NOT NULL,
  http_method TEXT NOT NULL,
  payload TEXT NOT NULL,
  headers TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  retry_policy TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  error_log TEXT
);
PRAGMA journal_mode=WAL;
CREATE INDEX IF NOT EXISTS idx_retry_queue
  ON dead_letter_records(status, next_retry_at);

```

# src/engine/backoff.ts

```ts
import type { RetryBackoffConfig, RetryPolicy } from '../types';

/** Unexported so tests can mock via `vi.spyOn` on this module's internals. */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Computes the delay before the next delivery attempt.
 *
 * @returns milliseconds to wait before next attempt,
 *          or -1 if the record should be marked DEAD
 */
export function calculateBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  backoff: RetryBackoffConfig,
): number {
  if (policy.kind === 'bounded' && attempt >= policy.maxAttempts) {
    return -1;
  }

  if (policy.kind === 'ttl' && Date.now() > policy.expiresAt.getTime()) {
    return -1;
  }

  const cappedDelay = Math.min(
    backoff.maxDelayMs,
    backoff.baseDelayMs * backoff.backoffMultiplier ** attempt,
  );
  const delay = randomBetween(0, cappedDelay);

  if (policy.kind === 'ttl') {
    if (Date.now() + delay > policy.expiresAt.getTime()) {
      return 0;
    }
  }

  return delay;
}

```

# src/engine/replayEngine.ts

```ts
import { getRetryQueue, updateStatus } from '../db/client';
import type { DeadLetterRecord, DeliveryError } from '../types';
import { calculateBackoffMs } from './backoff';

function buildDeliveryError(
  code: string,
  message: string,
  retryable: boolean,
  httpStatus?: number,
): DeliveryError {
  return {
    code,
    message,
    httpStatus,
    retryable,
    occurredAt: new Date().toISOString(),
  };
}

function headersToFetchInit(
  headers: DeadLetterRecord['event']['headers'],
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  return result;
}

function nextRetryAtFromDelayMs(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function nextRetryAtFromRetryAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export class ReplayEngine {
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly pollIntervalMs: number) {}

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this._processBatch();
    }, this.pollIntervalMs);
  }

  async _processBatch(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      const records = getRetryQueue(50);

      for (const record of records) {
        await this.processRecord(record);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  private async processRecord(record: DeadLetterRecord): Promise<void> {
    const now = new Date().toISOString();

    try {
      const response = await fetch(record.event.targetUrl, {
        method: record.event.method,
        headers: headersToFetchInit(record.event.headers),
        body: record.event.body,
      });

      if (response.status >= 200 && response.status < 300) {
        updateStatus(record.id, 'DELIVERED', {
          lastAttemptAt: now,
        });
        return;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterSeconds =
          retryAfter !== null && retryAfter !== '' && !Number.isNaN(Number(retryAfter))
            ? Number(retryAfter)
            : null;

        const nextRetryAt =
          retryAfterSeconds !== null
            ? nextRetryAtFromRetryAfterSeconds(retryAfterSeconds)
            : nextRetryAtFromDelayMs(
                calculateBackoffMs(
                  record.attemptCount,
                  record.retryPolicy,
                  record.retryBackoff,
                ),
              );

        updateStatus(record.id, 'RETRYING', {
          nextRetryAt,
          lastAttemptAt: now,
          lastError: buildDeliveryError(
            'RATE_LIMITED',
            `Target returned HTTP 429`,
            true,
            429,
          ),
        });
        return;
      }

      await this.handleFailure(
        record,
        now,
        buildDeliveryError(
          'HTTP_ERROR',
          `Target returned HTTP ${response.status}`,
          true,
          response.status,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed';

      await this.handleFailure(
        record,
        now,
        buildDeliveryError('NETWORK_ERROR', message, true),
      );
    }
  }

  private async handleFailure(
    record: DeadLetterRecord,
    now: string,
    lastError: DeliveryError,
  ): Promise<void> {
    const nextAttemptCount = record.attemptCount + 1;
    const delayMs = calculateBackoffMs(
      nextAttemptCount,
      record.retryPolicy,
      record.retryBackoff,
    );

    if (delayMs === -1) {
      updateStatus(record.id, 'DEAD', {
        lastError,
        lastAttemptAt: now,
      });
      return;
    }

    updateStatus(record.id, 'RETRYING', {
      attemptCount: nextAttemptCount,
      nextRetryAt: nextRetryAtFromDelayMs(delayMs),
      lastAttemptAt: now,
      lastError,
    });
  }
}

```

# src/index.ts

```ts
import { buildServer } from './api/server';
import { ReplayEngine } from './engine/replayEngine';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);

async function main(): Promise<void> {
  const server = buildServer();
  const engine = new ReplayEngine(POLL_INTERVAL_MS);

  await server.listen({ port: PORT, host: '0.0.0.0' });
  engine.start();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    engine.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main();

```

# src/types.ts

```ts
/** Unique identifier for a webhook event (UUID v4 or ULID). */
export type WebhookEventId = string;

/** Unique identifier for a dead letter record. */
export type DeadLetterRecordId = string;

/** ISO 8601 timestamp string. */
export type ISOTimestamp = string;

/** HTTP methods supported for webhook delivery. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Lifecycle status for a dead letter record.
 *
 * PENDING   — Failed delivery recorded; awaiting next retry window.
 * RETRYING  — Replay in progress (delivery attempt underway).
 * DELIVERED — Successfully delivered to target endpoint.
 * DEAD      — Permanently failed; bounded max attempts exhausted,
 *             TTL expired, or non-retryable error.
 */
export type DLQStatus = 'PENDING' | 'RETRYING' | 'DELIVERED' | 'DEAD';

/** Structured error captured from a failed delivery attempt. */
export interface DeliveryError {
  code: string;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  occurredAt: ISOTimestamp;
}

/** HTTP headers as key-value pairs (values may be string or string[]). */
export type HttpHeaders = Record<string, string | string[]>;

/**
 * The original inbound webhook event.
 * Immutable payload stored for replay.
 */
export interface WebhookEvent {
  id: WebhookEventId;
  targetUrl: string;
  method: HttpMethod;
  headers: HttpHeaders;
  body: string;
  contentType?: string;
  receivedAt: ISOTimestamp;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Discriminated union defining when retries must stop.
 *
 * bounded — Retry up to a fixed number of delivery attempts.
 * ttl     — Retry indefinitely until the expiry timestamp is reached.
 */
export type RetryPolicy =
  | { kind: 'bounded'; maxAttempts: number }
  | { kind: 'ttl'; expiresAt: Date };

/** Backoff and jitter settings applied alongside a retry policy. */
export interface RetryBackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
  nonRetryableStatusCodes?: number[];
  nonRetryableErrorCodes?: string[];
}

/**
 * A persisted dead letter record representing a failed delivery
 * and its retry state.
 */
export interface DeadLetterRecord {
  id: DeadLetterRecordId;
  event: WebhookEvent;
  status: DLQStatus;
  attemptCount: number;
  retryPolicy: RetryPolicy;
  retryBackoff: RetryBackoffConfig;
  nextRetryAt: ISOTimestamp | null;
  lastAttemptAt: ISOTimestamp | null;
  lastError: DeliveryError | null;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
  finalizedAt: ISOTimestamp | null;
}

/** Trigger for a replay operation. */
export type ReplayTrigger = 'manual' | 'scheduler';

/** Outcome of a single replay/delivery attempt. */
export type ReplayOutcome = 'delivered' | 'requeued' | 'dead';

/**
 * Result returned by the replay engine after attempting delivery.
 */
export interface ReplayResult {
  recordId: DeadLetterRecordId;
  eventId: WebhookEventId;
  trigger: ReplayTrigger;
  outcome: ReplayOutcome;
  status: DLQStatus;
  attemptNumber: number;
  httpStatus?: number;
  error?: DeliveryError;
  nextRetryAt?: ISOTimestamp;
  durationMs: number;
  completedAt: ISOTimestamp;
}

/** Lifecycle event emitted on status transitions (for logging/observability). */
export interface StatusLifecycleEvent {
  recordId: DeadLetterRecordId;
  eventId: WebhookEventId;
  from: DLQStatus;
  to: DLQStatus;
  attemptCount: number;
  timestamp: ISOTimestamp;
  metadata?: Record<string, unknown>;
}

```

# src/validators/webhookPayload.ts

```ts
import { z } from 'zod';

import type { RetryPolicy } from '../types';

const boundedRetryPolicySchema = z.object({
  kind: z.literal('bounded'),
  maxAttempts: z.number().int().positive(),
});

const ttlRetryPolicySchema = z.object({
  kind: z.literal('ttl'),
  expiresAt: z.coerce.date(),
});

export const retryPolicySchema: z.ZodType<RetryPolicy> = z.discriminatedUnion(
  'kind',
  [boundedRetryPolicySchema, ttlRetryPolicySchema],
);

export const webhookPayloadSchema = z.object({
  endpoint_url: z.string().min(1).url(),
  http_method: z.enum(['POST', 'PUT', 'PATCH']),
  payload: z.object({}).passthrough(),
  headers: z.object({}).passthrough().optional().default({}),
  retry_policy: retryPolicySchema,
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

```

# tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "CommonJS",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}

```

