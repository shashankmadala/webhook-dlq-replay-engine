import { randomUUID } from 'node:crypto';

import pino from 'pino';

import { claimDueRecords, updateClaimedStatus } from '../db/client';
import { assertSafeUrl, SsrfBlockedError } from '../security/ssrfGuard';
import type { DeadLetterRecord, DeliveryError, DLQStatus } from '../types';
import { calculateBackoffMs } from './backoff';
import { CircuitBreaker } from './circuitBreaker';
import { staleClaimCutoff } from './claiming';

const logger = pino({ name: 'replay-engine' });
const CIRCUIT_OPEN_RETRY_DELAY_MS = 60_000;

function buildDeliveryError(
  code: string,
  message: string,
  retryable: boolean,
  httpStatus?: number,
): DeliveryError {
  return {
    code,
    message,
    httpStatus,
    retryable,
    occurredAt: new Date().toISOString(),
  };
}

function headersToFetchInit(
  headers: DeadLetterRecord['event']['headers'],
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  return result;
}

function nextRetryAtFromDelayMs(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function nextRetryAtFromRetryAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function nextRetryAtFromCircuitOpen(): string {
  return new Date(Date.now() + CIRCUIT_OPEN_RETRY_DELAY_MS).toISOString();
}

export class ReplayEngine {
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly pollIntervalMs: number) {}

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this._processBatch();
    }, this.pollIntervalMs);
  }

  async _processBatch(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    const claimToken = randomUUID();

    try {
      const records = claimDueRecords(50, claimToken, staleClaimCutoff());

      for (const record of records) {
        await this.processRecord(record, claimToken);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  private logTransition(
    record: DeadLetterRecord,
    from: DLQStatus,
    to: DLQStatus,
    meta?: Record<string, unknown>,
  ): void {
    logger.info({
      event: 'dlq.status_transition',
      recordId: record.id,
      targetUrl: record.event.targetUrl,
      from,
      to,
      attemptCount: record.attemptCount,
      timestamp: new Date().toISOString(),
      ...meta,
    });
  }

  private getBreaker(url: string): CircuitBreaker {
    let breaker = this.breakers.get(url);

    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(url, breaker);
    }

    return breaker;
  }

  private updateClaimedRecord(
    record: DeadLetterRecord,
    claimToken: string,
    status: DLQStatus,
    patch?: Partial<DeadLetterRecord>,
  ): void {
    const updated = updateClaimedStatus(record.id, claimToken, status, patch);

    if (!updated) {
      logger.warn({
        event: 'dlq.claim_completion_lost',
        recordId: record.id,
        targetUrl: record.event.targetUrl,
        status,
      });
    }
  }

  private async processRecord(
    record: DeadLetterRecord,
    claimToken: string,
  ): Promise<void> {
    const url = record.event.targetUrl;
    const now = new Date().toISOString();

    try {
      await assertSafeUrl(url);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        logger.info({
          event: 'dlq.egress_blocked',
          recordId: record.id,
          targetUrl: url,
        });
        this.logTransition(record, record.status, 'DEAD', {
          errorCode: 'SSRF_BLOCKED',
        });
        this.updateClaimedRecord(record, claimToken, 'DEAD', {
          lastError: buildDeliveryError(
            'SSRF_BLOCKED',
            'The endpoint URL resolves to a blocked IP range',
            false,
          ),
          lastAttemptAt: now,
        });
        return;
      }

      throw error;
    }

    const breaker = this.getBreaker(url);

    if (!breaker.canRequest()) {
      logger.info({
        event: 'dlq.circuit_open',
        recordId: record.id,
        targetUrl: url,
      });
      this.updateClaimedRecord(record, claimToken, record.status, {
        nextRetryAt: nextRetryAtFromCircuitOpen(),
      });
      return;
    }

    try {
      const response = await fetch(record.event.targetUrl, {
        method: record.event.method,
        headers: headersToFetchInit(record.event.headers),
        body: record.event.body,
      });

      if (response.status >= 200 && response.status < 300) {
        breaker.recordSuccess();
        this.logTransition(record, record.status, 'DELIVERED');
        this.updateClaimedRecord(record, claimToken, 'DELIVERED', {
          lastAttemptAt: now,
        });
        return;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterSeconds =
          retryAfter !== null && !Number.isNaN(Number(retryAfter))
            ? Number(retryAfter)
            : null;

        await this.handleFailure(
          record,
          claimToken,
          now,
          buildDeliveryError('RATE_LIMITED', 'Target returned HTTP 429', true, 429),
          retryAfterSeconds !== null
            ? nextRetryAtFromRetryAfterSeconds(retryAfterSeconds)
            : undefined,
        );
        breaker.recordFailure();
        return;
      }

      await this.handleFailure(
        record,
        claimToken,
        now,
        buildDeliveryError(
          'HTTP_ERROR',
          `Target returned HTTP ${response.status}`,
          true,
          response.status,
        ),
      );
      breaker.recordFailure();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed';

      await this.handleFailure(
        record,
        claimToken,
        now,
        buildDeliveryError('NETWORK_ERROR', message, true),
      );
      breaker.recordFailure();
    }
  }

  private async handleFailure(
    record: DeadLetterRecord,
    claimToken: string,
    now: string,
    lastError: DeliveryError,
    nextRetryAtOverride?: string,
  ): Promise<void> {
    const nextAttemptCount = record.attemptCount + 1;
    const delayMs = calculateBackoffMs(
      nextAttemptCount,
      record.retryPolicy,
      record.retryBackoff,
    );

    if (delayMs === -1) {
      this.logTransition(record, record.status, 'DEAD', {
        errorCode: lastError.code,
      });
      this.updateClaimedRecord(record, claimToken, 'DEAD', {
        lastError,
        lastAttemptAt: now,
      });
      return;
    }

    const nextRetryAt = nextRetryAtOverride ?? nextRetryAtFromDelayMs(delayMs);
    this.logTransition(record, record.status, 'RETRYING', { nextRetryAt });
    this.updateClaimedRecord(record, claimToken, 'RETRYING', {
      attemptCount: nextAttemptCount,
      nextRetryAt,
      lastAttemptAt: now,
      lastError,
    });
  }
}
