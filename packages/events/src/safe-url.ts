// Webhook URLs are tenant input, and compute's workers sit inside the platform network: a URL pointing at a
// metadata service, a BMC or a database would turn deliveries into SSRF. URLs are checked when a webhook is
// saved (scheme, credentials, IP literals, internal names) and each delivery resolves the host, refuses
// private, loopback, link-local and other non-public addresses, and then connects to the address it
// checked (`postPinned`), so a DNS answer that changes between the check and the connection (rebinding)
// reaches nothing new. Addresses are judged by core's `classifyAddress`, the same classifier provider
// endpoints go through: by value, so an IPv4 address inside an IPv6 one (mapped in hex or dotted form,
// NAT64, 6to4) is judged too.

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  addressFamily,
  classifyAddress,
  ComputeError,
  isInternalHostName,
} from '@better-compute/core';

export interface UrlPolicy {
  /** Allow `http:` (development only). */
  allowInsecure?: boolean;
  /** Allow private and loopback destinations (development and tests only). */
  allowPrivate?: boolean;
}

/** Whether an IP address is anything but a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  return classifyAddress(address) !== undefined;
}

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

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
  const host = hostOf(url);
  if (!policy.allowPrivate) {
    const literal = addressFamily(host) !== 0;
    if (literal ? isNonPublicAddress(host) : isInternalHostName(host))
      throw new ComputeError('INVALID_INPUT', 'The webhook URL must point at a public address');
  }
  url.hash = '';
  return url.toString();
}

/**
 * Resolves a URL's host and refuses non-public addresses (unless the policy allows them). Returns the
 * addresses it checked, for the caller to connect to (`postPinned`); none when the policy allows private
 * destinations, where nothing is resolved here.
 */
export async function assertPublicDestination(
  value: string,
  policy: UrlPolicy = {},
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
): Promise<string[]> {
  checkWebhookUrl(value, policy);
  if (policy.allowPrivate) return [];
  const host = hostOf(new URL(value));
  const addresses = addressFamily(host) !== 0 ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isNonPublicAddress))
    throw new ComputeError(
      'DRIVER_ERROR',
      `The webhook host ${host} resolves to a non-public address`,
    );
  return addresses;
}

/** The address to connect to among checked ones: IPv4 first (the wider reachability), else the first. */
export function preferredAddress(addresses: readonly string[]): string {
  return addresses.find((address) => addressFamily(address) === 4) ?? addresses[0]!;
}

/**
 * POSTs `body` to `url`, connecting to `address` (an address the caller checked) whatever the host name
 * resolves to now, with TLS verified against the URL's host name. Redirects are not followed. The
 * response body is discarded unread; only the status comes back.
 */
export function postPinned(
  url: string,
  address: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<{ status: number; ok: boolean }> {
  const target = new URL(url);
  const family = addressFamily(address) === 6 ? 6 : 4;
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
    else (callback as (error: null, address: string, family: number) => void)(null, address, family);
  };
  const host = hostOf(target);
  const body = Buffer.from(init.body, 'utf8');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(
      {
        protocol: target.protocol,
        hostname: host,
        ...(target.port ? { port: Number(target.port) } : {}),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { ...init.headers, 'content-length': String(body.byteLength) },
        agent: false,
        lookup: pinned,
        ...(addressFamily(host) === 0 ? { servername: host } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        // Nothing of the answer is kept: free the socket without reading a body of any size.
        incoming.destroy();
        resolve({ status, ok: status >= 200 && status < 300 });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
