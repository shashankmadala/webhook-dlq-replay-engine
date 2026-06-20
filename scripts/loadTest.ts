/// <reference types="node" />

const COUNT = Number.parseInt(process.env.COUNT ?? '50', 10);
const BASE_URL = `http://localhost:${process.env.PORT ?? '3000'}`;
const TARGET_URL = 'http://localhost:9999/dead';
const METRICS_POLL_MS = 2_000;

interface MetricsResponse {
  summary: {
    total: number;
    pending: number;
    retrying: number;
    delivered: number;
    dead: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ingestOne(index: number): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/webhooks/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint_url: TARGET_URL,
        http_method: 'POST',
        payload: { loadTest: true, index },
        retry_policy: { kind: 'bounded', maxAttempts: 2 },
      }),
    });

    return response.status === 202;
  } catch {
    return false;
  }
}

async function fetchMetrics(): Promise<MetricsResponse> {
  const response = await fetch(`${BASE_URL}/metrics`);

  if (!response.ok) {
    throw new Error(`GET /metrics failed with status ${response.status}`);
  }

  return response.json() as Promise<MetricsResponse>;
}

async function main(): Promise<void> {
  const start = Date.now();

  const results = await Promise.all(
    Array.from({ length: COUNT }, (_, index) => ingestOne(index)),
  );

  const succeeded = results.filter(Boolean).length;
  const failed = results.length - succeeded;
  const durationMs = Date.now() - start;
  const rps = durationMs > 0 ? (COUNT / durationMs) * 1000 : COUNT;

  console.log(`Ingested: ${succeeded} succeeded, ${failed} failed`);
  console.log(`Duration: ${durationMs}ms`);
  console.log(`RPS: ${rps.toFixed(1)} requests/second`);

  let metrics = await fetchMetrics();

  while (metrics.summary.pending + metrics.summary.retrying > 0) {
    await sleep(METRICS_POLL_MS);
    metrics = await fetchMetrics();
  }

  const { summary } = metrics;

  console.log('Final metrics:');
  console.log(`  total: ${summary.total}`);
  console.log(`  pending: ${summary.pending}`);
  console.log(`  retrying: ${summary.retrying}`);
  console.log(`  delivered: ${summary.delivered}`);
  console.log(`  dead: ${summary.dead}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
