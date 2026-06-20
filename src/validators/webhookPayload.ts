import { z } from 'zod';

import type { RetryPolicy } from '../types';

const boundedRetryPolicySchema = z.object({
  kind: z.literal('bounded'),
  maxAttempts: z.number().int().positive(),
});

const ttlRetryPolicySchema = z.object({
  kind: z.literal('ttl'),
  expiresAt: z.coerce.date(),
});

export const retryPolicySchema: z.ZodType<RetryPolicy> = z.discriminatedUnion(
  'kind',
  [boundedRetryPolicySchema, ttlRetryPolicySchema],
);

export const webhookPayloadSchema = z.object({
  endpoint_url: z.string().min(1).url(),
  http_method: z.enum(['POST', 'PUT', 'PATCH']),
  payload: z.object({}).passthrough(),
  headers: z.object({}).passthrough().optional().default({}),
  retry_policy: retryPolicySchema,
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
