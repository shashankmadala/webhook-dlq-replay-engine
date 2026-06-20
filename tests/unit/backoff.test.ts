import { describe, it, expect, vi } from 'vitest';

import { calculateBackoffMs } from '../../src/engine/backoff';
import type { RetryBackoffConfig } from '../../src/types';

const backoff: RetryBackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

const defaultBackoff: RetryBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

describe('calculateBackoffMs', () => {
  describe('bounded policy', () => {
    const policy = { kind: 'bounded' as const, maxAttempts: 3 };

    it('attempt 0, maxAttempts 3 → result >= 0 and <= 5000', () => {
      const result = calculateBackoffMs(0, policy, backoff);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(5000);
    });

    it('attempt 1, maxAttempts 3 → result >= 0 and <= 5000', () => {
      const result = calculateBackoffMs(1, policy, backoff);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(5000);
    });

    it('attempt 2, maxAttempts 3 → result >= 0 and <= 5000', () => {
      const result = calculateBackoffMs(2, policy, backoff);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(5000);
    });

    it('attempt 3, maxAttempts 3 → result === -1 (DEAD sentinel)', () => {
      expect(calculateBackoffMs(3, policy, backoff)).toBe(-1);
    });

    it('attempt 5, maxAttempts 3 → result === -1', () => {
      expect(calculateBackoffMs(5, policy, backoff)).toBe(-1);
    });

    it('attempt 0, maxAttempts 1 → result >= 0 (first attempt allowed)', () => {
      const result = calculateBackoffMs(
        0,
        { kind: 'bounded', maxAttempts: 1 },
        backoff,
      );
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('attempt 1, maxAttempts 1 → result === -1', () => {
      expect(
        calculateBackoffMs(1, { kind: 'bounded', maxAttempts: 1 }, backoff),
      ).toBe(-1);
    });
  });

  describe('ttl policy', () => {
    it('expiresAt = Date.now() - 1 (already expired) → result === -1', () => {
      const result = calculateBackoffMs(
        0,
        { kind: 'ttl', expiresAt: new Date(Date.now() - 1) },
        backoff,
      );
      expect(result).toBe(-1);
    });

    it('expiresAt = Date.now() + 100000 (far future) → result >= 0', () => {
      const result = calculateBackoffMs(
        0,
        { kind: 'ttl', expiresAt: new Date(Date.now() + 100_000) },
        backoff,
      );
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('deterministic snapshot', () => {
    it('locks the backoff curve for attempts 0-6 with bounded maxAttempts 10', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const policy = { kind: 'bounded' as const, maxAttempts: 10 };

      const results = Array.from({ length: 7 }, (_, attempt) =>
        calculateBackoffMs(attempt, policy, defaultBackoff),
      );

      expect(results).toMatchSnapshot();
      randomSpy.mockRestore();
    });
  });
});
