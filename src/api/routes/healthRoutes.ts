import type { FastifyPluginCallback } from 'fastify';

import { db } from '../../db/client';

export const healthRoutes: FastifyPluginCallback = (server, _opts, done) => {
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

  done();
};
