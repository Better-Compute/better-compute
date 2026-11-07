import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteResult } from './index.js';
import type { DoState, Json } from './state.js';
import { uuidFrom } from './vpcs.js';

// VPC peerings under `/v2/vpc_peerings` (shape from the API reference: id, name, vpc_ids, status
// PROVISIONING/ACTIVE/DELETING, created_at; unverified until the live suite records one): create
// (202), list (paged), read and delete. A new peering is `PROVISIONING` for
// `emulator.peeringReads` reads, then `ACTIVE`; a delete (202) makes it `DELETING` for as many
// reads, then it is gone. Both VPCs must exist and differ, and two VPCs peer at most once (a 422).
// A VPC a peering joins can't be deleted (the VPC emulator answers its `409-vpc-in-use`).

const progress = new WeakMap<DoState, Map<string, number>>();

function progressOf(state: DoState): Map<string, number> {
  let map = progress.get(state);
  if (!map) {
    map = new Map();
    progress.set(state, map);
  }
  return map;
}

function unprocessable(message: string): RouteResult {
  return {
    status: 422,
    body: { id: 'unprocessable_entity', message, request_id: 'emulated-peer' },
  };
}

function afterRead(state: DoState, peering: Json): void {
  const reads = progressOf(state);
  const left = reads.get(peering.id);
  if (left === undefined) return;
  if (left > 1) {
    reads.set(peering.id, left - 1);
    return;
  }
  reads.delete(peering.id);
  if (peering.status === 'DELETING') state.vpcPeerings.delete(peering.id);
  else peering.status = 'ACTIVE';
}

/** The peering that joins a VPC, if any (the VPC emulator refuses to delete it). */
export function peeringOf(state: DoState, vpcId: string): Json | undefined {
  return [...state.vpcPeerings.values()].find((p) => (p.vpc_ids as string[]).includes(vpcId));
}

/** Puts a peering in the account, as if made out of band; returns the stored resource. */
export function seedPeering(state: DoState, seed: Json): Json {
  const id = seed.id ?? uuidFrom(`peer:${state.nextId()}`);
  const peering = { status: 'ACTIVE', created_at: isoSeconds(state.now()), ...seed, id };
  state.vpcPeerings.set(id, peering);
  return peering;
}

export function registerVpcPeerings(emulator: DoEmulator): void {
  emulator.route('POST', /^\/vpc_peerings$/, (context) => {
    const { state } = context;
    const body = context.body ?? {};
    if (typeof body.name !== 'string' || body.name === '') return unprocessable('Name is required');
    const ids = body.vpc_ids as string[] | undefined;
    if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1])
      return unprocessable('Two different VPCs are required');
    for (const id of ids) if (!state.vpcs.has(id)) return unprocessable(`VPC ${id} was not found`);
    if (
      [...state.vpcPeerings.values()].some((p) =>
        ids.every((id) => (p.vpc_ids as string[]).includes(id)),
      )
    )
      return unprocessable('The VPCs are already peered');
    const id = uuidFrom(`peer:${state.nextId()}:${body.name}`);
    const peering: Json = {
      id,
      name: body.name,
      vpc_ids: [...ids],
      status: 'PROVISIONING',
      created_at: isoSeconds(state.now()),
    };
    state.vpcPeerings.set(id, peering);
    if (emulator.peeringReads === 0) peering.status = 'ACTIVE';
    else progressOf(state).set(id, emulator.peeringReads);
    return { status: 202, body: { vpc_peering: structuredClone(peering) } };
  });
  emulator.route('GET', /^\/vpc_peerings$/, (context) => {
    for (const peering of [...context.state.vpcPeerings.values()])
      afterRead(context.state, peering);
    return emulator.paged(
      context,
      'vpc_peerings',
      structuredClone([...context.state.vpcPeerings.values()]),
    );
  });
  emulator.route('GET', /^\/vpc_peerings\/([0-9a-f-]+)$/, (context) => {
    const peering = context.state.vpcPeerings.get(context.match[1]!);
    if (!peering) return emulator.error('not-found');
    afterRead(context.state, peering);
    if (!context.state.vpcPeerings.has(peering.id)) return emulator.error('not-found');
    return { status: 200, body: { vpc_peering: structuredClone(peering) } };
  });
  emulator.route('DELETE', /^\/vpc_peerings\/([0-9a-f-]+)$/, (context) => {
    const { state } = context;
    const peering = state.vpcPeerings.get(context.match[1]!);
    if (!peering) return emulator.error('not-found');
    peering.status = 'DELETING';
    if (emulator.peeringReads === 0) state.vpcPeerings.delete(peering.id);
    else progressOf(state).set(peering.id, emulator.peeringReads);
    return { status: 202, body: { vpc_peering: structuredClone(peering) } };
  });
}
