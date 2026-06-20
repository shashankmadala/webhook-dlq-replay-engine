import type { RetryBackoffConfig, RetryPolicy } from '../types';

/** Unexported so tests can mock via `vi.spyOn` on this module's internals. */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Computes the delay before the next delivery attempt.
 *
 * @returns milliseconds to wait before next attempt,
 *          or -1 if the record should be marked DEAD
 */
export function calculateBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  backoff: RetryBackoffConfig,
): number {
  if (policy.kind === 'bounded' && attempt >= policy.maxAttempts) {
    return -1;
  }

  if (policy.kind === 'ttl' && Date.now() > policy.expiresAt.getTime()) {
    return -1;
  }

  const cappedDelay = Math.min(
    backoff.maxDelayMs,
    backoff.baseDelayMs * backoff.backoffMultiplier ** attempt,
  );
  const delay = randomBetween(0, cappedDelay);

  if (policy.kind === 'ttl') {
    if (Date.now() + delay > policy.expiresAt.getTime()) {
      return 0;
    }
  }

  return delay;
}
