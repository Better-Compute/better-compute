// Classifying network addresses for egress checks: one place that says whether an address is a public
// unicast one, used by every guard that keeps the control plane from being pointed at what only it can
// reach (provider endpoints an account's config chooses, webhook URLs a tenant saves). Pure: no I/O, no
// Node.js built-ins, so it stays in core's browser-safe root entry. The guards that resolve names and pin
// connections build on it (`@better-compute/core/egress`).
import { ComputeError } from './errors.js';

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

/** A parsed IP address: its family and its value as an unsigned integer. */
export interface ParsedAddress {
  family: 4 | 6;
  value: bigint;
}

/** A CIDR range with the category an address inside it gets. */
export interface AddressRange {
  family: 4 | 6;
  base: bigint;
  bits: number;
  category: AddressCategory;
}

const v4Pattern = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const hexGroup = /^[0-9a-f]{1,4}$/;

function v4Value(address: string): bigint {
  return address.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function v6Value(address: string): bigint | undefined {
  let text = address.toLowerCase();
  // A zone id (fe80::1%eth0) names an interface, not another address.
  const zone = text.indexOf('%');
  if (zone !== -1) {
    if (zone === 0 || zone === text.length - 1) return undefined;
    text = text.slice(0, zone);
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groupsOf = (half: string, last: boolean): string[] | undefined => {
    if (half === '') return [];
    const parts = half.split(':');
    const groups: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      // A trailing dotted quad (::ffff:10.0.0.1) is the low 32 bits.
      if (last && index === parts.length - 1 && part.includes('.')) {
        if (!v4Pattern.test(part)) return undefined;
        const v4 = v4Value(part);
        groups.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
      } else if (hexGroup.test(part)) groups.push(part);
      else return undefined;
    }
    return groups;
  };
  const compressed = halves.length === 2;
  const left = groupsOf(halves[0]!, !compressed);
  const right = compressed ? groupsOf(halves[1]!, true) : [];
  if (!left || !right) return undefined;
  const count = left.length + right.length;
  if (compressed ? count > 7 : count !== 8) return undefined;
  const groups = [...left, ...Array<string>(8 - count).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/**
 * Parses an IP literal (IPv4 dotted quad, or IPv6 in any textual form, brackets and zone id allowed);
 * undefined for anything else. Agrees with `net.isIP` on what is an address.
 */
export function parseAddress(address: string): ParsedAddress | undefined {
  const text = address.replace(/^\[(.*)\]$/, '$1');
  if (v4Pattern.test(text)) return { family: 4, value: v4Value(text) };
  if (!text.includes(':')) return undefined;
  const value = v6Value(text);
  return value === undefined ? undefined : { family: 6, value };
}

/** 4 or 6 for an IP literal, 0 for anything else (as `net.isIP`). */
export function addressFamily(address: string): 0 | 4 | 6 {
  return parseAddress(address)?.family ?? 0;
}

/** Parses a CIDR (`10.0.0.0/8`, `fc00::/7`; a bare address is a host range). Throws `INVALID_CONFIG`. */
export function parseCidr(cidr: string, category: AddressCategory): AddressRange {
  const [address, prefix] = cidr.split('/') as [string, string | undefined];
  const parsed = parseAddress(address);
  if (!parsed) throw new ComputeError('INVALID_CONFIG', `Address policy: ${cidr} is not a CIDR`);
  const width = parsed.family === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if (prefix === '' || !Number.isInteger(bits) || bits < 0 || bits > width)
    throw new ComputeError('INVALID_CONFIG', `Address policy: ${cidr} has a bad prefix length`);
  const shift = BigInt(width - bits);
  return { family: parsed.family, base: (parsed.value >> shift) << shift, bits, category };
}

/** Whether a parsed address lies in a range. */
export function addressInRange(range: AddressRange, address: ParsedAddress): boolean {
  if (range.family !== address.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - range.bits);
  return address.value >> shift === range.base >> shift;
}

/** Every range that is not public unicast space (IANA special-purpose registries). */
export const nonPublicRanges: readonly AddressRange[] = Object.freeze(
  (
    [
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
    ] as const
  ).map(([cidr, category]) => parseCidr(cidr, category)),
);

/**
 * The IPv4 address an IPv6 one carries, if any: IPv4-mapped (`::ffff:0:0/96`, in dotted or hex form), the
 * NAT64 well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`). A connection to one of these reaches
 * the embedded IPv4 address, so a check must judge that too.
 */
export function embeddedV4(address: ParsedAddress): ParsedAddress | undefined {
  if (address.family !== 6) return undefined;
  const { value } = address;
  if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
  if (value >> 32n === 0x64ff9b0000000000000000n) return { family: 4, value: value & 0xffffffffn };
  if (value >> 112n === 0x2002n) return { family: 4, value: (value >> 80n) & 0xffffffffn };
  return undefined;
}

export interface ClassifyOptions {
  /** Ranges exempt from every refusal (checked first). */
  allow?: readonly AddressRange[];
  /** More ranges to refuse, checked before the built-in ones. */
  deny?: readonly AddressRange[];
}

/**
 * Why an IP literal is not a public unicast address, or undefined when it is one. Anything that is not an
 * IP literal is `reserved`. An IPv6 address that embeds an IPv4 one is judged by both.
 */
export function classifyAddress(
  address: string,
  options: ClassifyOptions = {},
): AddressCategory | undefined {
  const parsed = parseAddress(address);
  if (!parsed) return 'reserved';
  const judge = (candidate: ParsedAddress): AddressCategory | undefined | 'allowed' => {
    if (options.allow?.some((range) => addressInRange(range, candidate))) return 'allowed';
    for (const range of options.deny ?? [])
      if (addressInRange(range, candidate)) return range.category;
    for (const range of nonPublicRanges)
      if (addressInRange(range, candidate)) return range.category;
    return undefined;
  };
  const own = judge(parsed);
  if (own === 'allowed') return undefined;
  if (own !== undefined) return own;
  const inner = embeddedV4(parsed);
  if (inner) {
    const embedded = judge(inner);
    if (embedded !== 'allowed' && embedded !== undefined) return embedded;
  }
  return undefined;
}

/** Whether a host name only resolves inside a network: never a public endpoint. A trailing dot is ignored. */
export function isInternalHostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name === 'metadata' ||
    name === 'kubernetes' ||
    !name.includes('.') ||
    /\.(localhost|local|internal|intranet|lan|home|corp|svc|cluster\.local|home\.arpa)$/.test(name)
  );
}
