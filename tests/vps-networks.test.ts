import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiSurface,
  ComputeError,
  manualClock,
  type Caller,
  type ExternalMachine,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type ProviderFirewallSpec,
  type ProviderNetworkSpec,
  type ProviderNetworkState,
  type ProviderSubnetSpec,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule } from '@better-compute/capacity';
import {
  defineProvider,
  maxRulesPerNetwork,
  networkTag,
  networksWork,
  providerResourceName,
  vps,
  vpsMigrations,
  type FirewallRuleView,
  type NetworkView,
  type VpsApi,
} from '@better-compute/vps';

// Tenant networks (v1.0): `networks.*` and `firewallRules.*` record what a tenant wants, and the
// `vps.networks` reconciler converges the provider through `ProviderImpl.networks`. The provider here
// is an inline fake that keeps networks, subnets, firewalls and tags in memory.

const T0 = Date.UTC(2026, 9, 17, 12);
const SITE = 'site_01jz0000000000000000000d01';
let db: SqlExecutor;
let clock: ManualClock;

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const mallory: Caller = { ...alice, identityId: 'usr_mallory', tenantId: 'other' };

// --- The fake provider -------------------------------------------------------------------------

/** Networks, subnets, firewalls and machine tags in memory, with operations that stay pending for a while. */
const gce = {
  networks: new Map<string, ProviderNetworkSpec>(),
  subnets: new Map<string, ProviderSubnetSpec>(),
  firewalls: new Map<string, ProviderFirewallSpec>(),
  tags: new Map<string, string[]>(),
  /** Every provider call, in order: `ensureNetwork bc-x`, `deleteFirewall bc-y`, `setTags vm-1`. */
  calls: [] as string[],
  /** Each ensure or delete answers `pending` this many times before it completes. */
  operationDelayTicks: 0,
  progress: new Map<string, number>(),
  /** The next provider call throws this. */
  failNext: undefined as ComputeError | undefined,
  /** The next ensure/delete answers this state instead. */
  answerNext: undefined as ProviderNetworkState['state'] | undefined,
  reset() {
    this.networks.clear();
    this.subnets.clear();
    this.firewalls.clear();
    this.tags.clear();
    this.calls.length = 0;
    this.operationDelayTicks = 0;
    this.progress.clear();
    this.failNext = undefined;
    this.answerNext = undefined;
  },
  /** Runs one ensure or delete: `pending` until it has been asked `operationDelayTicks + 1` times. */
  step(
    label: string,
    name: string,
    done: () => ProviderNetworkState['state'],
  ): ProviderNetworkState {
    this.calls.push(`${label} ${name}`);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    if (this.answerNext) {
      const state = this.answerNext;
      this.answerNext = undefined;
      return { id: name, state, ...(state === 'error' ? { message: 'the provider said no' } : {}) };
    }
    const asked = (this.progress.get(`${label} ${name}`) ?? 0) + 1;
    if (asked <= this.operationDelayTicks) {
      this.progress.set(`${label} ${name}`, asked);
      return { id: name, state: label.startsWith('delete') ? 'deleting' : 'pending' };
    }
    this.progress.delete(`${label} ${name}`);
    return { id: name, state: done() };
  },
};

const standard = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};
const gceLike = defineProvider({
  id: 'fake-gce',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new Error('unused');
    },
    async get(machineId: string): Promise<ExternalMachine | undefined> {
      return { id: machineId, name: machineId, state: 'running', addresses: [] };
    },
    async delete() {},
    networks: {
      async ensureNetwork(spec) {
        return gce.step('ensureNetwork', spec.name, () => {
          gce.networks.set(spec.name, spec);
          return 'ready';
        });
      },
      async ensureSubnet(spec) {
        return gce.step('ensureSubnet', spec.name, () => {
          if (!gce.networks.has(spec.network))
            throw new ComputeError('NOT_FOUND', `no network ${spec.network}`);
          gce.subnets.set(`${spec.region}/${spec.name}`, spec);
          return 'ready';
        });
      },
      async ensureFirewall(spec) {
        return gce.step('ensureFirewall', spec.name, () => {
          gce.firewalls.set(spec.name, spec);
          return 'ready';
        });
      },
      async deleteNetwork(name) {
        return gce.step('deleteNetwork', name, () => {
          gce.networks.delete(name);
          return 'deleted';
        });
      },
      async deleteSubnet(region, name) {
        return gce.step('deleteSubnet', name, () => {
          gce.subnets.delete(`${region}/${name}`);
          return 'deleted';
        });
      },
      async deleteFirewall(name) {
        return gce.step('deleteFirewall', name, () => {
          gce.firewalls.delete(name);
          return 'deleted';
        });
      },
      async setTags(machineId, tags) {
        gce.calls.push(`setTags ${machineId}`);
        if (gce.failNext) {
          const error = gce.failNext;
          gce.failNext = undefined;
          throw error;
        }
        gce.tags.set(machineId, [...tags]);
      },
    },
  }),
});
const hetznerLike = defineProvider({
  id: 'fake-hetzner',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new Error('unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});

// --- The module context ------------------------------------------------------------------------

const events: { type: string; subject: string; data: Record<string, unknown> }[] = [];
const authzOps: { op: string; resource: string; row?: Record<string, unknown> }[] = [];
/** The tenant each projected resource lives in: what IAM's resolver would answer from. */
const projected = new Map<string, string>();
const queue = new Map<string, number>();

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async () => 'x' },
    authz: {
      async upsert(_tx: SqlTx, row: { type: string; id: string; tenantId: string }) {
        authzOps.push({ op: 'upsert', resource: `${row.type}/${row.id}`, row });
        projected.set(`${row.type}/${row.id}`, row.tenantId);
      },
      async remove(_tx: SqlTx, ref: { type: string; id: string }) {
        authzOps.push({ op: 'remove', resource: `${ref.type}/${ref.id}` });
        projected.delete(`${ref.type}/${ref.id}`);
      },
      async setPending() {},
    },
    events: {
      async publish(
        _tx: SqlTx,
        event: { type: string; subject: string; data: Record<string, unknown> },
      ) {
        events.push({ type: event.type, subject: event.subject, data: event.data });
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }) {
        if (kind === networksWork) queue.set(key, options?.notBefore ?? clock.now());
      },
    },
    desired: { async invalidate() {} },
  } as unknown as ModuleContext;
}
function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  };
}

const module = vps({
  providers: [gceLike, hetznerLike],
  images: { resolve: async () => undefined },
});
const api = module.api!({} as ModuleContext) as VpsApi;

type Definition = {
  action: string | null;
  validate(raw: unknown): unknown;
  resource(input: unknown): { type: string; id: string } | undefined;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown; resource?: { type: string; id: string } }>;
    denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    abandoned?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
  };
};
/**
 * As the envelope runs a method: the tenant pre-check (a caller of another tenant is refused), the
 * admission's `prepare`, the decision on the resource (a resource projected into another tenant is
 * refused), the handler in a second transaction, and `abandoned` when that throws.
 */
async function run(definition: Definition, raw: unknown, who: Caller): Promise<any> {
  const input = definition.validate(raw);
  const tenantId = (input as { tenantId: string }).tenantId;
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req' }) as MethodContext;
  if (who.tenantId !== tenantId)
    throw new ComputeError('ACCESS_DENIED', 'The caller belongs to another tenant');
  const admission = definition.admission;
  let resource = definition.resource(input);
  if (admission) {
    const plan = await db.transaction((tx) => admission.prepare(context(tx), input, tx));
    if (plan.status === 'replay') return plan.result;
    resource = plan.resource;
  }
  const home = resource ? projected.get(`${resource.type}/${resource.id}`) : undefined;
  if (resource && home !== undefined && home !== tenantId) {
    const error = new ComputeError(
      'ACCESS_DENIED',
      `denied ${definition.action} on ${resource.type}/${resource.id}`,
    );
    if (admission?.denied)
      await db.transaction((tx) => admission.denied!(context(tx), input, tx, error));
    throw error;
  }
  try {
    return await db.transaction((tx) => definition.handler(context(tx), input));
  } catch (error) {
    if (admission?.abandoned)
      await db.transaction((tx) => admission.abandoned!(context(tx), input, tx, error));
    throw error;
  }
}
const call = (
  group: 'networks' | 'firewallRules',
  method: string,
  raw: unknown,
  who: Caller = alice,
) => run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

let gcePool: string;
let hetznerPool: string;
let gceAccount: string;
let keyCounter = 0;
const createNetwork = (
  raw: Record<string, unknown> = {},
  who: Caller = alice,
): Promise<NetworkView> =>
  call(
    'networks',
    'create',
    {
      tenantId: who.tenantId,
      poolId: gcePool,
      name: `net-${++keyCounter}`,
      idempotencyKey: `k-${keyCounter}`,
      ...raw,
    },
    who,
  );
const addSubnet = (
  networkId: string,
  raw: Record<string, unknown> = {},
  who: Caller = alice,
): Promise<NetworkView> =>
  call(
    'networks',
    'addSubnet',
    {
      tenantId: who.tenantId,
      networkId,
      name: `sub-${++keyCounter}`,
      region: 'us-central1',
      cidr: '10.0.0.0/20',
      ...raw,
    },
    who,
  );
const createRule = (
  networkId: string,
  raw: Record<string, unknown> = {},
  who: Caller = alice,
): Promise<FirewallRuleView> =>
  call(
    'firewallRules',
    'create',
    {
      tenantId: who.tenantId,
      networkId,
      name: `rule-${++keyCounter}`,
      direction: 'ingress',
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
      ...raw,
    },
    who,
  );

/** A minimal instance row on a provider pool (the instances API is not under test here). */
async function insertInstance(options: {
  externalId?: string;
  networkId?: string;
  subnetId?: string;
  state?: string;
  tenantId?: string;
}) {
  const instanceId = `inst_01jz${String(++keyCounter).padStart(22, '0')}`;
  await db.query(
    `INSERT INTO instances (id, tenant_id, pool_id, flavor_id, flavor, image_id, runtime, draft, state, desired_state,
                            provider_account_id, external_id, network_id, subnet_id, owner_identity_id, idempotency_key,
                            request_hash, version)
     VALUES ($1, $2, $3, 'flv_net', '{}'::jsonb, 'img', 'provider', false, $4, 'running', $5, $6, $7, $8, 'usr_alice', $1,
             decode('00', 'hex'), 1)`,
    [
      instanceId,
      options.tenantId ?? 'root',
      gcePool,
      options.state ?? 'running',
      gceAccount,
      options.externalId ?? `vm-${keyCounter}`,
      options.networkId ?? null,
      options.subnetId ?? null,
    ],
  );
  return instanceId;
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  const pools = capacityModule().api!({} as ModuleContext) as unknown as Record<
    string,
    Record<string, Definition>
  >;
  const accounts = api as unknown as Record<string, Record<string, Definition>>;
  const makeAccount = async (provider: string, name: string, config: Record<string, unknown>) =>
    (
      (await run(
        (module.api!({} as ModuleContext) as unknown as Record<string, Record<string, Definition>>)
          .providerAccounts!.create!,
        {
          tenantId: 'root',
          provider,
          name,
          config,
        },
        alice,
      )) as { id: string }
    ).id;
  void accounts;
  gceAccount = await makeAccount('fake-gce', 'gcp-main', {
    zones: ['us-central1-a', 'us-central1-b', 'europe-west4-a'],
  });
  const hetznerAccount = await makeAccount('fake-hetzner', 'hetzner', {});
  const poolOn = async (providerAccountId: string) =>
    (
      (await run(
        pools.pools!.create!,
        { tenantId: 'root', siteId: SITE, class: 'provider', providerAccountId },
        alice,
      )) as { id: string }
    ).id;
  gcePool = await poolOn(gceAccount);
  hetznerPool = await poolOn(hetznerAccount);
  await db.query(
    `INSERT INTO flavors (id, pool_id, name, vcpu, memory_gib, disk_gib, version) VALUES ('flv_net', $1, 'small', 1, 1, 10, 1)`,
    [gcePool],
  );
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  events.length = 0;
  authzOps.length = 0;
  queue.clear();
  gce.reset();
});

describe('api', () => {
  it('create returns pending and lists for the tenant', async () => {
    const created = await createNetwork({
      name: 'training',
      description: 'GPU training',
      idempotencyKey: 'train-1',
    });
    expect(created).toMatchObject({
      tenantId: 'root',
      poolId: gcePool,
      providerAccountId: gceAccount,
      name: 'training',
      description: 'GPU training',
      state: 'pending',
      subnets: [],
      version: 1,
    });
    expect(created.id).toMatch(/^net_/);
    expect(events.map((event) => event.type)).toEqual(['network.created']);
    expect(events[0]).toMatchObject({
      subject: `network/${created.id}`,
      data: { networkId: created.id },
    });
    expect(queue.has(created.id)).toBe(true);
    const upserts = authzOps.filter(
      (op) => op.op === 'upsert' && op.resource === `network/${created.id}`,
    );
    expect(upserts.at(-1)!.row).toMatchObject({
      type: 'network',
      tenantId: 'root',
      parentType: 'tenant',
      parentId: 'root',
      ownerId: 'usr_alice',
      attributes: { providerAccountId: gceAccount, poolId: gcePool },
    });

    const listed = (await call('networks', 'list', { tenantId: 'root' })) as {
      items: NetworkView[];
    };
    expect(listed.items.map((item) => item.id)).toContain(created.id);
    expect((await call('networks', 'list', { tenantId: 'other' }, mallory)).items).toEqual([]);
    expect(
      await call('networks', 'get', { tenantId: 'root', networkId: created.id }),
    ).toMatchObject({ name: 'training' });

    // A retry under the key replays; another request under it is a conflict; a taken name is a conflict.
    const again = await createNetwork({
      name: 'training',
      description: 'GPU training',
      idempotencyKey: 'train-1',
    });
    expect(again.id).toBe(created.id);
    expect(events).toHaveLength(1);
    expect(
      await codeOf(
        createNetwork({ name: 'training', description: 'other', idempotencyKey: 'train-1' }),
      ),
    ).toBe('CONFLICT');
    authzOps.length = 0;
    expect(await codeOf(createNetwork({ name: 'training', idempotencyKey: 'train-2' }))).toBe(
      'CONFLICT',
    );
    expect(authzOps.filter((op) => op.op === 'upsert')).toEqual([]);
    expect(await codeOf(createNetwork({ name: 'Bad_Name' }))).toBe('INVALID_INPUT');
    expect(await codeOf(createNetwork({ unknown: true }))).toBe('INVALID_INPUT');
  });

  it('refuses a pool whose provider has no networks', async () => {
    authzOps.length = 0;
    expect(await codeOf(createNetwork({ poolId: hetznerPool }))).toBe('UNSUPPORTED');
    expect(authzOps.filter((op) => op.op === 'upsert')).toEqual([]);
    // A pool the tenant cannot see is not found; a hosted pool is not a provider pool.
    expect(await codeOf(createNetwork({}, mallory))).toBe('NOT_FOUND');
  });

  it('refuses overlapping subnets', async () => {
    const network = await createNetwork();
    const first = await addSubnet(network.id, { name: 'a', cidr: '10.0.0.0/20' });
    expect(first.subnets).toMatchObject([
      { name: 'a', region: 'us-central1', cidr: '10.0.0.0/20', state: 'pending' },
    ]);
    expect(await codeOf(addSubnet(network.id, { name: 'b', cidr: '10.0.8.0/24' }))).toBe(
      'CONFLICT',
    );
    expect(await codeOf(addSubnet(network.id, { name: 'a', cidr: '10.1.0.0/24' }))).toBe(
      'CONFLICT',
    );
    // Another region is the same address space: a VPC does not reuse a range.
    expect(
      await codeOf(
        addSubnet(network.id, { name: 'c', cidr: '10.0.0.0/24', region: 'europe-west4' }),
      ),
    ).toBe('CONFLICT');
    expect(
      (await addSubnet(network.id, { name: 'd', cidr: '10.0.16.0/24', region: 'europe-west4' }))
        .subnets,
    ).toHaveLength(2);
    // Another network may reuse the range.
    const other = await createNetwork();
    expect((await addSubnet(other.id, { name: 'a', cidr: '10.0.0.0/20' })).subnets).toHaveLength(1);
    // The database refuses it too, whatever the handler checks.
    await expect(
      db.query(
        `INSERT INTO network_subnets (id, network_id, name, region, cidr, state, desired_state)
         VALUES ('snet_raw', $1, 'raw', 'us-central1', '10.0.4.0/24', 'pending', 'present')`,
        [network.id],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
    // A removed subnet frees its range and its name.
    const removed = await call('networks', 'removeSubnet', {
      tenantId: 'root',
      networkId: network.id,
      subnetId: first.subnets[0]!.id,
    });
    expect(
      removed.subnets.find((subnet: { id: string }) => subnet.id === first.subnets[0]!.id),
    ).toMatchObject({ state: 'deleting' });
    expect(
      (await addSubnet(network.id, { name: 'e', cidr: '10.0.8.0/24' })).subnets.map(
        (subnet) => subnet.name,
      ),
    ).toContain('e');
  });

  it('refuses a public CIDR', async () => {
    const network = await createNetwork();
    for (const cidr of [
      '8.8.0.0/16',
      '172.32.0.0/16',
      '192.169.0.0/16',
      '10.0.0.0/30',
      '10.0.0.0/7',
      '0.0.0.0/0',
      '10.0.0.1/24',
      'not-a-cidr',
      '10.0.0.0/24 ',
    ])
      expect(await codeOf(addSubnet(network.id, { cidr })), cidr).toBe('INVALID_INPUT');
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '172.20.1.0/24', '192.168.0.0/29'])
      expect(
        await codeOf(createNetwork().then((fresh) => addSubnet(fresh.id, { cidr }))),
        cidr,
      ).toBe('resolved');
    // The region must be one of the account's zones' regions.
    const fresh = await createNetwork();
    expect(await codeOf(addSubnet(fresh.id, { region: 'asia-east1' }))).toBe('INVALID_INPUT');
  });

  it('refuses deleting a network with instances on it', async () => {
    const network = await createNetwork();
    const withSubnet = await addSubnet(network.id, { name: 'a', cidr: '10.0.0.0/24' });
    const subnetId = withSubnet.subnets[0]!.id;
    const rule = await createRule(network.id);
    const instanceId = await insertInstance({ networkId: network.id, subnetId });
    const blocked = await call('networks', 'delete', {
      tenantId: 'root',
      networkId: network.id,
    }).catch((error) => error);
    expect(blocked).toMatchObject({
      code: 'INVALID_STATE',
      details: { instanceIds: [instanceId] },
    });
    const blockedSubnet = await call('networks', 'removeSubnet', {
      tenantId: 'root',
      networkId: network.id,
      subnetId,
    }).catch((error) => error);
    expect(blockedSubnet).toMatchObject({
      code: 'INVALID_STATE',
      details: { instanceIds: [instanceId] },
    });
    expect((await call('networks', 'get', { tenantId: 'root', networkId: network.id })).state).toBe(
      'pending',
    );

    await db.query(`UPDATE instances SET state = 'deleted' WHERE id = $1`, [instanceId]);
    queue.clear();
    events.length = 0;
    const deleting = await call('networks', 'delete', { tenantId: 'root', networkId: network.id });
    expect(deleting).toMatchObject({ state: 'deleting', version: 3 });
    expect(deleting.subnets).toMatchObject([{ id: subnetId, state: 'deleting' }]);
    expect(events.map((event) => event.type)).toEqual(['network.deleting']);
    expect(queue.has(network.id)).toBe(true);
    const { rows } = await db.query<{ desired_state: string }>(
      `SELECT desired_state FROM network_firewall_rules WHERE id = $1 UNION ALL SELECT desired_state FROM network_subnets WHERE id = $2`,
      [rule.id, subnetId],
    );
    expect(rows.map((row) => row.desired_state)).toEqual(['deleted', 'deleted']);
    // Deleting again is a no-op; a network being deleted takes no new subnets or rules.
    expect(
      await call('networks', 'delete', { tenantId: 'root', networkId: network.id }),
    ).toMatchObject({ state: 'deleting' });
    expect(await codeOf(addSubnet(network.id, { name: 'late', cidr: '10.9.0.0/24' }))).toBe(
      'INVALID_STATE',
    );
    expect(await codeOf(createRule(network.id))).toBe('INVALID_STATE');
  });

  it('firewall rule targets must be on the network', async () => {
    const network = await createNetwork();
    const other = await createNetwork();
    const onNetwork = await insertInstance({ networkId: network.id });
    const elsewhere = await insertInstance({ networkId: other.id });
    const unattached = await insertInstance({});
    for (const instanceId of [elsewhere, unattached])
      expect(await codeOf(createRule(network.id, { targets: { instanceIds: [instanceId] } }))).toBe(
        'INVALID_INPUT',
      );
    expect(
      await codeOf(createRule(network.id, { targets: { instanceIds: [onNetwork, elsewhere] } })),
    ).toBe('INVALID_INPUT');

    const rule = await createRule(network.id, {
      name: 'ssh',
      targets: { instanceIds: [onNetwork] },
      priority: 900,
    });
    expect(rule).toMatchObject({
      networkId: network.id,
      name: 'ssh',
      direction: 'ingress',
      action: 'allow',
      priority: 900,
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
      targets: { instanceIds: [onNetwork] },
      enabled: true,
      state: 'pending',
      version: 1,
    });
    expect(queue.has(network.id)).toBe(true);
    expect(await codeOf(createRule(network.id, { name: 'ssh' }))).toBe('CONFLICT');
    expect(
      (
        (await call('firewallRules', 'list', { tenantId: 'root', networkId: network.id })) as {
          items: FirewallRuleView[];
        }
      ).items,
    ).toMatchObject([{ id: rule.id, name: 'ssh' }]);

    // Updating bumps the version and returns the rule to pending; targets are checked again.
    const updated = await call('firewallRules', 'update', {
      tenantId: 'root',
      networkId: network.id,
      ruleId: rule.id,
      priority: 800,
      enabled: false,
    });
    expect(updated).toMatchObject({
      priority: 800,
      enabled: false,
      version: 2,
      state: 'pending',
      sources: ['0.0.0.0/0'],
      targets: { instanceIds: [onNetwork] },
    });
    expect(
      await codeOf(
        call('firewallRules', 'update', {
          tenantId: 'root',
          networkId: network.id,
          ruleId: rule.id,
          targets: { instanceIds: [elsewhere] },
        }),
      ),
    ).toBe('INVALID_INPUT');
    const removed = await call('firewallRules', 'delete', {
      tenantId: 'root',
      networkId: network.id,
      ruleId: rule.id,
    });
    expect(removed).toMatchObject({ state: 'deleting', version: 3 });
    expect(
      (
        await call('firewallRules', 'delete', {
          tenantId: 'root',
          networkId: network.id,
          ruleId: rule.id,
        })
      ).version,
    ).toBe(3);
  });

  it('checks the shape of a firewall rule', async () => {
    const network = await createNetwork();
    const bad: Record<string, unknown>[] = [
      { sources: undefined }, // ingress must name its sources
      { sources: [] },
      { sources: ['10.0.0.1/24'] },
      { sources: ['0.0.0.0/0'], destinations: ['10.0.0.0/8'] },
      { direction: 'egress', sources: ['10.0.0.0/8'] },
      { rules: [] },
      { rules: [{ protocol: 'icmp', ports: ['1'] }] },
      { rules: [{ protocol: 'tcp', ports: ['70000'] }] },
      { rules: [{ protocol: 'tcp', ports: ['9000-8000'] }] },
      { rules: [{ protocol: 'gre' }] },
      { priority: 70_000 },
      { priority: -1 },
      { action: 'maybe' },
      { name: 'Upper' },
    ];
    for (const patch of bad)
      expect(await codeOf(createRule(network.id, patch)), JSON.stringify(patch)).toBe(
        'INVALID_INPUT',
      );
    const egress = await createRule(network.id, {
      direction: 'egress',
      action: 'deny',
      sources: undefined,
      rules: [{ protocol: 'all' }],
    });
    expect(egress).toMatchObject({
      direction: 'egress',
      action: 'deny',
      priority: 1000,
      rules: [{ protocol: 'all' }],
      targets: {},
    });
    expect(egress.sources).toBeUndefined();
    expect(egress.destinations).toBeUndefined();
    expect(
      await codeOf(
        call('firewallRules', 'update', {
          tenantId: 'root',
          networkId: network.id,
          ruleId: egress.id,
        }),
      ),
    ).toBe('INVALID_INPUT');
    // Changing direction names the other range list again.
    expect(
      await codeOf(
        call('firewallRules', 'update', {
          tenantId: 'root',
          networkId: network.id,
          ruleId: egress.id,
          direction: 'ingress',
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await call('firewallRules', 'update', {
        tenantId: 'root',
        networkId: network.id,
        ruleId: egress.id,
        direction: 'ingress',
        sources: ['192.0.2.0/24'],
      }),
    ).toMatchObject({
      direction: 'ingress',
      sources: ['192.0.2.0/24'],
    });
  });

  it('allows at most 100 rules per network', async () => {
    const network = await createNetwork();
    expect(maxRulesPerNetwork).toBe(100);
    const rules = Array.from(
      { length: maxRulesPerNetwork },
      (_, index) =>
        `('fwr_cap${index}', $1, 'cap-${index}', '{"direction":"ingress","action":"allow","priority":1000,"rules":[{"protocol":"all"}],"sources":["10.0.0.0/8"],"targets":{}}'::jsonb, true, 'pending', 'present', 1)`,
    );
    await db.query(
      `INSERT INTO network_firewall_rules (id, network_id, name, spec, enabled, state, desired_state, version) VALUES ${rules.join(', ')}`,
      [network.id],
    );
    expect(await codeOf(createRule(network.id, { name: 'one-too-many' }))).toBe('QUOTA_EXCEEDED');
    // A deleted rule no longer counts.
    await db.query(
      `UPDATE network_firewall_rules SET state = 'deleted', desired_state = 'deleted' WHERE id = 'fwr_cap0'`,
    );
    expect(await codeOf(createRule(network.id, { name: 'fits-now' }))).toBe('resolved');
  });

  it('a different tenant cannot read the network', async () => {
    const network = await createNetwork();
    const rule = await createRule(network.id);
    const asMallory = (method: string, extra: Record<string, unknown> = {}) =>
      call('networks', method, { tenantId: 'other', networkId: network.id, ...extra }, mallory);
    expect(await codeOf(asMallory('get'))).toBe('ACCESS_DENIED');
    expect(await codeOf(asMallory('update', { description: 'mine now' }))).toBe('ACCESS_DENIED');
    expect(await codeOf(asMallory('delete'))).toBe('ACCESS_DENIED');
    expect(
      await codeOf(
        asMallory('addSubnet', { name: 'x', region: 'us-central1', cidr: '10.0.0.0/24' }),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await codeOf(
        call('firewallRules', 'list', { tenantId: 'other', networkId: network.id }, mallory),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await codeOf(
        call(
          'firewallRules',
          'delete',
          { tenantId: 'other', networkId: network.id, ruleId: rule.id },
          mallory,
        ),
      ),
    ).toBe('ACCESS_DENIED');
    // Naming the owner's tenant with another tenant's credentials is refused before any decision.
    expect(
      await codeOf(call('networks', 'get', { tenantId: 'root', networkId: network.id }, mallory)),
    ).toBe('ACCESS_DENIED');
    // And were the decision skipped, the handlers still scope every read to the tenant.
    const bare = (method: string, input: unknown) =>
      db.transaction((tx) =>
        (api.networks as unknown as Record<string, Definition>)[method]!.handler(
          { ...moduleContext(within(tx)), caller: mallory, requestId: 'r' } as MethodContext,
          input,
        ),
      );
    expect(await codeOf(bare('get', { tenantId: 'other', networkId: network.id }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(bare('delete', { tenantId: 'other', networkId: network.id }))).toBe(
      'NOT_FOUND',
    );
    expect((await call('networks', 'get', { tenantId: 'root', networkId: network.id })).name).toBe(
      network.name,
    );
  });

  it('registers exactly the methods the API surface rows declare', () => {
    const sample = { tenantId: 'root', networkId: 'net_x', idempotencyKey: 'k' };
    for (const group of ['networks', 'firewallRules'] as const) {
      const rows = apiSurface.filter((row) => row.group === group);
      const methods = api[group] as unknown as Record<string, Definition>;
      expect(Object.keys(methods).sort()).toEqual(rows.map((row) => row.method).sort());
      for (const row of rows) {
        const method = methods[row.method]!;
        expect(method.action, `${group}.${row.method}`).toBe(row.action);
        expect((method as unknown as { kind: string }).kind).toBe(row.kind);
        expect(method.resource(sample)?.type, `${group}.${row.method}`).toBe(row.resource);
      }
    }
  });

  it('names provider resources and tags as the provider rules need', () => {
    const tag = networkTag('inst_01jz00000000000000000000aa');
    expect(tag).toMatch(/^bc-[0-9a-f]{16}$/);
    expect(networkTag('inst_01jz00000000000000000000aa')).toBe(tag);
    expect(networkTag('inst_01jz00000000000000000000ab')).not.toBe(tag);
    expect(providerResourceName('net_01JZ0000_x.y')).toBe('bc-net-01jz0000-x-y');
    expect(providerResourceName('net_' + 'a'.repeat(80))).toHaveLength(63);
    expect(providerResourceName('net_' + 'a'.repeat(80))).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
  });
});
