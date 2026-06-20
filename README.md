# Webhook DLQ Replay Engine

A production-grade Dead Letter Queue replay engine for failed webhook deliveries.

## Architecture
- **Ingestion**: Fastify HTTP API with Zod validation
- **Storage**: SQLite with WAL mode and composite index on (status, next_retry_at)
- **Retry**: Exponential backoff with full jitter, bounded and TTL policies
- **Engine**: Recursive setTimeout polling loop with concurrent batch guard

## Quick Start
npm install
npx ts-node src/index.ts

## API
POST /webhooks/ingest       — ingest a failed webhook
GET  /webhooks/dead-letters — list dead records (cursor paginated)
POST /webhooks/replay/:id   — manually trigger replay
GET  /health                — liveness + DB connectivity probe

## Test
npm test
npm run test:coverage
