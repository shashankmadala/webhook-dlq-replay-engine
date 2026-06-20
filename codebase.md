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

