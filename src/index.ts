import { buildServer } from './api/server';
import { ReplayEngine } from './engine/replayEngine';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);

async function main(): Promise<void> {
  const server = buildServer();
  const engine = new ReplayEngine(POLL_INTERVAL_MS);

  await server.listen({ port: PORT, host: '0.0.0.0' });
  engine.start();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    engine.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main();
