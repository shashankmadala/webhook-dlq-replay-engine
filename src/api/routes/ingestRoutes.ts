import type { FastifyPluginCallback } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import { insertRecord } from '../../db/client';
import { isSafeUrl } from '../../security/ssrfGuard';
import type {
  DeadLetterRecord,
  HttpHeaders,
  RetryBackoffConfig,
} from '../../types';
import { webhookPayloadSchema } from '../../validators/webhookPayload';

const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export const ingestRoutes: FastifyPluginCallback = (server, _opts, done) => {
  server.post(
    '/webhooks/ingest',
    {
      onRequest(request, reply, hookDone) {
        const log = request.log.child({ requestId: uuidv4() });
        request.log = log;
        reply.log = log;
        hookDone();
      },
    },
    async (request, reply) => {
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
    },
  );

  done();
};
