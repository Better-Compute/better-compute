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
//
// Task 6 (part 2): before a federated account is stored, checkAccount proves that the pool provider
// trusts exactly the account's subject (a stranger's and a sibling's probes are refused, the real
// subject is accepted), that impersonation works, and that the final token can read the project.

afterEach(closeFixtures);

const ZONE = 'us-central1-a';
const ISSUER = 'https://compute.example.test/api/compute/workload';
const AUDIENCE =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/tenants/providers/control-plane';
const OTHER_AUDIENCE =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/tenants/providers/second';

interface WorldOptions {
  issuer?: boolean;
  /**
   * The pool provider's attribute condition. Default: exactly the subjects of the accounts these
   * tests create, so the probes (another tenant, another name) are refused.
   */
  trust?: (sub: string, ids: { acme: string; root: string }) => boolean;
  /** False: tokens STS grants are not valid at GCE or IAM Credentials. */
  grantValid?: boolean;
  checkTimeoutMs?: number;
}

const trustedNames = ['keyless', 'first', 'second', 'third', 'retry'];

async function world(options: WorldOptions = {}) {
  const emu = new GceEmulator();
  const issuer = workloadIssuer({ issuer: ISSUER, signingKey: generateP256KeyPair().privateKey });
  let granted = 0;
  const ids = { acme: '', root: '' };
  const trust =
    options.trust ??
    ((sub: string) =>
      sub === `compute-account:${ids.root}/gcp/platform` ||
      trustedNames.some((name) => sub === `compute-account:${ids.acme}/gcp/${name}`));
  const grant = () => {
    const token = `ya29.federated-${++granted}`;
    if (options.grantValid !== false) emu.validTokens.add(token);
    return token;
  };
  const sts = new FakeSts({
    jwks: () => issuer.jwks(),
    issuer: ISSUER,
    audience: AUDIENCE,
    condition: (sub) => trust(sub, ids),
    grant,
  });
  // A second provider of the same pool, with the same condition.
  const otherSts = new FakeSts({
    jwks: () => issuer.jwks(),
    issuer: ISSUER,
    audience: OTHER_AUDIENCE,
    condition: (sub) => trust(sub, ids),
    grant,
  });
  /** `hang`: STS never answers (until the request is aborted). `fetches` counts every call. */
  const control = { hang: false, fetches: 0 };
  // STS is a different Google host than compute/iamcredentials: route by hostname, then audience.
  const routed: typeof fetch = (input, init) => {
    control.fetches++;
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (url.hostname !== 'sts.googleapis.com') return emu.fetch(input, init);
    if (control.hang)
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const audience = new URLSearchParams(String(init?.body ?? '')).get('audience');
    return (audience === OTHER_AUDIENCE ? otherSts : sts).fetch(input, init);
  };
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [
          gcpProvider({
            fetch: routed,
            ...(options.checkTimeoutMs !== undefined
              ? { checkTimeoutMs: options.checkTimeoutMs }
              : {}),
          }),
        ],
        discovery: { every: '1m' },
      }),
    ],
    ...(options.issuer === false ? {} : { pki: { workloadIssuer: issuer } }),
  });
  const { compute, tenants, iam } = fixture;
  ids.acme = tenants.acme.id;
  ids.root = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const acme = { token: tenants.acme.token };
  const createAccount = (name: string, config: Record<string, unknown>, idempotencyKey?: string) =>
    api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'gcp',
      name,
      config: { projectId: 'p', zones: [ZONE], ...config },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  const accounts = async () =>
    (await api.providerAccounts.list(acme, { tenantId: tenants.acme.id })).items as {
      name: string;
    }[];
  const subjectOf = (name: string) => `compute-account:${tenants.acme.id}/gcp/${name}`;
  return {
    emu,
    sts,
    control,
    fixture,
    api,
    acme,
    tenants,
    createAccount,
    accounts,
    subjectOf,
    compute,
  };
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
    // The check's two probes were refused; every exchange STS accepted was for the account's
    // subject, and compute saw its token.
    expect(w.sts.exchanges.filter((exchange) => !exchange.accepted)).toHaveLength(2);
    const accepted = w.sts.exchanges.filter((exchange) => exchange.accepted);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((exchange) => exchange.sub === w.subjectOf('keyless'))).toBe(true);
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
    expect(
      w.sts.exchanges.every(
        (exchange) => !exchange.accepted || exchange.sub === w.subjectOf('keyless'),
      ),
    ).toBe(true);
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

describe('federated accounts prove their trust before they are stored (checkAccount)', () => {
  const computeCalls = (w: World) =>
    w.emu.requests.filter((request) => request.url.hostname === 'compute.googleapis.com');

  it('refuses a provider that trusts any account subject', async () => {
    const w = await world({ trust: (sub) => sub.startsWith('compute-account:') });
    const refused = await codeOf(w.createAccount('keyless', { federationAudience: AUDIENCE }));
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationTrustsAnySubject', probe: 'stranger' },
    });
    // The stranger's probe was accepted, so nothing further was tried.
    expect(w.sts.exchanges).toHaveLength(1);
    expect(w.sts.exchanges[0]!.sub).not.toContain(w.tenants.acme.id);
    expect(await w.accounts()).toEqual([]);
    expect(computeCalls(w)).toEqual([]);
  });

  it('refuses a provider that trusts every account of the tenant', async () => {
    const w = await world({
      trust: (sub, ids) => sub.startsWith(`compute-account:${ids.acme}/`),
    });
    const refused = await codeOf(w.createAccount('keyless', { federationAudience: AUDIENCE }));
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationTrustsAnySubject', probe: 'sibling' },
    });
    expect(w.sts.exchanges.map((exchange) => exchange.accepted)).toEqual([false, true]);
    expect(await w.accounts()).toEqual([]);
    expect(computeCalls(w)).toEqual([]);
  });

  it("accepts exactly the account's subject", async () => {
    const w = await world({ trust: (sub) => sub === w.subjectOf('keyless') });
    await w.createAccount('keyless', { federationAudience: AUDIENCE });
    const [stranger, sibling, real] = w.sts.exchanges;
    expect(w.sts.exchanges).toHaveLength(3);
    // Another tenant with the same name, then this tenant with another name, then the account.
    expect(stranger).toMatchObject({ accepted: false });
    expect(stranger!.sub).toMatch(/^compute-account:[^/]+\/gcp\/keyless$/);
    expect(stranger!.sub).not.toContain(w.tenants.acme.id);
    expect(sibling).toMatchObject({ accepted: false });
    expect(sibling!.sub).toMatch(new RegExp(`^compute-account:${w.tenants.acme.id}/gcp/`));
    expect(sibling!.sub).not.toBe(w.subjectOf('keyless'));
    expect(real).toEqual({ sub: w.subjectOf('keyless'), accepted: true });
    // The project was read with the federated token, on the provider's compute endpoint.
    const project = computeCalls(w);
    expect(project.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /compute/v1/projects/p',
    ]);
    expect(bearer(project[0]!)).toBe('ya29.federated-1');
    expect((await w.accounts()).map((account) => account.name)).toEqual(['keyless']);
  });

  it('a refused real subject explains the condition to set', async () => {
    const w = await world({ trust: () => false });
    let caught: unknown;
    await w.createAccount('keyless', { federationAudience: AUDIENCE }).catch((error: unknown) => {
      caught = error;
    });
    expect(caught).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationRefused', stsError: 'invalid_grant' },
    });
    const message = (caught as Error).message;
    expect(message).toContain('assertion.sub == "compute-account:');
    expect(message).toContain(`assertion.sub == "${w.subjectOf('keyless')}"`);
    // No token (a JWT, an access token) is in the message or the details.
    const serialized = JSON.stringify({ message, details: (caught as any).details });
    expect(serialized).not.toMatch(/eyJ|ya29\./);
    expect(w.sts.exchanges.map((exchange) => exchange.accepted)).toEqual([false, false, false]);
    expect(await w.accounts()).toEqual([]);
    expect(computeCalls(w)).toEqual([]);
  });

  it('a project the federated identity cannot read is projectAccess', async () => {
    for (const status of [403, 404]) {
      const w = await world();
      w.emu.failNext = { status, reason: status === 403 ? 'forbidden' : 'notFound' };
      const refused = await codeOf(w.createAccount('keyless', { federationAudience: AUDIENCE }));
      expect(refused).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { reason: 'projectAccess', status },
      });
      expect(await w.accounts()).toEqual([]);
    }
  });

  it('an unreachable STS refuses create with UNAVAILABLE; a retry succeeds', async () => {
    const w = await world();
    w.sts.down = true;
    const refused = await codeOf(
      w.createAccount('retry', { federationAudience: AUDIENCE }, 'retry-key'),
    );
    expect(refused).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await w.accounts()).toEqual([]);
    w.sts.down = false;
    const account = await w.createAccount('retry', { federationAudience: AUDIENCE }, 'retry-key');
    expect(account).toMatchObject({ name: 'retry' });
    expect((await w.accounts()).map((stored) => stored.name)).toEqual(['retry']);
  });

  it('an STS that never answers is UNAVAILABLE timeout, not an abort', async () => {
    const w = await world({ checkTimeoutMs: 25 });
    w.control.hang = true;
    const refused = await codeOf(w.createAccount('keyless', { federationAudience: AUDIENCE }));
    expect(refused).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'timeout' } });
    expect(await w.accounts()).toEqual([]);
  });

  it('impersonation refused is impersonationRefused', async () => {
    // STS grants a token IAM Credentials does not accept.
    const w = await world({ grantValid: false });
    const refused = await codeOf(
      w.createAccount('keyless', {
        federationAudience: AUDIENCE,
        impersonate: 'vm-admin@p.iam.gserviceaccount.com',
      }),
    );
    expect(refused).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'impersonationRefused' },
    });
    expect(await w.accounts()).toEqual([]);
    expect(computeCalls(w)).toEqual([]);
  });

  it('with impersonate, the project is read as the impersonated account', async () => {
    const w = await world();
    await w.createAccount('keyless', {
      federationAudience: AUDIENCE,
      impersonate: 'vm-admin@p.iam.gserviceaccount.com',
    });
    const project = computeCalls(w);
    expect(project.map((request) => request.path)).toEqual(['/compute/v1/projects/p']);
    expect(bearer(project[0]!)).toMatch(/^ya29\.imp-/);
  });

  it('a key account makes no network call when it is created', async () => {
    const w = await world();
    await w.createAccount('keyed', { credentials: `secret://${w.tenants.acme.id}/gcp-key` });
    expect(w.control.fetches).toBe(0);
    expect(w.sts.exchanges).toEqual([]);
    expect((await w.accounts()).map((stored) => stored.name)).toEqual(['keyed']);
  });
});
