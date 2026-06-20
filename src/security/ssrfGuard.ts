import dns from 'node:dns';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`SSRF blocked: ${url}`);
    this.name = 'SsrfBlockedError';
    this.url = url;
  }
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  if (a === 127) {
    return true;
  }

  if (a === 10) {
    return true;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  if (a === 192 && b === 168) {
    return true;
  }

  if (a === 169 && b === 254) {
    return true;
  }

  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = normalized.slice('::ffff:'.length);
    if (isIP(mappedIpv4) === 4) {
      return isBlockedIpv4(mappedIpv4);
    }
  }

  const firstHextet = normalized.split(':').find((part) => part.length > 0);
  if (firstHextet === undefined) {
    return true;
  }

  const value = Number.parseInt(firstHextet, 16);
  if (Number.isNaN(value)) {
    return true;
  }

  // fc00::/7 — unique local addresses
  return value >= 0xfc00 && value <= 0xfdff;
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isBlockedIpv4(address);
  }

  if (version === 6) {
    return isBlockedIpv6(address);
  }

  return true;
}

function resolveHostname(hostname: string): string | null {
  try {
    const { address } = dns.lookupSync(hostname, { verbatim: true });
    return address;
  } catch {
    return null;
  }
}

export function isSafeUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return false;
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    return !isBlockedIp(hostname);
  }

  const resolved = resolveHostname(hostname);
  if (resolved === null) {
    return false;
  }

  return !isBlockedIp(resolved);
}

export async function assertSafeUrl(url: string): Promise<void> {
  if (!isSafeUrl(url)) {
    throw new SsrfBlockedError(url);
  }
}
