import { createHash, randomBytes } from 'node:crypto';
import type { DoEmulator, Json } from './index.js';

// DigitalOcean Container Registry for the emulator, registered by the storage tests:
// `registerRegistry(emu)` adds the API v2 routes (docker credentials, registries, garbage
// collection), and `DocrEmulator` is the registry itself (`registry.digitalocean.com`) with its
// token service at `api.digitalocean.com/v2/registry/auth`. `docrFetch(emu, docr)` routes one fetch
// to both.

export interface IssuedCredential {
  username: string;
  password: string;
  expiresAt: number;
  readWrite: boolean;
}

export interface RegistryWorld {
  /** Credentials handed out by docker-credentials, by password. */
  issued: Map<string, IssuedCredential>;
  /** Registries by name (the multi-registry API). */
  registries: Map<string, Json>;
  /** Garbage collections by registry name, newest last. */
  collections: Map<string, Json[]>;
  /** Repositories by registry name. */
  repositories: Map<string, Json[]>;
  subscriptionTier: string;
  /** How many registries the subscription allows. */
  registryLimit: number;
}

const worlds = new WeakMap<DoEmulator, RegistryWorld>();

export function registryWorld(emu: DoEmulator): RegistryWorld {
  let world = worlds.get(emu);
  if (!world)
    worlds.set(
      emu,
      (world = {
        issued: new Map(),
        registries: new Map(),
        collections: new Map(),
        repositories: new Map(),
        subscriptionTier: 'professional',
        registryLimit: 9,
      }),
    );
  return world;
}

const invalid = (message: string) => ({ status: 422, body: { id: 'unprocessable_entity', message } });
const registryName = /^[a-z0-9-]{1,63}$/;

export function seedRegistry(emu: DoEmulator, registry: Json): Json {
  const entry = {
    name: 'reg',
    region: 'nyc3',
    created_at: new Date(emu.state.now()).toISOString(),
    storage_usage_bytes: 0,
    storage_usage_bytes_updated_at: new Date(emu.state.now()).toISOString(),
    ...registry,
  };
  registryWorld(emu).registries.set(entry.name, entry);
  return entry;
}

export function registerRegistry(emu: DoEmulator): void {
  const world = registryWorld(emu);
  emu.route('GET', /^\/registry\/docker-credentials$/, (c) => {
    const expiry = Number(c.url.searchParams.get('expiry_seconds') ?? 0) || 2_592_000;
    const password = `reg-${randomBytes(12).toString('hex')}`;
    world.issued.set(password, {
      username: password,
      password,
      expiresAt: emu.state.now() + expiry * 1000,
      readWrite: c.url.searchParams.get('read_write') === 'true',
    });
    return {
      status: 200,
      body: {
        auths: {
          'registry.digitalocean.com': {
            auth: Buffer.from(`${password}:${password}`).toString('base64'),
          },
        },
      },
    };
  });
  emu.route('GET', /^\/registries$/, (c) =>
    emu.paged(c, 'registries', [...world.registries.values()]),
  );
  emu.route('GET', /^\/registries\/([^/]+)$/, (c) => {
    const registry = world.registries.get(c.match[1]!);
    return registry ? { status: 200, body: { registry } } : emu.error('not-found');
  });
  emu.route('POST', /^\/registries$/, (c) => {
    const body = c.body ?? {};
    if (typeof body.name !== 'string' || !registryName.test(body.name))
      return invalid('invalid registry name');
    if (typeof body.region !== 'string') return invalid('region is required');
    if (world.registries.has(body.name))
      return { status: 409, body: { id: 'conflict', message: 'registry name already exists' } };
    if (world.registries.size >= world.registryLimit)
      return invalid('registry limit reached for your subscription tier');
    const registry = seedRegistry(emu, { name: body.name, region: body.region });
    return { status: 201, body: { registry } };
  });
  emu.route('DELETE', /^\/registries\/([^/]+)$/, (c) => {
    if (!world.registries.delete(c.match[1]!)) return emu.error('not-found');
    return { status: 204 };
  });
  emu.route('GET', /^\/registry\/subscription$/, () => ({
    status: 200,
    body: { subscription: { tier: { slug: world.subscriptionTier } } },
  }));
  emu.route('GET', /^\/registry\/([^/]+)\/repositoriesV2$/, (c) => {
    if (!world.registries.has(c.match[1]!)) return emu.error('not-found');
    return emu.paged(c, 'repositories', world.repositories.get(c.match[1]!) ?? []);
  });
  emu.route('POST', /^\/registry\/([^/]+)\/garbage-collection$/, (c) => {
    const name = c.match[1]!;
    if (!world.registries.has(name)) return emu.error('not-found');
    const list = world.collections.get(name) ?? [];
    if (list.some((gc) => !['succeeded', 'failed', 'cancelled'].includes(gc.status)))
      return { status: 409, body: { id: 'conflict', message: 'garbage collection already active' } };
    const gc = {
      uuid: `${randomBytes(4).toString('hex')}-0000-4000-8000-${randomBytes(6).toString('hex')}`,
      registry_name: name,
      status: 'requested',
      type: c.body?.type ?? 'untagged manifests and unreferenced blobs',
      created_at: new Date(emu.state.now()).toISOString(),
      updated_at: new Date(emu.state.now()).toISOString(),
      blobs_deleted: 0,
      freed_bytes: 0,
    };
    list.push(gc);
    world.collections.set(name, list);
    return { status: 201, body: { garbage_collection: gc } };
  });
  emu.route('GET', /^\/registry\/([^/]+)\/garbage-collection$/, (c) => {
    const active = (world.collections.get(c.match[1]!) ?? []).find(
      (gc) => !['succeeded', 'failed', 'cancelled'].includes(gc.status),
    );
    return active ? { status: 200, body: { garbage_collection: active } } : emu.error('not-found');
  });
  emu.route('GET', /^\/registry\/([^/]+)\/garbage-collections$/, (c) =>
    emu.paged(c, 'garbage_collections', [...(world.collections.get(c.match[1]!) ?? [])].reverse()),
  );
  emu.route('PUT', /^\/registry\/([^/]+)\/garbage-collection\/([^/]+)$/, (c) => {
    const gc = (world.collections.get(c.match[1]!) ?? []).find((g) => g.uuid === c.match[2]);
    if (!gc) return emu.error('not-found');
    if (c.body?.cancel === true && !['succeeded', 'failed', 'cancelled'].includes(gc.status))
      gc.status = 'cancelled';
    return { status: 200, body: { garbage_collection: gc } };
  });
}

interface Manifest {
  body: string;
  mediaType: string;
}

/** The registry (`registry.digitalocean.com`) and its token service. */
export class DocrEmulator {
  /** Manifests by `<name>` then reference (tag or digest). */
  manifests = new Map<string, Map<string, Manifest>>();
  blobs = new Map<string, Uint8Array>();
  /** Bearer tokens handed out, with their scope. */
  tokens = new Map<string, { scope: string; expiresAt: number }>();
  /** The realm the challenge names (a test can point it off DigitalOcean). */
  realm = 'https://api.digitalocean.com/v2/registry/auth';
  /** Serve blob bytes instead of redirecting to presigned storage. */
  serveBlobs = false;
  requests: { method: string; url: URL; headers: Record<string, string> }[] = [];

  constructor(
    private readonly world: RegistryWorld,
    private readonly now: () => number,
  ) {}

  /** Stores a manifest under `tag` and under its digest; returns the digest. */
  push(name: string, tag: string, manifest: Json, mediaType = 'application/vnd.oci.image.manifest.v1+json'): string {
    const body = JSON.stringify(manifest);
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const refs = this.manifests.get(name) ?? new Map<string, Manifest>();
    refs.set(tag, { body, mediaType });
    refs.set(digest, { body, mediaType });
    this.manifests.set(name, refs);
    return digest;
  }

  /** Stores a blob; returns its digest. */
  blob(bytes: Uint8Array): string {
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    this.blobs.set(digest, bytes);
    return digest;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const headers = new Headers(init?.headers);
    this.requests.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: Object.fromEntries(headers.entries()),
    });
    if (url.pathname === '/v2/registry/auth') return this.#token(url, headers);
    const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const [, name, kind, reference] = match;
    const scope = `repository:${name}:pull`;
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    const token = bearer ? this.tokens.get(bearer) : undefined;
    if (!token || token.expiresAt <= this.now() || token.scope !== scope)
      return new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }), {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="${this.realm}",service="registry.digitalocean.com",scope="${scope}"`,
        },
      });
    if (kind === 'manifests') {
      const manifest = this.manifests.get(name!)?.get(reference!);
      if (!manifest) return new Response(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }), { status: 404 });
      return new Response(manifest.body, {
        status: 200,
        headers: { 'content-type': manifest.mediaType },
      });
    }
    const blob = this.blobs.get(reference!);
    if (!blob) return new Response(JSON.stringify({ errors: [{ code: 'BLOB_UNKNOWN' }] }), { status: 404 });
    if (this.serveBlobs) return new Response(blob, { status: 200 });
    return new Response(null, {
      status: 307,
      headers: {
        location: `https://docr-blobs.nyc3.digitaloceanspaces.com/${reference!.replace(':', '/')}?X-Amz-Expires=1200&X-Amz-Signature=presigned`,
      },
    });
  };

  #token(url: URL, headers: Headers): Response {
    const basic = /^Basic (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    const decoded = basic ? Buffer.from(basic, 'base64').toString('utf8') : '';
    const [user, password] = decoded.split(':');
    const issued = password ? this.world.issued.get(password) : undefined;
    if (!issued || issued.username !== user || issued.expiresAt <= this.now())
      return new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }), { status: 401 });
    const token = `bearer-${randomBytes(8).toString('hex')}`;
    this.tokens.set(token, { scope: url.searchParams.get('scope') ?? '', expiresAt: this.now() + 300_000 });
    return new Response(JSON.stringify({ token, expires_in: 300 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** One fetch for the DO API emulator, the registry and its token service. */
export function docrFetch(emu: DoEmulator, docr: DocrEmulator): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (url.host === 'registry.digitalocean.com' || url.pathname === '/v2/registry/auth')
      return docr.fetch(input, init);
    return emu.fetch(input, init);
  }) as typeof fetch;
}
