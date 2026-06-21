import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import {
  db,
  getBulkReplayTargets,
  getDeadLetters,
  getMetrics,
  getRecordById,
  insertRecord,
  listRecords,
  requeueRecordForReplay,
} from '../db/client';
import { staleClaimCutoff } from '../engine/claiming';
import type {
  DeadLetterRecord,
  DLQStatus,
  HttpHeaders,
  RetryBackoffConfig,
} from '../types';
import { webhookPayloadSchema } from '../validators/webhookPayload';
import { isSafeUrl } from '../security/ssrfGuard';

const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

const VALID_STATUSES: DLQStatus[] = [
  'PENDING',
  'RETRYING',
  'DELIVERED',
  'DEAD',
];

function isValidIso8601(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

function parsePageLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) {
    return 50;
  }

  const parsedLimit = Number.parseInt(rawLimit, 10);
  if (Number.isNaN(parsedLimit)) {
    return 50;
  }

  return Math.min(Math.max(parsedLimit, 1), 200);
}

export function buildServer() {
  const server = Fastify({
    logger: true,
  });

  server.removeContentTypeParser('application/json');
  server.removeContentTypeParser('text/plain');
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  server.addContentTypeParser('*', (_request, _payload, done) => {
    const error = new Error('Unsupported Media Type') as Error & {
      statusCode: number;
    };
    error.statusCode = 415;
    done(error, undefined);
  });

  server.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode === 415) {
      return reply.status(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    request.log.error(error);
    return reply.status(err.statusCode ?? 500).send({
      error: err.message ?? 'Internal Server Error',
    });
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

    const payloadSize = Buffer.byteLength(JSON.stringify(parsed.data.payload));
    if (payloadSize > 512 * 1024) {
      return reply.status(413).send({
        error: 'PAYLOAD_TOO_LARGE',
        maxBytes: 512 * 1024,
      });
    }

    if (!(await isSafeUrl(parsed.data.endpoint_url))) {
      return reply.status(400).send({
        error: 'SSRF_BLOCKED_URL',
        message: 'The endpoint URL resolves to a blocked IP range',
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
    const limit = parsePageLimit(request.query.limit);
    const records = getDeadLetters(request.query.cursor, limit);
    const nextCursor =
      records.length < limit ? null : (records[records.length - 1]?.id ?? null);

    return reply.send({
      records,
      nextCursor,
    });
  });

  server.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      status?: DLQStatus;
      endpoint_url?: string;
      created_after?: string;
      created_before?: string;
    };
  }>('/webhooks/records', async (request, reply) => {
    const { status, endpoint_url, created_after, created_before, cursor } =
      request.query;

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        details: [{ message: 'Invalid status value' }],
      });
    }

    if (created_after !== undefined && !isValidIso8601(created_after)) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        details: [{ message: 'created_after must be a valid ISO 8601 timestamp' }],
      });
    }

    if (created_before !== undefined && !isValidIso8601(created_before)) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        details: [{ message: 'created_before must be a valid ISO 8601 timestamp' }],
      });
    }

    const limit = parsePageLimit(request.query.limit);
    const records = listRecords({
      status,
      endpointUrl: endpoint_url,
      createdAfter: created_after,
      createdBefore: created_before,
      cursor,
      limit,
    });

    const nextCursor =
      records.length < limit ? null : (records[records.length - 1]?.id ?? null);

    return reply.send({
      records,
      nextCursor,
    });
  });

  server.post<{
    Body: {
      filter?: {
        status?: DLQStatus;
        endpoint_url?: string;
      };
      limit?: number;
    };
  }>('/webhooks/replay/bulk', async (request, reply) => {
    const filter = request.body?.filter ?? {};
    const status = filter.status ?? 'DEAD';
    const endpointUrl = filter.endpoint_url;

    let limit = request.body?.limit ?? 50;
    if (typeof limit !== 'number' || Number.isNaN(limit)) {
      limit = 50;
    } else {
      limit = Math.min(Math.max(limit, 1), 200);
    }

    const records = getBulkReplayTargets(status, endpointUrl, limit);
    const ids: string[] = [];

    for (const record of records) {
      if (requeueRecordForReplay(record.id, staleClaimCutoff())) {
        ids.push(record.id);
      }
    }

    return reply.send({
      requeued: ids.length,
      ids,
    });
  });

  server.post<{ Params: { id: string } }>(
    '/webhooks/replay/:id',
    async (request, reply) => {
      const record = getRecordById(request.params.id);

      if (!record) {
        return reply.status(404).send({ error: 'NOT_FOUND' });
      }

      const requeued = requeueRecordForReplay(record.id, staleClaimCutoff());

      return reply.send({
        id: record.id,
        status: requeued ? 'PENDING' : record.status,
        message: requeued
          ? 'Record queued for immediate replay'
          : 'Record already has an active replay claim',
        requeued,
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
