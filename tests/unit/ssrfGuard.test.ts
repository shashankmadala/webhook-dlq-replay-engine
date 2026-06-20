import { afterEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() =>
  vi.fn((_hostname?: string, _options?: unknown) => ({
    address: '93.184.216.34',
    family: 4,
  })),
);

vi.mock('node:dns', () => ({
  promises: {
    lookup: (hostname: string, options?: unknown) =>
      lookupMock(hostname, options),
  },
}));

import {
  assertSafeUrl,
  isSafeUrl,
  SsrfBlockedError,
} from '../../src/security/ssrfGuard';

describe('ssrfGuard', () => {
  afterEach(() => {
    lookupMock.mockReset();
  });

  it('blocks localhost', async () => {
    lookupMock.mockResolvedValue({ address: '127.0.0.1', family: 4 });
    await expect(isSafeUrl('http://localhost/webhook')).resolves.toBe(false);
  });

  it('blocks 127.0.0.1', async () => {
    await expect(isSafeUrl('http://127.0.0.1/webhook')).resolves.toBe(false);
  });

  it('blocks 192.168.1.1', async () => {
    await expect(isSafeUrl('http://192.168.1.1/webhook')).resolves.toBe(false);
  });

  it('blocks 10.0.0.1', async () => {
    await expect(isSafeUrl('http://10.0.0.1/webhook')).resolves.toBe(false);
  });

  it('blocks 169.254.169.254 (AWS metadata)', async () => {
    await expect(
      isSafeUrl('http://169.254.169.254/latest/meta-data'),
    ).resolves.toBe(false);
  });

  it('allows https://example.com when DNS resolves to a public IP', async () => {
    lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    await expect(isSafeUrl('https://example.com/webhook')).resolves.toBe(true);
  });

  it('blocks ftp://example.com (wrong scheme)', async () => {
    await expect(isSafeUrl('ftp://example.com/file')).resolves.toBe(false);
  });

  it('assertSafeUrl throws SsrfBlockedError for blocked URLs', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/webhook')).rejects.toThrow(
      SsrfBlockedError,
    );
  });
});
