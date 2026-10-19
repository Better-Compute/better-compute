import type { DoEmulator, RouteContext } from './index.js';
import { isoSeconds, settleAction, startAction } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';
import { hasTag, touchTags } from './tags.js';
import { defaultVpc } from './vpcs.js';

// Droplets under `/v2/droplets`. A create answers 202 with the Droplet `new` and a `create`
// action `in-progress`; the action completes after `emulator.createReads` reads of the Droplet,
// which then turns `active` and gets its addresses. The list mirrors the pessimistic reading of
// the spec (research S2, ruling R5): the default list and a `tag_name` list both omit GPU
// Droplets (a Droplet whose size has `gpu_info`), `type=gpus` lists only them, and `type` with
// `tag_name` is a 422. Bodies are built from the fixture's spec Droplet and GPU Droplet.

const templates = fixture('droplets');
const plainTemplate = templates.droplet as Json;
const gpuTemplate = templates.gpuDroplet as Json;

/** Remaining reads before a new Droplet's create action completes, per emulator state. */
const progress = new WeakMap<DoState, Map<number, number>>();

function progressOf(state: DoState): Map<number, number> {
  let map = progress.get(state);
  if (!map) {
    map = new Map();
    progress.set(state, map);
  }
  return map;
}

export function isGpuDroplet(droplet: Json): boolean {
  return !!droplet.size?.gpu_info;
}

/** The addresses DO assigns once a Droplet is up: private 10.x, public from TEST-NET-3. */
function networksFor(id: number, ipv6: boolean): Json {
  const v4 = [
    {
      ip_address: `10.10.${(id >> 8) & 255}.${id & 255}`,
      netmask: '255.255.0.0',
      gateway: 'nil',
      type: 'private',
    },
    {
      ip_address: `203.0.113.${(id % 254) + 1}`,
      netmask: '255.255.255.0',
      gateway: '203.0.113.1',
      type: 'public',
    },
  ];
  const v6 = ipv6
    ? [
        {
          ip_address: `2001:db8::${id.toString(16)}`,
          netmask: 64,
          gateway: '2001:db8::1',
          type: 'public',
        },
      ]
    : [];
  return { v4, v6 };
}

export interface DropletSeed {
  id?: number;
  name?: string;
  /** A region slug from `state.regions`. Default `nyc3`. */
  region?: string;
  /** A size slug from `state.sizes`. Default `s-1vcpu-1gb`. */
  size_slug?: string;
  /** A slug or a numeric id. */
  image?: string | number;
  tags?: string[];
  status?: 'new' | 'active' | 'off' | 'archive';
  created_at?: string;
  /** Default: the region's default VPC; null for none. */
  vpc_uuid?: string | null;
  ipv6?: boolean;
}

/** A Droplet body shaped like the fixture's, for the size, region and image given. */
function dropletBody(state: DoState, seed: DropletSeed): Json {
  const id = seed.id ?? state.nextId();
  const regionSlug = seed.region ?? 'nyc3';
  const sizeSlug = seed.size_slug ?? 's-1vcpu-1gb';
  const size = state.sizes.find((s) => s.slug === sizeSlug);
  if (!size) throw new Error(`seedDroplet: no size ${sizeSlug}`);
  const region = state.regions.find((r) => r.slug === regionSlug) ?? {
    name: regionSlug,
    slug: regionSlug,
    features: [],
    available: true,
    sizes: [],
  };
  const template = size.gpu_info ? gpuTemplate : plainTemplate;
  const image = seed.image ?? 'ubuntu-24-04-x64';
  const status = seed.status ?? 'active';
  const ipv6 = seed.ipv6 ?? false;
  const droplet: Json = {
    ...structuredClone(template),
    id,
    name: seed.name ?? `droplet-${id}`,
    memory: size.memory,
    vcpus: size.vcpus,
    disk: size.disk,
    locked: false,
    status,
    created_at: seed.created_at ?? isoSeconds(state.now()),
    features: ipv6 ? ['private_networking', 'ipv6'] : ['private_networking'],
    backup_ids: [],
    next_backup_window: null,
    snapshot_ids: [],
    image:
      typeof image === 'number'
        ? { ...structuredClone(template.image), id: image, slug: null }
        : { ...structuredClone(template.image), slug: image },
    volume_ids: [],
    size: structuredClone(size),
    size_slug: size.slug,
    networks: status === 'new' ? { v4: [], v6: [] } : networksFor(id, ipv6),
    region: structuredClone(region),
    tags: [...(seed.tags ?? [])],
    vpc_uuid:
      seed.vpc_uuid === null ? undefined : (seed.vpc_uuid ?? defaultVpc(state, regionSlug).id),
  };
  if (droplet.vpc_uuid === undefined) delete droplet.vpc_uuid;
  if (size.gpu_info) droplet.gpu_info = structuredClone(size.gpu_info);
  else delete droplet.gpu_info;
  return droplet;
}

/** Puts a Droplet in the account, as if made out of band; returns the stored resource. */
export function seedDroplet(state: DoState, seed: DropletSeed = {}): Json {
  const droplet = dropletBody(state, seed);
  touchTags(state, droplet.tags);
  state.droplets.set(droplet.id, droplet);
  return droplet;
}

/** A read of a new Droplet: counts toward its create action, which may complete after it. */
function afterRead(state: DoState, droplet: Json): void {
  const reads = progressOf(state);
  const left = reads.get(droplet.id);
  if (left === undefined) return;
  const create = [...state.actions.values()].find(
    (a) => a.type === 'create' && a.resource_id === droplet.id,
  );
  if (!create || create.status !== 'in-progress') {
    reads.delete(droplet.id);
    return;
  }
  if (left > 1) {
    reads.set(droplet.id, left - 1);
    return;
  }
  reads.delete(droplet.id);
  settleAction(state, create, 'completed');
  droplet.status = 'active';
  droplet.networks = networksFor(droplet.id, (droplet.features as string[]).includes('ipv6'));
}

const namePattern = /^[a-zA-Z0-9]?[a-z0-9A-Z.-]*[a-z0-9A-Z]$/;
const tagPattern = /^[a-zA-Z0-9_:-]{1,255}$/;

function create(emulator: DoEmulator, context: RouteContext) {
  const { state } = context;
  const body = context.body ?? {};
  const name = body.name;
  if (typeof name !== 'string' || name.length > 255 || !namePattern.test(name))
    return emulator.error('422-unknown');
  const region = state.regions.find((r) => r.slug === body.region);
  if (!region) return emulator.error('422-unknown');
  if (!region.available) return emulator.error('422-region-unavailable');
  const size = state.sizes.find((s) => s.slug === body.size);
  if (!size) return emulator.error('422-invalid-size');
  if (!size.available || !region.sizes.includes(size.slug) || !size.regions.includes(region.slug))
    return emulator.error('422-size-unavailable-in-region');
  const image = body.image;
  if (!(typeof image === 'string' && image !== '') && !Number.isInteger(image))
    return emulator.error('422-invalid-image');
  const keys = (body.ssh_keys ?? []) as unknown[];
  const known = [...state.sshKeys.values()];
  if (
    !Array.isArray(keys) ||
    !keys.every((k) => known.some((s) => s.id === k || s.fingerprint === k))
  )
    return emulator.error('422-unknown');
  const userData = body.user_data;
  if (
    userData !== undefined &&
    (typeof userData !== 'string' || Buffer.byteLength(userData) > 65_536)
  )
    return emulator.error('422-unknown');
  const tags = (body.tags ?? []) as unknown[];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && tagPattern.test(t)))
    return emulator.error('422-unknown');
  if (body.vpc_uuid !== undefined) {
    const vpc = state.vpcs.get(body.vpc_uuid);
    if (!vpc || vpc.region !== region.slug) return emulator.error('422-unknown');
  }

  const droplet = seedDroplet(state, {
    name,
    region: region.slug,
    size_slug: size.slug,
    image,
    tags: tags as string[],
    status: 'new',
    ...(body.vpc_uuid !== undefined ? { vpc_uuid: body.vpc_uuid } : {}),
    ipv6: body.ipv6 === true,
  });
  const action = startAction(state, 'create', droplet);
  if (action.status === 'in-progress') progressOf(state).set(droplet.id, emulator.createReads);
  return {
    status: 202,
    body: {
      droplet: publicView(droplet),
      links: {
        actions: [
          { id: action.id, rel: 'create', href: `${context.url.origin}/v2/actions/${action.id}` },
        ],
      },
    },
  };
}

/** A copy to answer with: the stored Droplet may change before the response is serialised. */
function publicView(droplet: Json): Json {
  return structuredClone(droplet);
}

export function registerDroplets(emulator: DoEmulator): void {
  emulator.route('POST', /^\/droplets$/, (context) => create(emulator, context));

  emulator.route('GET', /^\/droplets$/, (context) => {
    const query = context.url.searchParams;
    const type = query.get('type');
    const tag = query.get('tag_name');
    const name = query.get('name');
    if (type !== null && tag !== null) return emulator.error('422-unknown');
    let droplets = [...context.state.droplets.values()].sort((a, b) => a.id - b.id);
    droplets = droplets.filter((d) => (type === 'gpus' ? isGpuDroplet(d) : !isGpuDroplet(d)));
    if (tag !== null) droplets = droplets.filter((d) => hasTag(d, tag));
    if (name !== null) droplets = droplets.filter((d) => d.name === name);
    return emulator.paged(context, 'droplets', droplets.map(publicView));
  });

  emulator.route('GET', /^\/droplets\/(\d+)$/, (context) => {
    const droplet = context.state.droplets.get(Number(context.match[1]));
    if (!droplet) return emulator.error('not-found');
    const view = publicView(droplet);
    afterRead(context.state, droplet);
    return { status: 200, body: { droplet: view } };
  });

  emulator.route('DELETE', /^\/droplets\/(\d+)$/, (context) => {
    const id = Number(context.match[1]);
    if (!context.state.droplets.delete(id)) return emulator.error('not-found');
    progressOf(context.state).delete(id);
    return { status: 204 };
  });
}
