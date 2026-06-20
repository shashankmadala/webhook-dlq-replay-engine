# Roadmap

## v1.1 — Observability
- [ ] OpenTelemetry trace spans on every delivery attempt
- [ ] Prometheus metrics endpoint (/metrics/prometheus)
- [ ] Alert webhook when dead_rate_pct exceeds threshold

## v1.2 — Resilience  
- [ ] Circuit breaker per endpoint_url (stop retrying after N consecutive failures)
- [ ] Idempotency key deduplication on ingestion
- [ ] Configurable non-retryable HTTP status codes per record

## v1.3 — Scale
- [ ] Migrate to Postgres for multi-node deployment
- [ ] Redis-backed distributed lock for replay engine coordination
- [ ] Webhook signature verification (HMAC-SHA256)
