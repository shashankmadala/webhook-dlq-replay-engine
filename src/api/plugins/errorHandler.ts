import type { FastifyInstance } from 'fastify';

export function errorHandler(server: FastifyInstance): void {
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
}
