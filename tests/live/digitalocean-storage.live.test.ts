import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isComputeError,
  systemClock,
  type CallContext,
  type ProviderContext,
  type SecretRef,
} from '@better-compute/core';
import {
  bucketMarkerKey,
  digitalocean,
  docrImageSource,
  doStorageResources,
  spacesBlobStore,
  spacesClient,
  xmlValues,
  type DoConfig,
  type DoStorageResources,
  type SpacesClient,
} from '@better-compute/provider-digitalocean';

// The storage half of provider-digitalocean (Spaces, CDN, Container Registry) against a real
// account. It is OFF unless BC_DO_LIVE, BC_DO_TOKEN and a Spaces key pair are all set. It creates
// (and always sweeps) a bucket, a Spaces key and a CDN endpoint; on an account without Spaces this
// starts the Spaces subscription, which is billed monthly.
//
//   BC_DO_LIVE=1 BC_DO_TOKEN=<token> BC_DO_SPACES_ACCESS_KEY=<id> BC_DO_SPACES_SECRET_KEY=<secret> \
//     node node_modules/vitest/vitest.mjs run tests/live/digitalocean-storage.live.test.ts
//
// Optional:
// - BC_DO_SPACES_REGION (nyc3), and BC_DO_SPACES_OTHER_REGION (ams3, or sgp1 when the first is
//   ams3) for the wrong-region HEAD.
// - BC_DO_LIVE_REGISTRY=1: also create and delete a registry `bc-live-<hex>` (needs a
//   subscription tier with a free registry slot).
// - BC_DO_LIVE_IMAGE=oci://registry.digitalocean.com/<registry>/<repository>:<tag>: a disk image
//   already pushed; docrImageSource resolves it and the presigned URL is fetched without
//   credentials.
//
// What it settles (marked unverified in the package README): HEAD answering 403 for a name another
// account holds and 301 from another region's endpoint; the grant format of Spaces keys; one CDN
// endpoint per origin; the registry's presigned blob redirect; and the token scopes the storage
// families need. Everything it makes is named `bc-live-<hex>-…`, and the sweeper deletes only that.

const env = process.env;
const flag = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
const enabled =
  flag(env.BC_DO_LIVE) &&
  Boolean(env.BC_DO_TOKEN && env.BC_DO_SPACES_ACCESS_KEY && env.BC_DO_SPACES_SECRET_KEY);

const endpoint = 'https://api.digitalocean.com/v2';
const run = randomBytes(4).toString('hex');
const prefix = `bc-live-${run}`;
const bucket = `${prefix}-assets`;
const keyName = `${prefix}-key`;
const registryName = prefix;
const region = env.BC_DO_SPACES_REGION || 'nyc3';
const otherRegion = env.BC_DO_SPACES_OTHER_REGION || (region === 'ams3' ? 'sgp1' : 'ams3');
const origin = `${bucket}.${region}.digitaloceanspaces.com`;

const refs = {
  token: 'secret://do/live',
  access: 'secret://spaces/live-access',
  secret: 'secret://spaces/live-secret',
  newAccess: 'secret://spaces/live-new-access',
  newSecret: 'secret://spaces/live-new-secret',
} as const satisfies Record<string, SecretRef>;
// Values the run receives (the new key's secret) live here only, never in a log or an assertion message.
const values = new Map<string, string>([
  [refs.token, env.BC_DO_TOKEN ?? ''],
  [refs.access, env.BC_DO_SPACES_ACCESS_KEY ?? ''],
  [refs.secret, env.BC_DO_SPACES_SECRET_KEY ?? ''],
]);
const secrets = {
  resolve: async (ref: string): Promise<string> => {
    const value = values.get(ref);
    if (value === undefined) throw new Error('the live suite has no such secret');
    return value;
  },
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const account = { id: 'pacct_live', tenantId: 'root', platform: true };
const providerContext: ProviderContext = { clock: systemClock, secrets, log: quiet, account };
const call = (key: string): CallContext => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock: systemClock,
  secrets,
  log: quiet,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `step` until it stops throwing and `done` accepts it, or `timeoutMs` has passed. */
async function until<T>(
  what: string,
  step: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await step();
      if (done(value)) return value;
      last = value;
    } catch (error) {
      last = isComputeError(error) ? `${error.code} ${String(error.details?.reason ?? '')}` : String(error);
    }
    if (Date.now() >= deadline)
      throw new Error(`${what}: not done after ${timeoutMs / 1000}s (last: ${JSON.stringify(last)})`);
    await sleep(intervalMs);
  }
}

/** A plain API call with the run's token (the sweeper and the raw checks). */
async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T | undefined }> {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.BC_DO_TOKEN ?? ''}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined };
}

const s3For = (slug: string): SpacesClient =>
  spacesClient({
    fetch,
    region: slug,
    credentials: async () => ({
      accessKeyId: env.BC_DO_SPACES_ACCESS_KEY ?? '',
      secretAccessKey: env.BC_DO_SPACES_SECRET_KEY ?? '',
    }),
    clock: systemClock,
  });

// ---------------------------------------------------------------------------------- sweeper

/** Deletes everything named for this run: CDN endpoints, objects and the bucket, keys, registry. */
async function sweep(): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await attempt('CDN endpoints', async () => {
    const { body } = await api<{ endpoints?: { id: string; origin: string }[] }>(
      'GET',
      '/cdn/endpoints?per_page=200',
    );
    for (const e of body?.endpoints ?? [])
      if (e.origin.startsWith(`${prefix}-`)) await api('DELETE', `/cdn/endpoints/${e.id}`);
  });
  await attempt('the bucket', async () => {
    const s3 = s3For(region);
    const head = await s3.request('HEAD', bucket, undefined, { allow: [301, 403, 404] });
    if (head.status !== 200) return;
    for (const versions of [true, false]) {
      const listing = await (
        await s3.request('GET', bucket, undefined, {
          query: versions ? { versions: '' } : { 'list-type': '2' },
          allow: [404],
        })
      ).text();
      for (const entry of [
        ...xmlValues(listing, 'Version'),
        ...xmlValues(listing, 'DeleteMarker'),
        ...xmlValues(listing, 'Contents'),
      ]) {
        const key = xmlValues(entry, 'Key')[0];
        const versionId = xmlValues(entry, 'VersionId')[0];
        if (key)
          await s3.request('DELETE', bucket, key, {
            ...(versionId ? { query: { versionId } } : {}),
            allow: [404],
          });
      }
    }
    await s3.request('DELETE', bucket, undefined, { allow: [404] });
  });
  await attempt('Spaces keys', async () => {
    const { body } = await api<{ keys?: { name: string; access_key: string }[] }>(
      'GET',
      '/spaces/keys?per_page=200',
    );
    for (const key of body?.keys ?? [])
      if (key.name.startsWith(`${prefix}-`)) await api('DELETE', `/spaces/keys/${key.access_key}`);
  });
  if (flag(env.BC_DO_LIVE_REGISTRY))
    await attempt('the registry', async () => {
      await api('DELETE', `/registries/${registryName}`);
    });
  return errors;
}

// ---------------------------------------------------------------------------------- the suite

describe.skipIf(!enabled)('provider-digitalocean storage live', () => {
  let resources: DoStorageResources;

  beforeAll(async () => {
    const parsed = await digitalocean.config['~standard'].validate({
      token: refs.token,
      regions: [region],
      spacesAccessKey: refs.access,
      spacesSecretKey: refs.secret,
    });
    if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
    resources = doStorageResources((parsed as { value: DoConfig }).value, providerContext, {
      deployment: `live-${run}`,
    });
  });

  afterAll(async () => {
    const errors = await sweep();
    if (errors.length > 0)
      throw new Error(
        `the storage sweep of live run ${run} did not finish clean; look for ${prefix}-*:\n${errors.join('\n')}`,
      );
  }, 300_000);

  it('HEAD answers 403 for a name another account holds', { timeout: 30_000 }, async () => {
    // A common name some other account has long since taken; HEAD never creates anything.
    const head = await s3For(region).request('HEAD', 'assets', undefined, {
      allow: [301, 403, 404],
    });
    expect([301, 403]).toContain(head.status);
  });

  it('creates a managed bucket, converges it, and guards its delete', { timeout: 180_000 }, async () => {
    const created = await until(
      'the bucket',
      () => resources.ensure({ kind: 'do.spaces-bucket', name: bucket, spec: { region } }, call('b1')),
      (s) => s.state === 'ready',
      60_000,
    );
    expect(created.outputs).toMatchObject({ bucket, region, origin, acl: 'private', versioning: 'off' });
    const marker = await s3For(region).request('GET', bucket, bucketMarkerKey);
    expect(JSON.parse(await marker.text())).toMatchObject({ managedBy: 'better-compute' });

    const changed = await resources.ensure(
      { kind: 'do.spaces-bucket', name: bucket, spec: { region, acl: 'public-read', versioning: true } },
      call('b1'),
    );
    expect(changed.outputs).toMatchObject({ acl: 'public-read', versioning: 'enabled' });
    await resources.ensure(
      { kind: 'do.spaces-bucket', name: bucket, spec: { region, acl: 'private', versioning: false } },
      call('b1'),
    );

    // The bucket answers 301 from another region's endpoint.
    const elsewhere = await s3For(otherRegion).request('HEAD', bucket, undefined, {
      allow: [301, 403, 404],
    });
    expect(elsewhere.status).toBe(301);

    await s3For(region).request('PUT', bucket, 'probe.txt', { body: new TextEncoder().encode('probe') });
    const refused = await resources.delete('do.spaces-bucket', `${region}/${bucket}`, call('b1')).catch((e) => e);
    expect(isComputeError(refused) && refused.details?.reason).toBe('bucketNotEmpty');
    await s3For(region).request('DELETE', bucket, 'probe.txt');
  });

  it('issues a Spaces key whose grant reaches the bucket', { timeout: 180_000 }, async () => {
    const created = await resources.ensure(
      { kind: 'do.spaces-key', name: keyName, spec: { grants: [`${bucket}:readwrite`] } },
      call('k1'),
    );
    expect(created.outputs?.grants).toBe(`${bucket}:readwrite`);
    const secret = created.secretOutputs?.secretKey;
    expect(typeof secret).toBe('string');
    values.set(refs.newAccess, created.id);
    values.set(refs.newSecret, secret!);
    const reread = await resources.get('do.spaces-key', created.id, call('k1'));
    expect(reread !== undefined && reread.secretOutputs === undefined).toBe(true);

    const store = spacesBlobStore({
      region,
      bucket,
      accessKey: refs.newAccess,
      secretKey: refs.newSecret,
      secrets,
      prefix: 'live/',
    });
    const bytes = new TextEncoder().encode(`run ${run}`);
    // A new key can take a moment to reach Spaces.
    await until('a put with the new key', () => store.put('hello.txt', bytes), () => true, 60_000);
    const read = await store.get('hello.txt');
    expect(read).toBeDefined();
    expect(new Uint8Array(await new Response(read!).arrayBuffer())).toEqual(bytes);
    await store.delete('hello.txt');

    expect((await resources.delete('do.spaces-key', created.id, call('k1'))).state).toBe('deleted');
  });

  it('puts one CDN endpoint in front of the bucket', { timeout: 300_000 }, async () => {
    const created = await until(
      'the CDN endpoint',
      () => resources.ensure({ kind: 'do.cdn-endpoint', name: `${prefix}-cdn`, spec: { origin } }, call('c1')),
      (s) => s.state === 'ready',
      60_000,
    );
    expect(created.outputs?.origin).toBe(origin);
    // A second endpoint for the same origin is refused by DigitalOcean itself.
    const second = await api('POST', '/cdn/endpoints', { origin, ttl: 3600 });
    expect(second.status).toBeGreaterThanOrEqual(400);
    const again = await resources.ensure(
      { kind: 'do.cdn-endpoint', name: `${prefix}-cdn`, spec: { origin, ttl: 600 }, id: created.id },
      call('c1'),
    );
    expect(again).toMatchObject({ id: created.id, outputs: { ttl: '600' } });
    expect((await resources.delete('do.cdn-endpoint', created.id, call('c1'))).state).toBe('deleted');
  });

  it.skipIf(!flag(env.BC_DO_LIVE_REGISTRY))(
    'creates, discovers and deletes a registry',
    { timeout: 180_000 },
    async () => {
      const created = await resources.ensure(
        { kind: 'do.container-registry', name: registryName, spec: { region } },
        call('r1'),
      );
      expect(created.outputs?.endpoint).toBe(`registry.digitalocean.com/${registryName}`);
      const found = [];
      for await (const entry of resources.discover('do.container-registry', call('r1'))) found.push(entry);
      expect(found.find((e) => e.id === registryName)).toMatchObject({ managedBy: 'this', region });
      expect((await resources.delete('do.container-registry', registryName, call('r1'))).state).toBe(
        'deleted',
      );
    },
  );

  it.skipIf(!env.BC_DO_LIVE_IMAGE)(
    'resolves a pushed disk image to a presigned URL a node can fetch',
    { timeout: 120_000 },
    async () => {
      const source = docrImageSource({ token: refs.token, secrets, mirrors: false });
      const resolved = await source.resolve(env.BC_DO_LIVE_IMAGE!);
      const url = new URL(resolved.url);
      expect(url.protocol).toBe('https:');
      // The URL carries no credential of ours (a boolean, so a failure never prints the token).
      expect(resolved.url.includes(env.BC_DO_TOKEN ?? '\u0000')).toBe(false);
      const response = await fetch(url, { headers: { range: 'bytes=0-0' } });
      await response.body?.cancel();
      expect([200, 206]).toContain(response.status);
      expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
