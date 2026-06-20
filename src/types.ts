/** Unique identifier for a webhook event (UUID v4 or ULID). */
export type WebhookEventId = string;

/** Unique identifier for a dead letter record. */
export type DeadLetterRecordId = string;

/** ISO 8601 timestamp string. */
export type ISOTimestamp = string;

/** HTTP methods supported for webhook delivery. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Lifecycle status for a dead letter record.
 *
 * PENDING   — Failed delivery recorded; awaiting next retry window.
 * RETRYING  — Replay in progress (delivery attempt underway).
 * DELIVERED — Successfully delivered to target endpoint.
 * DEAD      — Permanently failed; bounded max attempts exhausted,
 *             TTL expired, or non-retryable error.
 */
export type DLQStatus = 'PENDING' | 'RETRYING' | 'DELIVERED' | 'DEAD';

/** Structured error captured from a failed delivery attempt. */
export interface DeliveryError {
  code: string;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  occurredAt: ISOTimestamp;
}

/** HTTP headers as key-value pairs (values may be string or string[]). */
export type HttpHeaders = Record<string, string | string[]>;

/**
 * The original inbound webhook event.
 * Immutable payload stored for replay.
 */
export interface WebhookEvent {
  id: WebhookEventId;
  targetUrl: string;
  method: HttpMethod;
  headers: HttpHeaders;
  body: string;
  contentType?: string;
  receivedAt: ISOTimestamp;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Discriminated union defining when retries must stop.
 *
 * bounded — Retry up to a fixed number of delivery attempts.
 * ttl     — Retry indefinitely until the expiry timestamp is reached.
 */
export type RetryPolicy =
  | { kind: 'bounded'; maxAttempts: number }
  | { kind: 'ttl'; expiresAt: Date };

/** Backoff and jitter settings applied alongside a retry policy. */
export interface RetryBackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
  nonRetryableStatusCodes?: number[];
  nonRetryableErrorCodes?: string[];
}

/**
 * A persisted dead letter record representing a failed delivery
 * and its retry state.
 */
export interface DeadLetterRecord {
  id: DeadLetterRecordId;
  event: WebhookEvent;
  status: DLQStatus;
  attemptCount: number;
  retryPolicy: RetryPolicy;
  retryBackoff: RetryBackoffConfig;
  nextRetryAt: ISOTimestamp | null;
  lastAttemptAt: ISOTimestamp | null;
  lastError: DeliveryError | null;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
  finalizedAt: ISOTimestamp | null;
}

/** Trigger for a replay operation. */
export type ReplayTrigger = 'manual' | 'scheduler';

/** Outcome of a single replay/delivery attempt. */
export type ReplayOutcome = 'delivered' | 'requeued' | 'dead';

/**
 * Result returned by the replay engine after attempting delivery.
 */
export interface ReplayResult {
  recordId: DeadLetterRecordId;
  eventId: WebhookEventId;
  trigger: ReplayTrigger;
  outcome: ReplayOutcome;
  status: DLQStatus;
  attemptNumber: number;
  httpStatus?: number;
  error?: DeliveryError;
  nextRetryAt?: ISOTimestamp;
  durationMs: number;
  completedAt: ISOTimestamp;
}

/** Lifecycle event emitted on status transitions (for logging/observability). */
export interface StatusLifecycleEvent {
  recordId: DeadLetterRecordId;
  eventId: WebhookEventId;
  from: DLQStatus;
  to: DLQStatus;
  attemptCount: number;
  timestamp: ISOTimestamp;
  metadata?: Record<string, unknown>;
}
