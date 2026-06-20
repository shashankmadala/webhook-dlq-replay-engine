import { afterEach, describe, expect, it, vi } from 'vitest';

const lookupSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns', () => ({
  lookupSync: (...args: unknown[]) => lookupSyncMock(...args),
}));

import {
  assertSafeUrl,
  isSafeUrl,
  SsrfBlockedError,
} from '../../src/security/ssrfGuard';

describe('ssrfGuard', () => {
  afterEach(() => {
    lookupSyncMock.mockReset();
  });

  it('blocks localhost', () => {
    lookupSyncMock.mockReturnValue({ address: '127.0.0.1', family: 4 });
    expect(isSafeUrl('http://localhost/webhook')).toBe(false);
  });

  it('blocks 127.0.0.1', () => {
    expect(isSafeUrl('http://127.0.0.1/webhook')).toBe(false);
  });

  it('blocks 192.168.1.1', () => {
    expect(isSafeUrl('http://192.168.1.1/webhook')).toBe(false);
  });

  it('blocks 10.0.0.1', () => {
    expect(isSafeUrl('http://10.0.0.1/webhook')).toBe(false);
  });

  it('blocks 169.254.169.254 (AWS metadata)', () => {
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('allows https://example.com when DNS resolves to a public IP', () => {
    lookupSyncMock.mockReturnValue({ address: '93.184.216.34', family: 4 });
    expect(isSafeUrl('https://example.com/webhook')).toBe(true);
  });

  it('blocks ftp://example.com (wrong scheme)', () => {
    expect(isSafeUrl('ftp://example.com/file')).toBe(false);
  });

  it('assertSafeUrl throws SsrfBlockedError for blocked URLs', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/webhook')).rejects.toThrow(
      SsrfBlockedError,
    );
  });
});
