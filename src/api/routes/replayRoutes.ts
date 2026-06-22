import type { FastifyPluginCallback } from 'fastify';

import {
  getBulkReplayTargets,
  getRecordById,
  requeueRecordForReplay,
} from '../../db/client';
import { staleClaimCutoff } from '../../engine/claiming';
import type { DLQStatus } from '../../types';

export const replayRoutes: FastifyPluginCallback = (server, _opts, done) => {
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

  done();
};
