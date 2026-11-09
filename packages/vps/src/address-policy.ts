import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { ComputeError } from '@better-compute/core';

// The address policy (U-02) for provider endpoints that an account's config, or a host's API URL override,
// chooses (`ProviderInput.endpoints`: Proxmox's `url`, Hetzner's `endpoint` override). A tenant must not point
// the control plane at what only the control plane can reach: private and link-local ranges (the cloud metadata
// server at 169.254.169.254 among them), loopback, CGNAT, multicast, reserved and documentation ranges, the
// IPv6 equivalents, internal names (`localhost`, `*.internal`, `*.svc`, `*.cluster.local`), and the cluster
// ranges the host names. Account validation checks every address a name resolves to; the client then calls
// through `pinnedFetch`, which checks again on every connection and connects to the address it checked, so a
// DNS answer that changes in between (rebinding) reaches nothing new. Redirects are never followed.
//
// This never applies to Compute Engine: its token, STS, IAM Credentials and compute hosts come from host options
// only (the universe pin), and provider-gcp declares no `endpoints`.

/** Why an address or name is refused. */
export type AddressCategory =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cgnat'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'unique-local'
  | 'site-local'
  | 'translation'
  | 'internal-name'
  | 'cluster';

export interface AddressPolicyOptions {
  /**
   * More ranges to refuse, as CIDRs: the cluster's pod and service ranges and the control plane's own network
   * when they are not private ones already (e.g. a GKE cluster on public-range IPs, `2600:1900:4000::/44`).
   */
  denyCidrs?: readonly string[];
  /**
   * Ranges exempt from the refusal, as CIDRs (checked first): an operator's own private Proxmox network.
   * Exemptions apply to every account; prefer `platformAccounts: 'exempt'` when only the platform's need it.
   */
  allowCidrs?: readonly string[];
  /** Host names exempt from the internal-name rule and from every address rule, exactly (lower-case). */
  allowHosts?: readonly string[];
  /**
   * The platform's own accounts (root tenant): `enforce` (default) checks them like any other; `exempt` lets
   * them name private endpoints (an operator's PVE cluster on the control plane's network).
   */
  platformAccounts?: 'enforce' | 'exempt';
  /** Plain `http:` endpoints (default false: an API token never crosses the network in clear text). */
  allowHttp?: boolean;
  /** Resolves a host name to its addresses (tests). Default: the system resolver, every address. */
  resolve?: (host: string) => Promise<readonly string[]>;
}

/** The compiled policy: what account validation and `ProviderContext.fetch` use. */
export interface AddressPolicy {
  readonly platformAccounts: 'enforce' | 'exempt';
  /** Why `address` (an IP literal) is refused, or undefined when it may be called. */
  classify(address: string): AddressCategory | undefined;
  /**
   * Checks an endpoint URL: scheme, no credentials, an allowed host name, and every address it resolves to.
   * Returns the addresses. Throws `INVALID_CONFIG` (`details.reason`: `endpoint-scheme`, `endpoint-address`,
   * `endpoint-unresolved`) or `UNAVAILABLE` (the resolver failed for now).
   */
  check(endpoint: string): Promise<string[]>;
  /** A fetch that checks every connection and pins it to the checked address (`pinnedFetch`). */
  readonly fetch: typeof fetch;
}

// --- Address ranges ---------------------------------------------------------------------------------------------

interface Range {
  family: 4 | 6;
  base: bigint;
  bits: number;
  category: AddressCategory;
}

function v4ToBigInt(address: string): bigint {
  return address.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function v6ToBigInt(address: string): bigint {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // A trailing dotted quad (::ffff:10.0.0.1).
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const v4 = v4ToBigInt(text.slice(lastColon + 1));
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group || '0', 16)), 0n);
}

function parseCidr(cidr: string, category: AddressCategory): Range {
  const [address, prefix] = cidr.split('/') as [string, string | undefined];
  const family = isIP(address);
  if (family !== 4 && family !== 6)
    throw new ComputeError('INVALID_CONFIG', `Address policy: ${cidr} is not a CIDR`);
  const width = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > width)
    throw new ComputeError('INVALID_CONFIG', `Address policy: ${cidr} has a bad prefix length`);
  const value = family === 4 ? v4ToBigInt(address) : v6ToBigInt(address);
  const shift = BigInt(width - bits);
  return { family, base: (value >> shift) << shift, bits, category };
}

const builtinRanges: readonly Range[] = [
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'documentation'],
  ['192.88.99.0/24', 'reserved'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'reserved'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::/96', 'reserved'],
  ['64:ff9b:1::/48', 'translation'],
  ['100::/64', 'reserved'],
  ['2001::/32', 'translation'],
  ['2001:2::/48', 'reserved'],
  ['2001:db8::/32', 'documentation'],
  ['3fff::/20', 'documentation'],
  ['5f00::/16', 'reserved'],
  ['fc00::/7', 'unique-local'],
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local'],
  ['ff00::/8', 'multicast'],
].map(([cidr, category]) => parseCidr(cidr as string, category as AddressCategory));

function inRange(range: Range, family: 4 | 6, value: bigint): boolean {
  if (range.family !== family) return false;
  const shift = BigInt((family === 4 ? 32 : 128) - range.bits);
  return value >> shift === range.base >> shift;
}

/** The IPv4 address an IPv6 one carries (mapped, NAT64 well-known prefix, 6to4), if any. */
function embeddedV4(value: bigint): bigint | undefined {
  if (value >> 32n === 0xffffn) return value & 0xffffffffn; // ::ffff:0:0/96
  if (value >> 32n === 0x64ff9b0000000000000000n) return value & 0xffffffffn; // 64:ff9b::/96
  if (value >> 112n === 0x2002n) return (value >> 80n) & 0xffffffffn; // 2002::/16
  return undefined;
}

/** Names that only resolve inside a network: never a provider's public API. */
function internalName(host: string): boolean {
  return (
    host === 'localhost' ||
    host === 'metadata' ||
    host === 'kubernetes' ||
    !host.includes('.') ||
    /\.(localhost|local|internal|intranet|lan|home|corp|svc|cluster\.local|home\.arpa)$/.test(host)
  );
}

/** Compiles `vps({ addressPolicy })`. */
export function createAddressPolicy(options: AddressPolicyOptions = {}): AddressPolicy {
  const allow = (options.allowCidrs ?? []).map((cidr) => parseCidr(cidr, 'private'));
  const deny = (options.denyCidrs ?? []).map((cidr) => parseCidr(cidr, 'cluster'));
  const allowHosts = new Set((options.allowHosts ?? []).map((host) => host.toLowerCase()));
  const resolve =
    options.resolve ??
    (async (host: string) =>
      (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address));

  const classify = (address: string): AddressCategory | undefined => {
    const family = isIP(address);
    if (family !== 4 && family !== 6) return 'reserved';
    const value = family === 4 ? v4ToBigInt(address) : v6ToBigInt(address);
    if (allow.some((range) => inRange(range, family, value))) return undefined;
    for (const range of [...deny, ...builtinRanges])
      if (inRange(range, family, value)) return range.category;
    if (family === 6) {
      const v4 = embeddedV4(value);
      if (v4 !== undefined) {
        if (allow.some((range) => inRange(range, 4, v4))) return undefined;
        for (const range of [...deny, ...builtinRanges])
          if (inRange(range, 4, v4)) return range.category;
      }
    }
    return undefined;
  };

  const refuse = (
    endpoint: string,
    reason: string,
    message: string,
    extra: Record<string, string> = {},
  ) =>
    new ComputeError('INVALID_CONFIG', `Endpoint ${endpoint}: ${message}`, undefined, {
      reason,
      endpoint,
      ...extra,
    });

  /** The host's addresses, each checked; the URL's own literal when it is one. */
  const addressesOf = async (url: URL, endpoint: string): Promise<string[]> => {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const exempt = allowHosts.has(host);
    if (!exempt && isIP(host) === 0 && internalName(host))
      throw refuse(endpoint, 'endpoint-address', `${host} is an internal name`, {
        category: 'internal-name',
      });
    let addresses: string[];
    if (isIP(host) !== 0) addresses = [host];
    else {
      try {
        addresses = [...(await resolve(host))];
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA')
          throw refuse(endpoint, 'endpoint-unresolved', `${host} does not resolve`);
        throw new ComputeError(
          'UNAVAILABLE',
          `Endpoint ${endpoint}: resolving ${host} failed; retry`,
          undefined,
          {
            reason: 'endpoint-unresolved',
            endpoint,
            retryAfterMs: 5_000,
          },
        );
      }
      if (addresses.length === 0)
        throw refuse(endpoint, 'endpoint-unresolved', `${host} does not resolve`);
    }
    if (exempt) return addresses;
    for (const address of addresses) {
      const category = classify(address);
      // The resolved address is not echoed: it may describe the control plane's own network.
      if (category !== undefined)
        throw refuse(endpoint, 'endpoint-address', `${host} resolves to a ${category} address`, {
          category,
        });
    }
    return addresses;
  };

  const parse = (endpoint: string): URL => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw refuse(endpoint, 'endpoint-scheme', 'is not a URL');
    }
    if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:'))
      throw refuse(
        endpoint,
        'endpoint-scheme',
        `must be https${options.allowHttp ? ' or http' : ''}`,
      );
    if (url.username || url.password)
      throw refuse(endpoint, 'endpoint-scheme', 'must not carry credentials');
    return url;
  };

  const policy: AddressPolicy = {
    platformAccounts: options.platformAccounts ?? 'enforce',
    classify,
    async check(endpoint) {
      return addressesOf(parse(endpoint), endpoint);
    },
    fetch: undefined as unknown as typeof fetch,
  };
  (policy as { fetch: typeof fetch }).fetch = pinnedFetch(async (url) => {
    const endpoint = url.origin;
    parse(url.href);
    return (await addressesOf(url, endpoint))[0]!;
  });
  return Object.freeze(policy);
}

// --- The pinned fetch -------------------------------------------------------------------------------------------

/** The largest response body `pinnedFetch` reads (64 MiB). */
export const pinnedFetchMaxBody = 64 * 1024 * 1024;

/**
 * A fetch whose every request connects to the address `pick` returns for its URL (checked by the caller), with TLS
 * verified against the URL's host name. Redirects are returned, never followed. Request bodies are buffered.
 */
export function pinnedFetch(pick: (url: URL) => Promise<string>): typeof fetch {
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const address = await pick(url);
    const family = isIP(address) === 6 ? 6 : 4;
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (body) headers['content-length'] = String(body.length);
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
      else
        (callback as (error: null, address: string, family: number) => void)(null, address, family);
    };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        {
          protocol: url.protocol,
          hostname: host,
          ...(url.port ? { port: Number(url.port) } : {}),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          agent: false,
          lookup: pinned,
          ...(isIP(host) === 0 ? { servername: host } : {}),
          signal: request.signal,
        },
        (incoming: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > pinnedFetchMaxBody) {
              incoming.destroy(
                new Error(`Response from ${url.origin} is larger than ${pinnedFetchMaxBody} bytes`),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
              else if (value !== undefined) responseHeaders.set(key, value);
            }
            const status = incoming.statusCode ?? 502;
            const empty = request.method === 'HEAD' || [101, 204, 205, 304].includes(status);
            try {
              resolve(
                new Response(empty ? null : Buffer.concat(chunks), {
                  status: status < 200 || status > 599 ? 502 : status,
                  statusText: incoming.statusMessage ?? '',
                  headers: responseHeaders,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('error', reject);
      if (body) outgoing.write(body);
      outgoing.end();
    });
  };
  return fetcher as typeof fetch;
}

/** The fetch an account's client gets (`ProviderContext.fetch`): the policy's, or plain for exempt platform accounts. */
export function accountFetch(
  policy: AddressPolicy | undefined,
  platform: boolean,
): typeof fetch | undefined {
  if (!policy) return undefined;
  if (platform && policy.platformAccounts === 'exempt') return undefined;
  return policy.fetch;
}

/**
 * Account validation's endpoint check: every URL the provider declares for the config (`ProviderInput.endpoints`)
 * must pass the policy. Platform accounts are exempt when the policy says so.
 */
export async function checkEndpoints(
  policy: AddressPolicy | undefined,
  endpoints: readonly string[],
  platform: boolean,
): Promise<void> {
  if (!policy || (platform && policy.platformAccounts === 'exempt')) return;
  for (const endpoint of endpoints) await policy.check(endpoint);
}
