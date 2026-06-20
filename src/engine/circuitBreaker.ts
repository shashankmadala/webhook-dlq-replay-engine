export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureAt: number | null = null;
  private successCount = 0;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly recoveryTimeMs: number = 60_000,
    private readonly halfOpenSuccessThreshold: number = 2,
  ) {}

  canRequest(): boolean {
    if (this.state === 'OPEN') {
      if (this.lastFailureAt === null) {
        return false;
      }

      if (Date.now() - this.lastFailureAt < this.recoveryTimeMs) {
        return false;
      }

      this.state = 'HALF_OPEN';
      this.successCount = 0;
      return true;
    }

    return true;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount += 1;

      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureAt = null;
      }

      return;
    }

    if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount += 1;

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.lastFailureAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
