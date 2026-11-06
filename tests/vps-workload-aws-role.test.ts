import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SecretBroker,
  type SecretRef,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import {
  awsRoleAllowed,
  awsRoleGlobMatches,
  instanceSpecs,
  instanceWork,
  parseCreateInstance,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// AWS A7 workload identity, the vps half: an instance on a hosted pool may name the AWS IAM role its
// workloads assume (`workloadIdentity.awsRoleArn`). The role must match the pool's allow-list
// (`policy.workloadRoles.aws`, ARN globs) on a pool that turned workload identity on; vps passes it
// to the host as `InstanceSpec.awsRole`, where bcd exchanges the instance's workload token for the
// role's credentials (aud sts.amazonaws.com, sub t:<tenant>:instance:<id>). The role's own trust
// pins only the tenant; the workload broker enforces the allow-list for that audience
// (tests/e2e/imds.test.ts).

const T0 = Date.UTC(2026, 8, 24, 12);
const SITE = 'site_01jz0000000000000000000a71';
const NODE = 'node_01jz0000000000000000000a71';
const ALLOWED = 'arn:aws:iam::222222222222:role/ml-readers';
let db: SqlExecutor;
let clock: ManualClock;
let poolId: string;
let offPoolId: string;

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };

const sealed = new Map<string, string>();
let sealedCount = 0;
const broker: SecretBroker = {
  async put(tenantId, value) {
    const ref = `secret://${tenantId}/s${++sealedCount}` as SecretRef;
    sealed.set(ref, value);
    return ref;
  },
  async resolve(ref) {
    const value = sealed.get(ref);
    if (value === undefined) throw new ComputeError('NOT_FOUND', `no ${ref}`);
    return value;
  },
  async delete(ref) {
    sealed.delete(ref);
  },
};

const queue = new Set<string>();
function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: broker,
    capacity: createCapacityPort({ clock }, { topN: 3 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: { async publish() {} },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string) {
        if (kind === instanceWork) queue.add(key);
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

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown }>;
  };
};
async function run(definition: Definition, raw: unknown, who: Caller): Promise<unknown> {
  const input = definition.validate(raw);
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'r' }) as MethodContext;
  if (definition.admission) {
    const plan = await db.transaction((tx) =>
      definition.admission!.prepare(context(tx), input, tx),
    );
    if (plan.status === 'replay') return plan.result;
  }
  return db.transaction((tx) => definition.handler(context(tx), input));
}

const images = {
  async resolve() {
    return {
      url: 'https://images.example/base.qcow2',
      sha256: 'cd'.repeat(32),
      format: 'qcow2' as const,
      verified: true,
    };
  },
};
const module = vps({ images });
const api = module.api!({} as ModuleContext) as VpsApi;
const capacityApi = capacityModule().api!({} as ModuleContext) as unknown as Record<
  string,
  Record<string, Definition>
>;
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller = alice) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);

/** Runs the instance reconciler until its queue drains. */
async function settle(): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === instanceWork)!;
  for (let round = 0; round < 10 && queue.size; round++)
    for (const key of [...queue]) {
      queue.delete(key);
      await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, key);
    }
}

async function hostedPool(policy: Record<string, unknown>, node: string): Promise<string> {
  const pool = (await run(
    capacityApi.pools!.create!,
    { tenantId: 'root', siteId: SITE, class: 'vps-host', policy },
    root,
  )) as { id: string };
  await run(
    capacityApi.pools!.offer!,
    {
      tenantId: 'root',
      poolId: pool.id,
      toTenantId: 'acme',
      quota: { vcpu: 64, memoryGiB: 256, diskGiB: 4000 },
    },
    root,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                        trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [node, SITE, pool.id],
  );
  for (const runtime of ['libvirt-kvm', 'cloud-hypervisor'])
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '0.5.0', 'system')`,
      [node, `bc.dev/driver.${runtime}`],
    );
  for (const [resource, allocatable] of [
    ['vcpu', 64],
    ['memoryGiB', 256],
    ['diskGiB', 4000],
  ] as const)
    await db.query(
      `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`,
      [node, resource, allocatable],
    );
  await call(
    'flavors',
    'create',
    { tenantId: 'root', poolId: pool.id, name: 's', vcpu: 2, memoryGiB: 4, diskGiB: 40 },
    root,
  );
  return pool.id;
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
  poolId = await hostedPool(
    {
      workloadIdentity: true,
      workloadRoles: { aws: [ALLOWED, 'arn:aws:iam::333333333333:role/team-?/*'] },
    },
    NODE,
  );
  // pools.create refuses roles without workload identity on; a row stored around it (or before
  // that check) still allows nothing.
  offPoolId = await hostedPool({}, 'node_01jz0000000000000000000a72');
  await db.query(`UPDATE pools SET policy = $2::jsonb WHERE id = $1`, [
    offPoolId,
    JSON.stringify({ workloadRoles: { aws: [ALLOWED] } }),
  ]);
});
afterAll(async () => {
  await db.close();
});

const base = { tenantId: 'acme', flavor: 's', imageId: 'base' };

describe('instance AWS workload roles (A7)', () => {
  it('parses workloadIdentity.awsRoleArn and refuses anything but an IAM role ARN', () => {
    expect(
      parseCreateInstance({
        ...base,
        poolId: 'pool_01jz0000000000000000000a71',
        idempotencyKey: 'k',
        workloadIdentity: { awsRoleArn: ALLOWED },
      }).workloadIdentity,
    ).toEqual({ awsRoleArn: ALLOWED });
    for (const workloadIdentity of [
      { awsRoleArn: 'arn:aws:iam::222222222222:user/bob' },
      { awsRoleArn: 'arn:aws:iam::*:role/x' },
      { awsRoleArn: 'arn:aws:iam::222222222222:role/ml-*' },
      { awsRoleArn: 'arn:aws:s3:::bucket' },
      { awsRoleArn: 'arn:aws:iam::2222:role/x' },
      { awsRoleArn: 'arn:aws:iam::222222222222:role/x', gcp: 'y' },
      {},
      'arn:aws:iam::222222222222:role/x',
    ])
      expect(
        () =>
          parseCreateInstance({
            ...base,
            poolId: 'pool_01jz0000000000000000000a71',
            idempotencyKey: 'k',
            workloadIdentity,
          }),
        JSON.stringify(workloadIdentity),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('matches ARN globs as IAM does: * any run, ? one character, nothing else', () => {
    const list = [ALLOWED, 'arn:aws:iam::333333333333:role/team-?/*'];
    expect(awsRoleAllowed(list, ALLOWED)).toBe(true);
    expect(awsRoleAllowed(list, 'arn:aws:iam::333333333333:role/team-a/jobs/reader')).toBe(true);
    expect(awsRoleAllowed(list, 'arn:aws:iam::333333333333:role/team-ab/reader')).toBe(false);
    expect(awsRoleAllowed(list, 'arn:aws:iam::222222222222:role/ml-readers2')).toBe(false);
    expect(awsRoleAllowed(list, 'arn:aws:iam::222222222222:role/ml.readers')).toBe(false);
    expect(awsRoleAllowed([], ALLOWED)).toBe(false);
    expect(awsRoleAllowed(undefined, ALLOWED)).toBe(false);
    expect(awsRoleAllowed('nope', ALLOWED)).toBe(false);
    expect(awsRoleAllowed(['arn:aws:iam::222222222222:role/(.*)'], ALLOWED)).toBe(false);
    expect(awsRoleGlobMatches('arn:aws:iam::1:role/a*b?c*', 'arn:aws:iam::1:role/aXXbYcZZ')).toBe(
      true,
    );
    expect(awsRoleGlobMatches('arn:aws:iam::1:role/a*b?c*', 'arn:aws:iam::1:role/aXXbcZZ')).toBe(
      false,
    );
    expect(awsRoleGlobMatches('arn:aws:iam::1:role/***', 'arn:aws:iam::1:role/')).toBe(true);
    expect(awsRoleGlobMatches('arn:aws:iam::1:role/*x', 'arn:aws:iam::1:role/xax')).toBe(true);
    expect(awsRoleGlobMatches('arn:aws:iam::1:role/*x', 'arn:aws:iam::1:role/xa')).toBe(false);
  });

  it('matches a many-star glob in linear time: it never backtracks (no ReDoS on the event loop)', () => {
    const prefix = 'arn:aws:iam::123456789012:role/';
    const arn = prefix + 'a'.repeat(480);
    const twelve = prefix + '*a'.repeat(11) + '*b';
    const start = performance.now();
    expect(awsRoleGlobMatches(twelve, arn)).toBe(false);
    expect(awsRoleGlobMatches(twelve, `${arn}b`)).toBe(true);
    // The allow-list itself caps an entry at 8 stars, and still matches the worst case at once.
    const eight = prefix + '*a'.repeat(7) + '*b';
    expect(awsRoleAllowed([twelve], `${arn}b`)).toBe(false);
    expect(awsRoleAllowed([eight], arn)).toBe(false);
    expect(awsRoleAllowed([eight], `${arn}b`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('refuses a role ARN outside the pool allow-list', async () => {
    await expect(
      call('instances', 'create', {
        ...base,
        poolId,
        idempotencyKey: 'outside',
        workloadIdentity: { awsRoleArn: 'arn:aws:iam::222222222222:role/admin' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'awsRoleNotAllowed' } });
    const { rows } = await db.query(`SELECT id FROM instances WHERE idempotency_key = 'outside'`);
    expect(rows).toHaveLength(0);
  });

  it('refuses a role on a pool without workload identity', async () => {
    await expect(
      call('instances', 'create', {
        ...base,
        poolId: offPoolId,
        idempotencyKey: 'off',
        workloadIdentity: { awsRoleArn: ALLOWED },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'workloadIdentityOff' } });
  });

  it('passes the role to the instance spec', async () => {
    const instance = (await call('instances', 'create', {
      ...base,
      poolId,
      idempotencyKey: 'allowed',
      workloadIdentity: { awsRoleArn: ALLOWED },
    })) as { id: string; nodeId?: string; workloadIdentity?: unknown };
    expect(instance.nodeId).toBe(NODE);
    expect(instance.workloadIdentity).toEqual({ awsRoleArn: ALLOWED });
    await settle();
    const specs = await db.transaction((tx) => instanceSpecs(tx, NODE));
    expect(specs.find((spec) => spec.id === instance.id)?.awsRole).toBe(ALLOWED);

    const plain = (await call('instances', 'create', {
      ...base,
      poolId,
      idempotencyKey: 'plain',
    })) as { id: string; workloadIdentity?: unknown };
    expect(plain.workloadIdentity).toBeUndefined();
    await settle();
    const again = await db.transaction((tx) => instanceSpecs(tx, NODE));
    expect(again.find((spec) => spec.id === plain.id)).toBeDefined();
    expect(again.find((spec) => spec.id === plain.id)?.awsRole).toBeUndefined();
  });

  it('a role the pool stops allowing leaves the spec (fail closed)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM instances WHERE idempotency_key = 'allowed'`,
    );
    const id = rows[0]!.id;
    const read = () => db.transaction((tx) => instanceSpecs(tx, NODE));
    await db.query(`UPDATE pools SET policy = policy - 'workloadRoles' WHERE id = $1`, [poolId]);
    expect((await read()).find((spec) => spec.id === id)?.awsRole).toBeUndefined();
    await db.query(
      `UPDATE pools SET policy = jsonb_set(policy, '{workloadRoles}', $2::jsonb) WHERE id = $1`,
      [poolId, JSON.stringify({ aws: [ALLOWED] })],
    );
    expect((await read()).find((spec) => spec.id === id)?.awsRole).toBe(ALLOWED);
    await db.query(
      `UPDATE pools SET policy = jsonb_set(policy, '{workloadIdentity}', 'false') WHERE id = $1`,
      [poolId],
    );
    expect((await read()).find((spec) => spec.id === id)?.awsRole).toBeUndefined();
    // Roles listed but workload identity absent (not just false): no role either.
    await db.query(`UPDATE pools SET policy = policy - 'workloadIdentity' WHERE id = $1`, [poolId]);
    expect((await read()).find((spec) => spec.id === id)?.awsRole).toBeUndefined();
    await db.query(
      `UPDATE pools SET policy = jsonb_set(policy, '{workloadIdentity}', 'true') WHERE id = $1`,
      [poolId],
    );
    expect((await read()).find((spec) => spec.id === id)?.awsRole).toBe(ALLOWED);
  });

  it('an idempotency key reused with another role is CONFLICT', async () => {
    const first = (await call('instances', 'create', {
      ...base,
      poolId,
      idempotencyKey: 'role-key',
      workloadIdentity: { awsRoleArn: ALLOWED },
    })) as { id: string };
    await expect(
      call('instances', 'create', {
        ...base,
        poolId,
        idempotencyKey: 'role-key',
        workloadIdentity: { awsRoleArn: 'arn:aws:iam::333333333333:role/team-a/reader' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      call('instances', 'create', { ...base, poolId, idempotencyKey: 'role-key' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const replay = (await call('instances', 'create', {
      ...base,
      poolId,
      idempotencyKey: 'role-key',
      workloadIdentity: { awsRoleArn: ALLOWED },
    })) as { id: string; workloadIdentity?: unknown };
    expect(replay.id).toBe(first.id);
    expect(replay.workloadIdentity).toEqual({ awsRoleArn: ALLOWED });
  });

  it('refuses workloadIdentity on a provider pool', async () => {
    const account = 'pacct_01jz0000000000000000000a71';
    await db.query(
      `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
       VALUES ($1, 'root', 'aws', 'aws-a7', '{}'::jsonb, 1)`,
      [account],
    );
    const pool = (await run(
      capacityApi.pools!.create!,
      {
        tenantId: 'root',
        siteId: SITE,
        class: 'provider',
        providerAccountId: account,
        policy: { workloadIdentity: true, workloadRoles: { aws: [ALLOWED] } },
      },
      root,
    )) as { id: string };
    await run(
      capacityApi.pools!.offer!,
      {
        tenantId: 'root',
        poolId: pool.id,
        toTenantId: 'acme',
        quota: { vcpu: 64, memoryGiB: 256, diskGiB: 4000 },
      },
      root,
    );
    await db.query(
      `INSERT INTO flavors (id, pool_id, name, vcpu, memory_gib, disk_gib, offer_id, version)
       VALUES ('flv_a7_provider', $1, 's', 2, 4, 40, 'us-east-1a/m7i.large', 1)`,
      [pool.id],
    );
    await expect(
      call('instances', 'create', {
        ...base,
        poolId: pool.id,
        idempotencyKey: 'provider-role',
        workloadIdentity: { awsRoleArn: ALLOWED },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'workloadIdentityHostedOnly' },
    });
    const { rows } = await db.query(
      `SELECT id FROM instances WHERE idempotency_key = 'provider-role'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('pools refuse workload roles without workload identity on', async () => {
    for (const policy of [
      { workloadRoles: { aws: [ALLOWED] } },
      { workloadIdentity: false, workloadRoles: { aws: [ALLOWED] } },
    ])
      await expect(
        run(
          capacityApi.pools!.create!,
          { tenantId: 'root', siteId: SITE, class: 'vps-host', policy },
          root,
        ),
        JSON.stringify(policy),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('workloadIdentity'),
      });
    await expect(
      run(capacityApi.pools!.update!, { tenantId: 'root', poolId, policy: { workloadRoles: { aws: [ALLOWED] } } }, root),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // An empty list, or no aws key, needs nothing.
    for (const policy of [{ workloadRoles: { aws: [] } }, { workloadRoles: {} }])
      await expect(
        run(
          capacityApi.pools!.create!,
          { tenantId: 'root', siteId: SITE, class: 'vps-host', policy },
          root,
        ),
      ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('pools refuse a malformed allow-list', async () => {
    for (const workloadRoles of [
      'x',
      { aws: 'arn:aws:iam::222222222222:role/x' },
      { aws: ['arn:aws:iam::*:role/x'] },
      { aws: ['*'] },
      { aws: [`arn:aws:iam::222222222222:role/${'*a'.repeat(9)}`] },
      { gcp: [] },
      { aws: Array.from({ length: 65 }, (_, i) => `arn:aws:iam::222222222222:role/r${i}`) },
    ])
      await expect(
        run(
          capacityApi.pools!.create!,
          {
            tenantId: 'root',
            siteId: SITE,
            class: 'vps-host',
            policy: { workloadIdentity: true, workloadRoles },
          },
          root,
        ),
        JSON.stringify(workloadRoles).slice(0, 80),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
