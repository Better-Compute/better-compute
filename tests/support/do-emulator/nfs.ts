import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext, RouteResult } from './index.js';
import { isoSeconds } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';

// Network File Storage under `/v2/nfs` (P6). Shapes come from the `nfs` fixture, which is
// unverified (see its provenance). Every share call names the share's region (`?region=`, or
// `region` in an action body): a share read in another region is a 404, a list without one a 422.
//
// A share is created `CREATING` and turns `ACTIVE` after `emulator.nfsCreateReads` reads of it (at
// 0, the default, it is `ACTIVE` at once); `host` and `mount_path` appear only once it is active.
// It is reachable from the VPCs in `vpc_ids` (at least one, each in its region). Share actions
// (`POST /v2/nfs/{id}/actions`: `resize`, `snapshot`, `attach`, `detach`, with `params`) answer
// 201 with an action `in-progress`, which completes after `emulator.nfsActionReads` reads of the
// share and only then changes it; a second action while one runs is the `pending event` 422.
// `failNfsAction` makes the next action of a type end `errored`, changing nothing. A share name is
// unique per region (the `422-name-in-use` fixture) unless `emulator.nfsUniqueNames` is cleared.
// Snapshots outlive their share.

const templates = fixture('nfs');
const shareTemplate = templates.share as Json;
const snapshotTemplate = templates.snapshot as Json;
const actionTemplate = templates.action as Json;

export const minShareGiB = 50;
const maxShareGiB = 16_384;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

interface Running {
  action: Json;
  reads: number;
  apply: () => void;
}

/** The action still running on each share (by share id). */
const running = new WeakMap<DoState, Map<string, Running>>();
/** Armed failures per state: the next share action of the type ends `errored`. */
const armed = new WeakMap<DoState, string[]>();
/** Reads left before a `CREATING` share turns `ACTIVE`, per share id. */
const creating = new WeakMap<DoState, Map<string, number>>();

function mapOf<V>(store: WeakMap<DoState, Map<string, V>>, state: DoState): Map<string, V> {
  let map = store.get(state);
  if (!map) {
    map = new Map();
    store.set(state, map);
  }
  return map;
}

/** Makes the next share action of `type` end `errored`. */
export function failNfsAction(
  state: DoState,
  type: 'resize' | 'snapshot' | 'attach' | 'detach',
): void {
  const pending = armed.get(state) ?? [];
  pending.push(type);
  armed.set(state, pending);
}

export interface ShareSeed {
  id?: string;
  name: string;
  region?: string;
  size_gib?: number;
  vpc_ids?: string[];
  status?: 'CREATING' | 'ACTIVE' | 'FAILED';
  created_at?: string;
}

function activate(share: Json): void {
  share.status = 'ACTIVE';
  share.host = `10.250.${(share.name.length * 7) % 250}.2`;
  share.mount_path = `/${100000 + share.name.length}/${share.id}`;
}

/** Puts a share in the account, as if made out of band; returns the stored resource. */
export function seedShare(state: DoState, seed: ShareSeed): Json {
  const share: Json = {
    ...structuredClone(shareTemplate),
    id: seed.id ?? randomUUID(),
    name: seed.name,
    region: seed.region ?? 'nyc3',
    size_gib: seed.size_gib ?? 100,
    created_at: seed.created_at ?? isoSeconds(state.now()),
    vpc_ids: [...(seed.vpc_ids ?? [])],
  };
  delete share.host;
  delete share.mount_path;
  if ((seed.status ?? 'ACTIVE') === 'ACTIVE') activate(share);
  else share.status = seed.status;
  state.nfsShares.set(share.id, share);
  return share;
}

/** Puts a snapshot of a share in the account; returns the stored resource. */
export function seedShareSnapshot(
  state: DoState,
  seed: { share: Json; name: string; id?: string; status?: string; created_at?: string },
): Json {
  const snapshot: Json = {
    ...structuredClone(snapshotTemplate),
    id: seed.id ?? randomUUID(),
    name: seed.name,
    size_gib: seed.share.size_gib,
    region: seed.share.region,
    status: seed.status ?? 'ACTIVE',
    created_at: seed.created_at ?? isoSeconds(state.now()),
    share_id: seed.share.id,
  };
  state.nfsSnapshots.set(snapshot.id, snapshot);
  return snapshot;
}

/** A read of a share: advances its create and its running action. */
function afterRead(state: DoState, share: Json): void {
  const reads = mapOf(creating, state);
  const left = reads.get(share.id);
  if (left !== undefined) {
    if (left > 1) reads.set(share.id, left - 1);
    else {
      reads.delete(share.id);
      activate(share);
    }
  }
  const runs = mapOf(running, state);
  const run = runs.get(share.id);
  if (!run) return;
  if (run.reads > 1) {
    run.reads -= 1;
    return;
  }
  runs.delete(share.id);
  run.action.status = 'completed';
  run.action.completed_at = isoSeconds(state.now());
  run.apply();
}

function view(share: Json): Json {
  return structuredClone(share);
}

function regionOf(context: RouteContext): string | null {
  return context.url.searchParams.get('region');
}

/** The share at the path's id, in the request's region; undefined is a 404. */
function shareAt(context: RouteContext, region: string | null): Json | undefined {
  const share = context.state.nfsShares.get(context.match[1]!);
  if (!share || share.status === 'DELETED' || region !== share.region) return undefined;
  return share;
}

function pendingEvent(emulator: DoEmulator): RouteResult {
  const failure = emulator.error('422-pending-event');
  return {
    status: failure.status,
    body: { ...(failure.body as Json), message: 'The share has a pending event' },
  };
}

function create(emulator: DoEmulator, context: RouteContext): RouteResult {
  const { state } = context;
  const body = context.body ?? {};
  if (typeof body.name !== 'string' || !namePattern.test(body.name))
    return emulator.error('422-unknown');
  const region = state.regions.find((r) => r.slug === body.region);
  if (!region) return emulator.error('422-unknown');
  const size = body.size_gib;
  if (!Number.isInteger(size) || size < minShareGiB || size > maxShareGiB)
    return emulator.error('422-unknown');
  const vpcs = body.vpc_ids as unknown;
  if (!Array.isArray(vpcs) || vpcs.length === 0) return emulator.error('422-unknown');
  for (const vpcId of vpcs) {
    const vpc = state.vpcs.get(String(vpcId));
    if (!vpc || vpc.region !== region.slug) return emulator.error('422-unknown');
  }
  if (emulator.nfsUniqueNames)
    for (const share of state.nfsShares.values())
      if (share.name === body.name && share.region === region.slug && share.status !== 'DELETED')
        return emulator.error('422-name-in-use');
  const share = seedShare(state, {
    name: body.name,
    region: region.slug,
    size_gib: size,
    vpc_ids: [...new Set(vpcs.map(String))],
    status: emulator.nfsCreateReads > 0 ? 'CREATING' : 'ACTIVE',
  });
  if (emulator.nfsCreateReads > 0) mapOf(creating, state).set(share.id, emulator.nfsCreateReads);
  return { status: 201, body: { share: view(share) } };
}

function act(emulator: DoEmulator, context: RouteContext): RouteResult {
  const { state } = context;
  const body = context.body ?? {};
  const share = shareAt(context, typeof body.region === 'string' ? body.region : null);
  if (!share) return emulator.error('not-found');
  const params = (body.params ?? {}) as Json;
  const runs = mapOf(running, state);
  if (runs.has(share.id) || share.status !== 'ACTIVE') return pendingEvent(emulator);
  let apply: () => void;
  switch (body.type) {
    case 'resize': {
      const size = params.size_gib;
      if (!Number.isInteger(size) || size > maxShareGiB) return emulator.error('422-unknown');
      if (size <= share.size_gib) return emulator.error('422-volume-shrink');
      apply = () => {
        share.size_gib = size;
      };
      break;
    }
    case 'snapshot': {
      const name = params.name;
      if (typeof name !== 'string' || name === '' || name.length > 255)
        return emulator.error('422-unknown');
      apply = () => {
        seedShareSnapshot(state, { share, name });
      };
      break;
    }
    case 'attach': {
      const vpc = state.vpcs.get(String(params.vpc_id));
      if (!vpc || vpc.region !== share.region) return emulator.error('422-unknown');
      if ((share.vpc_ids as string[]).includes(vpc.id)) return emulator.error('422-unknown');
      apply = () => {
        if (!(share.vpc_ids as string[]).includes(vpc.id)) share.vpc_ids.push(vpc.id);
      };
      break;
    }
    case 'detach': {
      const vpcId = String(params.vpc_id);
      if (!(share.vpc_ids as string[]).includes(vpcId)) return emulator.error('422-unknown');
      apply = () => {
        share.vpc_ids = (share.vpc_ids as string[]).filter((id) => id !== vpcId);
      };
      break;
    }
    default:
      return emulator.error('422-unknown');
  }
  const action: Json = {
    ...structuredClone(actionTemplate),
    status: 'in-progress',
    type: body.type,
    started_at: isoSeconds(state.now()),
    completed_at: null,
    resource_id: share.id,
    region_slug: share.region,
  };
  const pending = armed.get(state) ?? [];
  const failure = pending.indexOf(body.type);
  if (failure >= 0) {
    pending.splice(failure, 1);
    action.status = 'errored';
    action.completed_at = isoSeconds(state.now());
  } else if (emulator.nfsActionReads <= 0) {
    action.status = 'completed';
    action.completed_at = isoSeconds(state.now());
    apply();
  } else runs.set(share.id, { action, reads: emulator.nfsActionReads, apply });
  return { status: 201, body: { action: structuredClone(action) } };
}

export function registerNfs(emulator: DoEmulator): void {
  emulator.route('POST', /^\/nfs$/, (context) => create(emulator, context));

  emulator.route('GET', /^\/nfs$/, (context) => {
    const region = regionOf(context);
    if (region === null) return emulator.error('422-unknown');
    const shares = [...context.state.nfsShares.values()]
      .filter((s) => s.region === region && s.status !== 'DELETED')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const share of shares) afterRead(context.state, share);
    return emulator.paged(context, 'shares', shares.map(view));
  });

  // Snapshot routes come before `/nfs/{id}`, which would otherwise take `snapshots` as an id.
  emulator.route('GET', /^\/nfs\/snapshots$/, (context) => {
    const region = regionOf(context);
    if (region === null) return emulator.error('422-unknown');
    const shareId = context.url.searchParams.get('share_id');
    const snapshots = [...context.state.nfsSnapshots.values()]
      .filter((s) => s.region === region && (shareId === null || s.share_id === shareId))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return emulator.paged(
      context,
      'snapshots',
      snapshots.map((s) => structuredClone(s)),
    );
  });

  emulator.route('GET', /^\/nfs\/snapshots\/([^/]+)$/, (context) => {
    const snapshot = context.state.nfsSnapshots.get(context.match[1]!);
    if (!snapshot || snapshot.region !== regionOf(context)) return emulator.error('not-found');
    return { status: 200, body: { snapshot: structuredClone(snapshot) } };
  });

  emulator.route('DELETE', /^\/nfs\/snapshots\/([^/]+)$/, (context) => {
    const snapshot = context.state.nfsSnapshots.get(context.match[1]!);
    if (!snapshot || snapshot.region !== regionOf(context)) return emulator.error('not-found');
    context.state.nfsSnapshots.delete(snapshot.id);
    return { status: 204 };
  });

  emulator.route('GET', /^\/nfs\/([^/]+)$/, (context) => {
    const share = shareAt(context, regionOf(context));
    if (!share) return emulator.error('not-found');
    afterRead(context.state, share);
    return { status: 200, body: { share: view(share) } };
  });

  emulator.route('DELETE', /^\/nfs\/([^/]+)$/, (context) => {
    const share = shareAt(context, regionOf(context));
    if (!share) return emulator.error('not-found');
    if (mapOf(running, context.state).has(share.id)) return pendingEvent(emulator);
    context.state.nfsShares.delete(share.id);
    mapOf(creating, context.state).delete(share.id);
    return { status: 204 };
  });

  emulator.route('POST', /^\/nfs\/([^/]+)\/actions$/, (context) => act(emulator, context));
}
