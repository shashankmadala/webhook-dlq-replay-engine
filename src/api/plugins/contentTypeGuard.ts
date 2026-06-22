import type { FastifyInstance } from 'fastify';

export function contentTypeGuard(server: FastifyInstance): void {
  server.removeContentTypeParser('application/json');
  server.removeContentTypeParser('text/plain');
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, parserDone) => {
      try {
        parserDone(null, JSON.parse(body as string));
      } catch (error) {
        parserDone(error as Error, undefined);
      }
    },
  );
  server.addContentTypeParser('*', (_request, _payload, parserDone) => {
    const error = new Error('Unsupported Media Type') as Error & {
      statusCode: number;
    };
    error.statusCode = 415;
    parserDone(error, undefined);
  });
}
