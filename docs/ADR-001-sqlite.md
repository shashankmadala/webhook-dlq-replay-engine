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
