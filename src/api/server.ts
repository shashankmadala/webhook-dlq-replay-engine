import Fastify from 'fastify';

import { contentTypeGuard } from './plugins/contentTypeGuard';
import { errorHandler } from './plugins/errorHandler';
import { healthRoutes } from './routes/healthRoutes';
import { ingestRoutes } from './routes/ingestRoutes';
import { metricsRoutes } from './routes/metricsRoutes';
import { recordsRoutes } from './routes/recordsRoutes';
import { replayRoutes } from './routes/replayRoutes';

export function buildServer() {
  const server = Fastify({
    logger: true,
  });

  contentTypeGuard(server);
  errorHandler(server);

  server.register(ingestRoutes);
  server.register(recordsRoutes);
  server.register(replayRoutes);
  server.register(metricsRoutes);
  server.register(healthRoutes);

  return server;
}
