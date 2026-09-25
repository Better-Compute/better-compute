import { afterEach, describe, expect, it } from 'vitest';
import {
  defineMethod,
  defineModule,
  definePlugin,
  shardOf,
  type Lease,
  type MethodContext,
  type ReconcileContext,
} from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// The context ports of 72537c5 (PLAN.md §5.4, §8.4): `ModuleContext.afterCommit` (the store's
// commit hooks), `ModuleContext.caches` (the envelope's own caches, for the IAM bridge's inbox
// handlers) and `ReconcileContext.lease` (the lease the run is fenced by).

afterEach(closeFixtures);

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ModuleContext.afterCommit', () => {
  it('runs hooks once the outermost transaction commits, never on rollback', async () => {
    const { compute } = await computeFixture();
    const { sql, afterCommit } = compute.context;
    expect(typeof afterCommit).toBe('function');
    const ran: string[] = [];

    await sql.transaction(async (tx) => {
      afterCommit!(() => void ran.push('outer'));
      await tx.query('SELECT 1');
      // A savepoint that rolls back drops its own hooks only.
      await sql
        .transaction(async () => {
          afterCommit!(() => void ran.push('rolled-back savepoint'));
          throw new Error('undo the savepoint');
        })
        .catch(() => undefined);
      await sql.transaction(async () => {
        afterCommit!(() => void ran.push('released savepoint'));
      });
      expect(ran).toEqual([]);
    });
    expect(ran).toEqual(['outer', 'released savepoint']);

    await expect(
      sql.transaction(async () => {
        afterCommit!(() => void ran.push('rolled back'));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await nextMacrotask();
    expect(ran).toEqual(['outer', 'released savepoint']);

    // Outside a transaction: the next macrotask, best effort.
    afterCommit!(() => void ran.push('outside'));
    expect(ran).toHaveLength(2);
    await nextMacrotask();
    expect(ran).toEqual(['outer', 'released savepoint', 'outside']);
  });

  it('reaches method handlers: a mutation hook runs after its commit, not after a failure', async () => {
    const fired: string[] = [];
    const seen: MethodContext[] = [];
    const hooked = definePlugin({
      id: 'hooked',
      catalog: { actions: ['compute:hooked:fire'] },
      api: () => ({
        hooks: {
          fire: defineMethod<{ tenantId: string; fail?: boolean }, { ok: true }>({
            action: 'compute:hooked:fire',
            kind: 'mutation',
            resource: (input) => ({ type: 'tenant', id: input.tenantId }),
            validate: (input) => input as { tenantId: string; fail?: boolean },
            async handler(context, input) {
              seen.push(context);
              context.afterCommit!(() => void fired.push(input.fail ? 'failed' : 'committed'));
              if (input.fail) throw new Error('handler failed after registering its hook');
              return { ok: true };
            },
          }),
        },
      }),
    });
    const fixture = await computeFixture({
      plugins: [hooked],
      iam: { allow: [{}] },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const credential = { token: fixture.tenants.acme.token };
    const tenantId = fixture.tenants.acme.id;
    await fixture.compute.api.plugins.hooked.hooks.fire(credential, { tenantId });
    expect(fired).toEqual(['committed']);
    await expect(
      fixture.compute.api.plugins.hooked.hooks.fire(credential, { tenantId, fail: true }),
    ).rejects.toThrow();
    await nextMacrotask();
    expect(fired).toEqual(['committed']);
    expect(typeof seen[0]!.caches?.dropIdentity).toBe('function');
  });
});

describe('ModuleContext.caches', () => {
  it('drops entries of the caches the envelope reads', async () => {
    const reader = definePlugin({
      id: 'reader',
      catalog: { actions: ['compute:reader:read'] },
      api: () => ({
        things: {
          get: defineMethod<{ tenantId: string }, { ok: true }>({
            action: 'compute:reader:read',
            kind: 'read',
            resource: (input) => ({ type: 'tenant', id: input.tenantId }),
            validate: (input) => input as { tenantId: string },
            handler: async () => ({ ok: true }),
          }),
        },
      }),
    });
    const fixture = await computeFixture({ plugins: [reader], iam: { allow: [{}] } });
    const { compute, iam, tenants } = fixture;
    const { caches } = compute.context;
    expect(caches).toBeDefined();
    const read = (tenant: typeof tenants.acme) =>
      compute.api.plugins.reader.things.get({ token: tenant.token }, { tenantId: tenant.id });

    await read(tenants.acme);
    await read(tenants.other);
    expect(compute.caches.stats()).toEqual({ authentications: 2, decisions: 2 });
    const before = iam.count('authenticate');

    caches!.dropIdentity(tenants.acme.caller.identityId);
    expect(compute.caches.stats()).toEqual({ authentications: 1, decisions: 1 });
    await read(tenants.acme);
    expect(iam.count('authenticate')).toBe(before + 1);

    caches!.dropSession(tenants.other.caller.sessionId);
    expect(compute.caches.stats()).toEqual({ authentications: 1, decisions: 1 });

    caches!.dropDecisions();
    expect(compute.caches.stats()).toEqual({ authentications: 1, decisions: 0 });
  });
});

describe('ReconcileContext.lease', () => {
  it('is the shard lease of a sharded run and the singleton lease otherwise', async () => {
    const runs: { reconciler: string; key: string; lease?: Lease; shard?: number }[] = [];
    const committed: string[] = [];
    const record =
      (reconciler: string) =>
      async (context: ReconcileContext, key: string): Promise<'DONE'> => {
        runs.push({
          reconciler,
          key,
          ...(context.lease ? { lease: { ...context.lease } } : {}),
          ...(context.shard === undefined ? {} : { shard: context.shard }),
        });
        // A fenced transaction through ctx.sql, with a hook that runs once it commits.
        await context.sql.transaction(async () => {
          context.afterCommit!(() => void committed.push(`${reconciler}:${key}`));
        });
        expect(committed).toContain(`${reconciler}:${key}`);
        return 'DONE';
      };
    const module = defineModule({
      name: 'leased',
      reconcilers: [
        { name: 'by-node', shardBy: 'node', run: record('by-node') },
        { name: 'by-none', shardBy: 'none', run: record('by-none') },
      ],
    });
    const { compute, database } = await computeFixture({ modules: [module] });
    await compute.context.sql.transaction(async (tx) => {
      await compute.context.work.enqueue(tx, 'by-node', 'node_one');
      await compute.context.work.enqueue(tx, 'by-none', 'all');
    });
    expect(await compute.jobs['by-node']!.tick()).toBe(1);
    expect(await compute.jobs['by-none']!.tick()).toBe(1);

    const lease = async (name: string) =>
      (
        await database.query<{ owner: string; epoch: string | number }>(
          'SELECT owner, epoch FROM leases WHERE name = $1',
          [name],
        )
      ).rows[0];
    const [sharded, singleton] = runs;
    expect(sharded).toMatchObject({
      reconciler: 'by-node',
      key: 'node_one',
      shard: shardOf('node_one'),
      lease: { name: `shard:${shardOf('node_one')}` },
    });
    expect(singleton).toMatchObject({
      reconciler: 'by-none',
      lease: { name: 'singleton:by-none' },
    });
    expect(singleton!.shard).toBeUndefined();
    for (const run of runs) {
      const row = await lease(run.lease!.name);
      expect(row).toBeDefined();
      expect(run.lease!.owner).toBe(row!.owner);
      expect(run.lease!.epoch).toBe(Number(row!.epoch));
      expect(run.lease!.expiresAt).toBeGreaterThan(compute.context.clock.now());
    }
    expect(committed).toEqual(['by-node:node_one', 'by-none:all']);
  });
});
