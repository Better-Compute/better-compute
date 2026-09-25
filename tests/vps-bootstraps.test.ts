import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manifest,
  manualClock,
  newId,
  type Caller,
  type ExternalMachine,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type PkiPort,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule } from '@better-compute/capacity';
import {
  bootstrapWork,
  defineProvider,
  vps,
  vpsMigrations,
  type ProviderBootstrap,
  type VpsApi,
} from '@better-compute/vps';

// Platform-owned provider machines (PLAN.md §3.6): providerAccounts.bootstrap claims a machine,
// identifies it, mints a single-use `provisioned` token bound to its SMBIOS UUID, hands it to the
// provider's bootstrap (never user data), and waits for the node to join.

const T0 = Date.UTC(2026, 8, 24, 12);
const SITE = 'site_01jz0000000000000000000b01';
const UUID = '4c4c4544-0051-3010-8052-b4c04f4a4e32';
let db: SqlExecutor;
let clock: ManualClock;
let vpsPool: string;
let metalPool: string;
let accountId: string;
let plainAccountId: string;

const root: Caller = {
  identityId: 'usr_root',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};

/** A provider with rescue: machines by id, the tokens its bootstrap received, failures to inject. */
const provider = {
  machines: new Map<string, ExternalMachine>(),
  delivered: [] as {
    machineId: string;
    joinToken: string;
    bcdUrl: string;
    sha256: string;
    controlPlaneUrl?: string;
  }[],
  failBootstraps: 0,
};
const rescueProvider = defineProvider({
  id: 'fake-rescue',
  version: '1.0.0',
  provides: ['metal'],
  config: manifest({}) as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(request, context) {
      const id = `srv-${request.offerId}`;
      const machine: ExternalMachine = {
        id,
        name: context.idempotencyKey,
        state: 'running',
        addresses: ['203.0.113.7'],
      };
      provider.machines.set(id, machine);
      return machine;
    },
    async get(id) {
      return provider.machines.get(id);
    },
    async delete(id) {
      provider.machines.delete(id);
    },
    async identify() {
      return { productUuid: UUID.toUpperCase() };
    },
    async bootstrap(machine, bootstrap) {
      if (provider.failBootstraps > 0) {
        provider.failBootstraps--;
        throw new ComputeError('PROVIDER_ERROR', 'rescue did not come up');
      }
      provider.delivered.push({ machineId: machine.id, ...bootstrap });
    },
  }),
});
const plainProvider = defineProvider({
  id: 'fake-plain',
  version: '1.0.0',
  provides: ['metal'],
  config: manifest({}) as never,
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

/** ctx.pki as the server's port does it: a join_tokens row, the bearer secret returned once. */
const pki: PkiPort = {
  async issueJoinToken(tx, input) {
    const id = newId('jt');
    const secret = randomBytes(32).toString('base64url');
    await tx.query(
      `INSERT INTO join_tokens (id, tenant_id, role, pool_id, secret_hash, uses_left, expect, allow_reclaim, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, compute_now() + make_interval(secs => $8))`,
      [
        id,
        input.tenantId,
        input.role,
        input.poolId ?? null,
        createHash('sha256').update(secret).digest(),
        input.maxUses ?? 1,
        input.expect ? JSON.stringify(input.expect) : null,
        input.ttlSeconds,
      ],
    );
    return { id, token: `bcjt_${id}.${secret}` };
  },
};

const queue = new Map<string, number>();
const events: { type: string; data: unknown }[] = [];
function moduleContext(sql: SqlExecutor, withPki = true): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async () => 'x' },
    ...(withPki ? { pki } : {}),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: {
      async publish(_tx: SqlTx, event: { type: string; data: unknown }) {
        events.push({ type: event.type, data: event.data });
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }) {
        if (kind === bootstrapWork) queue.set(key, options?.notBefore ?? clock.now());
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
};
const run = async (
  definition: Definition,
  raw: unknown,
  sql = (tx: SqlTx) => moduleContext(within(tx)),
) => {
  const input = definition.validate(raw);
  return db.transaction((tx) =>
    definition.handler({ ...sql(tx), caller: root, requestId: 'r' } as MethodContext, input),
  );
};

const options = {
  images: { resolve: async () => undefined },
  providers: [rescueProvider, plainProvider],
  bootstrap: {
    bcdUrl: 'https://downloads.example/bcd-linux-amd64',
    sha256: 'ab'.repeat(32),
    controlPlaneUrl: 'https://compute.example/api/compute',
  },
};
const module = vps(options);
const api = module.api!({} as ModuleContext) as VpsApi;
const accounts = api.providerAccounts as unknown as Record<string, Definition>;
const reconciler = () => module.reconcilers!.find((entry) => entry.name === bootstrapWork)!;

async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    const due = [...queue].filter(([, at]) => at <= clock.now()).map(([key]) => key);
    if (!due.length) return;
    for (const key of due) {
      queue.delete(key);
      await reconciler().run({ ...moduleContext(db), signal: new AbortController().signal }, key);
    }
  }
}
const bootstrap = (raw: Record<string, unknown>) =>
  run(accounts.bootstrap!, {
    tenantId: 'root',
    accountId,
    poolId: vpsPool,
    ...raw,
  }) as Promise<ProviderBootstrap>;
async function tokens() {
  const { rows } = await db.query<{
    id: string;
    role: string;
    uses_left: number;
    expect: Record<string, string>;
    revoked: boolean;
    ttl: number;
  }>(
    `SELECT id, role, uses_left, expect, revoked_at IS NOT NULL AS revoked,
            extract(epoch FROM expires_at - compute_now())::int AS ttl
       FROM join_tokens ORDER BY expires_at, id`,
  );
  return rows;
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
  vpsPool = (
    (await run(pools.pools!.create!, { tenantId: 'root', siteId: SITE, class: 'vps-host' })) as {
      id: string;
    }
  ).id;
  accountId = (
    (await run(accounts.create!, {
      tenantId: 'root',
      provider: 'fake-rescue',
      name: 'robot',
      config: {},
    })) as { id: string }
  ).id;
  plainAccountId = (
    (await run(accounts.create!, {
      tenantId: 'root',
      provider: 'fake-plain',
      name: 'plain',
      config: {},
    })) as { id: string }
  ).id;
  metalPool = (
    (await run(pools.pools!.create!, {
      tenantId: 'root',
      siteId: SITE,
      class: 'provider',
      providerAccountId: accountId,
    })) as { id: string }
  ).id;
});
afterAll(async () => {
  await db.close();
});

describe('providerAccounts.bootstrap (§3.6 platform-owned provider machines)', () => {
  it('claims, identifies, delivers a bound single-use token only to the provider, and waits', async () => {
    const started = await bootstrap({ offerId: '1001', idempotencyKey: 'rack-1' });
    expect(started).toMatchObject({ state: 'claiming', offerId: '1001', attempts: 0 });
    await settle();
    const [delivered] = provider.delivered;
    expect(delivered).toMatchObject({
      machineId: 'srv-1001',
      bcdUrl: 'https://downloads.example/bcd-linux-amd64',
      sha256: 'ab'.repeat(32),
      controlPlaneUrl: 'https://compute.example/api/compute',
    });
    expect(delivered!.joinToken).toMatch(/^bcjt_jt_/);
    const [token] = await tokens();
    expect(token).toMatchObject({
      role: 'provisioned',
      uses_left: 1,
      expect: { productUuid: UUID },
      revoked: false,
    });
    expect(token!.ttl).toBeLessThanOrEqual(7_200);
    // The API never shows the token; a retry under the key reports the status.
    const status = await bootstrap({ offerId: '1001', idempotencyKey: 'rack-1' });
    expect(status).toMatchObject({
      id: started.id,
      state: 'joining',
      machineId: 'srv-1001',
      productUuid: UUID,
    });
    expect(JSON.stringify(status)).not.toContain('bcjt_');
    expect(
      events.map((event) => event.type).filter((type) => type.startsWith('provider.bootstrap.')),
    ).toEqual(['provider.bootstrap.started', 'provider.bootstrap.installed']);
    await expect(bootstrap({ offerId: '1002', idempotencyKey: 'rack-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // The machine joins: a node of the pool reports that UUID.
    const nodeId = 'node_01jz0000000000000000000b01';
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                          trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [nodeId, SITE, vpsPool],
    );
    await db.query(
      `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
       VALUES ('inv_b1', $1, '\\x00', '{}', $2::jsonb, compute_now())`,
      [nodeId, JSON.stringify({ system: { productUuid: UUID.toUpperCase() } })],
    );
    await db.query(
      `INSERT INTO node_inventory (node_id, applied_snapshot_id) VALUES ($1, 'inv_b1')`,
      [nodeId],
    );
    clock.advance(30_000);
    await useSimClock(db, clock.now());
    await settle();
    expect(await bootstrap({ offerId: '1001', idempotencyKey: 'rack-1' })).toMatchObject({
      state: 'joined',
      nodeId,
    });
    expect(events.at(-1)).toMatchObject({ type: 'provider.bootstrap.joined', data: { nodeId } });
  });

  it('retries a failed install with a fresh token and revokes the one it replaces', async () => {
    provider.failBootstraps = 1;
    const before = (await tokens()).length;
    const started = await bootstrap({ machineId: 'srv-1001', idempotencyKey: 'rack-2' });
    expect(started.state).toBe('identifying');
    await settle();
    const failedOnce = await bootstrap({ machineId: 'srv-1001', idempotencyKey: 'rack-2' });
    expect(failedOnce).toMatchObject({
      state: 'installing',
      attempts: 1,
      error: { code: 'PROVIDER_ERROR' },
    });
    clock.advance(10 * 60_000);
    await useSimClock(db, clock.now());
    await settle();
    expect(await bootstrap({ machineId: 'srv-1001', idempotencyKey: 'rack-2' })).toMatchObject({
      state: 'joining',
    });
    const minted = (await tokens()).slice(before);
    expect(minted.map((token) => token.revoked)).toEqual([true, false]);
    expect(provider.delivered.at(-1)!.joinToken).toContain(minted[1]!.id);
  });

  it('gives up when the machine never joins, revoking its token', async () => {
    await bootstrap({ machineId: 'srv-1001', idempotencyKey: 'rack-3' });
    await settle();
    clock.advance(61 * 60_000);
    await useSimClock(db, clock.now());
    await settle();
    const failed = await bootstrap({ machineId: 'srv-1001', idempotencyKey: 'rack-3' });
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'JOIN_TIMEOUT' } });
    expect((await tokens()).at(-1)!.revoked).toBe(true);
  });

  it('refuses what cannot become a bcd node', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: { code?: string }) => error.code,
      );
    // A provider pool (agent none) is not where bcd nodes live.
    expect(await code(bootstrap({ poolId: metalPool, machineId: 'm', idempotencyKey: 'x1' }))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await code(bootstrap({ accountId: plainAccountId, machineId: 'm', idempotencyKey: 'x2' })),
    ).toBe('UNSUPPORTED');
    expect(await code(bootstrap({ machineId: 'm', offerId: 'o', idempotencyKey: 'x3' }))).toBe(
      'INVALID_INPUT',
    );
    expect(await code(bootstrap({ idempotencyKey: 'x4' }))).toBe('INVALID_INPUT');
    // Without the host PKI (join tokens) or vps({ bootstrap }), nothing starts.
    const noPki = (tx: SqlTx) => moduleContext(within(tx), false);
    expect(
      await code(
        run(
          accounts.bootstrap!,
          { tenantId: 'root', accountId, poolId: vpsPool, machineId: 'm', idempotencyKey: 'x5' },
          noPki,
        ),
      ),
    ).toBe('INVALID_CONFIG');
    const bare = vps({ providers: [rescueProvider] }).api!({} as ModuleContext) as VpsApi;
    expect(
      await code(
        run((bare.providerAccounts as unknown as Record<string, Definition>).bootstrap!, {
          tenantId: 'root',
          accountId,
          poolId: vpsPool,
          machineId: 'm',
          idempotencyKey: 'x6',
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(() =>
      vps({ bootstrap: { bcdUrl: 'http://insecure/bcd', sha256: 'ab'.repeat(32) } }),
    ).toThrow(/https/);
    expect(() =>
      vps({
        bootstrap: {
          bcdUrl: 'https://d.example/bcd',
          sha256: 'ab'.repeat(32),
          controlPlaneUrl: 'https://c.example/%i',
        },
      }),
    ).toThrow(/controlPlaneUrl/);
  });
});
