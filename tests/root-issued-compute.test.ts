import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apiSurface } from '@better-compute/core';
import { gcpProvider } from '@better-compute/provider-gcp';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { networkTag, providerResourceName, vps } from '@better-compute/vps';
import { GceEmulator, type Json } from './support/gce-emulator.js';

// Platform-issued compute (root-issuance brief): the root (platform) tenant adds compute and issues
// it to customer tenants, which then use and control it, while IAM keeps tenants apart from each
// other and from root-level resources. The real provider-gcp runs against the Compute Engine
// emulator, wired through vps, as in tests/gcp-end-to-end.test.ts.
//
// Callers (fake IAM, decided per tenant like a role binding is):
// - root: the root administrator (user session, MFA), allowed everything; cross-tenant calls reach
//   IAM in the target tenant (the envelope's ROOT_OVERRIDE path, operations.ts preCheck);
// - aOp: tenant A's operator, holding what a `compute-operator` role holds, in tenant A only;
// - aAdmin: tenant A's administrator, holding EVERY action in tenant A (the worst case: anything it
//   still cannot do is refused by compute itself, not by a missing grant);
// - b: tenant B's administrator, holding every action in tenant B.
// tests/root-issued-compute-iam.test.ts repeats the core of this against a real better-iam.

const ZONE = 'us-central1-a';
const REGION = 'us-central1';
const base = 'https://compute.googleapis.com/compute/v1';

type Api = any;
type Who = { token: string };

/** What a `compute-operator` role grants: instances and networks, read access to what it uses. */
const operatorActions = [
  'compute:instances:create',
  'compute:instances:read',
  'compute:instances:update',
  'compute:instances:delete',
  'compute:pools:read',
  'compute:capacity:read',
  'compute:flavors:read',
  'compute:quotas:read',
  'compute:networks:create',
  'compute:networks:read',
  'compute:networks:update',
  'compute:networks:delete',
];

interface Platform {
  emu: GceEmulator;
  fixture: ComputeFixture;
  api: Api;
  root: Who;
  aOp: Who;
  aAdmin: Who;
  b: Who;
  R: string;
  A: string;
  B: string;
  aOpId: string;
  accountId: string;
  poolId: string;
  tick(job: string, advanceMs?: number): Promise<void>;
  /** The instance as root reads it in its tenant. */
  view(tenantId: string, instanceId: string): Promise<any>;
  settle(tenantId: string, instanceId: string, state: string, rounds?: number): Promise<any>;
  convergeNetwork(tenantId: string, networkId: string): Promise<any>;
  decisions(): { method: string; decision: any }[];
}

/** The platform: a root GCP account backing a provider pool offered to A and to B. */
async function platform(): Promise<Platform> {
  const emu = new GceEmulator();
  emu.validTokens.add('host-token');
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [gcp], discovery: { every: '1m' }, reservations: { every: '1m' } })],
  });
  const { compute, tenants, iam } = fixture;
  const R = tenants.root.id;
  const A = tenants.acme.id;
  const B = tenants.other.id;
  (iam as { rootTenantId?: string }).rootTenantId = R;
  iam.addCaller('token-acme-admin', { tenantId: A, identityId: 'identity-acme-admin' });
  iam.allow({ token: tenants.root.token });
  for (const action of operatorActions)
    iam.allow({ token: tenants.acme.token, tenantId: A, action });
  iam.allow({ token: 'token-acme-admin', tenantId: A });
  iam.allow({ token: tenants.other.token, tenantId: B });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };

  // As ROOT: a root-owned GCP account, a site, a provider pool, offered to A and B with quota.
  const account = await api.providerAccounts.create(root, {
    tenantId: R,
    provider: 'gcp',
    name: 'gcp-platform',
    config: { projectId: 'p', zones: [ZONE] },
  });
  const site = await api.sites.create(root, {
    tenantId: R,
    kind: 'shared',
    region: REGION,
    idempotencyKey: 'platform-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: R,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'platform-pool',
  });
  for (const toTenantId of [A, B])
    await api.pools.offer(root, {
      tenantId: R,
      poolId: pool.id,
      toTenantId,
      quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
    });
  await api.quotas.set(root, { tenantId: A, poolId: pool.id, resource: 'vcpu', max: 1000 });
  await api.flavors.create(root, {
    tenantId: R,
    poolId: pool.id,
    name: 'n2.standard.4',
    vcpu: 4,
    memoryGiB: 16,
    diskGiB: 100,
    offerId: `${ZONE}/n2-standard-4`,
  });

  const tick = async (job: string, advanceMs = 1_000) => {
    await fixture.advance(advanceMs);
    for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
  };
  const view = (tenantId: string, instanceId: string) =>
    api.instances.get(root, { tenantId, instanceId });
  return {
    emu,
    fixture,
    api,
    root,
    aOp: { token: tenants.acme.token },
    aAdmin: { token: 'token-acme-admin' },
    b: { token: tenants.other.token },
    R,
    A,
    B,
    aOpId: tenants.acme.caller.identityId,
    accountId: account.id,
    poolId: pool.id,
    tick,
    view,
    async settle(tenantId, instanceId, state, rounds = 8) {
      let current = await view(tenantId, instanceId);
      for (let round = 0; round < rounds && current.state !== state; round++) {
        emu.finishOperations();
        await tick('vps.instances', 5_000);
        current = await view(tenantId, instanceId);
      }
      return current;
    },
    async convergeNetwork(tenantId, networkId) {
      const read = () => api.networks.get(root, { tenantId, networkId });
      let current = await read();
      for (let round = 0; round < 10 && current.state !== 'ready'; round++) {
        emu.finishOperations();
        await tick('vps.networks', 5_000);
        current = await read();
      }
      return current;
    },
    decisions: () =>
      iam.calls
        .filter((call) => ['require', 'authorize', 'authorizeMany'].includes(call.method))
        .map((call) => ({ method: call.method, decision: call.decision })),
  };
}

const reservationA = {
  kind: 'compute#reservation',
  name: 'rsv-a',
  zone: `${base}/projects/p/zones/${ZONE}`,
  selfLink: `${base}/projects/p/zones/${ZONE}/reservations/rsv-a`,
  status: 'READY',
  specificReservationRequired: true,
  specificReservation: {
    count: '3',
    inUseCount: '1',
    instanceProperties: { machineType: 'a3-highgpu-8g' },
  },
};

const createInput = (p: Platform, tenantId: string, extra: Record<string, unknown> = {}) => ({
  tenantId,
  poolId: p.poolId,
  flavor: 'n2.standard.4',
  imageId: 'debian-12',
  sshKeys: [],
  ...extra,
});

/** The emulator VM of an instance better-compute created (its ownership label). */
const vmOf = (p: Platform, instanceId: string): Json | undefined =>
  [...p.emu.instances.values()].find(
    (instance) => instance.labels?.['better-compute-instance'] === instanceId,
  );

/** `allowed`, or the refusal's code. */
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'allowed',
    (error: { code?: string; message?: string }) => error?.code ?? String(error),
  );
const refusal = (promise: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
  promise.then(
    () => ({ code: 'allowed' }),
    (error: { code?: string; message?: string }) => error,
  );
const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

describe('platform-issued compute, end to end', () => {
  afterEach(closeFixtures);

  it('root adds compute and issues it to tenant A, which uses and controls it', async () => {
    const p = await platform();
    const { api, root, aOp, A, R } = p;

    // Root: discovery lists the platform account's VMs.
    p.emu.addInstance(ZONE, 'legacy', { labels: { team: 'ml' } });
    await p.tick('vps.discovery', 60_000);
    const machines = await api.providerAccounts.machines(root, {
      tenantId: R,
      accountId: p.accountId,
    });
    expect(machines.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      `${ZONE}/legacy`,
    ]);

    // Root attaches VM-1 to tenant A, owned by A's operator.
    const attached = await api.instances.attach(root, {
      tenantId: A,
      poolId: p.poolId,
      externalId: `${ZONE}/legacy`,
      ownerIdentityId: p.aOpId,
      idempotencyKey: 'attach-legacy',
    });
    expect(attached).toMatchObject({
      tenantId: A,
      origin: 'attached',
      onDelete: 'detach',
      ownerIdentityId: p.aOpId,
    });
    expect(await p.settle(A, attached.id, 'running')).toMatchObject({ state: 'running' });

    // A reservation is detected and bound to the root pool.
    p.emu.reservations.push(reservationA);
    await p.tick('vps.reservations', 60_000);
    const reservations = await api.providerAccounts.reservations(root, {
      tenantId: R,
      accountId: p.accountId,
    });
    expect(reservations.items).toEqual([
      expect.objectContaining({ id: `${ZONE}/rsv-a`, state: 'ready', free: 2 }),
    ]);
    const bound = await api.providerAccounts.bindReservation(root, {
      tenantId: R,
      accountId: p.accountId,
      reservationId: `${ZONE}/rsv-a`,
      poolId: p.poolId,
      idempotencyKey: 'bind-rsv-a',
    });
    expect(bound.poolId).toBe(p.poolId);

    // Root issues a NEW VM to tenant A, owned by A's operator (G1).
    const issued = await api.instances.create(
      root,
      createInput(p, A, { ownerIdentityId: p.aOpId, idempotencyKey: 'issued-1' }),
    );
    expect(issued).toMatchObject({ tenantId: A, origin: 'created', ownerIdentityId: p.aOpId });
    expect(await p.settle(A, issued.id, 'running')).toMatchObject({ state: 'running' });

    // As tenant A's operator: both show in its own list (scope mine, the default) and in scope all.
    const mine = await api.instances.list(aOp, { tenantId: A });
    expect(ids(mine)).toEqual(expect.arrayContaining([attached.id, issued.id]));
    const all = await api.instances.list(aOp, { tenantId: A, scope: 'all' });
    expect(ids(all)).toEqual(expect.arrayContaining([attached.id, issued.id]));
    for (const instanceId of [attached.id, issued.id])
      expect(await api.instances.get(aOp, { tenantId: A, instanceId })).toMatchObject({
        id: instanceId,
        state: 'running',
      });

    // A controls them: stop and start the attached VM, reboot the issued one.
    const attachedRef = { tenantId: A, instanceId: attached.id };
    const issuedRef = { tenantId: A, instanceId: issued.id };
    await api.instances.stop(aOp, attachedRef);
    expect(await p.settle(A, attached.id, 'stopped')).toMatchObject({ state: 'stopped' });
    expect(p.emu.instances.get(`${ZONE}/legacy`)!.status).toBe('TERMINATED');
    await api.instances.start(aOp, attachedRef);
    expect(await p.settle(A, attached.id, 'running')).toMatchObject({ state: 'running' });
    expect(p.emu.instances.get(`${ZONE}/legacy`)!.status).toBe('RUNNING');
    await api.instances.reboot(aOp, issuedRef);
    for (let round = 0; round < 4; round++) {
      p.emu.finishOperations();
      await p.tick('vps.instances', 5_000);
    }
    const rebooted = await p.fixture.database.query<{ subject: string }>(
      `SELECT subject FROM outbox WHERE topic = 'instance.rebooted'`,
    );
    expect(rebooted.rows.map((row) => row.subject)).toEqual([`instance/${issued.id}`]);

    // A creates its own instance from the reservation-bound flavor: admitted, it consumes the slot.
    const onReservation = await api.instances.create(
      aOp,
      createInput(p, A, { flavor: 'rsv-rsv-a', idempotencyKey: 'a-rsv-1' }),
    );
    expect(await p.settle(A, onReservation.id, 'running')).toMatchObject({ state: 'running' });
    expect(vmOf(p, onReservation.id)!.reservationAffinity).toEqual({
      consumeReservationType: 'SPECIFIC_RESERVATION',
      key: 'compute.googleapis.com/reservation-name',
      values: ['rsv-a'],
    });

    // A builds a network on the offered pool, a subnet, puts an instance on it and a rule on that.
    const network = await api.networks.create(aOp, {
      tenantId: A,
      poolId: p.poolId,
      name: 'prod',
      idempotencyKey: 'a-net-prod',
    });
    const subnet = (
      await api.networks.addSubnet(aOp, {
        tenantId: A,
        networkId: network.id,
        name: 'app',
        region: REGION,
        cidr: '10.10.0.0/24',
      })
    ).subnets[0];
    expect(await p.convergeNetwork(A, network.id)).toMatchObject({ state: 'ready' });
    const onNetwork = await api.instances.create(
      aOp,
      createInput(p, A, {
        networkId: network.id,
        subnetId: subnet.id,
        idempotencyKey: 'a-net-vm',
      }),
    );
    expect(await p.settle(A, onNetwork.id, 'running')).toMatchObject({
      state: 'running',
      networkId: network.id,
      subnetId: subnet.id,
    });
    const rule = await api.firewallRules.create(aOp, {
      tenantId: A,
      networkId: network.id,
      name: 'ssh',
      direction: 'ingress',
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
      targets: { instanceIds: [onNetwork.id] },
    });
    expect(await p.convergeNetwork(A, network.id)).toMatchObject({ state: 'ready' });
    const rules = await api.firewallRules.list(aOp, { tenantId: A, networkId: network.id });
    expect(rules.items).toEqual([expect.objectContaining({ id: rule.id, state: 'ready' })]);
    expect(p.emu.firewalls.get(providerResourceName(rule.id))).toMatchObject({
      targetTags: [networkTag(onNetwork.id)],
    });
    expect(vmOf(p, onNetwork.id)!.tags.items).toContain(networkTag(onNetwork.id));

    // A gives the attached VM back (detach: it keeps running, unlabelled) and deletes the issued one.
    await api.instances.detach(aOp, attachedRef);
    expect(await p.settle(A, attached.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(p.emu.instances.get(`${ZONE}/legacy`)!.labels).toEqual({ team: 'ml' });
    await api.instances.delete(aOp, issuedRef);
    expect(await p.settle(A, issued.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(vmOf(p, issued.id)).toBeUndefined();
    expect(p.emu.instances.has(`${ZONE}/legacy`)).toBe(true);
  });
});

/** A's, B's and root's resources for the isolation matrix. */
interface World extends Platform {
  legacy: string;
  issued: string;
  aNet: { id: string; subnetId: string; ruleId: string; instanceId: string };
  bNet: string;
  bVm: string;
}

async function isolationWorld(): Promise<World> {
  const p = await platform();
  const { api, root, aOp, b, A, B, R } = p;
  p.emu.addInstance(ZONE, 'legacy');
  p.emu.addInstance(ZONE, 'spare');
  p.emu.reservations.push(reservationA);
  await p.tick('vps.discovery', 60_000);
  await p.tick('vps.reservations', 60_000);
  await api.providerAccounts.bindReservation(root, {
    tenantId: R,
    accountId: p.accountId,
    reservationId: `${ZONE}/rsv-a`,
    poolId: p.poolId,
    idempotencyKey: 'bind-rsv-a',
  });
  // Root attaches VM-1 to A, and creates a VM in A (owned by the operator who made it).
  const legacy = await api.instances.attach(root, {
    tenantId: A,
    poolId: p.poolId,
    externalId: `${ZONE}/legacy`,
    ownerIdentityId: p.aOpId,
    idempotencyKey: 'attach-legacy',
  });
  const issued = await api.instances.create(root, createInput(p, A, { idempotencyKey: 'issued' }));
  // A's network, subnet, instance on it and a rule targeting that instance.
  const network = await api.networks.create(aOp, {
    tenantId: A,
    poolId: p.poolId,
    name: 'prod',
    idempotencyKey: 'a-net',
  });
  const subnetId = (
    await api.networks.addSubnet(aOp, {
      tenantId: A,
      networkId: network.id,
      name: 'app',
      region: REGION,
      cidr: '10.10.0.0/24',
    })
  ).subnets[0].id;
  await p.convergeNetwork(A, network.id);
  const onNetwork = await api.instances.create(
    aOp,
    createInput(p, A, { networkId: network.id, subnetId, idempotencyKey: 'a-net-vm' }),
  );
  // B's own instance on the same offered pool, and B's own network.
  const bVm = await api.instances.create(b, createInput(p, B, { idempotencyKey: 'b-vm' }));
  const bNet = await api.networks.create(b, {
    tenantId: B,
    poolId: p.poolId,
    name: 'b-prod',
    idempotencyKey: 'b-net',
  });
  for (const [tenantId, instanceId] of [
    [A, legacy.id],
    [A, issued.id],
    [A, onNetwork.id],
    [B, bVm.id],
  ] as const)
    await p.settle(tenantId, instanceId, 'running');
  const rule = await api.firewallRules.create(aOp, {
    tenantId: A,
    networkId: network.id,
    name: 'ssh',
    direction: 'ingress',
    rules: [{ protocol: 'tcp', ports: ['22'] }],
    sources: ['0.0.0.0/0'],
    targets: { instanceIds: [onNetwork.id] },
  });
  // A rule has its own state (the network's covers the VPC and its subnets).
  const ruleState = async () =>
    (await api.firewallRules.list(root, { tenantId: A, networkId: network.id })).items[0].state;
  for (let round = 0; round < 10 && (await ruleState()) !== 'ready'; round++) {
    p.emu.finishOperations();
    await p.tick('vps.networks', 5_000);
  }
  return {
    ...p,
    legacy: legacy.id,
    issued: issued.id,
    aNet: { id: network.id, subnetId, ruleId: rule.id, instanceId: onNetwork.id },
    bNet: bNet.id,
    bVm: bVm.id,
  };
}

describe('isolation between tenants, and between tenants and the root tenant', () => {
  let w: World;
  beforeAll(async () => {
    w = await isolationWorld();
  }, 120_000);
  afterAll(closeFixtures);

  /** Runs a call and says whether IAM was asked anything meanwhile. */
  const traced = async (promise: () => Promise<unknown>) => {
    w.fixture.compute.caches.clear();
    const before = w.decisions().length;
    const code = await outcome(promise());
    return { code, decided: w.decisions().length > before };
  };

  it('B is refused every A resource, and none of A’s items are in B’s lists', async () => {
    const { api, b, A, B } = w;
    const instanceCalls = (tenantId: string, instanceId: string) => ({
      get: () => api.instances.get(b, { tenantId, instanceId }),
      start: () => api.instances.start(b, { tenantId, instanceId }),
      stop: () => api.instances.stop(b, { tenantId, instanceId }),
      reboot: () => api.instances.reboot(b, { tenantId, instanceId }),
      detach: () => api.instances.detach(b, { tenantId, instanceId }),
      delete: () => api.instances.delete(b, { tenantId, instanceId }),
    });
    const networkCalls = (tenantId: string) => {
      const networkId = w.aNet.id;
      return {
        'networks.get': () => api.networks.get(b, { tenantId, networkId }),
        'networks.update': () =>
          api.networks.update(b, { tenantId, networkId, description: 'taken' }),
        'networks.delete': () => api.networks.delete(b, { tenantId, networkId }),
        'networks.addSubnet': () =>
          api.networks.addSubnet(b, {
            tenantId,
            networkId,
            name: 'b',
            region: REGION,
            cidr: '10.99.0.0/24',
          }),
        'networks.removeSubnet': () =>
          api.networks.removeSubnet(b, { tenantId, networkId, subnetId: w.aNet.subnetId }),
        'firewallRules.list': () => api.firewallRules.list(b, { tenantId, networkId }),
        'firewallRules.create': () =>
          api.firewallRules.create(b, {
            tenantId,
            networkId,
            name: 'open',
            direction: 'ingress',
            rules: [{ protocol: 'all' }],
            sources: ['0.0.0.0/0'],
          }),
        'firewallRules.update': () =>
          api.firewallRules.update(b, {
            tenantId,
            networkId,
            ruleId: w.aNet.ruleId,
            enabled: false,
          }),
        'firewallRules.delete': () =>
          api.firewallRules.delete(b, { tenantId, networkId, ruleId: w.aNet.ruleId }),
      };
    };
    const results: Record<string, unknown> = {};
    for (const instanceId of [w.legacy, w.issued, w.aNet.instanceId]) {
      // In its own tenant B finds nothing (NOT_FOUND, as for an id that does not exist) …
      for (const [method, call] of Object.entries(instanceCalls(B, instanceId)))
        results[`instances.${method} ${instanceId} in B`] = (await traced(call)).code;
      // … and naming A's tenant is refused by the envelope before any decision.
      for (const [method, call] of Object.entries(instanceCalls(A, instanceId)))
        results[`instances.${method} ${instanceId} in A`] = await traced(call);
    }
    for (const [method, call] of Object.entries(networkCalls(B)))
      results[`${method} in B`] = (await traced(call)).code;
    for (const [method, call] of Object.entries(networkCalls(A)))
      results[`${method} in A`] = await traced(call);
    const expected: Record<string, unknown> = {};
    for (const key of Object.keys(results))
      expected[key] = key.endsWith(' in B')
        ? 'NOT_FOUND'
        : { code: 'ACCESS_DENIED', decided: false };
    expect(results).toEqual(expected);

    // B's lists: its own items only.
    for (const scope of ['mine', 'all']) {
      const listed = ids(await api.instances.list(b, { tenantId: B, scope }));
      expect(listed).toEqual([w.bVm]);
    }
    expect(ids(await api.networks.list(b, { tenantId: B }))).toEqual([w.bNet]);
    expect(ids(await api.firewallRules.list(b, { tenantId: B, networkId: w.bNet }))).toEqual([]);
  });

  it('A, even holding every action in its own tenant, reaches no root-level resource', async () => {
    const { api, A, B, R } = w;
    const account = (who: Who, tenantId: string) => ({
      'providerAccounts.get': () =>
        api.providerAccounts.get(who, { tenantId, accountId: w.accountId }),
      'providerAccounts.machines': () =>
        api.providerAccounts.machines(who, { tenantId, accountId: w.accountId, filter: 'all' }),
      'providerAccounts.discover': () =>
        api.providerAccounts.discover(who, { tenantId, accountId: w.accountId }),
      'providerAccounts.reservations': () =>
        api.providerAccounts.reservations(who, { tenantId, accountId: w.accountId }),
      'providerAccounts.bindReservation': () =>
        api.providerAccounts.bindReservation(who, {
          tenantId,
          accountId: w.accountId,
          reservationId: `${ZONE}/rsv-a`,
          poolId: w.poolId,
          idempotencyKey: 'a-bind',
        }),
      'providerAccounts.unbindReservation': () =>
        api.providerAccounts.unbindReservation(who, {
          tenantId,
          accountId: w.accountId,
          reservationId: `${ZONE}/rsv-a`,
        }),
      'providerAccounts.update': () =>
        api.providerAccounts.update(who, {
          tenantId,
          accountId: w.accountId,
          config: { projectId: 'p', zones: [ZONE] },
        }),
      'providerAccounts.delete': () =>
        api.providerAccounts.delete(who, { tenantId, accountId: w.accountId }),
      'pools.update': () => api.pools.update(who, { tenantId, poolId: w.poolId, policy: {} }),
      'pools.offer': () =>
        api.pools.offer(who, {
          tenantId,
          poolId: w.poolId,
          toTenantId: A,
          quota: { vcpu: 1_000_000 },
        }),
      'pools.offer to B': () =>
        api.pools.offer(who, { tenantId, poolId: w.poolId, toTenantId: B, quota: { vcpu: 0 } }),
      'pools.unoffer B': () =>
        api.pools.unoffer(who, { tenantId, poolId: w.poolId, toTenantId: B }),
      'flavors.create': () =>
        api.flavors.create(who, {
          tenantId,
          poolId: w.poolId,
          name: 'free.lunch',
          vcpu: 96,
          memoryGiB: 384,
          diskGiB: 100,
          offerId: `${ZONE}/n2-standard-96`,
        }),
    });
    // In its own tenant compute finds none of the root's resources (NOT_FOUND) …
    const inA: Record<string, string> = {};
    for (const [method, call] of Object.entries(account(w.aAdmin, A)))
      inA[method] = (await traced(call)).code;
    expect(inA).toEqual(Object.fromEntries(Object.keys(inA).map((key) => [key, 'NOT_FOUND'])));
    // … and naming the root tenant is refused before any decision.
    const inRoot: Record<string, unknown> = {};
    for (const [method, call] of Object.entries(account(w.aAdmin, R)))
      inRoot[method] = await traced(call);
    expect(inRoot).toEqual(
      Object.fromEntries(
        Object.keys(inRoot).map((key) => [key, { code: 'ACCESS_DENIED', decided: false }]),
      ),
    );
    // A's operator, without the grants, is refused either way.
    for (const tenantId of [A, R])
      for (const [method, call] of Object.entries(account(w.aOp, tenantId)))
        expect(['ACCESS_DENIED', 'NOT_FOUND'], `${method} in ${tenantId}`).toContain(
          (await traced(call)).code,
        );

    // instances.attach, in any form: from the root account into A, into B, into the root tenant.
    const attach = (who: Who, tenantId: string, key: string) =>
      api.instances.attach(who, {
        tenantId,
        poolId: w.poolId,
        externalId: `${ZONE}/spare`,
        idempotencyKey: key,
      });
    expect(await traced(() => attach(w.aAdmin, A, 'grab'))).toEqual({
      code: 'ACCESS_DENIED',
      decided: true,
    });
    expect(await traced(() => attach(w.aAdmin, B, 'grab-b'))).toEqual({
      code: 'ACCESS_DENIED',
      decided: false,
    });
    expect(await traced(() => attach(w.aAdmin, R, 'grab-r'))).toEqual({
      code: 'ACCESS_DENIED',
      decided: false,
    });
    expect(['ACCESS_DENIED']).toContain(await outcome(attach(w.aOp, A, 'grab-op')));
    // Quotas are the fleet's: refused before any decision, for A's own quota too.
    expect(
      await traced(() =>
        api.quotas.set(w.aAdmin, { tenantId: A, poolId: w.poolId, resource: 'vcpu', max: 1e6 }),
      ),
    ).toEqual({ code: 'ACCESS_DENIED', decided: false });
    // Another tenant's offer and quota.
    expect(await traced(() => api.quotas.get(w.aAdmin, { tenantId: B }))).toEqual({
      code: 'ACCESS_DENIED',
      decided: false,
    });
    // A still sees the pool it is offered, and its flavors, but nothing of B's offer.
    expect(await outcome(api.pools.get(w.aAdmin, { tenantId: A, poolId: w.poolId }))).toBe(
      'allowed',
    );
    const flavors = await api.flavors.list(w.aOp, { tenantId: A, poolId: w.poolId });
    expect(flavors.items.map((flavor: { name: string }) => flavor.name).sort()).toEqual([
      'n2.standard.4',
      'rsv-rsv-a',
    ]);
  });

  it('A cannot aim at B: rules on B’s instances, B’s networks, attach into B', async () => {
    const { api, aOp, aAdmin, root, A, B } = w;
    const ghost = 'inst_00000000000000000000000000';
    const target = (instanceId: string) =>
      refusal(
        api.firewallRules.create(aOp, {
          tenantId: A,
          networkId: w.aNet.id,
          name: 'at-b',
          direction: 'ingress',
          rules: [{ protocol: 'tcp', ports: ['443'] }],
          sources: ['0.0.0.0/0'],
          targets: { instanceIds: [instanceId] },
        }),
      );
    // INVALID_INPUT, worded exactly as for an instance that does not exist: no existence leak.
    const atB = await target(w.bVm);
    const atGhost = await target(ghost);
    expect(atB.code).toBe('INVALID_INPUT');
    expect(atB.message!.replace(w.bVm, '<id>')).toBe(atGhost.message!.replace(ghost, '<id>'));
    const update = await refusal(
      api.firewallRules.update(aOp, {
        tenantId: A,
        networkId: w.aNet.id,
        ruleId: w.aNet.ruleId,
        targets: { instanceIds: [w.bVm] },
      }),
    );
    expect(update.code).toBe('INVALID_INPUT');

    // instances.create on B's network: as for a network that does not exist.
    const ghostNet = 'net_00000000000000000000000000';
    const onNet = (networkId: string, key: string) =>
      refusal(api.instances.create(aOp, createInput(w, A, { networkId, idempotencyKey: key })));
    const onB = await onNet(w.bNet, 'on-b-net');
    const onGhost = await onNet(ghostNet, 'on-ghost-net');
    expect(onB.code).toBe('INVALID_INPUT');
    expect(onB.message!.replace(w.bNet, '<id>')).toBe(onGhost.message!.replace(ghostNet, '<id>'));

    // instances.attach with B's network: A may not attach at all from the root account; even the
    // platform cannot link a machine attached to A to B's network.
    const attach = (who: Who, tenantId: string, key: string) =>
      refusal(
        api.instances.attach(who, {
          tenantId,
          poolId: w.poolId,
          externalId: `${ZONE}/spare`,
          networkId: w.bNet,
          idempotencyKey: key,
        }),
      );
    expect((await attach(aAdmin, A, 'a-b-net')).code).toBe('ACCESS_DENIED');
    expect((await attach(root, A, 'root-a-b-net')).code).toBe('INVALID_INPUT');
    // attach with tenantId B, by A: the envelope.
    expect((await attach(aAdmin, B, 'into-b')).code).toBe('ACCESS_DENIED');
  });

  it('A cannot escalate into the root project through its own GCP account (C1, ruling F1)', async () => {
    const { api, aAdmin, A, R } = w;
    const requests = w.emu.requests.length;
    const create = (tenantId: string, name: string, config: Record<string, unknown>) =>
      outcome(
        api.providerAccounts.create(aAdmin, {
          tenantId,
          provider: 'gcp',
          name,
          config: { projectId: 'p', zones: [ZONE], ...config },
        }),
      );
    expect(await create(A, 'byo', {})).toBe('INVALID_CONFIG');
    expect(
      await create(A, 'byo', { impersonate: 'platform-admin@p.iam.gserviceaccount.com' }),
    ).toBe('INVALID_CONFIG');
    expect(await create(R, 'byo', { credentials: 'secret://root/gcp' })).toBe('ACCESS_DENIED');
    expect(w.emu.requests.length).toBe(requests);
    expect((await api.providerAccounts.list(aAdmin, { tenantId: A })).items).toEqual([]);
  });

  it('a tenant caller naming another tenant is refused by the envelope, before any decision', async () => {
    const { api, aOp, aAdmin, b, A, B, R } = w;
    const calls: [string, () => Promise<unknown>][] = [
      ['instances.list B', () => api.instances.list(aAdmin, { tenantId: B, scope: 'all' })],
      ['instances.get B', () => api.instances.get(aAdmin, { tenantId: B, instanceId: w.bVm })],
      ['networks.list B', () => api.networks.list(aAdmin, { tenantId: B })],
      ['networks.get B', () => api.networks.get(aAdmin, { tenantId: B, networkId: w.bNet })],
      [
        'instances.create B',
        () => api.instances.create(aOp, createInput(w, B, { idempotencyKey: 'in-b' })),
      ],
      ['providerAccounts.list root', () => api.providerAccounts.list(aAdmin, { tenantId: R })],
      ['instances.list root', () => api.instances.list(aAdmin, { tenantId: R, scope: 'all' })],
      ['networks.list A as B', () => api.networks.list(b, { tenantId: A })],
      ['instances.list A as B', () => api.instances.list(b, { tenantId: A, scope: 'all' })],
    ];
    for (const [name, call] of calls)
      expect(await traced(call), name).toEqual({ code: 'ACCESS_DENIED', decided: false });
  });

  it('instances.create takes ownerIdentityId from the platform only (G1)', async () => {
    const { api, aAdmin, b, root, A, B, R } = w;
    // A tenant cannot hand an instance to someone else, not even in its own tenant.
    expect(
      await outcome(
        api.instances.create(
          aAdmin,
          createInput(w, A, { ownerIdentityId: w.aOpId, idempotencyKey: 'for-op' }),
        ),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await outcome(
        api.instances.create(
          b,
          createInput(w, B, { ownerIdentityId: 'identity-other-2', idempotencyKey: 'for-b2' }),
        ),
      ),
    ).toBe('ACCESS_DENIED');
    // Naming itself changes nothing, so it is accepted.
    const own = await api.instances.create(
      aAdmin,
      createInput(w, A, { ownerIdentityId: 'identity-acme-admin', idempotencyKey: 'for-me' }),
    );
    expect(own.ownerIdentityId).toBe('identity-acme-admin');
    // The platform hands instances to other tenants only; in its own tenant they stay the caller's.
    expect(
      await outcome(
        api.instances.create(
          root,
          createInput(w, R, { ownerIdentityId: 'identity-root-2', idempotencyKey: 'root-own' }),
        ),
      ),
    ).toBe('ACCESS_DENIED');
    // A malformed identity is refused as attach refuses it.
    expect(
      await outcome(
        api.instances.create(
          root,
          createInput(w, A, { ownerIdentityId: 'not an id!', idempotencyKey: 'bad-owner' }),
        ),
      ),
    ).toBe('INVALID_INPUT');
    await api.instances.delete(aAdmin, { tenantId: A, instanceId: own.id });
  });

  it('nothing refused above changed A’s resources', async () => {
    const { api, aOp, root, A, R } = w;
    expect(await api.instances.get(aOp, { tenantId: A, instanceId: w.legacy })).toMatchObject({
      state: 'running',
      desiredState: 'running',
      origin: 'attached',
      ownerIdentityId: w.aOpId,
    });
    for (const instanceId of [w.issued, w.aNet.instanceId])
      expect(await api.instances.get(aOp, { tenantId: A, instanceId })).toMatchObject({
        state: 'running',
        desiredState: 'running',
      });
    const network = await api.networks.get(aOp, { tenantId: A, networkId: w.aNet.id });
    expect(network).toMatchObject({
      state: 'ready',
      subnets: [expect.objectContaining({ id: w.aNet.subnetId, state: 'ready' })],
    });
    expect(network.description).toBeUndefined();
    expect(
      (await api.firewallRules.list(aOp, { tenantId: A, networkId: w.aNet.id })).items,
    ).toEqual([
      expect.objectContaining({ id: w.aNet.ruleId, enabled: true, state: 'ready', version: 1 }),
    ]);
    const spare = await api.providerAccounts.machines(root, {
      tenantId: R,
      accountId: w.accountId,
      filter: 'free',
    });
    expect(spare.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      `${ZONE}/spare`,
    ]);
    const offers = await api.quotas.get(root, { tenantId: A, poolId: w.poolId });
    expect(offers.items.find((row: { resource: string }) => row.resource === 'vcpu')).toMatchObject(
      { max: 1000 },
    );
  });

  it('root is allowed all of it, decided in the tenant that holds the resource', async () => {
    const { api, root, A, B, R } = w;
    const net = w.aNet.id;
    const steps: { path: string; tenant: string; call: () => Promise<unknown>; expect?: string }[] =
      [
        // A's instances, in A.
        {
          path: 'instances.get',
          tenant: A,
          call: () => api.instances.get(root, { tenantId: A, instanceId: w.legacy }),
        },
        {
          path: 'instances.list',
          tenant: A,
          call: () => api.instances.list(root, { tenantId: A, scope: 'all' }),
        },
        {
          path: 'instances.reboot',
          tenant: A,
          call: () => api.instances.reboot(root, { tenantId: A, instanceId: w.legacy }),
        },
        {
          path: 'instances.stop',
          tenant: A,
          call: () => api.instances.stop(root, { tenantId: A, instanceId: w.issued }),
        },
        {
          path: 'instances.start',
          tenant: A,
          call: () => api.instances.start(root, { tenantId: A, instanceId: w.issued }),
        },
        // The root account, in the root tenant.
        {
          path: 'providerAccounts.get',
          tenant: R,
          call: () => api.providerAccounts.get(root, { tenantId: R, accountId: w.accountId }),
        },
        {
          path: 'providerAccounts.machines',
          tenant: R,
          call: () => api.providerAccounts.machines(root, { tenantId: R, accountId: w.accountId }),
        },
        {
          path: 'providerAccounts.discover',
          tenant: R,
          call: () => api.providerAccounts.discover(root, { tenantId: R, accountId: w.accountId }),
        },
        {
          path: 'providerAccounts.reservations',
          tenant: R,
          call: () =>
            api.providerAccounts.reservations(root, { tenantId: R, accountId: w.accountId }),
        },
        {
          path: 'providerAccounts.unbindReservation',
          tenant: R,
          call: () =>
            api.providerAccounts.unbindReservation(root, {
              tenantId: R,
              accountId: w.accountId,
              reservationId: `${ZONE}/rsv-a`,
            }),
        },
        {
          path: 'providerAccounts.bindReservation',
          tenant: R,
          call: () =>
            api.providerAccounts.bindReservation(root, {
              tenantId: R,
              accountId: w.accountId,
              reservationId: `${ZONE}/rsv-a`,
              poolId: w.poolId,
              idempotencyKey: 'rebind-rsv-a',
            }),
        },
        {
          path: 'providerAccounts.update',
          tenant: R,
          call: () =>
            api.providerAccounts.update(root, {
              tenantId: R,
              accountId: w.accountId,
              config: { projectId: 'p', zones: [ZONE] },
            }),
        },
        // The root pool and the fleet.
        {
          path: 'pools.update',
          tenant: R,
          call: () => api.pools.update(root, { tenantId: R, poolId: w.poolId, policy: {} }),
        },
        {
          path: 'pools.offer',
          tenant: R,
          call: () =>
            api.pools.offer(root, {
              tenantId: R,
              poolId: w.poolId,
              toTenantId: A,
              quota: { vcpu: 1200 },
            }),
        },
        {
          path: 'flavors.create',
          tenant: R,
          call: () =>
            api.flavors.create(root, {
              tenantId: R,
              poolId: w.poolId,
              name: 'n2.standard.8',
              vcpu: 8,
              memoryGiB: 32,
              diskGiB: 100,
              offerId: `${ZONE}/n2-standard-8`,
            }),
        },
        {
          path: 'quotas.set',
          tenant: R,
          call: () =>
            api.quotas.set(root, { tenantId: A, poolId: w.poolId, resource: 'vcpu', max: 1100 }),
        },
        // A's network, in A.
        { path: 'networks.list', tenant: A, call: () => api.networks.list(root, { tenantId: A }) },
        {
          path: 'networks.get',
          tenant: A,
          call: () => api.networks.get(root, { tenantId: A, networkId: net }),
        },
        {
          path: 'networks.update',
          tenant: A,
          call: () =>
            api.networks.update(root, { tenantId: A, networkId: net, description: 'audited' }),
        },
        {
          path: 'networks.addSubnet',
          tenant: A,
          call: () =>
            api.networks.addSubnet(root, {
              tenantId: A,
              networkId: net,
              name: 'ops',
              region: REGION,
              cidr: '10.20.0.0/24',
            }),
        },
        {
          path: 'networks.removeSubnet',
          tenant: A,
          call: async () => {
            const view = await api.networks.get(root, { tenantId: A, networkId: net });
            const ops = view.subnets.find((subnet: { name: string }) => subnet.name === 'ops');
            return api.networks.removeSubnet(root, {
              tenantId: A,
              networkId: net,
              subnetId: ops.id,
            });
          },
        },
        {
          path: 'firewallRules.list',
          tenant: A,
          call: () => api.firewallRules.list(root, { tenantId: A, networkId: net }),
        },
        {
          path: 'firewallRules.create',
          tenant: A,
          call: () =>
            api.firewallRules.create(root, {
              tenantId: A,
              networkId: net,
              name: 'web',
              direction: 'ingress',
              rules: [{ protocol: 'tcp', ports: ['443'] }],
              sources: ['0.0.0.0/0'],
              targets: { instanceIds: [w.aNet.instanceId] },
            }),
        },
        {
          path: 'firewallRules.update',
          tenant: A,
          call: async () => {
            const rules = await api.firewallRules.list(root, { tenantId: A, networkId: net });
            const web = rules.items.find((item: { name: string }) => item.name === 'web');
            return api.firewallRules.update(root, {
              tenantId: A,
              networkId: net,
              ruleId: web.id,
              enabled: false,
            });
          },
        },
        {
          path: 'firewallRules.delete',
          tenant: A,
          call: async () => {
            const rules = await api.firewallRules.list(root, { tenantId: A, networkId: net });
            const web = rules.items.find((item: { name: string }) => item.name === 'web');
            return api.firewallRules.delete(root, { tenantId: A, networkId: net, ruleId: web.id });
          },
        },
        {
          path: 'networks.create',
          tenant: A,
          call: () =>
            api.networks.create(root, {
              tenantId: A,
              poolId: w.poolId,
              name: 'ops',
              idempotencyKey: 'root-ops',
            }),
        },
        {
          path: 'networks.delete',
          tenant: A,
          call: async () => {
            const listed = await api.networks.list(root, { tenantId: A });
            const ops = listed.items.find((item: { name: string }) => item.name === 'ops');
            return api.networks.delete(root, { tenantId: A, networkId: ops.id });
          },
        },
        // Issuing to B: attach the spare machine to B, then take it back.
        {
          path: 'instances.attach',
          tenant: B,
          call: () =>
            api.instances.attach(root, {
              tenantId: B,
              poolId: w.poolId,
              externalId: `${ZONE}/spare`,
              idempotencyKey: 'to-b',
            }),
        },
        {
          path: 'instances.detach',
          tenant: B,
          call: async () => {
            const listed = await api.instances.list(root, { tenantId: B, scope: 'all' });
            const spare = listed.items.find(
              (item: { externalId?: string }) => item.externalId === `${ZONE}/spare`,
            );
            return api.instances.detach(root, { tenantId: B, instanceId: spare.id });
          },
        },
        {
          path: 'instances.delete',
          tenant: A,
          call: () => api.instances.delete(root, { tenantId: A, instanceId: w.issued }),
        },
        // Allowed, and then refused by state: the account still backs a pool.
        {
          path: 'providerAccounts.delete',
          tenant: R,
          call: () => api.providerAccounts.delete(root, { tenantId: R, accountId: w.accountId }),
          expect: 'INVALID_STATE',
        },
      ];
    const results: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const step of steps) {
      // Allowed reads are cached for 10 s per session: each step is decided afresh.
      w.fixture.compute.caches.clear();
      const before = w.decisions().length;
      const code = await outcome(step.call());
      // The step's own decision: the last one it made (a helper read may come first).
      const made = w.decisions().slice(before);
      const [group, method] = step.path.split('.');
      const row = apiSurface.find((entry) => entry.group === group && entry.method === method)!;
      const targets = [{ action: row.action, resource: row.resource }, ...(row.alternatives ?? [])];
      const decided = made.find(
        (call) =>
          call.decision &&
          targets.some(
            (target) =>
              target.action === call.decision.action &&
              `compute-${target.resource}` === call.decision.resource.type,
          ),
      );
      results[step.path] = { code, tenant: decided?.decision.tenantId };
      expected[step.path] = {
        code: step.expect ?? 'allowed',
        tenant: row.resource === 'fleet' ? R : step.tenant,
      };
    }
    expect(results).toEqual(expected);

    // Every method this branch added is in the steps above: each one's declared action and resource
    // is what IAM is asked, in the tenant that holds the resource.
    const added = apiSurface
      .filter(
        (row) =>
          row.module === 'vps' &&
          row.phase === 'v1.0' &&
          ['instances', 'providerAccounts', 'networks', 'firewallRules'].includes(row.group),
      )
      .map((row) => `${row.group}.${row.method}`);
    expect(added.length).toBeGreaterThanOrEqual(18);
    expect(added.filter((path) => !steps.some((step) => step.path === path))).toEqual([]);
  });
});
