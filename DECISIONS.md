# Engineering Decisions & Bug Log

## Architecture Invariants

- Async ingestion is intentional: `POST /webhooks/ingest` validates, checks SSRF safety, persists a `PENDING` record, and returns `202`; replay delivery happens later through the scheduler or manual replay APIs.
- Do not introduce `/admin/*` routes unless authentication and authorization exist; route names imply product and security semantics.
- Replay completion requires claim ownership. A worker must not mark a record `DELIVERED`, `DEAD`, or requeued unless it owns the active claim token.
- Stale claim recovery is part of replay safety. It prevents abandoned `RETRYING` records from being stuck forever while still protecting active claims from being stolen.
- SQLite timestamp comparisons must use the same ISO timestamp format stored in the database.
- Security-sensitive Node/runtime assumptions, including SSRF behavior, must be runtime-verified instead of only typechecked.
- `/metrics` is JSON only. `/metrics/prometheus` is not implemented until a route and tests exist.
- Runtime mismatches must be explicitly accepted, deferred, or fixed before moving on.
- Every endpoint behavior change must include at least one negative or failure-case test.
- The primary quality gates are `npm run verify`, `npm run verify:full`, and CI.

## Bug 1: Replay engine fired only once
scheduleNext() was called once from start() but never recursively.
Fix: moved scheduleNext() into the finally block of _processBatch().

## Bug 2: Records never reached DEAD status
calculateBackoffMs() received pre-increment attemptCount so the
bounded policy ceiling check (attempt >= maxAttempts) never fired.
Fix: pass attemptCount + 1 to calculateBackoffMs() in handleFailure().

## Bug 3: SQLite datetime format mismatch
next_retry_at stored as ISO 8601 ("2026-06-20T07:31:13.427Z") but
datetime('now') returns "2026-06-20 07:31:13" — lexicographic
comparison always failed so records were never picked up after first retry.
Fix: use strftime('%Y-%m-%dT%H:%M:%SZ', 'now') in the WHERE clause.

## Bug 4: 429 responses bypassed attempt ceiling
The 429 branch called updateStatus() directly without incrementing
attemptCount or checking the retry policy ceiling — records could
retry forever on rate-limited endpoints.
Fix: route 429 through handleFailure() with Retry-After override.
