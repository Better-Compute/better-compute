import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  manualClock,
  type Caller,
  type MethodContext,
  type ModuleContext,
  type NodeRecord,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  buildReleaseManifest,
  createReleaseSigningKey,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
} from '@better-compute/pki';
import {
  advanceRollout,
  daemonSpecFor,
  rolloutMigrations,
  rolloutModule,
  waveOf,
  type Rollout,
} from '@better-compute/rollout';

// The Rollout controller (PLAN.md §6 "Self-update"): releases, waves, budget, soak, the failure
// gate, abort with rollback and NodeSpec.daemon, on PGlite with recording ports.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;
let now = T0;
let events: string[] = [];
let invalidated: string[] = [];
const key = createReleaseSigningKey();
const downloadsUrl = 'https://compute.test/api/compute/downloads';
const module = rolloutModule({ release: { pins: [spkiPin(key.publicKey)] }, downloadsUrl });

const root: Caller = {
  identityId: 'usr_root',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};

function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  } as SqlExecutor;
}

function context(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock: manualClock(T0),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    events: {
      async publish(_tx: SqlTx, event: { type: string }) {
        events.push(event.type);
      },
    },
    desired: {
      async invalidate(_tx: SqlTx, nodeId: string) {
        invalidated.push(nodeId);
      },
    },
    work: { async enqueue() {} },
  } as unknown as ModuleContext;
}

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
};
const api = module.api!(context(db!)) as unknown as Record<string, Record<string, Definition>>;
async function call<O>(group: string, method: string, raw: unknown): Promise<O> {
  const definition = api[group]![method]!;
  const input = definition.validate(raw);
  return db.transaction(
    async (tx) =>
      (await definition.handler(
        { ...context(within(tx)), caller: root, requestId: 'r' } as MethodContext,
        input,
      )) as O,
  );
}

const release = (version: string, sequence: number) =>
  signReleaseManifest(
    buildReleaseManifest({
      product: 'bcd',
      version,
      sequence,
      signers: [key],
      clock: manualClock(T0),
      artifacts: [
        releaseArtifact(
          `bcd_${version}_linux_amd64`,
          new TextEncoder().encode(`bcd ${version}`),
          'linux-amd64',
        ),
        releaseArtifact(`bcd_${version}_linux_amd64.tar.gz`, new Uint8Array(4), 'linux-amd64'),
      ],
    }),
    [key],
  );

const advance = (rolloutId: string) =>
  db.transaction((tx) => advanceRollout(context(db), tx, rolloutId));
async function tick(ms: number) {
  now += ms;
  await setSimClock(db, now);
}
const report = (nodeIds: readonly string[], version: string) =>
  db.query('UPDATE node_sessions SET daemon_version = $2 WHERE node_id = ANY($1::text[])', [
    nodeIds,
    version,
  ]);

const pools = ['pool_01jz00000000000000000000pa', 'pool_01jz00000000000000000000pb'];
const nodeId = (pool: number, index: number) =>
  `node_01jz0000000000000000000${pool}${String.fromCharCode(97 + index)}`;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...rolloutMigrations]);
  const column = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'node_sessions' AND column_name = 'daemon_version'`,
  );
  if (!column.rows.length)
    await db.query('ALTER TABLE node_sessions ADD COLUMN daemon_version text');
});
afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  for (const table of [
    'rollout_nodes',
    'rollouts',
    'daemon_releases',
    'node_labels',
    'node_sessions',
    'nodes',
    'pools',
    'sites',
  ])
    await db.query(`DELETE FROM ${table}`);
  now = T0;
  await useSimClock(db, T0);
  events = [];
  invalidated = [];
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`,
  );
  for (const pool of pools)
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
       VALUES ($1, 'root', 'site_01jz00000000000000000000aa', 'metal-host', 'exclusive', 'bcd', '{"disruptionBudget":0.2}', 1)`,
      [pool],
    );
  for (const [p, pool] of pools.entries())
    for (let index = 0; index < 10; index++) {
      const id = nodeId(p, index);
      await db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                            connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false, 'connected',
                 'platform', 1, 1, 1, 1, 0, 1)`,
        [id, pool],
      );
      await db.query(
        `INSERT INTO node_sessions (node_id, session_epoch, daemon_version) VALUES ($1, 1, '1.0.0')`,
        [id],
      );
      await db.query(
        `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'cpu.arch', 'x86_64', 'inventory')`,
        [id],
      );
    }
  await call('releases', 'register', { tenantId: 'root', manifest: release('1.0.0', 1) });
  await call('releases', 'register', { tenantId: 'root', manifest: release('1.1.0', 2) });
});

const record = (id: string, poolId = pools[0]!): NodeRecord =>
  ({
    id,
    poolId,
    labels: [{ key: 'cpu.arch', value: 'x86_64', source: 'inventory' }],
  }) as unknown as NodeRecord;
const spec = (id: string, poolId?: string) =>
  db.transaction((tx) => daemonSpecFor(tx, record(id, poolId), downloadsUrl));

describe('releases', () => {
  it('registers verified manifests, replays, and refuses rollbacks and unsigned ones', async () => {
    const items = await call<{ items: { version: string; binaries: object }[] }>(
      'releases',
      'list',
      {
        tenantId: 'root',
      },
    );
    expect(items.items.map((item) => item.version)).toEqual(['1.1.0', '1.0.0']);
    expect(Object.keys(items.items[0]!.binaries)).toEqual(['linux-amd64']);
    await expect(
      call('releases', 'register', { tenantId: 'root', manifest: release('1.0.0', 1) }),
    ).resolves.toMatchObject({ version: '1.0.0' });
    await expect(
      call('releases', 'register', { tenantId: 'root', manifest: release('0.9.0', 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'rollback' } });
    const other = createReleaseSigningKey();
    const forged = signReleaseManifest(
      buildReleaseManifest({
        product: 'bcd',
        version: '2.0.0',
        sequence: 9,
        signers: [other],
        artifacts: [releaseArtifact('bcd_2.0.0_linux_amd64', new Uint8Array(3), 'linux-amd64')],
      }),
      [other],
    );
    await expect(
      call('releases', 'register', { tenantId: 'root', manifest: forged }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'threshold' } });
  });
});

describe('rollouts', () => {
  it('waves hold at least one node each and end at 100%', () => {
    expect(Array.from({ length: 20 }, (_, i) => waveOf(i, 20, [10, 50, 100]))).toEqual([
      0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    ]);
    expect(Array.from({ length: 3 }, (_, i) => waveOf(i, 3, [1, 10, 50, 100]))).toEqual([0, 1, 2]);
  });

  it('upgrades wave by wave within the budget, soaks, pauses on failures and rolls back', async () => {
    const rollout = await call<Rollout>('rollouts', 'create', {
      tenantId: 'root',
      version: '1.1.0',
      waves: [10, 50, 100],
      soakSeconds: 60,
      upgradeTimeoutSeconds: 600,
    });
    expect(rollout).toMatchObject({ state: 'running', wave: 0, nodes: { pending: 20 } });
    expect(events).toContain('rollout.started');
    // One writer per node.
    await expect(
      call('rollouts', 'create', { tenantId: 'root', version: '1.1.0' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const first = (await advance(rollout.id))!;
    expect(first.started).toHaveLength(2);
    expect(invalidated).toEqual(first.started);
    expect(await spec(first.started[0]!)).toEqual({
      version: '1.1.0',
      url: `${downloadsUrl}/bcd/1.1.0/linux-amd64`,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const untouched = nodeId(0, 0) === first.started[0] ? nodeId(0, 1) : nodeId(0, 0);
    if (!first.started.includes(untouched)) expect(await spec(untouched)).toBeUndefined();

    // The canaries rejoin on 1.1.0; the wave soaks, then the next one starts within budget.
    await report(first.started, '1.1.0');
    expect((await advance(rollout.id))!).toMatchObject({
      succeeded: first.started,
      waiting: 'soak',
    });
    await tick(61_000);
    const second = (await advance(rollout.id))!;
    expect(second.wave).toBe(1);
    expect(events).toContain('rollout.wave');
    // disruptionBudget 0.2 of 10 nodes: at most 2 upgrading per pool.
    expect(second.started).toHaveLength(4);
    expect(second.waiting).toBe('budget');

    // Nobody reports back: the upgrades time out and the failure gate pauses the rollout.
    await tick(601_000);
    const gated = (await advance(rollout.id))!;
    expect(gated.failed).toHaveLength(4);
    expect(gated.state).toBe('paused');
    expect(events).toContain('rollout.paused');
    // A failed node goes back to its previous version.
    expect((await spec(second.started[0]!))?.version).toBe('1.0.0');

    // Abort with rollback: upgraded nodes go back to 1.0.0 and finish when they report it.
    const aborted = await call<Rollout>('rollouts', 'abort', {
      tenantId: 'root',
      rolloutId: rollout.id,
      rollback: true,
    });
    expect(aborted).toMatchObject({ state: 'aborted', nodes: { 'rolling-back': 2 } });
    expect(await spec(first.started[0]!)).toMatchObject({ version: '1.0.0' });
    await report(first.started, '1.0.0');
    expect((await advance(rollout.id))!.succeeded).toEqual(first.started);
    const got = await call<Rollout & { nodeList: { state: string }[] }>('rollouts', 'get', {
      tenantId: 'root',
      rolloutId: rollout.id,
    });
    expect(got.nodes['rolled-back']).toBe(2);
    expect(got.nodeList).toHaveLength(20);
  });

  it('completes, and then every node of the pool gets the version as its default', async () => {
    const rollout = await call<Rollout>('rollouts', 'create', {
      tenantId: 'root',
      version: '1.1.0',
      poolIds: [pools[1]],
      waves: [100],
      soakSeconds: 0,
    });
    let outcome = (await advance(rollout.id))!;
    expect(outcome.started).toHaveLength(2);
    // Offline nodes are skipped instead of blocking the wave.
    await db.query(`UPDATE nodes SET connectivity = 'lost' WHERE id = $1`, [nodeId(1, 9)]);
    for (let round = 0; round < 10 && outcome.state === 'running'; round++) {
      await report(
        Array.from({ length: 10 }, (_, i) => nodeId(1, i)).filter((id) => id !== nodeId(1, 9)),
        '1.1.0',
      );
      outcome = (await advance(rollout.id))!;
    }
    expect(outcome.state).toBe('completed');
    expect(events).toContain('rollout.completed');
    const done = await call<Rollout>('rollouts', 'get', {
      tenantId: 'root',
      rolloutId: rollout.id,
    });
    expect(done.nodes).toMatchObject({ succeeded: 9, skipped: 1 });
    // The skipped node, and any node that joins the pool later, converge on the pool default.
    expect((await spec(nodeId(1, 9), pools[1]))?.version).toBe('1.1.0');
    expect(await spec('node_01jz00000000000000000000zz', pools[0])).toBeUndefined();
  });

  it('pauses and resumes by hand; refuses unknown versions', async () => {
    await expect(
      call('rollouts', 'create', { tenantId: 'root', version: '9.9.9' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rollout = await call<Rollout>('rollouts', 'create', {
      tenantId: 'root',
      version: '1.1.0',
    });
    await call('rollouts', 'pause', { tenantId: 'root', rolloutId: rollout.id, reason: 'freeze' });
    expect((await advance(rollout.id))!).toMatchObject({ waiting: 'paused', started: [] });
    await call('rollouts', 'resume', { tenantId: 'root', rolloutId: rollout.id });
    expect((await advance(rollout.id))!.started.length).toBeGreaterThan(0);
    const list = await call<{ items: Rollout[] }>('rollouts', 'list', { tenantId: 'root' });
    expect(list.items[0]!.id).toBe(rollout.id);
  });
});
