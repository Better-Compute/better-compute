import { BlockList, isIP } from 'node:net';
import { ComputeError } from '@better-compute/core';

// Trusted proxies (`trustedProxies`): behind a load balancer the socket peer is the balancer, so
// IAM's `request.sourceIp` would be the balancer's address for every caller. When — and only when —
// the peer is a configured proxy, the caller is read from X-Forwarded-For: walking it right to left,
// the first address that is not itself a trusted proxy (each proxy appends the hop it saw, so the
// entries to the left of the first untrusted one are whatever the client claimed). A peer that is
// not a trusted proxy is the caller, whatever the headers say. A trusted proxy that sends no usable
// header leaves the caller unknown (no sourceIp: IAM conditions on it do not match).

/**
 * Headers that claim a client address. Stripped from every credential IAM sees, whichever way the
 * call came in (HTTP or the in-process API), and replaced by the verified `sourceIp` alone.
 */
export const forwardingHeaders = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-cluster-client-ip',
] as const;

/** Resolves the caller's address from the socket peer and the request's forwarding headers. */
export type SourceAddressResolver = (peer: string | undefined, headers: Headers) => string | undefined;

/** Strips an IPv4-mapped IPv6 prefix, so `::ffff:10.0.0.1` matches `10.0.0.0/8`. */
function normalize(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

/**
 * Parses `trustedProxies` (addresses or CIDR ranges, IPv4 or IPv6). An empty list trusts no proxy:
 * the socket peer is always the caller.
 */
export function sourceAddressResolver(trusted: readonly string[] = []): SourceAddressResolver {
  const list = new BlockList();
  for (const entry of trusted) {
    if (typeof entry !== 'string')
      throw new ComputeError('INVALID_CONFIG', 'trustedProxies must list addresses or CIDR ranges');
    const [address, prefix, extra] = entry.trim().split('/');
    const family = isIP(address ?? '');
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    if (
      extra !== undefined ||
      family === 0 ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > (family === 4 ? 32 : 128) ||
      (prefix !== undefined && !/^\d+$/.test(prefix))
    )
      throw new ComputeError('INVALID_CONFIG', `trustedProxies: ${JSON.stringify(entry)} is not an address or CIDR`);
    list.addSubnet(address!, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = (address: string) => {
    const family = isIP(address);
    return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
  return (peer, headers) => {
    if (peer === undefined || peer === '') return undefined;
    const direct = normalize(peer);
    if (trusted.length === 0 || !isTrusted(direct)) return direct;
    const hops = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map(normalize)
      .filter((hop) => hop !== '');
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = hops[index]!;
      // A malformed hop: the caller is unknown. Never the proxy's own address, which an internal
      // allowlist might match.
      if (isIP(hop) === 0) return undefined;
      if (!isTrusted(hop)) return hop;
    }
    // Every hop is a trusted proxy (an internal caller): the leftmost one. No header: unknown.
    return hops[0];
  };
}
