export const CLAIM_STALE_AFTER_MS = 5 * 60 * 1_000;

export function staleClaimCutoff(now = Date.now()): string {
  return new Date(now - CLAIM_STALE_AFTER_MS).toISOString();
}
