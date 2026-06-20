# Engineering Decisions & Bug Log

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
