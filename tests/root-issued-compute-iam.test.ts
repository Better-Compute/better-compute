import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeResourceTypes,
  manualClock,
  type Credential,
  type SqlExecutor,
} from '@better-compute/core';
import {
  createEmbeddedTestIam,
  type EmbeddedTestIam,
  type TestMember,
} from '@better-compute/iam/testing';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { gcpProvider } from '@better-compute/provider-gcp';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';
import { GceEmulator } from './support/gce-emulator.js';

// Platform-issued compute against a REAL better-iam (embedded, with compute's plugin, resolver and
// projection), the IAM half of tests/root-issued-compute.test.ts: the root administrator (MFA)
// issues compute to Acme through ROOT_OVERRIDE; Acme's operator holds an owner-conditioned policy
// (the `OwnReservations` pattern of examplePolicies, for instances), Acme's administrator holds
// `compute:*` on `*` in Acme, and Other's administrator likewise in Other. Policies are evaluated by
// better-iam on the projection rows compute writes: nothing here is scripted.

const ZONE = 'us-central1-a';
const REGION = 'us-central1';

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let emu: GceEmulator;
let api: any;
const clock = manualClock(Math.floor(Date.now() / 1000) * 1000);
let root: Credential;
let R: string;
let A: string;
let B: string;
let accountId: string;
let poolId: string;
let op: TestMember;
let admin: TestMember;
let bAdmin: TestMember;

const allow = (actions: string[], resources: string[], conditions?: Record<string, unknown>) => ({
  effect: 'allow' as const,
  actions,
  resources,
  ...(conditions ? { conditions } : {}),
});
const everything = { version: 1 as const, statements: [allow(['compute:*'], ['*'])] };

async function tick(job: string, ms = 5_000): Promise<void> {
  clock.set(clock.now() + ms);
  await setSimClock(database, clock.now());
  for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
}
async function settle(tenantId: string, instanceId: string, state: string): Promise<any> {
  let current = await api.instances.get(root, { tenantId, instanceId });
  for (let round = 0; round < 8 && current.state !== state; round++) {
    emu.finishOperations();
    await tick('vps.instances');
    current = await api.instances.get(root, { tenantId, instanceId });
  }
  return current;
}
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error?.code ?? String(error),
  );
const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
const createInput = (tenantId: string, extra: Record<string, unknown>) => ({
  tenantId,
  poolId,
  flavor: 'n2.standard.4',
  imageId: 'debian-12',
  sshKeys: [],
  ...extra,
});

beforeAll(async () => {
  emu = new GceEmulator();
  emu.validTokens.add('host-token');
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-root-issuance-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [...t.bridge.modules, vps({ providers: [gcp], discovery: { every: '1m' } })],
  } as any);
  await compute.initialize();
  await useSimClock(database, clock.now());
  api = compute.api;
  root = t.root.credential;
  R = t.root.tenantId;
  A = t.acme.tenantId;
  B = t.other.tenantId;

  // The platform: a root GCP account, a site, a provider pool offered to Acme and Other.
  const account = await api.providerAccounts.create(root, {
    tenantId: R,
    provider: 'gcp',
    name: 'gcp-platform',
    config: { projectId: 'p', zones: [ZONE] },
  });
  accountId = account.id;
  const site = await api.sites.create(root, {
    tenantId: R,
    kind: 'shared',
    region: REGION,
    idempotencyKey: 'iam-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: R,
    siteId: site.id,
    class: 'provider',
    providerAccountId: accountId,
    idempotencyKey: 'iam-pool',
  });
  poolId = pool.id;
  for (const toTenantId of [A, B])
    await api.pools.offer(root, {
      tenantId: R,
      poolId,
      toTenantId,
      quota: { vcpu: 200, memoryGiB: 2_000, diskGiB: 2_000, gpu: 0 },
    });
  await api.flavors.create(root, {
    tenantId: R,
    poolId,
    name: 'n2.standard.4',
    vcpu: 4,
    memoryGiB: 16,
    diskGiB: 100,
    offerId: `${ZONE}/n2-standard-4`,
  });
  emu.addInstance(ZONE, 'legacy');
  emu.addInstance(ZONE, 'spare');
  await api.providerAccounts.discover(root, { tenantId: R, accountId });
  await tick('vps.discovery');

  // Acme's operator: list gates on the tenant, read access to the offered pool, create anywhere,
  // and everything else on the instances it owns; networks of its tenant.
  op = await t.acme.member('operator');
  await t.acme.grant(op.identityId, {
    version: 1,
    statements: [
      allow(
        [
          'compute:instances:read',
          'compute:pools:read',
          'compute:networks:read',
          'compute:quotas:read',
        ],
        ['compute-tenant/*'],
      ),
      allow(
        ['compute:pools:read', 'compute:flavors:read', 'compute:capacity:read'],
        ['compute-pool/*'],
      ),
      allow(['compute:instances:create'], ['compute-instance/*']),
      allow(
        ['compute:instances:read', 'compute:instances:update', 'compute:instances:delete'],
        ['compute-instance/*'],
        { StringEquals: { 'resource.ownerId': '${principal.id}' } },
      ),
      allow(
        [
          'compute:networks:create',
          'compute:networks:read',
          'compute:networks:update',
          'compute:networks:delete',
        ],
        ['compute-network/*'],
      ),
    ],
  });
  admin = await t.acme.member('admin');
  await t.acme.grant(admin.identityId, everything);
  bAdmin = await t.other.member('admin');
  await t.other.grant(bAdmin.identityId, everything);
  // Sessions minted after the grants.
  op = { ...op, credential: await t.acme.signIn('operator') };
  admin = { ...admin, credential: await t.acme.signIn('admin') };
  bAdmin = { ...bAdmin, credential: await t.other.signIn('admin') };
}, 180_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

describe('platform-issued compute on a real better-iam', () => {
  let attached: string;
  let issued: string;
  let unowned: string;
  let network: string;

  it('root attaches and issues VMs to Acme’s operator, who controls exactly those (owner policy)', async () => {
    attached = (
      await api.instances.attach(root, {
        tenantId: A,
        poolId,
        externalId: `${ZONE}/legacy`,
        ownerIdentityId: op.identityId,
        idempotencyKey: 'attach-legacy',
      })
    ).id;
    issued = (
      await api.instances.create(
        root,
        createInput(A, { ownerIdentityId: op.identityId, idempotencyKey: 'issued' }),
      )
    ).id;
    // Without ownerIdentityId the instance is the operator's who made it (root's identity).
    unowned = (await api.instances.create(root, createInput(A, { idempotencyKey: 'unowned' }))).id;
    for (const id of [attached, issued, unowned])
      expect(await settle(A, id, 'running')).toMatchObject({ state: 'running' });

    expect(ids(await api.instances.list(op.credential, { tenantId: A })).sort()).toEqual(
      [attached, issued].sort(),
    );
    // scope 'all' decides item by item: the owner policy shows its own only.
    expect(
      ids(await api.instances.list(op.credential, { tenantId: A, scope: 'all' })).sort(),
    ).toEqual([attached, issued].sort());
    for (const instanceId of [attached, issued]) {
      const ref = { tenantId: A, instanceId };
      expect(await outcome(api.instances.get(op.credential, ref))).toBe('allowed');
      expect(await outcome(api.instances.stop(op.credential, ref))).toBe('allowed');
      expect(await outcome(api.instances.start(op.credential, ref))).toBe('allowed');
    }
    expect(
      await outcome(api.instances.get(op.credential, { tenantId: A, instanceId: unowned })),
    ).toBe('ACCESS_DENIED');
    expect(
      await outcome(api.instances.stop(op.credential, { tenantId: A, instanceId: unowned })),
    ).toBe('ACCESS_DENIED');
    // A tenant cannot hand instances to someone else, even with every grant of its tenant.
    expect(
      await outcome(
        api.instances.create(
          admin.credential,
          createInput(A, { ownerIdentityId: op.identityId, idempotencyKey: 'admin-for-op' }),
        ),
      ),
    ).toBe('ACCESS_DENIED');

    network = (
      await api.networks.create(op.credential, {
        tenantId: A,
        poolId,
        name: 'prod',
        idempotencyKey: 'op-net',
      })
    ).id;
    expect(
      await outcome(api.networks.get(op.credential, { tenantId: A, networkId: network })),
    ).toBe('allowed');
  });

  it('an owner must be an active identity of the tenant (R2), and only a root administrator issues (ROOT_OVERRIDE)', async () => {
    // R2: better-iam says who belongs to Acme; Other's administrator does not.
    expect(t.port.isMember).toBeTypeOf('function');
    expect(await t.port.isMember!(A, op.identityId)).toBe(true);
    expect(await t.port.isMember!(A, bAdmin.identityId)).toBe(false);
    expect(
      await outcome(
        api.instances.create(
          root,
          createInput(A, { ownerIdentityId: bAdmin.identityId, idempotencyKey: 'for-outsider' }),
        ),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(
        api.instances.attach(root, {
          tenantId: A,
          poolId,
          externalId: `${ZONE}/spare`,
          ownerIdentityId: bAdmin.identityId,
          idempotencyKey: 'spare-for-outsider',
        }),
      ),
    ).toBe('INVALID_INPUT');

    // A member of the root tenant holding compute:* there, but neither root administrator nor MFA:
    // its calls into Acme are decided in Acme, where it holds nothing.
    const member = await t.iam.api.identities.create(root, {
      tenantId: R,
      email: 'operator@root.test',
      name: 'Operator',
      password: 'a strong root operator password',
    });
    const policy = await t.iam.api.policies.create(root, {
      tenantId: R,
      name: 'root-compute-everything',
      document: everything,
    });
    const role = await t.iam.api.roles.create(root, {
      tenantId: R,
      name: 'root-compute-everything',
      policyIds: [policy.id],
    });
    await t.iam.api.bindings.create(root, {
      tenantId: R,
      roleId: role.id,
      subjectType: 'identity',
      subjectId: member.id,
    });
    const signedIn = await t.iam.api.auth.signIn({
      tenantId: R,
      email: 'operator@root.test',
      password: 'a strong root operator password',
    });
    if (!('token' in signedIn)) throw new Error('Unexpected MFA for a root member');
    const rootMember: Credential = { token: signedIn.token };
    expect(await t.port.authenticate(rootMember)).toMatchObject({ tenantId: R, mfa: false });
    expect(
      await outcome(
        api.instances.create(
          rootMember,
          createInput(A, { ownerIdentityId: op.identityId, idempotencyKey: 'member-issues' }),
        ),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await outcome(
        api.instances.attach(rootMember, {
          tenantId: A,
          poolId,
          externalId: `${ZONE}/spare`,
          ownerIdentityId: op.identityId,
          idempotencyKey: 'member-attaches',
        }),
      ),
    ).toBe('ACCESS_DENIED');
    // In its own tenant its grant holds.
    expect(
      await outcome(api.providerAccounts.machines(rootMember, { tenantId: R, accountId })),
    ).toBe('allowed');
  });

  it('Acme, with compute:* in its own tenant, reaches nothing of the root tenant', async () => {
    const who = admin.credential;
    const calls = (tenantId: string): Record<string, () => Promise<unknown>> => ({
      'providerAccounts.get': () => api.providerAccounts.get(who, { tenantId, accountId }),
      'providerAccounts.machines': () =>
        api.providerAccounts.machines(who, { tenantId, accountId }),
      'providerAccounts.discover': () =>
        api.providerAccounts.discover(who, { tenantId, accountId }),
      'providerAccounts.reservations': () =>
        api.providerAccounts.reservations(who, { tenantId, accountId }),
      'providerAccounts.update': () =>
        api.providerAccounts.update(who, {
          tenantId,
          accountId,
          config: { projectId: 'p', zones: [ZONE] },
        }),
      'providerAccounts.delete': () => api.providerAccounts.delete(who, { tenantId, accountId }),
      'pools.update': () => api.pools.update(who, { tenantId, poolId, policy: {} }),
      'pools.offer': () =>
        api.pools.offer(who, { tenantId, poolId, toTenantId: A, quota: { vcpu: 100_000 } }),
      'flavors.create': () =>
        api.flavors.create(who, {
          tenantId,
          poolId,
          name: 'free.lunch',
          vcpu: 96,
          memoryGiB: 384,
          diskGiB: 100,
          offerId: `${ZONE}/n2-standard-96`,
        }),
      'instances.attach': () =>
        api.instances.attach(who, {
          tenantId,
          poolId,
          externalId: `${ZONE}/spare`,
          idempotencyKey: `grab-${tenantId}`,
        }),
    });
    const results: Record<string, string> = {};
    for (const tenantId of [A, R])
      for (const [method, call] of Object.entries(calls(tenantId)))
        results[`${method} in ${tenantId === A ? 'A' : 'root'}`] = await outcome(call());
    for (const [key, code] of Object.entries(results))
      expect(['ACCESS_DENIED', 'NOT_FOUND'], key).toContain(code);
    expect(
      await outcome(api.quotas.set(who, { tenantId: A, poolId, resource: 'vcpu', max: 100_000 })),
    ).toBe('ACCESS_DENIED');
    // The machine was not attached.
    const free = await api.providerAccounts.machines(root, { tenantId: R, accountId });
    expect(free.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      `${ZONE}/spare`,
    ]);
  });

  it('Other, with compute:* in its own tenant, reaches nothing of Acme’s', async () => {
    const who = bAdmin.credential;
    for (const tenantId of [B, A]) {
      for (const instanceId of [attached, issued]) {
        const ref = { tenantId, instanceId };
        for (const call of [
          () => api.instances.get(who, ref),
          () => api.instances.stop(who, ref),
          () => api.instances.reboot(who, ref),
          () => api.instances.detach(who, ref),
          () => api.instances.delete(who, ref),
        ])
          expect(['ACCESS_DENIED', 'NOT_FOUND']).toContain(await outcome(call()));
      }
      const ref = { tenantId, networkId: network };
      for (const call of [
        () => api.networks.get(who, ref),
        () => api.networks.update(who, { ...ref, description: 'taken' }),
        () => api.networks.delete(who, ref),
        () => api.firewallRules.list(who, ref),
      ])
        expect(['ACCESS_DENIED', 'NOT_FOUND']).toContain(await outcome(call()));
    }
    expect(ids(await api.instances.list(who, { tenantId: B, scope: 'all' }))).toEqual([]);
    expect(ids(await api.networks.list(who, { tenantId: B }))).toEqual([]);
    // Acme's instances are as they were.
    expect(
      await api.instances.get(op.credential, { tenantId: A, instanceId: attached }),
    ).toMatchObject({ desiredState: 'running', ownerIdentityId: op.identityId });
  });

  it('the root administrator acts on both sides (ROOT_OVERRIDE)', async () => {
    expect(await outcome(api.instances.get(root, { tenantId: A, instanceId: attached }))).toBe(
      'allowed',
    );
    expect(await outcome(api.networks.get(root, { tenantId: A, networkId: network }))).toBe(
      'allowed',
    );
    expect(await outcome(api.providerAccounts.machines(root, { tenantId: R, accountId }))).toBe(
      'allowed',
    );
    expect(await outcome(api.instances.reboot(root, { tenantId: A, instanceId: issued }))).toBe(
      'allowed',
    );
    expect(
      await outcome(api.quotas.set(root, { tenantId: A, poolId, resource: 'vcpu', max: 150 })),
    ).toBe('allowed');
  });

  it('the network kind and instance attributes reach better-iam’s catalog', () => {
    const types = t.bridge.catalog.resourceTypes;
    expect(types['compute-network']).toEqual(computeResourceTypes()['compute-network']);
    expect(types['compute-network']).toMatchObject({
      parent: 'compute-tenant',
      attributes: { providerAccountId: 'string', poolId: 'string', projectId: 'string' },
    });
    expect(types['compute-network']!.actions).toEqual(
      expect.arrayContaining([
        'compute:networks:create',
        'compute:networks:read',
        'compute:networks:update',
        'compute:networks:delete',
      ]),
    );
    expect(types['compute-instance']!.actions).toContain('compute:instances:attach');
    expect(types['compute-instance']!.attributes).toMatchObject({
      vcpu: 'number',
      memoryGiB: 'number',
      gpus: 'number',
      projectId: 'string',
    });
    expect(types['compute-tenant']!.actions).toContain('compute:networks:read');
  });
});
