import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type ComputeError,
  type Manifest,
} from '@better-compute/core';
import {
  bucketMarkerKey,
  deploymentTag,
  managedNamePrefix,
  resetBudgets,
} from '@better-compute/provider-digitalocean';
import { registerCdn, seedCdnEndpoint } from './support/do-emulator/cdn.js';
import { registerRegistry, seedRegistry } from './support/do-emulator/registry.js';
import { registerSpacesKeys, seedSpacesKey } from './support/do-emulator/spaces-keys.js';
import { storageWorld, type StorageWorld } from './support/do-storage-harness.js';

// The DigitalOcean storage kinds as the cloud-resources `ProviderResources` contract asks for them:
// request-shaped `ensure` (a known provider id wins over the name), `adopt`/`release` through the
// bucket marker, `notManaged`/`managedByAnother` refusals, and `managedBy: 'this' | 'other'` in
// discovery.

beforeEach(() => resetBudgets());

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

// A copy of core's `ProviderResources` (cloud-resources, not yet on this base): the storage
// resources must be assignable to it as they are, so integration only plugs them in.
interface ContractState {
  id: string;
  state: 'pending' | 'ready' | 'updating' | 'deleting' | 'deleted' | 'error';
  outputs?: Readonly<Record<string, string>>;
  secretOutputs?: Readonly<Record<string, string>>;
  spec?: Readonly<Record<string, unknown>>;
  message?: string;
}
interface ContractKind {
  kind: string;
  family: 'storage' | 'network' | 'edge' | 'data' | 'platform' | 'ai' | 'observability';
  description?: string;
  spec: Manifest<unknown>;
  outputs: readonly string[];
  secretOutputs?: readonly string[];
  regional: boolean;
  updatable: readonly string[];
  meters?: readonly { meter: string; unit: string }[];
  preview?: boolean;
  parent?: string;
}
interface ContractResources {
  kinds(): readonly ContractKind[];
  ensure(
    request: {
      kind: string;
      name: string;
      spec: unknown;
      id?: string;
      parent?: string;
      labels?: Readonly<Record<string, string>>;
    },
    context: CallContext,
  ): Promise<ContractState>;
  get(kind: string, id: string, context: CallContext): Promise<ContractState | undefined>;
  delete(kind: string, id: string, context: CallContext): Promise<ContractState>;
  discover?(
    kind: string,
    context: CallContext,
  ): AsyncIterable<{
    id: string;
    name: string;
    region?: string;
    managedBy?: 'this' | 'other';
    outputs?: Readonly<Record<string, string>>;
    spec?: Readonly<Record<string, unknown>>;
  }>;
  adopt?(
    kind: string,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<ContractState>;
  release?(kind: string, id: string, context: CallContext): Promise<void>;
}

const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_01abc',
  'better-compute-tenant': 'ten_01abc',
};

const own = managedNamePrefix('default');

const world = (): Promise<StorageWorld> =>
  storageWorld(undefined, undefined, ({ emu, spaces }) => {
    registerSpacesKeys(emu, spaces);
    registerCdn(emu);
    registerRegistry(emu);
  });

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe('the ProviderResources contract', () => {
  it('is served as it is, with a description and a valid name for every kind', async () => {
    const w = await world();
    const resources: ContractResources = w.resources;
    const kinds = resources.kinds();
    expect(kinds.map((k) => k.kind)).toEqual([
      'do.spaces-key',
      'do.spaces-bucket',
      'do.cdn-endpoint',
      'do.container-registry',
      'do.registry-garbage-collection',
    ]);
    for (const kind of kinds) {
      expect(kind.kind).toMatch(/^[a-z0-9.-]{1,64}$/);
      expect(kind.description?.length).toBeGreaterThan(10);
    }
    expect(kinds.find((k) => k.kind === 'do.registry-garbage-collection')?.parent).toBe(
      'do.container-registry',
    );
  });

  it('refuses adopt and release for a kind owned by its name', async () => {
    const w = await world();
    const key = seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001' });
    const refused = await failure(w.resources.adopt('do.spaces-key', key.access_key, labels, w.ctx()));
    expect(refused.code).toBe('UNSUPPORTED');
    expect(refused.details?.reason).toBe('adopt');
    expect((await failure(w.resources.release('do.spaces-key', key.access_key, w.ctx()))).code).toBe(
      'UNSUPPORTED',
    );
  });
});

// A copy of the provider-wide DigitalOcean kind (lane do-cloud-resources' `DoKind`): the storage
// kinds join its `DoResources` dispatcher as entries of this shape.
interface LaneKindEnv {
  client: unknown;
  deploymentTag: string;
  previews: boolean;
}
interface LaneDoKind {
  readonly definition: ContractKind;
  ensure(
    env: LaneKindEnv,
    request: Parameters<ContractResources['ensure']>[0],
    context: CallContext,
  ): Promise<ContractState>;
  get(env: LaneKindEnv, id: string, context: CallContext): Promise<ContractState | undefined>;
  delete(env: LaneKindEnv, id: string, context: CallContext): Promise<ContractState>;
  discover?(
    env: LaneKindEnv,
    context: CallContext,
  ): ReturnType<NonNullable<ContractResources['discover']>>;
  adopt?(
    env: LaneKindEnv,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<ContractState>;
  release?(env: LaneKindEnv, id: string, context: CallContext): Promise<void>;
}

describe('doStorageKinds, for the provider-wide dispatcher', () => {
  it('serves the same kinds as plain definitions plus env-first calls', async () => {
    const w = await world();
    const kinds: readonly LaneDoKind[] = w.kinds;
    expect(kinds.map((k) => k.definition)).toEqual(
      w.resources.kinds().map((k) => ({
        kind: k.kind,
        family: k.family,
        description: k.description,
        spec: k.spec,
        outputs: k.outputs,
        ...(k.secretOutputs ? { secretOutputs: k.secretOutputs } : {}),
        regional: k.regional,
        updatable: k.updatable,
        ...(k.parent ? { parent: k.parent } : {}),
      })),
    );
    // Only metadata in a definition: no calls, no kind-specific helpers (purge, repositories).
    for (const { definition } of kinds)
      for (const value of Object.values(definition)) expect(typeof value).not.toBe('function');

    const env: LaneKindEnv = { client: {}, deploymentTag: 'ignored', previews: false };
    const bucketKind = kinds.find((k) => k.definition.kind === 'do.spaces-bucket')!;
    // The spec is validated and defaulted here too (acl, versioning).
    const created = await bucketKind.ensure(
      env,
      { kind: 'do.spaces-bucket', name: `${own}tenant-a-assets`, spec: { region: 'nyc3' }, labels },
      w.ctx(),
    );
    expect(created.outputs).toMatchObject({ acl: 'private', versioning: 'off' });
    expect((await bucketKind.get(env, created.id, w.ctx()))?.spec).toEqual({
      region: 'nyc3',
      acl: 'private',
      versioning: false,
    });
    // Named for this deployment, it is owned by its name: adopt is a no-op, release is refused.
    expect((await bucketKind.adopt!(env, created.id, labels, w.ctx())).state).toBe('ready');
    expect((await failure(bucketKind.release!(env, created.id, w.ctx()))).code).toBe('UNSUPPORTED');
    expect((await bucketKind.delete(env, created.id, w.ctx())).state).toBe('deleted');
    expect(
      (await failure(bucketKind.ensure(env, { kind: 'do.spaces-bucket', name: 'x', spec: {} }, w.ctx())))
        .code,
    ).toBe('INVALID_INPUT');
    expect(kinds.find((k) => k.definition.kind === 'do.spaces-key')!.adopt).toBeUndefined();
  });
});

describe('do.spaces-bucket adopt and release', () => {
  it("never lets a tenant adopt an unmarked bucket (the operator's blob store, say) by default", async () => {
    const w = await world();
    // The spacesBlobStore bucket: the operator's, holding every tenant's downloads, never marked.
    w.spaces.seedBucket('acme-bc-ops');
    const before = w.spaces.requests.length;
    const refused = await failure(w.resources.adopt('do.spaces-bucket', 'nyc3/acme-bc-ops', labels, w.ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['ACCESS_DENIED', 'tenantAdopt']);
    expect(w.spaces.requests.slice(before).some((r) => r.method !== 'GET' && r.method !== 'HEAD')).toBe(false);
    expect(w.spaces.buckets.get('acme-bc-ops')!.objects.has(bucketMarkerKey)).toBe(false);
    // So no tenant key can be granted it either.
    const key = await failure(
      w.ensure('do.spaces-key', 'bc-key1', { grants: ['nyc3/acme-bc-ops:readwrite'] }, w.ctx(), { labels }),
    );
    expect([key.code, key.details?.reason]).toEqual(['ACCESS_DENIED', 'grantBucket']);
    expect(w.emu.requests.some((r) => r.method === 'POST')).toBe(false);
    // The operator (no tenant label) may adopt it.
    const { 'better-compute-tenant': _t, ...operator } = labels;
    expect((await w.resources.adopt('do.spaces-bucket', 'nyc3/acme-bc-ops', operator, w.ctx())).state).toBe('ready');
  });

  it('adopts a bucket by writing the marker, then manages it by its id', async () => {
    // Tenant adoption of an unmarked bucket is an operator code option.
    const w = await storageWorld(undefined, { spacesTenantBucketAdopt: true }, ({ emu, spaces }) => {
      registerSpacesKeys(emu, spaces);
      registerCdn(emu);
      registerRegistry(emu);
    });
    w.spaces.seedBucket('hand-made', { acl: 'public-read' });
    const adopted = await w.resources.adopt('do.spaces-bucket', 'nyc3/hand-made', labels, w.ctx());
    expect(adopted).toMatchObject({
      id: 'nyc3/hand-made',
      state: 'ready',
      spec: { region: 'nyc3', acl: 'public-read', versioning: false },
    });
    const marker = JSON.parse(
      new TextDecoder().decode(w.spaces.buckets.get('hand-made')!.objects.get(bucketMarkerKey)!.body),
    );
    expect(marker).toEqual({
      managedBy: 'better-compute',
      deployment: deploymentTag('default'),
      resource: 'crs_01abc',
      tenant: 'ten_01abc',
    });
    // Again: nothing changes.
    expect((await w.resources.adopt('do.spaces-bucket', 'nyc3/hand-made', labels, w.ctx())).id).toBe(
      'nyc3/hand-made',
    );
    expect((await w.resources.get('do.spaces-bucket', 'nyc3/hand-made', w.ctx()))?.spec).toEqual({
      region: 'nyc3',
      acl: 'public-read',
      versioning: false,
    });

    // An update after adoption names the derived name, but the known id wins: no new bucket.
    const updated = await w.ensure('do.spaces-bucket', 'bc-r-crs01abc', { region: 'nyc3' }, w.ctx(), {
      id: 'nyc3/hand-made',
      labels,
    });
    expect(updated.outputs?.acl).toBe('private');
    expect(w.spaces.buckets.has(`${own}r-crs01abc`)).toBe(false);
    expect(w.spaces.buckets.get('hand-made')!.acl).toBe('private');

    const moved = await failure(
      w.ensure('do.spaces-bucket', 'bc-r-crs01abc', { region: 'ams3' }, w.ctx(), {
        id: 'nyc3/hand-made',
        labels,
      }),
    );
    expect(moved.code).toBe('INVALID_STATE');
    expect(moved.details?.reason).toBe('replaceRequired');
  });

  it('refuses a bucket another deployment manages, and one that does not exist', async () => {
    const w = await world();
    w.spaces.seedBucket('theirs').objects.set(bucketMarkerKey, {
      body: new TextEncoder().encode(
        JSON.stringify({ managedBy: 'better-compute', deployment: deploymentTag('other') }),
      ),
    });
    const refused = await failure(w.resources.adopt('do.spaces-bucket', 'nyc3/theirs', labels, w.ctx()));
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('managedByAnother');
    expect((await failure(w.resources.release('do.spaces-bucket', 'nyc3/theirs', w.ctx()))).details?.reason).toBe(
      'managedByAnother',
    );
    expect(w.spaces.buckets.get('theirs')!.objects.has(bucketMarkerKey)).toBe(true);
    expect(
      (await failure(w.resources.adopt('do.spaces-bucket', 'nyc3/nowhere', labels, w.ctx()))).code,
    ).toBe('NOT_FOUND');
  });

  it('releases an adopted bucket: the marker goes, the bucket and its data stay', async () => {
    const w = await world();
    w.spaces.seedBucket('hand-made');
    await w.resources.adopt('do.spaces-bucket', 'nyc3/hand-made', {}, w.ctx());
    await w.resources.release('do.spaces-bucket', 'nyc3/hand-made', w.ctx());
    const bucket = w.spaces.buckets.get('hand-made')!;
    expect(bucket.objects.has(bucketMarkerKey)).toBe(false);
    // Releasing again is a no-op; deleting a released bucket is refused.
    await w.resources.release('do.spaces-bucket', 'nyc3/hand-made', w.ctx());
    const refused = await failure(w.resources.delete('do.spaces-bucket', 'nyc3/hand-made', w.ctx()));
    expect(refused.details?.reason).toBe('notManaged');
    expect(w.spaces.buckets.has('hand-made')).toBe(true);
  });

  it('never releases a bucket named for this deployment: its name keeps it managed', async () => {
    const w = await world();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    const refused = await failure(
      w.resources.release('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()),
    );
    expect([refused.code, refused.details?.reason]).toEqual(['UNSUPPORTED', 'adopt']);
    expect(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.has(bucketMarkerKey)).toBe(true);
  });
});

describe('refusals and discovery', () => {
  it('names every refused delete notManaged', async () => {
    const w = await world();
    w.spaces.seedBucket('hand-made');
    seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001' });
    seedRegistry(w.emu, { name: 'hand-registry' });
    const endpoint = seedCdnEndpoint(w.emu, { origin: 'hand-made.nyc3.digitaloceanspaces.com' });
    const reasons = await Promise.all([
      failure(w.resources.delete('do.spaces-bucket', 'nyc3/hand-made', w.ctx())),
      failure(w.resources.delete('do.spaces-key', 'DOFOREIGN0001', w.ctx())),
      failure(w.resources.delete('do.container-registry', 'hand-registry', w.ctx())),
      failure(w.resources.delete('do.cdn-endpoint', endpoint.id, w.ctx())),
    ]);
    expect(reasons.map((e) => [e.code, e.details?.reason])).toEqual([
      ['INVALID_STATE', 'notManaged'],
      ['INVALID_STATE', 'notManaged'],
      ['INVALID_STATE', 'notManaged'],
      ['INVALID_STATE', 'notManaged'],
    ]);
  });

  it('a known key id wins over a create, for the key of its own name only', async () => {
    const w = await world();
    await w.ensure('do.spaces-bucket', `${own}b-one`, { region: 'nyc3' }, w.ctx(), { labels });
    const created = await w.ensure('do.spaces-key', 'bc-key1', { grants: [`nyc3/${own}b-one:read`] }, w.ctx(), {
      labels,
    });
    const again = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: [`nyc3/${own}b-one:readwrite`] },
      w.ctx(),
      { id: created.id, labels },
    );
    expect(again.id).toBe(created.id);
    expect(again.outputs?.grants).toBe(`${own}b-one:readwrite`);
    expect(again.secretOutputs).toBeUndefined();
    // The id of a key made for another name (another resource's) is refused, not regranted.
    const crossed = await failure(
      w.ensure('do.spaces-key', 'bc-key-renamed-row', { grants: [`nyc3/${own}b-one:read`] }, w.ctx(), {
        id: created.id,
        labels,
      }),
    );
    expect([crossed.code, crossed.details?.reason]).toEqual(['INVALID_STATE', 'idMismatch']);
  });

  it('marks what this deployment manages, with region, outputs and spec', async () => {
    const w = await world();
    seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001', grants: [] });
    seedSpacesKey(w.emu, {
      name: `${own}mine`,
      access_key: 'DOMINE000001',
      grants: [{ bucket: `${own}b-one`, permission: 'read' }],
    });
    expect(await collect(w.resources.discover('do.spaces-key', w.ctx()))).toEqual([
      {
        id: 'DOFOREIGN0001',
        name: 'ci-deploy',
        outputs: { accessKeyId: 'DOFOREIGN0001', name: 'ci-deploy', grants: '' },
      },
      {
        id: 'DOMINE000001',
        name: `${own}mine`,
        managedBy: 'this',
        // A key records bucket names but not their regions: its spec cannot be read back.
        outputs: { accessKeyId: 'DOMINE000001', name: `${own}mine`, grants: `${own}b-one:read` },
      },
    ]);

    seedRegistry(w.emu, { name: `${own}reg`, region: 'ams3' });
    const [registry] = await collect(w.resources.discover('do.container-registry', w.ctx()));
    expect(registry).toMatchObject({
      id: `${own}reg`,
      name: `${own}reg`,
      region: 'ams3',
      managedBy: 'this',
      spec: { region: 'ams3' },
    });

    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { labels });
    const ours = await w.ensure(
      'do.cdn-endpoint',
      'bc-cdn1',
      { origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com` },
      w.ctx(),
      { parent: `nyc3/${own}tenant-a-assets`, labels },
    );
    w.spaces.seedBucket('hand-made');
    seedCdnEndpoint(w.emu, { origin: 'hand-made.nyc3.digitaloceanspaces.com' });
    const endpoints = await collect(w.resources.discover('do.cdn-endpoint', w.ctx()));
    expect(endpoints.map((e) => [e.name, e.managedBy])).toEqual([
      [`${own}tenant-a-assets.nyc3.digitaloceanspaces.com`, 'this'],
      ['hand-made.nyc3.digitaloceanspaces.com', undefined],
    ]);
    expect(endpoints[0]).toMatchObject({
      id: ours.id,
      spec: { origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com`, ttl: 3600 },
    });
  });

  it('adopts a CDN endpoint only in front of a bucket it manages', async () => {
    const w = await world();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { labels });
    const mine = seedCdnEndpoint(w.emu, { origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com` });
    expect(await w.resources.adopt('do.cdn-endpoint', mine.id, labels, w.ctx())).toMatchObject({
      id: mine.id,
      state: 'ready',
      spec: { origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com`, ttl: 3600 },
    });
    w.spaces.seedBucket('hand-made');
    const theirs = seedCdnEndpoint(w.emu, { origin: 'hand-made.nyc3.digitaloceanspaces.com' });
    expect(
      (await failure(w.resources.adopt('do.cdn-endpoint', theirs.id, labels, w.ctx()))).details?.reason,
    ).toBe('notManaged');
  });
});
