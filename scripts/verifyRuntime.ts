/// <reference types="node" />

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface MetricsResponse {
  summary?: {
    total?: unknown;
    pending?: unknown;
    retrying?: unknown;
    delivered?: unknown;
    dead?: unknown;
  };
  uptime_seconds?: unknown;
}

function assertStatus(response: Response, pathName: string): void {
  if (response.status !== 200) {
    throw new Error(`GET ${pathName} returned ${response.status}`);
  }
}

function assertNumber(value: unknown, field: string): void {
  if (typeof value !== 'number') {
    throw new Error(`Expected metrics field ${field} to be a number`);
  }
}

function assertMetricsShape(metrics: MetricsResponse): void {
  assertNumber(metrics.summary?.total, 'summary.total');
  assertNumber(metrics.summary?.pending, 'summary.pending');
  assertNumber(metrics.summary?.retrying, 'summary.retrying');
  assertNumber(metrics.summary?.delivered, 'summary.delivered');
  assertNumber(metrics.summary?.dead, 'summary.dead');
  assertNumber(metrics.uptime_seconds, 'uptime_seconds');
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-dlq-runtime-'));
  const dbPath = path.join(tempDir, 'dlq.db');
  process.env.DB_PATH = dbPath;

  const { buildServer } = await import('../src/api/server');
  const server = buildServer();

  try {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('Unable to determine runtime verification server address');
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/health`);
    assertStatus(healthResponse, '/health');

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    assertStatus(metricsResponse, '/metrics');
    assertMetricsShape((await metricsResponse.json()) as MetricsResponse);

    console.log(`Runtime verification passed at ${baseUrl}`);
  } finally {
    await server.close();
    await removeIfExists(dbPath);
    await removeIfExists(`${dbPath}-shm`);
    await removeIfExists(`${dbPath}-wal`);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
