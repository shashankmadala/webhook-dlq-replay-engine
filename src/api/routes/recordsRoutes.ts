import type { FastifyPluginCallback } from 'fastify';

import { getDeadLetters, listRecords } from '../../db/client';
import type { DLQStatus } from '../../types';

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

export const recordsRoutes: FastifyPluginCallback = (server, _opts, done) => {
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

  done();
};
