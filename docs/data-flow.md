# Webhook DLQ Replay Engine — Data Flow

```
                                    ┌─────────────────────────────────────────────────────────┐
                                    │                    EXTERNAL SYSTEMS                      │
                                    └─────────────────────────────────────────────────────────┘
                                                              │
  Failed Webhook                                              │
  (POST /webhooks/ingest)                                     ▼
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
│  • SSRF check    │                                          │
│  • Persist       │                                          │
│    PENDING       │                                          │
│  • Return 202    │                                          │
└────────┬─────────┘                                          │
         │                                                    │
         │ durable record                                     │
         │ status: PENDING                                    │
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
         │ scheduler/manual replay                            │
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

1. **Failed Webhook** is submitted to `POST /webhooks/ingest`.
2. **Ingestion Layer** validates the payload, checks SSRF safety for the target URL, persists a SQLite DLQ record with status `PENDING`, and returns `202`.
3. **Replay Engine** later picks eligible records through the scheduler or manual replay APIs.
4. **Delivery Service** sends the persisted payload to the target endpoint during replay.
5. **Status Update** writes `DELIVERED` on 2xx, re-queues with backoff on retryable failure, or writes `DEAD` after max retries, TTL expiry, or non-retryable safety failure.

## Pipeline

```
Failed Webhook → Ingestion Layer → DLQ Store → Replay Engine → Target Endpoint → Status Update
```
