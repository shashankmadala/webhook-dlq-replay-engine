import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../src/engine/circuitBreaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    const breaker = new CircuitBreaker();

    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canRequest()).toBe(true);
  });

  it('opens after failureThreshold failures', () => {
    const breaker = new CircuitBreaker(3, 60_000, 2);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('returns false from canRequest() when OPEN within recovery window', () => {
    const breaker = new CircuitBreaker(2, 1_000, 2);

    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canRequest()).toBe(false);
  });

  it('transitions to HALF_OPEN after recoveryTimeMs elapses', () => {
    const breaker = new CircuitBreaker(2, 1_000, 2);

    breaker.recordFailure();
    breaker.recordFailure();

    vi.advanceTimersByTime(999);
    expect(breaker.canRequest()).toBe(false);
    expect(breaker.getState()).toBe('OPEN');

    vi.advanceTimersByTime(1);
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('closes after halfOpenSuccessThreshold successes in HALF_OPEN', () => {
    const breaker = new CircuitBreaker(2, 1_000, 2);

    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(1_000);

    expect(breaker.canRequest()).toBe(true);
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canRequest()).toBe(true);
  });

  it('resets failureCount on recordSuccess() while CLOSED', () => {
    const breaker = new CircuitBreaker(3, 1_000, 2);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });
});
