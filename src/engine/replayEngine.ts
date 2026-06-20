import { getRetryQueue, updateStatus } from '../db/client';
import type { DeadLetterRecord, DeliveryError } from '../types';
import { calculateBackoffMs } from './backoff';

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

export class ReplayEngine {
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

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

    try {
      const records = getRetryQueue(50);

      for (const record of records) {
        await this.processRecord(record);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  private async processRecord(record: DeadLetterRecord): Promise<void> {
    const now = new Date().toISOString();

    try {
      const response = await fetch(record.event.targetUrl, {
        method: record.event.method,
        headers: headersToFetchInit(record.event.headers),
        body: record.event.body,
      });

      if (response.status >= 200 && response.status < 300) {
        updateStatus(record.id, 'DELIVERED', {
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
          now,
          buildDeliveryError('RATE_LIMITED', 'Target returned HTTP 429', true, 429),
        );

        if (retryAfterSeconds !== null) {
          updateStatus(record.id, 'RETRYING', {
            nextRetryAt: nextRetryAtFromRetryAfterSeconds(retryAfterSeconds),
          });
        }
        return;
      }

      await this.handleFailure(
        record,
        now,
        buildDeliveryError(
          'HTTP_ERROR',
          `Target returned HTTP ${response.status}`,
          true,
          response.status,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed';

      await this.handleFailure(
        record,
        now,
        buildDeliveryError('NETWORK_ERROR', message, true),
      );
    }
  }

  private async handleFailure(
    record: DeadLetterRecord,
    now: string,
    lastError: DeliveryError,
  ): Promise<void> {
    const nextAttemptCount = record.attemptCount + 1;
    const delayMs = calculateBackoffMs(
      nextAttemptCount,
      record.retryPolicy,
      record.retryBackoff,
    );

    if (delayMs === -1) {
      updateStatus(record.id, 'DEAD', {
        lastError,
        lastAttemptAt: now,
      });
      return;
    }

    updateStatus(record.id, 'RETRYING', {
      attemptCount: nextAttemptCount,
      nextRetryAt: nextRetryAtFromDelayMs(delayMs),
      lastAttemptAt: now,
      lastError,
    });
  }
}
