import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteResult } from './index.js';
import { fixture, type DoState, type Json } from './state.js';
import { uuidFrom } from './vpcs.js';

// VPC NAT gateways under `/v2/nat_gateways`: create (202), list (paged, filtered by `region` and
// `name`), read and delete over `state.natGateways`. A new gateway is `NEW` for
// `emulator.natGatewayReads` reads (a list entry counts), then `ACTIVE` with a public egress
// address from TEST-NET-3 and a gateway address inside each VPC it serves. Each VPC it names must
// exist and be in its region, and a VPC has at most one gateway (a 422). A VPC a gateway still
// serves can't be deleted (the VPC emulator answers its `409-vpc-in-use`).

const template = fixture('nat-gateways').nat_gateway as Json;
const readsLeft = new WeakMap<DoState, Map<string, number>>();

function readsOf(state: DoState): Map<string, number> {
  let map = readsLeft.get(state);
  if (!map) {
    map = new Map();
    readsLeft.set(state, map);
  }
  return map;
}

function unprocessable(message: string): RouteResult {
  return { status: 422, body: { id: 'unprocessable_entity', message, request_id: 'emulated-nat' } };
}

function activate(state: DoState, gateway: Json): void {
  gateway.state = 'ACTIVE';
  gateway.egresses = { public_gateways: [{ ipv4: `203.0.113.${(state.nextId() % 199) + 1}` }] };
  for (const vpc of gateway.vpcs as Json[]) {
    const range = String(state.vpcs.get(vpc.vpc_uuid)?.ip_range ?? '10.10.0.0/24');
    vpc.gateway_ip = range.replace(/\.\d+\/\d+$/, '.7');
  }
}

function afterRead(state: DoState, gateway: Json): void {
  const reads = readsOf(state);
  const left = reads.get(gateway.id);
  if (left === undefined) return;
  if (left > 1) {
    reads.set(gateway.id, left - 1);
    return;
  }
  reads.delete(gateway.id);
  activate(state, gateway);
}

/** Whether a VPC is served by a NAT gateway (the VPC emulator refuses to delete it). */
export function natGatewayOf(state: DoState, vpcId: string): Json | undefined {
  return [...state.natGateways.values()].find((g) =>
    (g.vpcs as Json[]).some((vpc) => vpc.vpc_uuid === vpcId),
  );
}

/** Puts a NAT gateway in the account, as if made out of band; returns the stored resource. */
export function seedNatGateway(state: DoState, seed: Json & { vpc: string }): Json {
  const { vpc, ...rest } = seed;
  const id = rest.id ?? uuidFrom(`nat:${state.nextId()}`);
  const gateway: Json = {
    ...structuredClone(template),
    created_at: isoSeconds(state.now()),
    ...rest,
    id,
    vpcs: [{ vpc_uuid: vpc, gateway_ip: '', default_gateway: true }],
  };
  activate(state, gateway);
  state.natGateways.set(id, gateway);
  return gateway;
}

export function registerNatGateways(emulator: DoEmulator): void {
  emulator.route('POST', /^\/nat_gateways$/, (context) => {
    const { state } = context;
    const body = context.body ?? {};
    if (typeof body.name !== 'string' || body.name === '') return unprocessable('Name is required');
    if (body.type !== 'PUBLIC') return unprocessable('Type is invalid');
    if (!state.regions.some((r) => r.slug === body.region))
      return unprocessable('Region is invalid');
    const vpcs = (body.vpcs ?? []) as Json[];
    if (vpcs.length === 0) return unprocessable('At least one VPC is required');
    for (const vpc of vpcs) {
      const found = state.vpcs.get(vpc.vpc_uuid);
      if (!found || found.region !== body.region) return unprocessable('VPC was not found');
      if (natGatewayOf(state, vpc.vpc_uuid))
        return unprocessable('The VPC already has a NAT gateway');
    }
    const id = uuidFrom(`nat:${state.nextId()}:${body.name}`);
    const gateway: Json = {
      ...structuredClone(template),
      id,
      name: body.name,
      type: 'PUBLIC',
      state: 'NEW',
      region: body.region,
      size: body.size ?? 1,
      vpcs: vpcs.map((vpc) => ({
        vpc_uuid: vpc.vpc_uuid,
        gateway_ip: '',
        default_gateway: vpc.default_gateway === true,
      })),
      egresses: { public_gateways: [] },
      created_at: isoSeconds(state.now()),
      updated_at: isoSeconds(state.now()),
    };
    state.natGateways.set(id, gateway);
    if (emulator.natGatewayReads === 0) activate(state, gateway);
    else readsOf(state).set(id, emulator.natGatewayReads);
    return { status: 202, body: { nat_gateway: structuredClone(gateway) } };
  });
  emulator.route('GET', /^\/nat_gateways$/, (context) => {
    const region = context.url.searchParams.get('region');
    const name = context.url.searchParams.get('name');
    const all = [...context.state.natGateways.values()].filter(
      (g) => (region === null || g.region === region) && (name === null || g.name === name),
    );
    for (const gateway of all) afterRead(context.state, gateway);
    return emulator.paged(context, 'nat_gateways', structuredClone(all));
  });
  emulator.route('GET', /^\/nat_gateways\/([0-9a-f-]+)$/, (context) => {
    const gateway = context.state.natGateways.get(context.match[1]!);
    if (!gateway) return emulator.error('not-found');
    afterRead(context.state, gateway);
    return { status: 200, body: { nat_gateway: structuredClone(gateway) } };
  });
  emulator.route('DELETE', /^\/nat_gateways\/([0-9a-f-]+)$/, (context) => {
    const id = context.match[1]!;
    if (!context.state.natGateways.delete(id)) return emulator.error('not-found');
    readsOf(context.state).delete(id);
    return { status: 204 };
  });
}
