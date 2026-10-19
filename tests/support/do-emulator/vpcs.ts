import { createHash } from 'node:crypto';
import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteContext } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// VPCs under `/v2/vpcs`: list (paged), read, create and delete over `state.vpcs`, plus a seed.
// Each region also has a default VPC, which a Droplet created without `vpc_uuid` joins; it is
// made on first use. A create follows `vpc.yml` (research S3): the name is `[a-zA-Z0-9.-]` and
// unique in the account (the `422-name-in-use` fixture), the description at most 255 characters,
// and the range an RFC 1918 IPv4 CIDR from /16 to /28 that overlaps no other VPC of the account
// (the `422-vpc-range-overlap` fixture); without a range the emulator picks a free /20. A VPC
// that a Droplet is in can't be deleted (the `409-vpc-in-use` fixture), nor can a default one.

/** The shape of a `vpc` body, from the fixture. */
const template = fixture('vpcs').vpc as Json;

/** A uuid-shaped id derived from a seed, so the emulator's ids are stable across runs. */
export function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Puts a VPC in the account; returns the stored resource. */
export function seedVpc(
  state: DoState,
  vpc: {
    name: string;
    region: string;
    ip_range?: string;
    default?: boolean;
    id?: string;
    description?: string;
  },
): Json {
  const id = vpc.id ?? uuidFrom(`vpc:${vpc.name}:${vpc.region}`);
  const stored: Json = {
    ...structuredClone(template),
    id,
    urn: `do:vpc:${id}`,
    name: vpc.name,
    description: vpc.description ?? '',
    region: vpc.region,
    ip_range: vpc.ip_range ?? `10.${10 + state.vpcs.size}.0.0/20`,
    default: vpc.default ?? false,
    created_at: isoSeconds(state.now()),
  };
  state.vpcs.set(id, stored);
  return stored;
}

/** The region's default VPC, made on first use. */
export function defaultVpc(state: DoState, region: string): Json {
  for (const vpc of state.vpcs.values()) if (vpc.region === region && vpc.default) return vpc;
  return seedVpc(state, { name: `default-${region}`, region, default: true });
}

/** An IPv4 CIDR as an inclusive range; undefined when it is not one. */
function v4Range(cidr: string): [number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const size = 2 ** (32 - prefix);
  const start = value - (value % size);
  return [start, start + size - 1, prefix];
}

const private1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((c) => v4Range(c)!);

function validRange(cidr: string): boolean {
  const range = v4Range(cidr);
  if (!range) return false;
  const [start, end, prefix] = range;
  return prefix >= 16 && prefix <= 28 && private1918.some(([s, e]) => s <= start && end <= e);
}

function overlaps(state: DoState, cidr: string): boolean {
  const [start, end] = v4Range(cidr)!;
  for (const vpc of state.vpcs.values()) {
    const other = v4Range(vpc.ip_range);
    if (other && other[0] <= end && start <= other[1]) return true;
  }
  return false;
}

function freeRange(state: DoState): string {
  for (let i = 0; i < 256; i++) {
    const cidr = `10.${i}.0.0/20`;
    if (!overlaps(state, cidr)) return cidr;
  }
  throw new Error('the emulator has no free /20 left');
}

const namePattern = /^[a-zA-Z0-9\-.]+$/;

function create(emulator: DoEmulator, context: RouteContext) {
  const { state } = context;
  const body = context.body ?? {};
  const { name, region, ip_range: range, description } = body;
  if (typeof name !== 'string' || !namePattern.test(name)) return emulator.error('422-unknown');
  if (!state.regions.some((r) => r.slug === region)) return emulator.error('422-unknown');
  if (description !== undefined && (typeof description !== 'string' || description.length > 255))
    return emulator.error('422-unknown');
  if (range !== undefined && (typeof range !== 'string' || !validRange(range)))
    return emulator.error('422-unknown');
  if ([...state.vpcs.values()].some((vpc) => vpc.name === name))
    return emulator.error('422-name-in-use');
  if (range !== undefined && overlaps(state, range)) return emulator.error('422-vpc-range-overlap');
  const vpc = seedVpc(state, {
    name,
    region,
    ip_range: range ?? freeRange(state),
    description: description ?? '',
    id: uuidFrom(`vpc:${name}:${region}:${state.nextId()}`),
  });
  return { status: 201, body: { vpc: structuredClone(vpc) } };
}

export function registerVpcs(emulator: DoEmulator): void {
  emulator.route('GET', /^\/vpcs$/, (context) =>
    emulator.paged(
      context,
      'vpcs',
      [...context.state.vpcs.values()].map((v) => structuredClone(v)),
    ),
  );

  emulator.route('POST', /^\/vpcs$/, (context) => create(emulator, context));

  emulator.route('GET', /^\/vpcs\/([^/]+)$/, (context) => {
    const vpc = context.state.vpcs.get(decodeURIComponent(context.match[1]!));
    if (!vpc) return emulator.error('not-found');
    return { status: 200, body: { vpc: structuredClone(vpc) } };
  });

  emulator.route('DELETE', /^\/vpcs\/([^/]+)$/, (context) => {
    const id = decodeURIComponent(context.match[1]!);
    const vpc = context.state.vpcs.get(id);
    if (!vpc) return emulator.error('not-found');
    if (vpc.default) return emulator.error('422-unknown');
    if ([...context.state.droplets.values()].some((d) => d.vpc_uuid === id))
      return emulator.error('409-vpc-in-use');
    context.state.vpcs.delete(id);
    return { status: 204 };
  });
}
