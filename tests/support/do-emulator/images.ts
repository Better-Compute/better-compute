import type { DoEmulator, RouteContext } from './index.js';
import { isoSeconds } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';
import { hasTag, touchTags } from './tags.js';

// Images under `/v2/images` (P3). Public distribution images are seeded from the fixture. A
// custom-image import (`POST /v2/images` with a `url`) answers 202 with the image `NEW` and no
// regions; it turns `available` in its region after `emulator.importReads` reads of it (a
// `GET /images/{id}` or a list it appears in). `failImport` makes one end `deleted` with an
// `error_message`, as DO reports a failed import. A `transfer` image action (`POST
// /v2/images/{id}/actions`) is an action with `resource_type: 'image'`; it completes, and adds
// the region, after `emulator.transferReads` reads of the image. `GET /v2/images` filters by
// `private=true` (no public images), `type` and `tag_name`.

const templates = fixture('images');
const customTemplate = templates.custom as Json;
const actionTemplate = fixture('actions').action as Json;

const tagPattern = /^[a-zA-Z0-9_:-]{1,255}$/;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const distributions = new Set([
  'Arch Linux',
  'CentOS',
  'CoreOS',
  'Debian',
  'Fedora',
  'Fedora Atomic',
  'FreeBSD',
  'Gentoo',
  'openSUSE',
  'RancherOS',
  'Rocky Linux',
  'Ubuntu',
  'Unknown',
]);

interface Progress {
  /** Reads before the import completes. */
  imports: Map<number, number>;
  /** Per image: in-progress transfers and the reads left before each completes. */
  transfers: Map<number, { action: Json; region: string; left: number }[]>;
}

const progress = new WeakMap<DoState, Progress>();

function progressOf(state: DoState): Progress {
  let p = progress.get(state);
  if (!p) {
    p = { imports: new Map(), transfers: new Map() };
    progress.set(state, p);
  }
  return p;
}

/** The images of an emulator state. */
export function imagesOf(state: DoState): Map<number, Json> {
  return state.images;
}

export interface ImageSeed {
  name?: string;
  regions?: string[];
  tags?: string[];
  status?: 'NEW' | 'available' | 'pending' | 'deleted' | 'retired';
  created_at?: string;
  type?: string;
}

/** Puts a private image in the account, as if made out of band; returns the stored resource. */
export function seedImage(state: DoState, seed: ImageSeed = {}): Json {
  const id = state.nextId();
  const image: Json = {
    ...structuredClone(customTemplate),
    id,
    name: seed.name ?? `image-${id}`,
    type: seed.type ?? 'custom',
    regions: [...(seed.regions ?? ['nyc3'])],
    tags: [...(seed.tags ?? [])],
    status: seed.status ?? 'available',
    created_at: seed.created_at ?? isoSeconds(state.now()),
    error_message: '',
  };
  touchTags(state, image.tags);
  imagesOf(state).set(id, image);
  return image;
}

/** Makes an import end `deleted`, with DO's error message, instead of `available`. */
export function failImport(state: DoState, id: number, message = 'Failed to import image'): void {
  const image = imagesOf(state).get(id);
  if (!image) throw new Error(`failImport: no image ${id}`);
  progressOf(state).imports.delete(id);
  image.status = 'deleted';
  image.error_message = message;
}

/** A read of an image: counts toward its import and its transfers. */
function afterRead(state: DoState, image: Json): void {
  const p = progressOf(state);
  const left = p.imports.get(image.id);
  if (left !== undefined) {
    if (left > 1) p.imports.set(image.id, left - 1);
    else {
      p.imports.delete(image.id);
      image.status = 'available';
      image.regions = [image.importRegion];
      image.size_gigabytes = 2.5;
      image.min_disk_size = 10;
    }
  }
  const transfers = p.transfers.get(image.id) ?? [];
  for (const transfer of [...transfers]) {
    if (transfer.left > 1) {
      transfer.left -= 1;
      continue;
    }
    transfers.splice(transfers.indexOf(transfer), 1);
    transfer.action.status = 'completed';
    transfer.action.completed_at = isoSeconds(state.now());
    if (!(image.regions as string[]).includes(transfer.region))
      (image.regions as string[]).push(transfer.region);
  }
}

/** A copy to answer with; DO's body has no `importRegion`. */
function view(image: Json): Json {
  const { importRegion: _region, ...rest } = image;
  return structuredClone(rest);
}

function byIdOrSlug(state: DoState, key: string): Json | undefined {
  const images = imagesOf(state);
  if (/^\d+$/.test(key)) return images.get(Number(key));
  return [...images.values()].find((image) => image.slug === key);
}

function importImage(emulator: DoEmulator, context: RouteContext) {
  const { state } = context;
  const body = context.body ?? {};
  if (typeof body.name !== 'string' || !namePattern.test(body.name))
    return emulator.error('422-unknown');
  if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url))
    return emulator.error('422-unknown');
  if (!state.regions.some((r) => r.slug === body.region)) return emulator.error('422-unknown');
  if (body.distribution !== undefined && !distributions.has(body.distribution))
    return emulator.error('422-unknown');
  const tags = (body.tags ?? []) as unknown[];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && tagPattern.test(t)))
    return emulator.error('422-unknown');
  const id = state.nextId();
  const image: Json = {
    ...structuredClone(customTemplate),
    id,
    name: body.name,
    distribution: body.distribution ?? 'Unknown',
    description: typeof body.description === 'string' ? body.description : '',
    regions: [],
    tags: [...(tags as string[])],
    status: 'NEW',
    created_at: isoSeconds(state.now()),
    error_message: '',
    importRegion: body.region,
  };
  touchTags(state, image.tags);
  imagesOf(state).set(id, image);
  progressOf(state).imports.set(id, emulator.importReads);
  return { status: 202, body: { image: view(image) } };
}

function transfer(emulator: DoEmulator, context: RouteContext, image: Json) {
  const { state } = context;
  const type = context.body?.type;
  if (type !== 'transfer') return emulator.error('422-unknown');
  const region = context.body?.region;
  if (!state.regions.some((r) => r.slug === region)) return emulator.error('422-unknown');
  if (image.status !== 'available') return emulator.error('422-unknown');
  const action: Json = {
    ...structuredClone(actionTemplate),
    id: state.nextId(),
    status: 'in-progress',
    type: 'transfer',
    started_at: isoSeconds(state.now()),
    completed_at: null,
    resource_id: image.id,
    resource_type: 'image',
    region: state.regions.find((r) => r.slug === region),
    region_slug: region,
  };
  state.actions.set(action.id, action);
  const transfers = progressOf(state).transfers.get(image.id) ?? [];
  transfers.push({ action, region, left: emulator.transferReads });
  progressOf(state).transfers.set(image.id, transfers);
  return { status: 201, body: { action: structuredClone(action) } };
}

export function registerImages(emulator: DoEmulator): void {
  for (const image of templates.images as Json[])
    emulator.state.images.set(image.id, structuredClone(image));
  emulator.route('GET', /^\/images$/, (context) => {
    const query = context.url.searchParams;
    const tag = query.get('tag_name');
    const type = query.get('type');
    let images = [...imagesOf(context.state).values()].sort((a, b) => a.id - b.id);
    if (query.get('private') === 'true') images = images.filter((i) => !i.public);
    if (type !== null)
      images = images.filter((i) =>
        type === 'distribution' ? i.public && i.type === 'base' : i.type === type,
      );
    if (tag !== null) images = images.filter((i) => hasTag(i, tag));
    for (const image of images) afterRead(context.state, image);
    return emulator.paged(context, 'images', images.map(view));
  });

  emulator.route('GET', /^\/images\/([^/]+)$/, (context) => {
    const image = byIdOrSlug(context.state, decodeURIComponent(context.match[1]!));
    if (!image) return emulator.error('not-found');
    afterRead(context.state, image);
    return { status: 200, body: { image: view(image) } };
  });

  emulator.route('POST', /^\/images$/, (context) => importImage(emulator, context));

  emulator.route('DELETE', /^\/images\/(\d+)$/, (context) => {
    const id = Number(context.match[1]);
    const image = imagesOf(context.state).get(id);
    if (!image || image.public) return emulator.error('not-found');
    imagesOf(context.state).delete(id);
    progressOf(context.state).imports.delete(id);
    progressOf(context.state).transfers.delete(id);
    return { status: 204 };
  });

  emulator.route('POST', /^\/images\/(\d+)\/actions$/, (context) => {
    const image = imagesOf(context.state).get(Number(context.match[1]));
    if (!image || image.public) return emulator.error('not-found');
    return transfer(emulator, context, image);
  });

  emulator.route('GET', /^\/images\/(\d+)\/actions$/, (context) => {
    const id = Number(context.match[1]);
    if (!imagesOf(context.state).has(id)) return emulator.error('not-found');
    const actions = [...context.state.actions.values()].filter(
      (action) => action.resource_type === 'image' && action.resource_id === id,
    );
    return emulator.paged(context, 'actions', actions);
  });
}

/** Whether a numeric image id names an image of the account that is not usable in `region`. */
export function imageMissingInRegion(state: DoState, image: unknown, region: string): boolean {
  if (!Number.isInteger(image)) return false;
  const found = imagesOf(state).get(image as number);
  if (!found) return false;
  return found.status !== 'available' || !(found.regions as string[]).includes(region);
}
