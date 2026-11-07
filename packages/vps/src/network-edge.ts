import { strictObject, type InputSchema, type SqlTx } from '@better-compute/core';
import { fail, id, object, tenant } from './input.js';

// The edge of a tenant network (DO P4): NAT gateways, peerings and static routes, all kept in one
// table (`network_edges`) next to the network's subnets and firewall rules. `networks.natGateway`,
// `networks.peer` and `networks.routes` record what the tenant wants; the `vps.networks` reconciler
// converges them through `ProviderNetworks.ensureNatGateway?` / `ensurePeering?` / `ensureRoute?`
// (networks.ts) and writes back `state`. This file holds the table, the input, the schemas and the
// views; it imports nothing from networks.ts, which imports it.

/** At most this many routes (not removed) per subnet. */
export const maxRoutesPerSubnet = 32;
/** At most this many peerings (not removed) a network takes part in, either side. */
export const maxPeeringsPerNetwork = 16;

/**
 * The SQL of the edge table, run in vps/0120 (with the DNS tables: the lane's migration block).
 * `subnet_id` is the subnet a gateway or route belongs to, and a peering's own side; a peering's
 * row lives on the network that asked first (`network_id`), names the other side in
 * `peer_network_id`/`peer_subnet_id`, and is shown on both networks. One live gateway per subnet,
 * one live route per (subnet, name) and one live peering per unordered pair of subnets.
 */
export const networkEdgesSql = `
CREATE TABLE network_edges (
  id text PRIMARY KEY,
  network_id text NOT NULL REFERENCES networks,
  kind text NOT NULL CHECK (kind IN ('nat-gateway', 'peering', 'route')),
  subnet_id text NOT NULL REFERENCES network_subnets,
  name text,
  peer_network_id text REFERENCES networks,
  peer_subnet_id text REFERENCES network_subnets,
  destination cidr,
  next_hop jsonb,
  -- What the provider answered: its id (a route's NAT next hop names the gateway's) and plain outputs.
  external_id text,
  outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  CHECK ((kind = 'peering') = (peer_subnet_id IS NOT NULL AND peer_network_id IS NOT NULL)),
  CHECK ((kind = 'route') = (name IS NOT NULL AND destination IS NOT NULL AND next_hop IS NOT NULL))
);
CREATE UNIQUE INDEX network_edges_gateway ON network_edges (subnet_id)
  WHERE kind = 'nat-gateway' AND desired_state = 'present';
CREATE UNIQUE INDEX network_edges_route ON network_edges (subnet_id, name)
  WHERE kind = 'route' AND desired_state = 'present';
CREATE UNIQUE INDEX network_edges_peering
  ON network_edges (least(subnet_id, peer_subnet_id), greatest(subnet_id, peer_subnet_id))
  WHERE kind = 'peering' AND desired_state = 'present';
CREATE INDEX network_edges_live ON network_edges (network_id) WHERE state <> 'deleted';
CREATE INDEX network_edges_peer ON network_edges (peer_network_id)
  WHERE kind = 'peering' AND state <> 'deleted';
`;

// --- Views and input ---------------------------------------------------------------------------

export type EdgeState = 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';

/** Where a route sends its traffic: the subnet's NAT gateway, an instance on the subnet, or an address in it. */
export type RouteNextHop = { natGateway: true } | { instanceId: string } | { address: string };

export interface NetworkNatGatewayView {
  id: string;
  subnetId: string;
  state: EdgeState;
  message?: string;
  /** Its public egress IPv4 addresses, once the provider assigned them. */
  addresses?: string[];
}
export interface NetworkPeeringView {
  id: string;
  /** This network's side. */
  subnetId: string;
  peerNetworkId: string;
  peerSubnetId: string;
  state: EdgeState;
  message?: string;
}
export interface NetworkRouteView {
  id: string;
  subnetId: string;
  name: string;
  destination: string;
  nextHop: RouteNextHop;
  state: EdgeState;
  message?: string;
}

export interface SetNatGatewayInput {
  tenantId: string;
  networkId: string;
  subnetId: string;
  enabled: boolean;
}
export interface PeerNetworkInput {
  tenantId: string;
  networkId: string;
  subnetId: string;
  peerNetworkId: string;
  peerSubnetId: string;
  enabled: boolean;
}
export interface RouteInput {
  name: string;
  destination: string;
  nextHop: RouteNextHop;
}
export interface SetRoutesInput {
  tenantId: string;
  networkId: string;
  subnetId: string;
  routes: RouteInput[];
}

const routeName = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address as a number, or undefined when it is not one. */
export function ipv4Number(value: string): number | undefined {
  const match = ipv4.exec(value);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

/** `a.b.c.d/n` with no host bits set, prefix 0 to 32. */
function destinationCidr(value: unknown, what: string): string {
  const [address = '', prefix = '', extra] = typeof value === 'string' ? value.split('/') : [];
  const start = ipv4Number(address);
  const bits = /^\d{1,2}$/.test(prefix) ? Number(prefix) : NaN;
  if (start === undefined || extra !== undefined || !(bits >= 0 && bits <= 32))
    return fail(`${what} must be an IPv4 CIDR such as 10.8.0.0/16`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  if ((start & ~mask) >>> 0 !== 0) fail(`${what} has host bits set: write it as its network address`);
  return value as string;
}

function boolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be true or false`);
  return value as boolean;
}

function nextHop(value: unknown, what: string): RouteNextHop {
  const input = object(value, ['natGateway', 'instanceId', 'address']);
  const given = Object.keys(input).filter((field) => input[field] !== undefined);
  if (given.length !== 1)
    fail(`${what} must be exactly one of { natGateway: true }, { instanceId } or { address }`);
  if (input.natGateway !== undefined) {
    if (input.natGateway !== true) fail(`${what}.natGateway must be true`);
    return { natGateway: true };
  }
  if (input.instanceId !== undefined)
    return { instanceId: id(input.instanceId, 'inst', `${what}.instanceId`) };
  if (typeof input.address !== 'string' || ipv4Number(input.address) === undefined)
    fail(`${what}.address must be an IPv4 address`);
  return { address: input.address as string };
}

export function parseSetNatGateway(raw: unknown): SetNatGatewayInput {
  const input = object(raw, ['tenantId', 'networkId', 'subnetId', 'enabled']);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    subnetId: id(input.subnetId, 'snet', 'subnetId'),
    enabled: boolean(input.enabled, 'enabled'),
  };
}

export function parsePeerNetwork(raw: unknown): PeerNetworkInput {
  const input = object(raw, [
    'tenantId',
    'networkId',
    'subnetId',
    'peerNetworkId',
    'peerSubnetId',
    'enabled',
  ]);
  const out: PeerNetworkInput = {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    subnetId: id(input.subnetId, 'snet', 'subnetId'),
    peerNetworkId: id(input.peerNetworkId, 'net', 'peerNetworkId'),
    peerSubnetId: id(input.peerSubnetId, 'snet', 'peerSubnetId'),
    enabled: input.enabled === undefined ? true : boolean(input.enabled, 'enabled'),
  };
  if (out.subnetId === out.peerSubnetId) fail('A subnet is not peered with itself');
  return out;
}

export function parseSetRoutes(raw: unknown): SetRoutesInput {
  const input = object(raw, ['tenantId', 'networkId', 'subnetId', 'routes']);
  if (!Array.isArray(input.routes) || input.routes.length > maxRoutesPerSubnet)
    fail(`routes must list at most ${maxRoutesPerSubnet} routes`);
  const names = new Set<string>();
  const routes = (input.routes as unknown[]).map((entry, index): RouteInput => {
    const what = `routes[${index}]`;
    const route = object(entry, ['name', 'destination', 'nextHop']);
    if (typeof route.name !== 'string' || !routeName.test(route.name))
      fail(`${what}.name must be 1-42 lower-case letters, digits or '-', starting with a letter`);
    if (names.has(route.name as string)) fail(`${what}.name repeats ${route.name as string}`);
    names.add(route.name as string);
    return {
      name: route.name as string,
      destination: destinationCidr(route.destination, `${what}.destination`),
      nextHop: nextHop(route.nextHop, `${what}.nextHop`),
    };
  });
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    subnetId: id(input.subnetId, 'snet', 'subnetId'),
    routes,
  };
}

// JSON Schema descriptions of the inputs, for the generated reference and tool schemas.
const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantIdSchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};

export const networkEdgeSchemas = {
  natGateway: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: idOf('net', 'The network'),
      subnetId: idOf('snet', 'The subnet whose egress the gateway carries'),
      enabled: {
        type: 'boolean',
        description: 'true: the subnet has a NAT gateway; false: it has none',
      },
    },
    ['tenantId', 'networkId', 'subnetId', 'enabled'],
  ),
  peer: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: idOf('net', 'The network'),
      subnetId: idOf('snet', 'This network’s subnet'),
      peerNetworkId: idOf('net', 'The other network (the same one for two of its subnets)'),
      peerSubnetId: idOf('snet', 'The other network’s subnet'),
      enabled: {
        type: 'boolean',
        default: true,
        description: 'true: the two subnets are peered; false: they are not',
      },
    },
    ['tenantId', 'networkId', 'subnetId', 'peerNetworkId', 'peerSubnetId'],
  ),
  routes: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: idOf('net', 'The network'),
      subnetId: idOf('snet', 'The subnet whose routes these are'),
      routes: {
        type: 'array',
        maxItems: maxRoutesPerSubnet,
        description: 'Every static route of the subnet: the list replaces the current one',
        items: strictObject(
          {
            name: {
              type: 'string',
              pattern: routeName.source,
              maxLength: 42,
              description: 'Unique in the subnet',
            },
            destination: { type: 'string', description: 'An IPv4 CIDR, e.g. 0.0.0.0/0' },
            nextHop: strictObject(
              {
                natGateway: { const: true, description: 'The subnet’s NAT gateway' },
                instanceId: idOf('inst', 'An instance of the tenant on the subnet'),
                address: { type: 'string', description: 'A host address inside the subnet' },
              },
              [],
            ),
          },
          ['name', 'destination', 'nextHop'],
        ),
      },
    },
    ['tenantId', 'networkId', 'subnetId', 'routes'],
  ),
} satisfies Record<string, InputSchema>;

// --- Rows --------------------------------------------------------------------------------------

export interface EdgeRow {
  id: string;
  network_id: string;
  kind: 'nat-gateway' | 'peering' | 'route';
  subnet_id: string;
  name: string | null;
  peer_network_id: string | null;
  peer_subnet_id: string | null;
  destination: string | null;
  next_hop: RouteNextHop | string | null;
  external_id: string | null;
  outputs: Record<string, string> | string;
  state: EdgeState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  version: string | number;
}

export const edgeColumns = `id, network_id, kind, subnet_id, name, peer_network_id, peer_subnet_id,
  destination::text AS destination, next_hop, external_id, outputs, state, desired_state, message, version`;

export const hopOf = (row: EdgeRow): RouteNextHop =>
  typeof row.next_hop === 'string'
    ? (JSON.parse(row.next_hop) as RouteNextHop)
    : (row.next_hop as RouteNextHop);
export const outputsOf = (row: EdgeRow): Record<string, string> =>
  typeof row.outputs === 'string'
    ? (JSON.parse(row.outputs) as Record<string, string>)
    : row.outputs;

/** Every edge row of the networks that is not gone: their own, and peerings other networks hold with them. */
export async function readEdges(tx: SqlTx, networkIds: readonly string[]): Promise<EdgeRow[]> {
  if (networkIds.length === 0) return [];
  const { rows } = await tx.query<EdgeRow>(
    `SELECT ${edgeColumns} FROM network_edges
      WHERE (network_id = ANY($1::text[]) OR peer_network_id = ANY($1::text[])) AND state <> 'deleted'
      ORDER BY kind, subnet_id, name NULLS FIRST, id`,
    [networkIds],
  );
  return rows;
}

/** The edge fields of a network's view, seen from `networkId`; a field with nothing to show is absent. */
export function edgeViews(
  networkId: string,
  rows: readonly EdgeRow[],
): {
  natGateways?: NetworkNatGatewayView[];
  peerings?: NetworkPeeringView[];
  routes?: NetworkRouteView[];
} {
  const live = rows.filter((row) => row.state !== 'deleted' && row.desired_state === 'present');
  const message = (row: EdgeRow) => (row.message !== null ? { message: row.message } : {});
  const natGateways = live
    .filter((row) => row.kind === 'nat-gateway' && row.network_id === networkId)
    .map((row): NetworkNatGatewayView => {
      const addresses = (outputsOf(row).address ?? '')
        .split(',')
        .map((address) => address.trim())
        .filter((address) => address !== '');
      return {
        id: row.id,
        subnetId: row.subnet_id,
        state: row.state,
        ...message(row),
        ...(addresses.length > 0 ? { addresses } : {}),
      };
    });
  const peerings = live
    .filter(
      (row) =>
        row.kind === 'peering' &&
        (row.network_id === networkId || row.peer_network_id === networkId),
    )
    .map((row): NetworkPeeringView => {
      // Seen from the network that holds the row (also for two of its own subnets), or from its peer.
      const ours = row.network_id === networkId;
      return {
        id: row.id,
        subnetId: ours ? row.subnet_id : row.peer_subnet_id!,
        peerNetworkId: ours ? row.peer_network_id! : row.network_id,
        peerSubnetId: ours ? row.peer_subnet_id! : row.subnet_id,
        state: row.state,
        ...message(row),
      };
    });
  const routes = live
    .filter((row) => row.kind === 'route' && row.network_id === networkId)
    .map(
      (row): NetworkRouteView => ({
        id: row.id,
        subnetId: row.subnet_id,
        name: row.name!,
        destination: row.destination!,
        nextHop: hopOf(row),
        state: row.state,
        ...message(row),
      }),
    );
  return {
    ...(natGateways.length > 0 ? { natGateways } : {}),
    ...(peerings.length > 0 ? { peerings } : {}),
    ...(routes.length > 0 ? { routes } : {}),
  };
}

/** Whether `address` is a host address of `cidr` (not its network or broadcast address on /30 and wider). */
export function hostOf(cidr: string, address: string): boolean {
  const [base = '', prefixText = '32'] = cidr.split('/');
  const start = ipv4Number(base);
  const value = ipv4Number(address);
  if (start === undefined || value === undefined) return false;
  const prefix = Number(prefixText);
  const size = 2 ** (32 - prefix);
  if (value < start || value >= start + size) return false;
  return prefix >= 31 || (value !== start && value !== start + size - 1);
}
