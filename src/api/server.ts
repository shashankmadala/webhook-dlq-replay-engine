import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import {
  db,
  getDeadLetters,
  getMetrics,
  getRecordById,
  insertRecord,
  updateStatus,
} from '../db/client';
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

  server.post('/webhooks/ingest', {
    onRequest(request, reply, done) {
      const log = request.log.child({ requestId: uuidv4() });
      request.log = log;
      reply.log = log;
      done();
    },
  }, async (request, reply) => {
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

  server.get('/metrics', async (_request, reply) => {
    const { summary, oldest_pending_at } = getMetrics();
    const dead_rate_pct =
      summary.total > 0
        ? Math.round((summary.dead / summary.total) * 1000) / 10
        : 0;

    return reply.send({
      summary,
      oldest_pending_at,
      dead_rate_pct,
      uptime_seconds: process.uptime(),
    });
  });

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
