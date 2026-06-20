# Webhook DLQ Replay Engine — Data Flow

```
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
```

## Flow summary

1. **Inbound Webhook** hits the ingestion endpoint.
2. **Ingestion Layer** validates and attempts immediate delivery to the target.
3. On failure, a dead letter record is persisted in SQLite with status `PENDING` and `next_retry_at`.
4. **Replay Engine** (scheduler or manual API) picks due entries, sets `RETRYING`, and re-invokes delivery.
5. **Target Endpoint** receives the replayed payload.
6. **Status Update** writes `DELIVERED` or re-queues with backoff; after max retries or TTL expiry, `DEAD`.

## Pipeline

```
Inbound Webhook → Ingestion Layer → DLQ Store → Replay Engine → Target Endpoint → Status Update
```
