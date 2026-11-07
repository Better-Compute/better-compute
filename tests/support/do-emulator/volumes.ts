import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import { isoSeconds, settleAction } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';
import { touchTags } from './tags.js';

// Block Storage under `/v2/volumes`. A volume is ready as soon as its create answers (201). Its
// actions (`POST /v2/volumes/{id}/actions`: attach, detach, resize) answer 202 with an action
// `in-progress`, which completes after `emulator.volumeActionReads` reads of the volume (or of its
// action list) and only then changes the volume; at 0 (the default) it completes at once.
// `failVolumeAction` makes the next action of a type end `errored`, changing nothing. Deleting a
// Droplet detaches its volumes, as DO does. A volume name is unique per region; a duplicate is
// the 422 `already exists`. Attaching a volume that is attached elsewhere, to a Droplet in
// another region or to a Droplet that has 7 volumes, and shrinking one, are the 422s DO clients
// report; deleting an attached volume is a 409. A volume restored from a snapshot reports the
// filesystem of the volume the snapshot was taken of.

const templates = fixture('volumes');
const volumeTemplate = templates.volume as Json;
const snapshotTemplate = templates.snapshot as Json;
const actionTemplate = fixture('actions').action as Json;

/** DO's per-Droplet cap on attached volumes. */
export const volumesPerDroplet = 7;
const maxSizeGiB = 16_384;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const tagPattern = /^[a-zA-Z0-9_:-]{1,255}$/;

/** What a volume action does to the volume once it completes, per in-progress action id. */
const effects = new WeakMap<DoState, Map<number, { reads: number; apply: () => void }>>();
/**
 * The filesystem each volume snapshot carries (its volume's when it was taken): a volume restored from it reports
 * that `filesystem_type`, as DO does. Not part of the snapshot DO shows.
 */
const snapshotFilesystems = new WeakMap<Json, string>();
/** Armed failures per state: the next volume action of the type ends `errored`. */
const armed = new WeakMap<DoState, string[]>();

function effectsOf(state: DoState): Map<number, { reads: number; apply: () => void }> {
  let map = effects.get(state);
  if (!map) {
    map = new Map();
    effects.set(state, map);
  }
  return map;
}

/** Makes the next volume action of `type` (`attach`, `detach`, `resize`) end `errored`. */
export function failVolumeAction(state: DoState, type: 'attach' | 'detach' | 'resize'): void {
  const pending = armed.get(state) ?? [];
  pending.push(type);
  armed.set(state, pending);
}

export interface VolumeSeed {
  id?: string;
  name: string;
  region?: string;
  size_gigabytes?: number;
  tags?: string[];
  droplet_ids?: number[];
  filesystem_type?: string;
  created_at?: string;
}

/** Puts a volume in the account, as if made out of band; returns the stored resource. */
export function seedVolume(state: DoState, seed: VolumeSeed): Json {
  const regionSlug = seed.region ?? 'nyc3';
  const region = state.regions.find((r) => r.slug === regionSlug) ?? {
    name: regionSlug,
    slug: regionSlug,
    features: [],
    available: true,
    sizes: [],
  };
  const volume: Json = {
    ...structuredClone(volumeTemplate),
    id: seed.id ?? randomUUID(),
    name: seed.name,
    region: structuredClone(region),
    droplet_ids: [...(seed.droplet_ids ?? [])],
    description: '',
    size_gigabytes: seed.size_gigabytes ?? 10,
    created_at: seed.created_at ?? isoSeconds(state.now()),
    filesystem_type: seed.filesystem_type ?? '',
    filesystem_label: '',
    tags: [...(seed.tags ?? [])],
  };
  touchTags(state, volume.tags);
  state.volumes.set(volume.id, volume);
  for (const dropletId of volume.droplet_ids as number[])
    state.droplets.get(dropletId)?.volume_ids?.push(volume.id);
  return volume;
}

/** A read of a volume: counts toward its in-progress actions, which may complete after it. */
function afterRead(state: DoState, volumeId: string): void {
  const pending = effectsOf(state);
  for (const action of [...state.actions.values()]) {
    if (action.resource_type !== 'volume' || action.volume_id !== volumeId) continue;
    const effect = pending.get(action.id);
    if (!effect) continue;
    if (effect.reads > 1) {
      effect.reads -= 1;
      continue;
    }
    pending.delete(action.id);
    if (action.status !== 'in-progress') continue;
    settleAction(state, action, 'completed');
    effect.apply();
  }
}

/** The volume without the emulator's bookkeeping. */
function view(volume: Json): Json {
  return structuredClone(volume);
}

/** An action body without the emulator's `volume_id`. */
function actionView(action: Json): Json {
  const { volume_id: _volume, ...rest } = action;
  return structuredClone(rest);
}

function attach(state: DoState, volume: Json, droplet: Json): void {
  if (!(volume.droplet_ids as number[]).includes(droplet.id)) volume.droplet_ids.push(droplet.id);
  const ids = (droplet.volume_ids ??= []) as string[];
  if (!ids.includes(volume.id)) ids.push(volume.id);
}

function detach(state: DoState, volume: Json, dropletId: number): void {
  volume.droplet_ids = (volume.droplet_ids as number[]).filter((id) => id !== dropletId);
  const droplet = state.droplets.get(dropletId);
  if (droplet)
    droplet.volume_ids = ((droplet.volume_ids ?? []) as string[]).filter((id) => id !== volume.id);
}

/** Detaches every volume of a Droplet that is being deleted. */
export function detachAll(state: DoState, dropletId: number): void {
  for (const volume of state.volumes.values())
    if ((volume.droplet_ids as number[]).includes(dropletId)) detach(state, volume, dropletId);
}

function startVolumeAction(
  emulator: DoEmulator,
  state: DoState,
  volume: Json,
  type: 'attach' | 'detach' | 'resize',
  apply: () => void,
): Json {
  const action: Json = {
    ...structuredClone(actionTemplate),
    id: state.nextId(),
    status: 'in-progress',
    type: `${type}_volume`,
    started_at: isoSeconds(state.now()),
    completed_at: null,
    resource_id: null,
    resource_type: 'volume',
    region: structuredClone(volume.region),
    region_slug: volume.region.slug,
    volume_id: volume.id,
  };
  state.actions.set(action.id, action);
  const pending = armed.get(state) ?? [];
  const failure = pending.indexOf(type);
  if (failure >= 0) {
    pending.splice(failure, 1);
    settleAction(state, action, 'errored');
  } else if (emulator.volumeActionReads <= 0) {
    settleAction(state, action, 'completed');
    apply();
  } else effectsOf(state).set(action.id, { reads: emulator.volumeActionReads, apply });
  return action;
}

function create(emulator: DoEmulator, context: RouteContext) {
  const { state } = context;
  const body = context.body ?? {};
  const name = body.name;
  if (typeof name !== 'string' || !namePattern.test(name)) return emulator.error('422-unknown');
  const region = state.regions.find((r) => r.slug === body.region);
  if (!region) return emulator.error('422-unknown');
  const size = body.size_gigabytes;
  if (!Number.isInteger(size) || size < 1 || size > maxSizeGiB)
    return emulator.error('422-unknown');
  const fs = body.filesystem_type;
  if (fs !== undefined && fs !== 'ext4' && fs !== 'xfs') return emulator.error('422-unknown');
  const tags = (body.tags ?? []) as unknown[];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && tagPattern.test(t)))
    return emulator.error('422-unknown');
  let inherited: string | undefined;
  if (body.snapshot_id !== undefined) {
    const snapshot = state.snapshots.get(body.snapshot_id);
    if (!snapshot || snapshot.resource_type !== 'volume') return emulator.error('422-unknown');
    if (!(snapshot.regions as string[]).includes(region.slug))
      return emulator.error('422-volume-region');
    if (size < snapshot.min_disk_size) return emulator.error('422-unknown');
    inherited = snapshotFilesystems.get(snapshot) ?? '';
  }
  for (const volume of state.volumes.values())
    if (volume.name === name && volume.region.slug === region.slug)
      return emulator.error('422-name-in-use');
  if (state.volumes.size >= emulator.volumeLimit) return emulator.error('422-volume-limit');
  const volume = seedVolume(state, {
    name,
    region: region.slug,
    size_gigabytes: size,
    tags: tags as string[],
    // A restore carries the snapshot's filesystem.
    ...(inherited !== undefined ? { filesystem_type: inherited } : fs !== undefined ? { filesystem_type: fs } : {}),
  });
  if (typeof body.description === 'string') volume.description = body.description;
  if (body.snapshot_id !== undefined) volume.snapshot_id = body.snapshot_id;
  return { status: 201, body: { volume: view(volume) } };
}

function act(emulator: DoEmulator, context: RouteContext) {
  const { state } = context;
  const volume = state.volumes.get(context.match[1]!);
  if (!volume) return emulator.error('not-found');
  const body = context.body ?? {};
  if (body.region !== undefined && body.region !== volume.region.slug)
    return emulator.error('422-volume-region');
  const ids = volume.droplet_ids as number[];
  let action: Json;
  switch (body.type) {
    case 'attach': {
      const droplet = state.droplets.get(Number(body.droplet_id));
      if (!droplet) return emulator.error('not-found');
      if (droplet.region.slug !== volume.region.slug) return emulator.error('422-volume-region');
      if (ids.length > 0 && !ids.includes(droplet.id))
        return emulator.error('422-volume-attached-elsewhere');
      if (((droplet.volume_ids ?? []) as string[]).length >= volumesPerDroplet)
        return emulator.error('422-volumes-per-droplet');
      action = startVolumeAction(emulator, state, volume, 'attach', () =>
        attach(state, volume, droplet),
      );
      break;
    }
    case 'detach': {
      const dropletId = Number(body.droplet_id);
      if (!ids.includes(dropletId)) return emulator.error('422-unknown');
      action = startVolumeAction(emulator, state, volume, 'detach', () =>
        detach(state, volume, dropletId),
      );
      break;
    }
    case 'resize': {
      const size = body.size_gigabytes;
      if (!Number.isInteger(size) || size > maxSizeGiB) return emulator.error('422-unknown');
      if (size <= volume.size_gigabytes) return emulator.error('422-volume-shrink');
      action = startVolumeAction(emulator, state, volume, 'resize', () => {
        volume.size_gigabytes = size;
      });
      break;
    }
    default:
      return emulator.error('422-unknown');
  }
  return { status: 202, body: { action: actionView(action) } };
}

export function registerVolumes(emulator: DoEmulator): void {
  emulator.route('POST', /^\/volumes$/, (context) => create(emulator, context));

  emulator.route('GET', /^\/volumes$/, (context) => {
    const name = context.url.searchParams.get('name');
    const region = context.url.searchParams.get('region');
    const volumes = [...context.state.volumes.values()]
      .filter((v) => name === null || v.name === name)
      .filter((v) => region === null || v.region.slug === region)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return emulator.paged(context, 'volumes', volumes.map(view));
  });

  emulator.route('GET', /^\/volumes\/([0-9a-f-]{36})$/, (context) => {
    const id = context.match[1]!;
    afterRead(context.state, id);
    const volume = context.state.volumes.get(id);
    if (!volume) return emulator.error('not-found');
    return { status: 200, body: { volume: view(volume) } };
  });

  emulator.route('DELETE', /^\/volumes\/([0-9a-f-]{36})$/, (context) => {
    const volume = context.state.volumes.get(context.match[1]!);
    if (!volume) return emulator.error('not-found');
    if ((volume.droplet_ids as number[]).length > 0) return emulator.error('409-volume-attached');
    context.state.volumes.delete(volume.id);
    return { status: 204 };
  });

  emulator.route('POST', /^\/volumes\/([0-9a-f-]{36})\/actions$/, (context) =>
    act(emulator, context),
  );

  emulator.route('GET', /^\/volumes\/([0-9a-f-]{36})\/actions$/, (context) => {
    const id = context.match[1]!;
    afterRead(context.state, id);
    if (!context.state.volumes.has(id)) return emulator.error('not-found');
    const actions = [...context.state.actions.values()]
      .filter((a) => a.resource_type === 'volume' && a.volume_id === id)
      .map(actionView);
    return emulator.paged(context, 'actions', actions);
  });

  // Volume snapshots: `POST /v2/volumes/{id}/snapshots` answers 201 with the snapshot (DO keeps
  // no name unique); `GET /v2/volumes/{id}/snapshots` lists a volume's, `GET` and `DELETE
  // /v2/snapshots/{id}` (and `/v2/volumes/snapshots/{id}`) read and delete one. A snapshot
  // outlives its volume.
  emulator.route('POST', /^\/volumes\/([0-9a-f-]{36})\/snapshots$/, (context) => {
    const volume = context.state.volumes.get(context.match[1]!);
    if (!volume) return emulator.error('not-found');
    const name = context.body?.name;
    if (typeof name !== 'string' || name === '' || name.length > 255)
      return emulator.error('422-unknown');
    const tags = (context.body?.tags ?? []) as unknown[];
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && tagPattern.test(t)))
      return emulator.error('422-unknown');
    const snapshot = seedSnapshot(context.state, { volume, name, tags: tags as string[] });
    return { status: 201, body: { snapshot: structuredClone(snapshot) } };
  });

  emulator.route('GET', /^\/volumes\/([0-9a-f-]{36})\/snapshots$/, (context) => {
    const id = context.match[1]!;
    if (!context.state.volumes.has(id)) return emulator.error('not-found');
    const snapshots = [...context.state.snapshots.values()].filter((s) => s.resource_id === id);
    return emulator.paged(
      context,
      'snapshots',
      snapshots.map((s) => structuredClone(s)),
    );
  });

  for (const pattern of [/^\/snapshots\/([^/]+)$/, /^\/volumes\/snapshots\/([^/]+)$/]) {
    emulator.route('GET', pattern, (context) => {
      const snapshot = context.state.snapshots.get(context.match[1]!);
      if (!snapshot) return emulator.error('not-found');
      return { status: 200, body: { snapshot: structuredClone(snapshot) } };
    });
    emulator.route('DELETE', pattern, (context) => {
      if (!context.state.snapshots.delete(context.match[1]!)) return emulator.error('not-found');
      return { status: 204 };
    });
  }
}

/** Puts a snapshot of a volume in the account; returns the stored resource. */
export function seedSnapshot(
  state: DoState,
  seed: { volume: Json; name: string; tags?: string[]; id?: string; created_at?: string },
): Json {
  const snapshot: Json = {
    ...structuredClone(snapshotTemplate),
    id: seed.id ?? randomUUID(),
    name: seed.name,
    regions: [seed.volume.region.slug],
    created_at: seed.created_at ?? isoSeconds(state.now()),
    resource_id: seed.volume.id,
    resource_type: 'volume',
    min_disk_size: seed.volume.size_gigabytes,
    size_gigabytes: 0,
    tags: [...(seed.tags ?? [])],
  };
  touchTags(state, snapshot.tags);
  state.snapshots.set(snapshot.id, snapshot);
  snapshotFilesystems.set(snapshot, String(seed.volume.filesystem_type ?? ''));
  return snapshot;
}
