import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import { isoSeconds, settleAction } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';

// Reserved IPs under `/v2/reserved_ips` (IPv4) and `/v2/reserved_ipv6`. A reserve answers at
// once with the address (v4: 202, v6: 201), drawn from TEST-NET-2 and 2001:db8:1::/64. Assign and
// unassign (`POST /{ip}/actions`) answer 201 with an action `in-progress` that completes after
// `emulator.addressActionReads` reads of the address (at 0, the default, at once); while it runs a
// v4 address is `locked`, and another action on the address is the 422 `has a pending event`.
// Assigning moves an address from another Droplet as DO does (the provider never asks for that).
// Deleting a Droplet unassigns its addresses. An assigned address can't be deleted (422).
//
// BYOIP prefixes (`/v2/byoip_prefixes`) are seeded by tests (`seedPrefix`) and only read. A v4
// reserve with `byoip_prefix_uuid` draws the next free address of an active prefix in the region
// (this request shape is unverified, see the fixture); a prefix that is full is the 422
// `no available IPs`.

const templates = fixture('reserved-ips');
const v4Template = templates.reserved_ip as Json;
const v6Template = templates.reserved_ipv6 as Json;
const actionTemplate = fixture('actions').action as Json;
const prefixTemplate = fixture('byoip-prefixes').byoip_prefix as Json;

type Family = 'v4' | 'v6';

interface Pending {
  reads: number;
  action: Json;
  apply: () => void;
}

const pendingByState = new WeakMap<DoState, Map<string, Pending>>();

function pendingOf(state: DoState): Map<string, Pending> {
  let map = pendingByState.get(state);
  if (!map) {
    map = new Map();
    pendingByState.set(state, map);
  }
  return map;
}

function table(state: DoState, family: Family): Map<string, Json> {
  return family === 'v4' ? state.reservedIps : state.reservedIpv6;
}

function regionOf(address: Json): string {
  return address.region?.slug ?? address.region_slug;
}

/** A reserved IP in the account, as if made out of band; `droplet` assigns it. */
export function seedAddress(
  state: DoState,
  seed: { family?: Family; ip?: string; region?: string; droplet?: Json },
): Json {
  const family = seed.family ?? 'v4';
  const regionSlug = seed.region ?? 'nyc3';
  const n = state.nextId();
  const ip =
    seed.ip ??
    (family === 'v4'
      ? `198.51.100.${(n % 254) + 1}`
      : `2001:db8:1::${((n % 0xfffe) + 1).toString(16)}`);
  const region = state.regions.find((r) => r.slug === regionSlug) ?? {
    name: regionSlug,
    slug: regionSlug,
    features: [],
    available: true,
    sizes: [],
  };
  const address: Json =
    family === 'v4'
      ? {
          ...structuredClone(v4Template),
          ip,
          region: structuredClone(region),
          droplet: null,
          locked: false,
        }
      : {
          ...structuredClone(v6Template),
          ip,
          region_slug: regionSlug,
          reserved_at: isoSeconds(state.now()),
          droplet: null,
        };
  table(state, family).set(ip, address);
  if (seed.droplet) address.droplet_id = seed.droplet.id;
  return address;
}

/** The address as DO shows it: its Droplet embedded, as of now. */
function view(state: DoState, address: Json): Json {
  const { droplet_id: dropletId, ...rest } = address;
  const droplet = dropletId === undefined ? undefined : state.droplets.get(dropletId);
  return { ...structuredClone(rest), droplet: droplet ? structuredClone(droplet) : null };
}

/** A read of an address: counts toward its in-progress action, which may complete after it. */
function afterRead(state: DoState, ip: string): void {
  const pending = pendingOf(state);
  const entry = pending.get(ip);
  if (!entry) return;
  if (entry.reads > 1) {
    entry.reads -= 1;
    return;
  }
  pending.delete(ip);
  settleAction(state, entry.action, 'completed');
  entry.apply();
}

/** Unassigns every address of a Droplet that is being deleted. */
export function unassignAll(state: DoState, dropletId: number): void {
  for (const family of ['v4', 'v6'] as const)
    for (const address of table(state, family).values())
      if (address.droplet_id === dropletId) delete address.droplet_id;
}

/** A BYOIP prefix on the account, as if brought out of band. Default an active /29 in nyc3. */
export function seedPrefix(
  state: DoState,
  seed: { prefix?: string; region?: string; status?: string; uuid?: string } = {},
): Json {
  const prefix: Json = {
    ...structuredClone(prefixTemplate),
    uuid: seed.uuid ?? randomUUID(),
    prefix: seed.prefix ?? '203.0.113.0/29',
    region: seed.region ?? 'nyc3',
    status: seed.status ?? 'active',
  };
  state.byoipPrefixes.set(prefix.uuid, prefix);
  return prefix;
}

/** The addresses of an IPv4 CIDR, network and broadcast left out. */
function hosts(cidr: string): string[] {
  const [base, bits] = cidr.split('/');
  const n = base!.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  const out: string[] = [];
  for (let i = 1; i < size - 1; i += 1) {
    const v = n + i;
    out.push([24, 16, 8, 0].map((shift) => Math.floor(v / 2 ** shift) % 256).join('.'));
  }
  return out;
}

function reserve(emulator: DoEmulator, context: RouteContext, family: Family) {
  const { state } = context;
  const body = context.body ?? {};
  const slug = family === 'v4' ? body.region : body.region_slug;
  if (typeof slug !== 'string' || !state.regions.some((r) => r.slug === slug))
    return emulator.error('422-unknown');
  if (state.reservedIps.size + state.reservedIpv6.size >= emulator.reservedIpLimit)
    return emulator.error('422-reserved-ip-limit');
  let ip: string | undefined;
  if (body.byoip_prefix_uuid !== undefined) {
    const prefix = state.byoipPrefixes.get(String(body.byoip_prefix_uuid));
    if (family !== 'v4' || !prefix) return emulator.error('not-found');
    if (prefix.status !== 'active' || prefix.region !== slug) return emulator.error('422-unknown');
    ip = hosts(prefix.prefix).find((candidate) => !state.reservedIps.has(candidate));
    if (ip === undefined) return emulator.error('422-unknown');
  }
  const address = seedAddress(state, { family, region: slug, ...(ip ? { ip } : {}) });
  return family === 'v4'
    ? { status: 202, body: { reserved_ip: view(state, address), links: {} } }
    : { status: 201, body: { reserved_ipv6: view(state, address) } };
}

function act(emulator: DoEmulator, context: RouteContext, family: Family) {
  const { state } = context;
  const ip = decodeURIComponent(context.match[1]!);
  const address = table(state, family).get(ip);
  if (!address) return emulator.error('not-found');
  if (pendingOf(state).has(ip)) return emulator.error('422-pending-event');
  const body = context.body ?? {};
  let apply: () => void;
  if (body.type === 'assign') {
    const droplet = state.droplets.get(Number(body.droplet_id));
    if (!droplet) return emulator.error('not-found');
    if (droplet.region.slug !== regionOf(address)) return emulator.error('422-unknown');
    apply = () => {
      address.droplet_id = droplet.id;
    };
  } else if (body.type === 'unassign') {
    if (address.droplet_id === undefined) return emulator.error('422-unknown');
    apply = () => {
      delete address.droplet_id;
    };
  } else return emulator.error('422-unknown');
  const action: Json = {
    ...structuredClone(actionTemplate),
    id: state.nextId(),
    status: 'in-progress',
    type: `${body.type}_ip`,
    started_at: isoSeconds(state.now()),
    completed_at: null,
    resource_id: null,
    resource_type: family === 'v4' ? 'reserved_ip' : 'reserved_ipv6',
    region_slug: regionOf(address),
  };
  state.actions.set(action.id, action);
  if (emulator.addressActionReads <= 0) {
    settleAction(state, action, 'completed');
    apply();
  } else {
    if (family === 'v4') address.locked = true;
    pendingOf(state).set(ip, {
      reads: emulator.addressActionReads,
      action,
      apply: () => {
        apply();
        if (family === 'v4') address.locked = false;
      },
    });
  }
  return { status: 201, body: { action: structuredClone(action) } };
}

export function registerAddresses(emulator: DoEmulator): void {
  emulator.route('GET', /^\/byoip_prefixes$/, (context) =>
    emulator.paged(context, 'byoip_prefixes', [...context.state.byoipPrefixes.values()]),
  );
  emulator.route('GET', /^\/byoip_prefixes\/([^/]+)$/, (context) => {
    const prefix = context.state.byoipPrefixes.get(decodeURIComponent(context.match[1]!));
    if (!prefix) return emulator.error('not-found');
    return { status: 200, body: { byoip_prefix: structuredClone(prefix) } };
  });
  for (const [family, base, field, one] of [
    ['v4', 'reserved_ips', 'reserved_ips', 'reserved_ip'],
    ['v6', 'reserved_ipv6', 'reserved_ipv6s', 'reserved_ipv6'],
  ] as const) {
    const item = new RegExp(`^\\/${base}\\/([^/]+)$`);
    emulator.route('POST', new RegExp(`^\\/${base}$`), (context) =>
      reserve(emulator, context, family),
    );
    emulator.route('GET', new RegExp(`^\\/${base}$`), (context) =>
      emulator.paged(
        context,
        field,
        [...table(context.state, family).values()].map((a) => view(context.state, a)),
      ),
    );
    emulator.route('GET', item, (context) => {
      const ip = decodeURIComponent(context.match[1]!);
      afterRead(context.state, ip);
      const address = table(context.state, family).get(ip);
      if (!address) return emulator.error('not-found');
      return { status: 200, body: { [one]: view(context.state, address) } };
    });
    emulator.route('DELETE', item, (context) => {
      const ip = decodeURIComponent(context.match[1]!);
      const address = table(context.state, family).get(ip);
      if (!address) return emulator.error('not-found');
      if (address.droplet_id !== undefined) return emulator.error('422-unknown');
      table(context.state, family).delete(ip);
      return { status: 204 };
    });
    emulator.route('POST', new RegExp(`^\\/${base}\\/([^/]+)\\/actions$`), (context) =>
      act(emulator, context, family),
    );
  }
}
