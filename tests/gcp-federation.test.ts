import { afterEach, describe, expect, it } from 'vitest';
import { gcpProvider } from '@better-compute/provider-gcp';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { GceEmulator } from './support/gce-emulator.js';
import { FakeSts } from './support/gcp/sts.js';

// GCP WS1 Task 5: a tenant's GCP account signs in with no key. vps fixes the account's workload
// subject; provider-gcp mints a JWT for it, exchanges it at STS for an access token (optionally
// impersonating a service account on top), and uses that token on compute calls. Federation is
// never ambient, so the F1 refusal (a tenant account needs its own credentials) is satisfied by it.

afterEach(closeFixtures);

const ZONE = 'us-central1-a';
const ISSUER = 'https://compute.example.test/api/compute/workload';
const AUDIENCE =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/tenants/providers/control-plane';
const OTHER_AUDIENCE =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/tenants/providers/second';

async function world(options: { issuer?: boolean } = {}) {
  const emu = new GceEmulator();
  const issuer = workloadIssuer({ issuer: ISSUER, signingKey: generateP256KeyPair().privateKey });
  let granted = 0;
  const sts = new FakeSts({
    jwks: () => issuer.jwks(),
    issuer: ISSUER,
    audience: AUDIENCE,
    condition: (sub) => sub.startsWith('compute-account:'),
    grant: () => {
      const token = `ya29.federated-${++granted}`;
      emu.validTokens.add(token);
      return token;
    },
  });
  // STS is a different Google host than compute/iamcredentials: route by hostname.
  const routed: typeof fetch = (input, init) =>
    new URL(typeof input === 'object' && 'url' in input ? input.url : String(input)).hostname ===
    'sts.googleapis.com'
      ? sts.fetch(input, init)
      : emu.fetch(input, init);
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [gcpProvider({ fetch: routed })], discovery: { every: '1m' } })],
    ...(options.issuer === false ? {} : { pki: { workloadIssuer: issuer } }),
  });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const acme = { token: tenants.acme.token };
  const createAccount = (name: string, config: Record<string, unknown>) =>
    api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'gcp',
      name,
      config: { projectId: 'p', zones: [ZONE], ...config },
    });
  return { emu, sts, fixture, api, acme, tenants, createAccount, compute };
}

type World = Awaited<ReturnType<typeof world>>;

/** acme's pool over its own account, with one flavor, ready for `instances.create`. */
async function poolFor(w: World, accountId: string) {
  const { api, acme, tenants } = w;
  // A tenant's own (custom) site and pool, over its own account (R1).
  const site = await api.sites.create(acme, {
    tenantId: tenants.acme.id,
    kind: 'custom',
    region: 'us-central1',
    idempotencyKey: 'site',
  });
  const pool = await api.pools.create(acme, {
    tenantId: tenants.acme.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: accountId,
    ownerQuota: { vcpu: 100, memoryGiB: 1000, diskGiB: 10_000 },
    idempotencyKey: 'pool',
  });
  await api.flavors.create(acme, {
    tenantId: tenants.acme.id,
    poolId: pool.id,
    name: 'n2.standard.4',
    vcpu: 4,
    memoryGiB: 16,
    diskGiB: 100,
    offerId: `${ZONE}/n2-standard-4`,
  });
  return pool;
}

async function createVm(w: World, poolId: string) {
  const { api, acme, tenants, emu, fixture, compute } = w;
  const created = await api.instances.create(acme, {
    tenantId: tenants.acme.id,
    poolId,
    flavor: 'n2.standard.4',
    imageId: 'debian-12',
    sshKeys: [],
    idempotencyKey: 'vm-1',
  });
  for (let round = 0; round < 6; round++) {
    emu.finishOperations();
    await fixture.advance(5_000);
    for (let pass = 0; pass < 2; pass++) await compute.jobs['vps.instances']!.tick();
    if (
      (await api.instances.get(acme, { tenantId: tenants.acme.id, instanceId: created.id }))
        .state === 'running'
    )
      break;
  }
  return created;
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved' }) as { code?: string; details?: unknown },
    (error: { code?: string; details?: unknown }) => ({ code: error.code, details: error.details }),
  );

const bearer = (request: { headers: Headers }) =>
  /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];

describe('keyless GCP accounts (workload identity federation)', () => {
  it('a tenant account with federation and no key creates a VM', async () => {
    const w = await world();
    const account = await w.createAccount('keyless', { federationAudience: AUDIENCE });
    const pool = await poolFor(w, account.id);
    const created = await createVm(w, pool.id);

    const vm = [...w.emu.instances.values()].find(
      (instance) => instance.labels?.['better-compute-instance'] === created.id,
    );
    expect(vm).toBeDefined();
    // The one exchange STS accepted was for the account's subject, and compute saw its token.
    expect(w.sts.exchanges).toEqual([
      { sub: `compute-account:${w.tenants.acme.id}/gcp/keyless`, accepted: true },
    ]);
    const compute = w.emu.requests.filter(
      (request) => request.url.hostname === 'compute.googleapis.com',
    );
    expect(compute.length).toBeGreaterThan(0);
    expect(compute.every((request) => bearer(request)?.startsWith('ya29.federated-'))).toBe(true);
    // No key path and no ambient identity were touched.
    expect(w.emu.jwtClaims).toEqual([]);
    expect(w.emu.metadataFlavors).toEqual([]);
  });

  it('federation with impersonate exchanges then impersonates', async () => {
    const w = await world();
    const target = 'vm-admin@p.iam.gserviceaccount.com';
    const account = await w.createAccount('keyless', {
      federationAudience: AUDIENCE,
      impersonate: target,
    });
    const pool = await poolFor(w, account.id);
    await createVm(w, pool.id);

    const iam = w.emu.requests.filter(
      (request) => request.url.hostname === 'iamcredentials.googleapis.com',
    );
    expect(iam.length).toBeGreaterThan(0);
    expect(iam[0]!.path).toContain(`/serviceAccounts/${target}:generateAccessToken`);
    // The impersonation call was authorised by the STS-granted token ...
    expect(bearer(iam[0]!)).toMatch(/^ya29\.federated-/);
    expect(w.sts.exchanges.every((exchange) => exchange.accepted)).toBe(true);
    // ... and compute then ran as the impersonated account.
    const compute = w.emu.requests.filter(
      (request) => request.url.hostname === 'compute.googleapis.com',
    );
    expect(compute.length).toBeGreaterThan(0);
    expect(compute.every((request) => bearer(request)?.startsWith('ya29.imp-'))).toBe(true);
  });

  it('a platform account may federate too', async () => {
    const w = await world();
    const root = { token: w.tenants.root.token };
    const account = await w.api.providerAccounts.create(root, {
      tenantId: w.tenants.root.id,
      provider: 'gcp',
      name: 'platform',
      config: { projectId: 'p', zones: [ZONE], federationAudience: AUDIENCE },
    });
    w.emu.addInstance(ZONE, 'platform-db');
    await w.api.providerAccounts.discover(root, {
      tenantId: w.tenants.root.id,
      accountId: account.id,
    });
    await w.fixture.advance(60_000);
    for (let round = 0; round < 2; round++) await w.compute.jobs['vps.discovery']!.tick();
    const machines = await w.api.providerAccounts.machines(root, {
      tenantId: w.tenants.root.id,
      accountId: account.id,
    });
    expect(machines.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      `${ZONE}/platform-db`,
    ]);
    expect(w.sts.exchanges.length).toBeGreaterThan(0);
  });

  it('refuses credentials together with federation', async () => {
    const w = await world();
    const refused = await codeOf(
      w.createAccount('both', {
        federationAudience: AUDIENCE,
        credentials: `secret://${w.tenants.acme.id}/gcp-key`,
      }),
    );
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'credentialsAndFederation' },
    });
    expect(w.sts.exchanges).toEqual([]);
    expect(w.emu.requests).toEqual([]);
  });

  it('a federated account without an issuer is INVALID_CONFIG noWorkloadIssuer', async () => {
    const w = await world({ issuer: false });
    const refused = await codeOf(w.createAccount('keyless', { federationAudience: AUDIENCE }));
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'noWorkloadIssuer' },
    });
    expect(w.sts.exchanges).toEqual([]);
  });

  it('a tenant account with neither credentials nor federation is still refused (F1)', async () => {
    const w = await world();
    const refused = await codeOf(w.createAccount('ambient', {}));
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'ambientCredentials' },
    });
  });

  it('refuses a malformed federation audience', async () => {
    const w = await world();
    const refused = await codeOf(
      w.createAccount('bad', { federationAudience: 'https://example.com/pool' }),
    );
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationAudience' },
    });
  });

  it('refuses a second account with the same audience', async () => {
    const w = await world();
    await w.createAccount('first', { federationAudience: AUDIENCE });
    expect(await codeOf(w.createAccount('second', { federationAudience: AUDIENCE }))).toMatchObject(
      {
        code: 'CONFLICT',
      },
    );
    // The exclusive key is the audience only: a different provider of the pool is free.
    await w.createAccount('third', { federationAudience: OTHER_AUDIENCE });
  });
});
