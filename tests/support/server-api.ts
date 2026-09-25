import {
  ComputeError,
  manualClock,
  newId,
  type AuthzRow,
  type CommandQueue,
  type ComputeEvent,
  type ComputeModule,
  type DriverDefinition,
  type ComputePlugin,
  type Credential,
  type EnqueueCommand,
  type EventPublisher,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
  type WorkQueue,
  type AuthzWriter,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { coreGroups } from '../../packages/server/src/api.js';
import type { JoinTokenMinter } from '../../packages/server/src/api/join-tokens.js';
import { createOperations } from '../../packages/server/src/operations.js';
import { resolveOptions } from '../../packages/server/src/options.js';
import { createQuorumModule } from '../../packages/server/src/quorum/quorum.js';
import { createRegistry } from '../../packages/server/src/registry.js';
import { fakeIam, type FakeIam } from './fake-iam.js';
import { ACME, BASE_URL, OTHER, ROOT, SECRET } from './server.js';

// A server envelope and the server's own API groups over PGlite, with recording, SQL-backed fakes
// of the runtime's ports (authz writer, outbox, work queue, command queue). The groups code only
// against the core port interfaces, so these fakes stand in for the runtime in unit tests.

export const START = Date.UTC(2026, 0, 1);
export const USER = 'token-acme-user-0123456789';
export const OUTSIDER = 'token-other-user-0123456789';
export const ADMIN = 'token-root-admin-0123456789';

/** An executor that also counts the transactions open on it, to catch IAM calls inside one. */
export interface CountingExecutor extends SqlExecutor {
  readonly log: string[];
  openTransactions(): number;
}

export function countingExecutor(inner: SqlExecutor): CountingExecutor {
  const log: string[] = [];
  let open = 0;
  return {
    dialect: inner.dialect,
    kind: inner.kind,
    log,
    openTransactions: () => open,
    query(text, params) {
      log.push(`query ${text}`);
      return inner.query(text, params);
    },
    async transaction(fn, options) {
      log.push(options?.readOnly ? 'transaction (read only)' : 'transaction');
      open += 1;
      try {
        return await inner.transaction(fn, options);
      } finally {
        open -= 1;
      }
    },
    migrate(extra) {
      log.push('migrate');
      return inner.migrate(extra);
    },
    close: () => inner.close(),
  };
}

export interface FakePorts {
  authz: AuthzWriter & { rows: AuthzRow[]; removed: { type: string; id: string }[] };
  events: EventPublisher & { published: Omit<ComputeEvent, 'id' | 'time' | 'sequence'>[] };
  work: WorkQueue & { enqueued: { kind: string; key: string }[] };
  commands: CommandQueue & { enqueued: EnqueueCommand[] };
}

/** SQL-backed fakes of the runtime's ports that also record what they were asked. */
export function fakePorts(): FakePorts {
  const rows: AuthzRow[] = [];
  const removed: { type: string; id: string }[] = [];
  const published: FakePorts['events']['published'] = [];
  const workItems: { kind: string; key: string }[] = [];
  const commands: EnqueueCommand[] = [];
  return {
    authz: {
      rows,
      removed,
      async upsert(tx, row) {
        rows.push(structuredClone(row));
        await tx.query(
          `INSERT INTO authz_projection (type, id, tenant_id, attributes, parent_type, parent_id, owner_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           ON CONFLICT (type, id, tenant_id) DO UPDATE SET attributes = EXCLUDED.attributes,
             parent_type = EXCLUDED.parent_type, parent_id = EXCLUDED.parent_id, owner_id = EXCLUDED.owner_id`,
          [
            row.type,
            row.id,
            row.tenantId,
            JSON.stringify(row.attributes),
            row.parentType ?? null,
            row.parentId ?? null,
            row.ownerId ?? null,
          ],
        );
      },
      async remove(tx, ref) {
        removed.push({ type: ref.type, id: ref.id });
        await tx.query(
          'DELETE FROM authz_projection WHERE type = $1 AND id = $2 AND ($3::text IS NULL OR tenant_id = $3)',
          [ref.type, ref.id, ref.tenantId ?? null],
        );
      },
      async setPending(tx, ref, pending) {
        await tx.query(
          'UPDATE authz_projection SET pending = $4::jsonb WHERE type = $1 AND id = $2 AND tenant_id = $3',
          [ref.type, ref.id, ref.tenantId, pending === null ? null : JSON.stringify(pending)],
        );
      },
    },
    events: {
      published,
      async publish(tx, event) {
        published.push(structuredClone(event));
        await tx.query(
          `INSERT INTO outbox (topic, payload)
           VALUES ($1, $2::jsonb || jsonb_build_object('time', compute_now()))`,
          [
            event.type,
            JSON.stringify({
              id: newId('evt'),
              type: event.type,
              tenantId: event.tenantId,
              subject: event.subject,
              data: event.data,
            }),
          ],
        );
      },
    },
    work: {
      enqueued: workItems,
      async enqueue(_tx, kind, key) {
        workItems.push({ kind, key });
      },
    },
    commands: {
      enqueued: commands,
      async enqueue(tx, command) {
        commands.push(structuredClone(command));
        const { rows: existing } = await tx.query<{ id: string; seq: string }>(
          'SELECT id, seq::text AS seq FROM commands WHERE node_id = $1 AND idempotency_key = $2',
          [command.nodeId, command.idempotencyKey],
        );
        if (existing[0]) return { id: existing[0].id, seq: Number(existing[0].seq) };
        const { rows: next } = await tx.query<{ seq: string }>(
          `UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1
           RETURNING (next_cmd_seq - 1)::text AS seq`,
          [command.nodeId],
        );
        if (!next[0]) throw new ComputeError('NOT_FOUND', 'Node not found');
        const id = newId('cmd');
        await tx.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe,
             self_terminating, attested, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, true, $7, false, $8)`,
          [
            id,
            command.nodeId,
            next[0].seq,
            command.kind,
            new TextEncoder().encode(
              JSON.stringify(command.payload, (_key, value: unknown) =>
                typeof value === 'bigint' ? value.toString() : value,
              ),
            ),
            new Date(command.notAfter),
            command.kind === 'node.reboot',
            command.idempotencyKey,
          ],
        );
        return { id, seq: Number(next[0].seq) };
      },
      cancel: () => Promise.reject(new Error('not used')),
    },
  };
}

const unused = (what: string) => () => Promise.reject(new Error(`${what} is not used here`));

export interface HarnessOptions {
  plugins?: readonly ComputePlugin[];
  /** Modules registered after the core groups (groups not yet in `coreGroups`). */
  modules?: readonly ComputeModule[];
  iam?: FakeIam;
  joinTokens?: JoinTokenMinter;
  /** The registered drivers `drivers.list` shows (default none). */
  drivers?: () => readonly DriverDefinition[];
}

export type Harness = Awaited<ReturnType<typeof serverHarness>>;

/**
 * PGlite migrated with the base schema (and plugin migrations), the sim clock at `START`, a fake
 * IAM with USER (acme), OUTSIDER (other) and ADMIN (root), and the server's envelope and groups.
 */
export async function serverHarness(options: HarnessOptions = {}) {
  const store = pglite();
  const plugins = options.plugins ?? [];
  // The quorum module is always hosted: the commands API reads its batch members.
  await store.migrate([
    ...(createQuorumModule({}).migrations ?? []),
    ...plugins.flatMap((plugin) => plugin.migrations ?? []),
  ]);
  await useSimClock(store, START);
  const clock = manualClock(START);
  const iam = options.iam ?? fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  iam.addCaller(OUTSIDER, { tenantId: OTHER, identityId: 'id-outsider', sessionId: 'ses-out' });
  iam.addCaller(ADMIN, {
    tenantId: ROOT,
    identityId: 'id-admin',
    sessionId: 'ses-admin',
    mfa: true,
  });
  const database = countingExecutor(store);
  const warnings: string[] = [];
  const log = {
    debug() {},
    info() {},
    warn: (message: string) => void warnings.push(message),
    error: (message: string) => void warnings.push(message),
  };
  const resolved = resolveOptions({
    database,
    iam,
    secret: SECRET,
    baseURL: BASE_URL,
    rootTenantId: ROOT,
    clock,
    log,
  });
  const ports = fakePorts();
  let context: ModuleContext | undefined;
  const registry = createRegistry({
    core: coreGroups(
      resolved,
      {
        info: () => ({
          name: 'better-compute',
          version: 'test',
          basePath: '/api/compute',
          protocol: { min: 1, max: 1 },
        }),
        selfCheck: () => Promise.resolve({ ok: true, findings: [] }),
        ...(options.drivers ? { drivers: options.drivers } : {}),
      },
      { listRetryDelayMs: 0, ...(options.joinTokens ? { joinTokens: options.joinTokens } : {}) },
    ),
    modules: options.modules ?? [],
    plugins,
    extensions: [],
    context: (view) =>
      (context = {
        sql: resolved.database,
        clock,
        leases: { acquire: unused('leases'), release: unused('leases'), fence: unused('leases') },
        iam,
        registry: view,
        commands: ports.commands,
        desired: { invalidate: unused('desired state') },
        capacity: { reserve: unused('capacity'), release: unused('capacity') },
        inventory: { get: unused('inventory') },
        events: ports.events,
        work: ports.work,
        authz: ports.authz,
        log,
      }),
  });
  const operations = createOperations(resolved, context!, registry);

  /** Calls `path` as the holder of `token` (no credential when `token` is undefined). */
  async function call<T = any>(
    path: string,
    token: string | undefined,
    input: unknown,
  ): Promise<T> {
    const method = registry.method(path);
    if (!method) throw new Error(`No method ${path}`);
    const credential: Credential | undefined = token === undefined ? undefined : { token };
    return (await operations.call(method, credential, input, { requestId: newId('req') })) as T;
  }

  /** The ComputeError `call` rejects with. */
  async function failure(
    path: string,
    token: string | undefined,
    input: unknown,
  ): Promise<ComputeError> {
    try {
      await call(path, token, input);
    } catch (error) {
      if (error instanceof ComputeError) return error;
      throw error;
    }
    throw new Error(`Expected ${path} to fail`);
  }

  /** Forgets recorded IAM calls, port calls and executor calls (callers and rules stay). */
  function reset(): void {
    iam.reset();
    database.log.length = 0;
    ports.authz.rows.length = 0;
    ports.authz.removed.length = 0;
    ports.events.published.length = 0;
    ports.work.enqueued.length = 0;
    ports.commands.enqueued.length = 0;
    warnings.length = 0;
    operations.caches.clear();
  }

  return {
    store,
    database,
    iam,
    ports,
    warnings,
    clock,
    registry,
    operations,
    call,
    failure,
    reset,
    seed: seeds(store),
    close: () => store.close(),
  };
}

/** Rows the server groups read but other components write (sites, pools, nodes, projection). */
export function seeds(sql: SqlTx) {
  const projection = async (type: string, id: string, tenantId: string, attributes = {}) => {
    await sql.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [type, id, tenantId, JSON.stringify(attributes)],
    );
  };
  return {
    projection,
    async site(
      owner = ROOT,
      options: { kind?: string; region?: string; visibleTo?: string[] } = {},
    ) {
      const id = newId('site');
      await sql.query(
        'INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, $3, $4, 1)',
        [
          id,
          owner,
          options.kind ?? (owner === ROOT ? 'shared' : 'custom'),
          options.region ?? 'eu-west-1',
        ],
      );
      for (const tenant of options.visibleTo ?? [owner]) await projection('site', id, tenant);
      return id;
    },
    async pool(
      owner: string,
      siteId: string,
      options: { agent?: 'bcd' | 'none'; id?: string } = {},
    ) {
      const id = options.id ?? newId('pool');
      await sql.query(
        `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
         VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', $4, '{}', 1)`,
        [id, owner, siteId, options.agent ?? 'bcd'],
      );
      await projection('pool', id, owner);
      return id;
    },
    async node(
      owner: string,
      siteId: string,
      options: {
        poolId?: string;
        state?: string;
        visible?: boolean;
        cordoned?: boolean;
        reasons?: string[];
        trust?: string;
      } = {},
    ) {
      const id = newId('node');
      await sql.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
           cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
           next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, $2, $3, $4, 'host', $5, false, $6, 'connected', $7, $8, 1, 1, 1, 0, 0, 1)`,
        [
          id,
          siteId,
          options.poolId ?? null,
          owner,
          options.state ?? 'adopted',
          options.cordoned ?? false,
          options.trust ?? (owner === ROOT ? 'platform' : 'tenant-owned'),
          options.reasons ?? [],
        ],
      );
      await sql.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [id]);
      if (options.visible !== false) await projection('node', id, owner);
      return id;
    },
  };
}
