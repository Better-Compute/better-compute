import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  isComputeError,
  manualClock,
  type CallContext,
  type ExternalMachine,
  type Logger,
  type ProviderImpl,
} from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import {
  cachedTokenSource,
  gcp,
  gcpProvider,
  gpuModel,
  toMachine,
  type GcpConfig,
  type GcpProviderOptions,
  gceClient,
  impersonatedTokenSource,
  instanceName,
  labelValue,
  machineId,
  metadataTokenSource,
  offerId,
  parseMachineId,
  parseOfferId,
  requestIdFor,
  serviceAccountTokenSource,
  type TokenSource,
} from '@better-compute/provider-gcp';
import { GceEmulator } from './support/gce-emulator.js';

// provider-gcp against an in-memory emulator of the Compute Engine endpoints it uses, plugged in
// through the `fetch` option.

const endpoint = 'https://compute.googleapis.com/compute/v1';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@p.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

/** A root-tenant account: the only kind that may use ambient credentials (ruling F1). */
const platformAccount = { id: 'pacct_platform', tenantId: 'root', platform: true };
/** A tenant's own account. */
const tenantAccount = { id: 'pacct_acme', tenantId: 'acme', platform: false };

function context(clock = manualClock(1_000_000)) {
  return { signal: new AbortController().signal, clock };
}

describe('auth & client', () => {
  it('service-account key mints a bearer token and caches it until expiry', async () => {
    const emu = new GceEmulator();
    const clock = manualClock(1_000_000);
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const client = gceClient({ fetch: emu.fetch, endpoint, projectId: 'p', tokens, clock });
    const call = () =>
      client.request('GET', '/zones/us-central1-a/instances', {
        signal: new AbortController().signal,
      });
    await call();
    await call();
    const posts = () =>
      emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/token');
    expect(posts()).toHaveLength(1);
    expect(emu.jwtClaims[0]).toMatchObject({
      iss: 'sa@p.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    // The compute requests carry the minted token.
    const compute = emu.requests.filter((r) => r.url.hostname === 'compute.googleapis.com');
    expect(
      compute.every((r) => r.headers.get('authorization') === `Bearer ${emu.mintedTokens[0]}`),
    ).toBe(true);
    clock.advance(3_600_000);
    await call();
    expect(posts()).toHaveLength(2);
  });

  it('refreshes a minute before expiry and shares one in-flight mint', async () => {
    const emu = new GceEmulator();
    const clock = manualClock(0);
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const get = () => tokens.token({ signal: new AbortController().signal, clock });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(emu.mintedTokens).toHaveLength(1);
    clock.advance(3_539_000);
    expect(await get()).toBe(a);
    clock.advance(2_000);
    expect(await get()).not.toBe(a);
  });

  it('metadata token source sends Metadata-Flavor: Google', async () => {
    const emu = new GceEmulator();
    const tokens = metadataTokenSource({ fetch: emu.fetch });
    const token = await tokens.token(context());
    expect(token).toBe(emu.mintedTokens[0]);
    expect(emu.metadataFlavors).toEqual(['Google']);
    expect(emu.requests[0]!.url.hostname).toBe('metadata.google.internal');
  });

  it("impersonation exchanges the base token for the target's", async () => {
    const emu = new GceEmulator();
    const base = metadataTokenSource({ fetch: emu.fetch });
    const tokens = impersonatedTokenSource(base, 'sa@p.iam.gserviceaccount.com', {
      fetch: emu.fetch,
    });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
    });
    await client.request('GET', '/zones/us-central1-a/instances', {
      signal: new AbortController().signal,
    });
    const exchange = emu.requests.find((r) => r.url.hostname === 'iamcredentials.googleapis.com')!;
    expect(exchange.method).toBe('POST');
    expect(exchange.url.pathname).toBe(
      '/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken',
    );
    expect(exchange.headers.get('authorization')).toBe(`Bearer ${emu.mintedTokens[0]}`);
    expect(exchange.body).toMatchObject({
      scope: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const compute = emu.requests.find((r) => r.url.hostname === 'compute.googleapis.com')!;
    expect(compute.headers.get('authorization')).toBe(`Bearer ${emu.mintedTokens[1]}`);
    expect(emu.mintedTokens[1]).toContain('imp');
  });

  it('cachedTokenSource caches a custom source for its default lifetime', async () => {
    let calls = 0;
    const custom: TokenSource = { token: async () => `custom-${++calls}` };
    const clock = manualClock(0);
    const tokens = cachedTokenSource(custom);
    const ctx = { signal: new AbortController().signal, clock };
    expect(await tokens.token(ctx)).toBe('custom-1');
    expect(await tokens.token(ctx)).toBe('custom-1');
    clock.advance(301_000);
    expect(await tokens.token(ctx)).toBe('custom-2');
  });

  it('rejects a malformed key and a refused token request', async () => {
    expect(() => serviceAccountTokenSource('not json')).toThrowError(/not valid JSON/);
    expect(() => serviceAccountTokenSource('{}')).toThrowError(/client_email/);
    const failing = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    const tokens = serviceAccountTokenSource(keyJson, { fetch: failing });
    await expect(tokens.token(context())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      details: { provider: 'gcp', status: 400, reason: 'invalid_grant' },
    });
  });

  describe('maps GCE errors to ComputeError codes', () => {
    const table: [string, number, string, string, Record<string, string>?, number?][] = [
      ['404', 404, 'notFound', 'NOT_FOUND'],
      ['409 alreadyExists', 409, 'alreadyExists', 'CONFLICT'],
      [
        '409 resourceInUseByAnotherResource',
        409,
        'resourceInUseByAnotherResource',
        'INVALID_STATE',
      ],
      [
        '400 resourceInUseByAnotherResource',
        400,
        'resourceInUseByAnotherResource',
        'INVALID_STATE',
      ],
      [
        '429 with Retry-After',
        429,
        'rateLimitExceeded',
        'RATE_LIMITED',
        { 'retry-after': '7' },
        7000,
      ],
      ['429 without Retry-After', 429, 'rateLimitExceeded', 'RATE_LIMITED', undefined, 10_000],
      ['403 rateLimitExceeded', 403, 'rateLimitExceeded', 'RATE_LIMITED', undefined, 10_000],
      [
        '403 userRateLimitExceeded',
        403,
        'userRateLimitExceeded',
        'RATE_LIMITED',
        undefined,
        10_000,
      ],
      ['403 quotaExceeded', 403, 'quotaExceeded', 'QUOTA_EXCEEDED'],
      ['403 other', 403, 'forbidden', 'ACCESS_DENIED'],
      ['400', 400, 'invalid', 'INVALID_INPUT'],
      ['503', 503, 'backendError', 'UNAVAILABLE'],
      ['500', 500, 'internalError', 'UNAVAILABLE'],
      ['412 conditionNotMet', 412, 'conditionNotMet', 'PROVIDER_ERROR'],
      ['418', 418, 'teapot', 'PROVIDER_ERROR'],
    ];
    for (const [name, status, reason, code, headers, retryAfterMs] of table)
      it(name, async () => {
        const emu = new GceEmulator();
        const tokens = metadataTokenSource({ fetch: emu.fetch });
        const client = gceClient({
          fetch: emu.fetch,
          endpoint,
          projectId: 'p',
          tokens,
          clock: manualClock(0),
        });
        await tokens.token(context());
        emu.failNext = { status, reason, message: 'boom', headers };
        const error = await client
          .request('GET', '/zones/us-central1-a/instances/x', {
            signal: new AbortController().signal,
          })
          .catch((e: unknown) => e);
        expect(isComputeError(error, code as never)).toBe(true);
        expect(error).toMatchObject({ details: { provider: 'gcp', status, reason } });
        if (retryAfterMs !== undefined)
          expect((error as { retryAfterMs: number }).retryAfterMs).toBe(retryAfterMs);
      });

    it('an unreachable endpoint is UNAVAILABLE', async () => {
      const tokens: TokenSource = { token: async () => 'x' };
      const client = gceClient({
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
        endpoint,
        projectId: 'p',
        tokens,
      });
      await expect(
        client.request('GET', '/x', { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { provider: 'gcp', status: 0 } });
    });
  });

  it('pages and aggregated iterate every page', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'a1');
    emu.addInstance('us-central1-a', 'a2');
    emu.addInstance('us-central1-b', 'b1');
    emu.addInstance('europe-west4-a', 'e1');
    emu.addInstance('europe-west4-a', 'e2');
    const tokens = metadataTokenSource({ fetch: emu.fetch });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
    });
    const signal = new AbortController().signal;
    const names = async (items: AsyncIterable<{ name: string }>) => {
      const out: string[] = [];
      for await (const item of items) out.push(item.name);
      return out;
    };
    const before = emu.requests.length;
    const all = await names(
      client.aggregated<{ name: string }>('/aggregated/instances', 'instances', {
        query: { maxResults: '2' },
        signal,
      }),
    );
    expect(all.sort()).toEqual(['a1', 'a2', 'b1', 'e1', 'e2']);
    // 3 pages for the aggregated list (plus one token request).
    expect(
      emu.requests.slice(before).filter((r) => r.url.pathname.endsWith('/aggregated/instances')),
    ).toHaveLength(3);
    const zonal = await names(
      client.pages<{ name: string }>('/zones/us-central1-a/instances', 'items', { signal }),
    );
    expect(zonal.sort()).toEqual(['a1', 'a2']);
    const second = await names(
      client.pages<{ name: string }>('/zones/europe-west4-a/instances', 'items', { signal }),
    );
    expect(second.sort()).toEqual(['e1', 'e2']);
  });

  it('ids round-trip', () => {
    const input = {
      zone: 'us-central1-a',
      machineType: 'a3-highgpu-8g',
      reservation: 'projects/o/reservations/r',
    };
    expect(parseOfferId(offerId(input.zone, input.machineType, input.reservation))).toEqual(input);
    expect(parseOfferId(offerId('us-central1-a', 'a3-highgpu-8g'))).toEqual({
      zone: 'us-central1-a',
      machineType: 'a3-highgpu-8g',
    });
    expect(offerId('us-central1-a', 'a3-highgpu-8g', 'rsv-a')).toBe(
      'us-central1-a/a3-highgpu-8g@rsv-a',
    );
    expect(parseMachineId(machineId('us-central1-a', 'bc-x'))).toEqual({
      zone: 'us-central1-a',
      name: 'bc-x',
    });
    for (const bad of ['bc-conformance-missing-0', 'a/b/c', '/x', 'x/', 'US/x', '']) {
      expect(() => parseMachineId(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    }
    for (const bad of ['a3-highgpu-8g', 'z/', 'z/m@', '/m'])
      expect(() => parseOfferId(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    const name = instanceName('ins_01JZABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(name).toMatch(/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(instanceName('ins_01JZ')).toBe('bc-ins-01jz');
    expect(labelValue('Ins_01JZ Ä.x')).toMatch(/^[a-z0-9_-]*$/);
    expect(labelValue('a'.repeat(100))).toHaveLength(63);
    expect(requestIdFor('k')).toBe(requestIdFor('k'));
    expect(requestIdFor('k')).not.toBe(requestIdFor('k2'));
    expect(requestIdFor('k')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('never logs tokens', async () => {
    const emu = new GceEmulator();
    const lines: string[] = [];
    const record = (level: string) => (message: string, fields?: Record<string, unknown>) =>
      void lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    const log: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
      log,
    });
    const signal = new AbortController().signal;
    await client.request('GET', '/zones/us-central1-a/instances', { signal });
    emu.failNext = { status: 403, reason: 'forbidden' };
    const error = await client
      .request('GET', '/zones/us-central1-a/instances', { signal })
      .catch((e: unknown) => e);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('ya29.');
    expect(String((error as Error).message)).not.toContain('ya29.');
    expect(JSON.stringify(error)).not.toContain('ya29.');
  });
});

// -------------------------------------------------------------------------------------- compute

const secrets = {
  resolve: async (): Promise<string> => {
    throw new Error('this account has no secrets');
  },
};

function ctx(key = 'k1', clock = manualClock(1_000_000)): CallContext {
  return {
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock,
    secrets,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const gcpAccount = { projectId: 'p', zones: ['us-central1-a'] };

async function build(
  emu: GceEmulator,
  config: Record<string, unknown> = gcpAccount,
  options: GcpProviderOptions = {},
): Promise<ProviderImpl> {
  const provider = gcpProvider({ fetch: emu.fetch, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return provider.create((parsed as { value: GcpConfig }).value, {
    clock: manualClock(1_000_000),
    secrets,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    account: platformAccount,
  });
}

describe('compute', () => {
  it('passes every case of the ProviderImpl contract', async () => {
    const report = await runConformance(providerConformanceCases(), () => {
      const emu = new GceEmulator();
      emu.addInstance('us-central1-a', 'legacy');
      return {
        provider: gcpProvider({ fetch: emu.fetch }),
        config: gcpAccount,
        attachable: 'us-central1-a/legacy',
        offerId: 'us-central1-a/a3-highgpu-8g',
        image: 'ubuntu-2404-lts',
        context: { secrets, account: platformAccount },
      };
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toHaveLength(providerConformanceCases().length);
  });

  it('is a well-formed definition with the documented capabilities', async () => {
    expect(gcp).toMatchObject({ id: 'gcp', provides: ['vps'], extension: 'provider' });
    expect(gcp.capabilities).toEqual([
      'power',
      'list',
      'discover',
      'claim',
      'reservations',
      'networks',
    ]);
    const parsed = await gcp.config['~standard'].validate({
      projectId: 'p',
      zones: ['us-central1-a'],
    });
    expect(parsed).toMatchObject({
      value: { network: 'default', imageProject: 'ubuntu-os-cloud', diskGiB: 100 },
    });
    const none = await gcp.config['~standard'].validate({ projectId: 'p', zones: [] });
    expect('issues' in none && none.issues?.length).toBeTruthy();
    const inline = await gcp.config['~standard'].validate({
      projectId: 'p',
      zones: ['z'],
      credentials: '{"private_key":"raw"}',
    });
    expect('issues' in inline && inline.issues?.length).toBeTruthy();
  });

  it('create retries are deduplicated by requestId', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    const request = {
      offerId: 'us-central1-a/n2-standard-4',
      image: 'ubuntu-2404-lts',
      userData: '#cloud-config\n',
      name: 'ins_x',
    };
    const first = await impl.create(request, ctx('key-1'));
    const again = await impl.create(request, ctx('key-1'));
    expect(again.id).toBe(first.id);
    const inserts = emu.requests.filter(
      (r) => r.method === 'POST' && r.url.pathname.endsWith('/zones/us-central1-a/instances'),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.url.searchParams.get('requestId')).toBe(requestIdFor('key-1'));
    expect(inserts[1]!.url.searchParams.get('requestId')).toBe(requestIdFor('key-1'));
    expect(emu.instances.size).toBe(1);
  });

  it('create builds the VM from the offer, image, user data, labels and network', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu, { ...gcpAccount, diskGiB: 200 });
    const machine = await impl.create(
      {
        offerId: 'us-central1-a/a3-highgpu-8g',
        image: 'ubuntu-2404-lts',
        userData: '#cloud-config\nusers: []\n',
        name: 'ins_x',
        network: { network: 'bc-net', subnet: 'bc-sub', tags: ['bc-abc'] },
        labels: { 'better-compute-tenant': 'ten_1', 'better-compute-managed': 'false' },
      },
      ctx('key-1'),
    );
    expect(machine).toMatchObject({
      id: 'us-central1-a/bc-ins-x',
      state: 'pending',
      zone: 'us-central1-a',
      region: 'us-central1',
      machineType: 'a3-highgpu-8g',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
      claimedBy: 'ins_x',
    });
    const body = emu.requests.find((r) => r.method === 'POST' && r.body?.name)!.body!;
    expect(body).toMatchObject({
      name: 'bc-ins-x',
      machineType: 'zones/us-central1-a/machineTypes/a3-highgpu-8g',
      labels: {
        'better-compute-managed': 'true',
        'better-compute-instance': 'ins_x',
        'better-compute-tenant': 'ten_1',
      },
      metadata: { items: [{ key: 'user-data', value: '#cloud-config\nusers: []\n' }] },
      scheduling: { onHostMaintenance: 'TERMINATE' },
      tags: { items: ['bc-abc'] },
    });
    expect(body.disks[0].initializeParams).toMatchObject({
      sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts',
      diskSizeGb: '200',
    });
    expect(body.networkInterfaces[0]).toMatchObject({
      network: 'global/networks/bc-net',
      subnetwork: 'regions/us-central1/subnetworks/bc-sub',
    });
    const stored = emu.instances.get('us-central1-a/bc-ins-x')!;
    expect(stored.labels['better-compute-managed']).toBe('true');
  });

  it('create without a network ref uses the configured network and subnet; a full image URL is kept', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu, {
      ...gcpAccount,
      network: 'shared',
      subnet: 'shared-a',
      imageProject: 'my-images',
    });
    await impl.create(
      {
        offerId: 'us-central1-a/n2-standard-4',
        image: 'ubuntu-2404-lts',
        userData: '',
        name: 'ins_a',
      },
      ctx('a'),
    );
    await impl.create(
      {
        offerId: 'us-central1-a/n2-standard-4',
        image: 'https://compute.googleapis.com/compute/v1/projects/x/global/images/img-1',
        userData: '',
        name: 'ins_b',
      },
      ctx('b'),
    );
    const bodies = emu.requests
      .filter((r) => r.method === 'POST' && r.body?.name)
      .map((r) => r.body!);
    expect(bodies[0]!.networkInterfaces[0]).toMatchObject({
      network: 'global/networks/shared',
      subnetwork: 'regions/us-central1/subnetworks/shared-a',
    });
    expect(bodies[0]!.disks[0].initializeParams.sourceImage).toBe(
      'projects/my-images/global/images/family/ubuntu-2404-lts',
    );
    expect(bodies[1]!.disks[0].initializeParams.sourceImage).toBe(
      'https://compute.googleapis.com/compute/v1/projects/x/global/images/img-1',
    );
    expect(bodies[0]!.scheduling.onHostMaintenance).toBe('MIGRATE');
  });

  it('create on a reservation offer sets SPECIFIC_RESERVATION affinity', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    await impl.create(
      {
        offerId: 'us-central1-a/a3-highgpu-8g@rsv-a',
        image: 'ubuntu-2404-lts',
        userData: '',
        name: 'ins_x',
      },
      ctx('k'),
    );
    expect(emu.instances.get('us-central1-a/bc-ins-x')!.reservationAffinity).toEqual({
      consumeReservationType: 'SPECIFIC_RESERVATION',
      key: 'compute.googleapis.com/reservation-name',
      values: ['rsv-a'],
    });
  });

  it('create reports capacity, quota and zone errors', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    const request = (offerId: string) => ({
      offerId,
      image: 'ubuntu-2404-lts',
      userData: '',
      name: 'ins_x',
    });
    // An insert that is already DONE with an error (GCE answers some failures at once).
    emu.insertDelayTicks = 0;
    emu.failNextOperation = { code: 'ZONE_RESOURCE_POOL_EXHAUSTED', httpErrorStatusCode: 503 };
    await expect(
      impl.create(request('us-central1-a/a3-highgpu-8g'), ctx('k1')),
    ).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { provider: 'gcp', reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' },
    });
    emu.failNext = { status: 403, reason: 'quotaExceeded', message: 'Quota GPUS exceeded' };
    await expect(
      impl.create(request('us-central1-a/a3-highgpu-8g'), ctx('k2')),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    await expect(
      impl.create(request('europe-west4-a/n2-standard-4'), ctx('k3')),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      impl.create(request('us-central1-a/no-such-type'), ctx('k4')),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(emu.instances.size).toBe(0);
  });

  it('an asynchronous stockout surfaces from get as CAPACITY_UNAVAILABLE', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    const request = {
      offerId: 'us-central1-a/a3-highgpu-8g',
      image: 'ubuntu-2404-lts',
      userData: '',
      name: 'ins_x',
    };
    emu.failNextOperation = { code: 'ZONE_RESOURCE_POOL_EXHAUSTED', httpErrorStatusCode: 503 };
    const machine = await impl.create(request, ctx('k1'));
    expect(machine.state).toBe('pending');
    // The insert is still running: the VM is on its way.
    expect(await impl.get(machine.id, ctx())).toMatchObject({ id: machine.id, state: 'pending' });
    emu.finishOperations();
    await expect(impl.get(machine.id, ctx())).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { provider: 'gcp', reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' },
    });
    const lookup = emu.requests.find((r) =>
      r.url.pathname.endsWith('/zones/us-central1-a/operations'),
    )!;
    expect(lookup.url.searchParams.get('filter')).toContain('operationType="insert"');
    expect(lookup.url.searchParams.get('filter')).toContain('instances/bc-ins-x');
    // A quota error on the operation maps the same way.
    emu.failNextOperation = { code: 'QUOTA_EXCEEDED', message: 'Quota GPUS exceeded' };
    const second = await impl.create({ ...request, name: 'ins_y' }, ctx('k2'));
    emu.finishOperations();
    await expect(impl.get(second.id, ctx())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    // A VM that never had an insert is simply absent.
    expect(await impl.get('us-central1-a/never', ctx())).toBeUndefined();
  });

  it('get answers pending while the insert runs and the VM is not visible yet', async () => {
    const emu = new GceEmulator();
    emu.deferInsert = true;
    const impl = await build(emu);
    const machine = await impl.create(
      { offerId: 'us-central1-a/n2-standard-4', image: 'i', userData: '', name: 'ins_x' },
      ctx('k1'),
    );
    expect(emu.instances.size).toBe(0);
    expect(await impl.get(machine.id, ctx())).toMatchObject({
      id: 'us-central1-a/bc-ins-x',
      state: 'pending',
      zone: 'us-central1-a',
    });
    emu.finishOperations();
    expect(await impl.get(machine.id, ctx())).toMatchObject({ state: 'running', vcpu: 4 });
  });

  it('a VM shows as pending while its insert runs and running after', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    const machine = await impl.create(
      { offerId: 'us-central1-a/n2-standard-4', image: 'i', userData: '', name: 'ins_x' },
      ctx('k1'),
    );
    expect(await impl.get(machine.id, ctx())).toMatchObject({ state: 'pending' });
    emu.finishOperations();
    expect(await impl.get(machine.id, ctx())).toMatchObject({ state: 'running' });
  });

  it('create adopts an existing VM that carries the same instance label', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'bc-ins-x', {
      labels: { 'better-compute-managed': 'true', 'better-compute-instance': 'ins_x' },
    });
    emu.addInstance('us-central1-a', 'bc-ins-y', {
      labels: { 'better-compute-instance': 'someone-else' },
    });
    const impl = await build(emu);
    const base = { offerId: 'us-central1-a/n2-standard-4', image: 'i', userData: '' };
    const adopted = await impl.create({ ...base, name: 'ins_x' }, ctx('fresh-key'));
    expect(adopted.id).toBe('us-central1-a/bc-ins-x');
    await expect(impl.create({ ...base, name: 'ins_y' }, ctx('other-key'))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('get maps the VM and answers undefined for a missing or malformed id', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'vm1', { machineType: 'a3-highgpu-8g' });
    const impl = await build(emu);
    expect(await impl.get('us-central1-a/vm1', ctx())).toMatchObject({
      id: 'us-central1-a/vm1',
      state: 'running',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
      addresses: ['10.128.0.' + (Number(emu.instances.get('us-central1-a/vm1')!.id) % 250)],
    });
    expect(await impl.get('us-central1-a/missing', ctx())).toBeUndefined();
    expect(await impl.get('not-an-id', ctx())).toBeUndefined();
  });

  it('delete refuses a VM without the managed label', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'legacy');
    emu.addInstance('us-central1-a', 'mine', { labels: { 'better-compute-managed': 'true' } });
    const impl = await build(emu);
    await expect(impl.delete('us-central1-a/legacy', ctx())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(emu.instances.has('us-central1-a/legacy')).toBe(true);
    await impl.delete('us-central1-a/mine', ctx());
    expect(emu.instances.has('us-central1-a/mine')).toBe(false);
    // Already gone, or never an id: counts as deleted.
    await impl.delete('us-central1-a/mine', ctx());
    await impl.delete('nonsense', ctx());
  });

  it('power maps actions', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'vm1', { labels: { 'better-compute-instance': 'ins_1' } });
    emu.addInstance('us-central1-a', 'legacy');
    const impl = await build(emu);
    const verbs = () =>
      emu.requests
        .filter((r) => r.method === 'POST' && r.url.pathname.includes('/instances/vm1/'))
        .map((r) => r.url.pathname.split('/').pop() + r.url.search);
    await impl.power!('us-central1-a/vm1', 'graceful-restart', ctx());
    expect(verbs()).toEqual(['stop', 'start']);
    emu.requests.length = 0;
    await impl.power!('us-central1-a/vm1', 'off', ctx());
    await impl.power!('us-central1-a/vm1', 'graceful-off', ctx());
    await impl.power!('us-central1-a/vm1', 'on', ctx());
    await impl.power!('us-central1-a/vm1', 'reset', ctx());
    await impl.power!('us-central1-a/vm1', 'cycle', ctx());
    expect(verbs()).toEqual(['stop?discardLocalSsd=false', 'stop', 'start', 'reset', 'reset']);
    await expect(impl.power!('us-central1-a/vm1', 'nmi', ctx())).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(impl.power!('us-central1-a/legacy', 'on', ctx())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(impl.power!('us-central1-a/ghost', 'on', ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('graceful-restart waits for the stop, and gives up with UNAVAILABLE after 20 s', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'vm1', { labels: { 'better-compute-instance': 'ins_1' } });
    const impl = await build(emu, gcpAccount, { operationPollMs: 1 });
    emu.operationDelayTicks = 2;
    await impl.power!('us-central1-a/vm1', 'graceful-restart', ctx());
    expect(emu.instances.get('us-central1-a/vm1')!.status).toBe('RUNNING');
    expect(emu.requests.filter((r) => r.url.pathname.includes('/operations/'))).toHaveLength(3);
    // Polling every 2 s, the wait gives up after 20 s of (fake) time.
    const slow = await build(emu);
    emu.operationDelayTicks = 1000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const outcome = slow.power!('us-central1-a/vm1', 'graceful-restart', ctx()).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await outcome).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('toMachine maps a3-highgpu-8g with 8 nvidia-h100-80gb', () => {
    const machine = toMachine({
      name: 'vm1',
      zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a',
      machineType:
        'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/machineTypes/a3-highgpu-8g',
      status: 'RUNNING',
      guestAccelerators: [
        {
          acceleratorType: 'zones/us-central1-a/acceleratorTypes/nvidia-h100-80gb',
          acceleratorCount: 8,
        },
      ],
      networkInterfaces: [{ networkIP: '10.0.0.2', accessConfigs: [{ natIP: '34.1.2.3' }] }],
    });
    expect(machine).toMatchObject({
      id: 'us-central1-a/vm1',
      state: 'running',
      gpus: { model: 'H100', count: 8 },
      vcpu: 208,
      memoryGiB: 1872,
      zone: 'us-central1-a',
      region: 'us-central1',
      offerId: 'us-central1-a/a3-highgpu-8g',
      addresses: ['10.0.0.2', '34.1.2.3'],
    });
  });

  it('maps statuses and accelerator models', () => {
    const base = {
      name: 'v',
      zone: 'zones/z-a',
      machineType: 'zones/z-a/machineTypes/n2-standard-4',
    };
    const state = (status: string) => toMachine({ ...base, status }).state;
    expect(
      [
        'PROVISIONING',
        'STAGING',
        'RUNNING',
        'STOPPING',
        'SUSPENDING',
        'SUSPENDED',
        'TERMINATED',
        'STOPPED',
        'REPAIRING',
        'WHAT',
      ].map(state),
    ).toEqual([
      'pending',
      'pending',
      'running',
      'stopped',
      'stopped',
      'stopped',
      'stopped',
      'stopped',
      'error',
      'unknown',
    ]);
    expect(toMachine(base).state).toBe('unknown');
    const models = [
      'nvidia-h100-80gb',
      'nvidia-h100-mega-80gb',
      'nvidia-h200-141gb',
      'nvidia-b200',
      'nvidia-a100-80gb',
      'nvidia-tesla-a100',
      'nvidia-l4',
      'nvidia-l40s',
      'nvidia-tesla-t4',
    ].map(gpuModel);
    expect(models).toEqual(['H100', 'H100', 'H200', 'B200', 'A100', 'A100', 'L4', 'L40S', 'other']);
    expect(toMachine(base)).toMatchObject({ vcpu: 4 });
    expect(
      toMachine({ ...base, machineType: 'zones/z-a/machineTypes/n2-custom-6-12288' }),
    ).toMatchObject({
      vcpu: 6,
      memoryGiB: 12,
    });
  });

  it('listOffers filters by gpuModel and minGpus', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu, { projectId: 'p', zones: ['us-central1-a', 'europe-west4-a'] });
    const all = await impl.listOffers({});
    expect(all.map((o) => o.id)).toEqual([
      'europe-west4-a/a2-highgpu-1g',
      'europe-west4-a/a3-highgpu-8g',
      'europe-west4-a/e2-standard-2',
      'europe-west4-a/g2-standard-4',
      'europe-west4-a/n2-standard-4',
      'us-central1-a/a2-highgpu-1g',
      'us-central1-a/a3-highgpu-8g',
      'us-central1-a/e2-standard-2',
      'us-central1-a/g2-standard-4',
      'us-central1-a/n2-standard-4',
    ]);
    expect(all.find((o) => o.id === 'us-central1-a/a3-highgpu-8g')).toEqual({
      id: 'us-central1-a/a3-highgpu-8g',
      kind: 'vps',
      region: 'us-central1',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
      available: true,
    });
    const h100 = await impl.listOffers({ gpuModel: 'H100' });
    expect(h100.map((o) => o.id)).toEqual([
      'europe-west4-a/a3-highgpu-8g',
      'us-central1-a/a3-highgpu-8g',
    ]);
    expect((await impl.listOffers({ minGpus: 8 })).map((o) => o.gpus?.count)).toEqual([8, 8]);
    expect((await impl.listOffers({ minGpus: 1 })).every((o) => o.gpus)).toBe(true);
    expect(await impl.listOffers({ gpuModel: 'B200' })).toEqual([]);
    expect(
      (await impl.listOffers({ region: 'us-central1', minVcpu: 100 })).map((o) => o.id),
    ).toEqual(['us-central1-a/a3-highgpu-8g']);
    expect(await impl.listOffers({ kind: 'metal' })).toEqual([]);
    expect(await impl.listOffers({ minMemoryGiB: 2000 })).toEqual([]);
  });

  it('list yields only managed VMs in the configured zones', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'mine', { labels: { 'better-compute-managed': 'true' } });
    emu.addInstance('us-central1-a', 'mine2', { labels: { 'better-compute-managed': 'true' } });
    emu.addInstance('us-central1-a', 'mine3', { labels: { 'better-compute-managed': 'true' } });
    emu.addInstance('us-central1-a', 'legacy');
    emu.addInstance('europe-west4-a', 'elsewhere', {
      labels: { 'better-compute-managed': 'true' },
    });
    const impl = await build(emu);
    const ids: string[] = [];
    for await (const machine of impl.list!(ctx())) ids.push(machine.id);
    expect(ids.sort()).toEqual([
      'us-central1-a/mine',
      'us-central1-a/mine2',
      'us-central1-a/mine3',
    ]);
    const listing = emu.requests.filter((r) => r.url.pathname.endsWith('/aggregated/instances'));
    expect(listing[0]!.url.searchParams.get('filter')).toBe('labels.better-compute-managed=true');
  });

  it('uses the key behind credentials, impersonation and a host token source', async () => {
    const emu = new GceEmulator();
    const keySecrets = { resolve: async () => keyJson };
    const provider = gcpProvider({ fetch: emu.fetch });
    const impl = await provider.create(
      { projectId: 'p', zones: ['us-central1-a'], credentials: 'vault://kv/gcp' as never },
      { clock: manualClock(0), secrets: keySecrets, log: ctx().log },
    );
    await impl.get('us-central1-a/x', ctx());
    expect(emu.jwtClaims).toHaveLength(1);
    const impersonating = await provider.create(
      { projectId: 'p', zones: ['us-central1-a'], impersonate: 'target@p.iam.gserviceaccount.com' },
      { clock: manualClock(0), secrets: keySecrets, log: ctx().log, account: platformAccount },
    );
    await impersonating.get('us-central1-a/x', ctx());
    expect(
      emu.requests.some((r) =>
        r.url.pathname.endsWith('target@p.iam.gserviceaccount.com:generateAccessToken'),
      ),
    ).toBe(true);
    const hostEmu = new GceEmulator();
    const host = await build(hostEmu, gcpAccount, {
      tokenSource: { token: async () => 'host-token' },
    });
    await host.get('us-central1-a/x', ctx()).catch(() => undefined);
    expect(hostEmu.requests[0]!.headers.get('authorization')).toBe('Bearer host-token');
  });

  it('ambient credentials serve platform accounts only; a key is never overridden (F1)', async () => {
    const emu = new GceEmulator();
    emu.validTokens.add('host-token');
    const keySecrets = { resolve: async () => keyJson };
    const provider = gcpProvider({
      fetch: emu.fetch,
      tokenSource: { token: async () => 'host-token' },
    });
    const base = { clock: manualClock(0), secrets: keySecrets, log: ctx().log };
    const ambient = { projectId: 'p', zones: ['us-central1-a'] };
    // A tenant's account (or one whose owner is unknown) cannot run on the host's identity, with
    // or without impersonation; refused when the client is built, before any request.
    for (const account of [tenantAccount, undefined])
      for (const config of [
        ambient,
        { ...ambient, impersonate: 'admin@p.iam.gserviceaccount.com' },
      ]) {
        const error = await Promise.resolve()
          .then(() => provider.create(config, { ...base, ...(account ? { account } : {}) }))
          .catch((e: unknown) => e);
        expect(error).toMatchObject({
          code: 'INVALID_CONFIG',
          details: { reason: 'ambientCredentials' },
        });
      }
    expect(emu.requests).toEqual([]);
    // A tenant's account with its own key uses the key, even though the host has a token source.
    const keyed = await provider.create(
      { ...ambient, credentials: 'vault://kv/acme-gcp' as never },
      { ...base, account: tenantAccount },
    );
    await keyed.get('us-central1-a/x', ctx()).catch(() => undefined);
    expect(emu.jwtClaims).toHaveLength(1);
    const computeCalls = emu.requests.filter((r) => r.url.hostname === 'compute.googleapis.com');
    expect(computeCalls.length).toBeGreaterThan(0);
    for (const call of computeCalls)
      expect(call.headers.get('authorization')).not.toBe('Bearer host-token');
    // The platform's own account still runs on the host identity.
    const platform = await provider.create(ambient, { ...base, account: platformAccount });
    const before = emu.requests.length;
    await platform.get('us-central1-a/x', ctx()).catch(() => undefined);
    expect(emu.requests[before]!.headers.get('authorization')).toBe('Bearer host-token');
  });
});

describe('attach primitives', () => {
  const owned = 'better-compute-instance';
  const managed = 'better-compute-managed';

  it('discover yields unlabeled VMs with shape, networks and consumed reservation', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'legacy', {
      machineType: 'a3-highgpu-8g',
      labels: { team: 'ml' },
      tags: { items: ['ssh', 'web'] },
      networkInterfaces: [
        {
          network: 'https://compute.googleapis.com/compute/v1/projects/p/global/networks/vpc-1',
          subnetwork:
            'https://compute.googleapis.com/compute/v1/projects/p/regions/us-central1/subnetworks/sub-1',
          accessConfigs: [{}],
        },
      ],
      creationTimestamp: '2026-01-02T03:04:05.000Z',
      resourceStatus: {
        reservationConsumptionInfo: {
          consumedReservation:
            'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/reservations/rsv-a',
        },
      },
    });
    emu.addInstance('us-central1-a', 'shared-vm', {
      resourceStatus: {
        reservationConsumptionInfo: {
          consumedReservation: 'projects/owner/zones/us-central1-a/reservations/shared-rsv',
        },
      },
    });
    emu.addInstance('us-central1-a', 'claimed', {
      labels: { [owned]: 'ins_7', [managed]: 'true' },
    });
    emu.addInstance('europe-west4-a', 'elsewhere');
    const impl = await build(emu);
    const found = new Map<string, ExternalMachine>();
    for await (const machine of impl.discover!(ctx())) found.set(machine.id, machine);
    expect([...found.keys()].sort()).toEqual([
      'us-central1-a/claimed',
      'us-central1-a/legacy',
      'us-central1-a/shared-vm',
    ]);
    const legacy = found.get('us-central1-a/legacy')!;
    const suffix = Number(emu.instances.get('us-central1-a/legacy')!.id) % 250;
    expect(legacy).toMatchObject({
      state: 'running',
      zone: 'us-central1-a',
      region: 'us-central1',
      machineType: 'a3-highgpu-8g',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
      labels: { team: 'ml' },
      networks: [
        {
          network: 'vpc-1',
          subnet: 'sub-1',
          address: `10.128.0.${suffix}`,
          publicAddress: `203.0.113.${suffix}`,
          tags: ['ssh', 'web'],
        },
      ],
      reservation: 'us-central1-a/rsv-a',
      createdAt: Date.parse('2026-01-02T03:04:05.000Z'),
    });
    expect(legacy.claimedBy).toBeUndefined();
    expect(found.get('us-central1-a/shared-vm')!.reservation).toBe(
      'projects/owner/zones/us-central1-a/reservations/shared-rsv',
    );
    expect(found.get('us-central1-a/claimed')!.claimedBy).toBe('ins_7');
  });

  it('discover honours discoverLabel', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'a', { labels: { fleet: 'gpu' } });
    emu.addInstance('us-central1-a', 'b', { labels: { fleet: 'cpu' } });
    emu.addInstance('us-central1-a', 'c');
    emu.addInstance('us-central1-a', 'd', { labels: { fleet: 'gpu' } });
    const impl = await build(emu, { ...gcpAccount, discoverLabel: 'fleet=gpu' });
    const ids: string[] = [];
    for await (const machine of impl.discover!(ctx())) ids.push(machine.id);
    expect(ids.sort()).toEqual(['us-central1-a/a', 'us-central1-a/d']);
    expect(
      emu.requests
        .find((r) => r.url.pathname.endsWith('/aggregated/instances'))!
        .url.searchParams.get('filter'),
    ).toBe('labels.fleet=gpu');
    await expect(build(emu, { ...gcpAccount, discoverLabel: 'Bad Label' })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('claim writes the instance label using the fingerprint', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'legacy', { labels: { team: 'ml' } });
    const fingerprint = vm.labelFingerprint;
    const impl = await build(emu);
    const claimed = await impl.claim!('us-central1-a/legacy', 'ins_1', ctx());
    const write = emu.requests.find((r) => r.url.pathname.endsWith('/setLabels'))!;
    expect(write.body).toEqual({
      labels: { team: 'ml', [owned]: 'ins_1' },
      labelFingerprint: fingerprint,
    });
    expect(claimed).toMatchObject({ claimedBy: 'ins_1', labels: { team: 'ml', [owned]: 'ins_1' } });
    expect(vm.labelFingerprint).not.toBe(fingerprint);
    // Claiming again for the same instance writes nothing.
    emu.requests.length = 0;
    await impl.claim!('us-central1-a/legacy', 'ins_1', ctx());
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/setLabels'))).toBe(false);
    // Neither managed nor anything else was added.
    expect(emu.instances.get('us-central1-a/legacy')!.labels[managed]).toBeUndefined();
  });

  it('claim with managed also hands deletion to better-compute', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'legacy');
    const impl = await build(emu);
    await impl.claim!('us-central1-a/legacy', 'ins_1', ctx(), { managed: true });
    expect(emu.instances.get('us-central1-a/legacy')!.labels).toEqual({
      [owned]: 'ins_1',
      [managed]: 'true',
    });
    await impl.delete('us-central1-a/legacy', ctx());
    expect(emu.instances.has('us-central1-a/legacy')).toBe(false);
  });

  it('claim refuses a VM claimed by another instance', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'taken', { labels: { [owned]: 'ins_other' } });
    emu.addInstance('europe-west4-a', 'far');
    const impl = await build(emu);
    await expect(impl.claim!('us-central1-a/taken', 'ins_1', ctx())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/setLabels'))).toBe(false);
    expect(emu.instances.get('us-central1-a/taken')!.labels[owned]).toBe('ins_other');
    await expect(impl.claim!('us-central1-a/ghost', 'ins_1', ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(impl.claim!('europe-west4-a/far', 'ins_1', ctx())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('claim retries once on a stale fingerprint, and reports CONFLICT on a second', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'legacy', { labels: { team: 'ml' } });
    const impl = await build(emu);
    let stale = 1;
    emu.beforeAction = (action, instance) => {
      if (action === 'setLabels' && stale-- > 0) {
        // Somebody else relabels the VM between our read and our write.
        instance.labels = { ...instance.labels, extra: 'x' };
        instance.labelFingerprint = `changed-by-someone-${stale}`;
      }
    };
    const claimed = await impl.claim!('us-central1-a/legacy', 'ins_1', ctx());
    expect(claimed.labels).toEqual({ team: 'ml', extra: 'x', [owned]: 'ins_1' });
    expect(emu.requests.filter((r) => r.url.pathname.endsWith('/setLabels'))).toHaveLength(2);
    // Release, then lose the race twice.
    await impl.release!('us-central1-a/legacy', 'ins_1', ctx());
    stale = 2;
    await expect(impl.claim!('us-central1-a/legacy', 'ins_1', ctx())).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { status: 412 },
    });
    expect(vm.labels[owned]).toBeUndefined();
  });

  it('release only removes its own label', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'legacy', {
      labels: { team: 'ml', [owned]: 'ins_1' },
    });
    const impl = await build(emu);
    await impl.release!('us-central1-a/legacy', 'ins_other', ctx());
    expect(vm.labels).toEqual({ team: 'ml', [owned]: 'ins_1' });
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/setLabels'))).toBe(false);
    await impl.release!('us-central1-a/legacy', 'ins_1', ctx());
    expect(vm.labels).toEqual({ team: 'ml' });
    // Releasing an unclaimed VM is a no-op.
    emu.requests.length = 0;
    await impl.release!('us-central1-a/legacy', 'ins_1', ctx());
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/setLabels'))).toBe(false);
  });

  it('release keeps the managed label it never wrote', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'legacy', {
      labels: { [owned]: 'ins_1', [managed]: 'true' },
    });
    const impl = await build(emu);
    await impl.release!('us-central1-a/legacy', 'ins_1', ctx());
    expect(vm.labels).toEqual({ [managed]: 'true' });
  });

  it('release of a deleted VM succeeds', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    await impl.release!('us-central1-a/gone', 'ins_1', ctx());
    await impl.release!('nonsense', 'ins_1', ctx());
  });
});
