// Webhook URLs are tenant input, and compute's workers sit inside the platform network: a URL pointing at a
// metadata service, a BMC or a database would turn deliveries into SSRF. URLs are checked when a webhook is
// saved (scheme, credentials, IP literals) and each delivery resolves the host and refuses private,
// loopback, link-local and other non-public addresses.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ComputeError } from '@better-compute/core';

export interface UrlPolicy {
  /** Allow `http:` (development only). */
  allowInsecure?: boolean;
  /** Allow private and loopback destinations (development and tests only). */
  allowPrivate?: boolean;
}

function v4(address: string): number[] | undefined {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

/** Whether an IP address is anything but a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = v4(address)!;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a! >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isNonPublicAddress(mapped[1]!);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(lower) ||
      /^fe[89ab][0-9a-f]:/.test(lower) ||
      /^ff[0-9a-f]{2}:/.test(lower) ||
      lower.startsWith('64:ff9b:') ||
      lower.startsWith('2001:db8:')
    );
  }
  return true;
}

/** Checks a webhook URL when it is saved; returns it normalized. */
export function checkWebhookUrl(value: string, policy: UrlPolicy = {}): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ComputeError('INVALID_INPUT', 'The webhook URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:'))
    throw new ComputeError('INVALID_INPUT', 'The webhook URL must use https');
  if (url.username || url.password)
    throw new ComputeError('INVALID_INPUT', 'The webhook URL must not carry credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (isIP(host) && isNonPublicAddress(host))
      throw new ComputeError('INVALID_INPUT', 'The webhook URL must point at a public address');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
      throw new ComputeError('INVALID_INPUT', 'The webhook URL must point at a public address');
  }
  url.hash = '';
  return url.toString();
}

/** Resolves a URL's host and refuses non-public addresses (unless the policy allows them). */
export async function assertPublicDestination(
  value: string,
  policy: UrlPolicy = {},
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
): Promise<void> {
  checkWebhookUrl(value, policy);
  if (policy.allowPrivate) return;
  const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isNonPublicAddress))
    throw new ComputeError(
      'DRIVER_ERROR',
      `The webhook host ${host} resolves to a non-public address`,
    );
}
