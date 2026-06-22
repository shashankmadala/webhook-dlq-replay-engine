import type { FastifyPluginCallback } from 'fastify';

import { getMetrics } from '../../db/client';

export const metricsRoutes: FastifyPluginCallback = (server, _opts, done) => {
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

  done();
};
