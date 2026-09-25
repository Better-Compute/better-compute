// Tenancy (PLAN.md §12.8 `iam:tenants:update|delete` → "suspend admissions; schedule teardown and purge"), hosted:
// - `compute_tenant_states` mirrors the IAM tenants that are not active (suspended or deleted). The IAM bridge's
//   `tenant` handler (`tenantStateHandler`) runs in the inbox transaction, so it makes no IAM call (§8.1): it queues a
//   `sync:<tenant>` key (without a reader it can only record the deletion of the event's own tenant); the `tenancy`
//   reconciler then re-reads the tenant's
//   subtree from IAM outside any transaction (a suspension or deletion cascades to descendants, and the audit event
//   names only the tenant acted on), retrying with back-off while IAM is down. A periodic `resync` re-reads the
//   whole tree from the root as the backstop for anything missed (its own reconciler, `tenancy.resync`). The root
//   tenant is never suspended or deleted here, and `missing` (IAM no longer knows a tenant) only confirms a tenant
//   already recorded as suspended or deleted: it never starts a teardown by itself;
// - the envelope's gate (`createTenantGate`) refuses a suspended tenant's mutations and everything of a deleted
//   tenant with `TENANT_SUSPENDED`; root callers may still act in a suspended tenant and read a deleted one;
// - the `tenancy` reconciler tears a deleted tenant down: every module's `tenantDeleted` hook until all answer
//   `DONE`, then `teardown_done_at` and `tenant.torn-down`.

import {
  ComputeError,
  defineModule,
  type Caller,
  type ComputeModule,
  type Json,
  type Migration,
  type ModuleContext,
  type ReconcileContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';

export const tenancyModuleName = 'tenancy';
/** The reconciler's work kind. Keys: a tenant id (its teardown), `sync:<tenant id>` (re-read it and its subtree
 * from IAM), and the periodic `sweep` (unfinished teardowns). */
export const tenancyWorkKind = 'tenancy';
/** The full re-read from the root (periodic `resync`), in a reconciler of its own so it never delays the rest. */
export const tenancyResyncWorkKind = 'tenancy.resync';

export type TenantState = 'active' | 'suspended' | 'deleted';

export const tenantStatesMigration: Migration = {
  name: 'tenancy/0001_tenant_states',
  sql: `
CREATE TABLE compute_tenant_states (
  tenant_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'deleted')),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  teardown_done_at timestamptz
);
CREATE INDEX compute_tenant_states_teardown ON compute_tenant_states (tenant_id)
  WHERE state = 'deleted' AND teardown_done_at IS NULL;
`,
};

/** When a teardown was last attempted: the sweep retries the longest-waiting first, so none starves. */
export const tenantTeardownAttemptsMigration: Migration = {
  name: 'tenancy/0002_teardown_attempts',
  sql: `ALTER TABLE compute_tenant_states ADD COLUMN teardown_attempted_at timestamptz;`,
};

// --- The gate ------------------------------------------------------------------------------------------------

export interface TenantGateOptions {
  sql: Pick<SqlExecutor, 'transaction'>;
  rootTenantId: string;
  /** How often `start()` reloads the states (default 5 s, the bound on another process's refusal delay). */
  refreshMs?: number;
  onError?(error: unknown): void;
}

export interface TenantGate {
  /**
   * Refuses the call when the caller's tenant or a tenant it acts in is suspended (a mutation) or deleted
   * (anything). Root callers may act in a suspended tenant and read a deleted one, never change it. Memory only,
   * so a refusal costs no SQL, except on the first call of a process that never started the gate and right after
   * `invalidate()` (this process changed a state), when it (re)loads first.
   */
  check(
    caller: Caller,
    tenantIds: readonly (string | undefined)[],
    mutation: boolean,
  ): Promise<void>;
  /** Reloads every tenant that is not active. */
  load(): Promise<void>;
  /** Loads, then reloads every `refreshMs` until `stop()`. */
  start(): Promise<void>;
  stop(): void;
  /** Marks the states stale (this process wrote one): the next `check` reloads them. */
  invalidate(tenantId?: string): void;
}

const undefinedTable = (error: unknown) => (error as { code?: unknown }).code === '42P01';

/** A gate that refuses nothing: operations built without a deployment (unit harnesses). */
export const noTenantGate: TenantGate = Object.freeze({
  check: async () => {},
  load: async () => {},
  start: async () => {},
  stop: () => {},
  invalidate: () => {},
});

export function createTenantGate(options: TenantGateOptions): TenantGate {
  let states = new Map<string, TenantState>();
  /** Loaded at least once: a process that never ran `start()` (an API-only replica) loads on its first call. */
  let loaded = false;
  /** Bumped by `invalidate()`: a load that began before it does not count as fresh. */
  let generation = 0;
  let loadedGeneration = -1;
  let loading: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const load = (): Promise<void> => {
    loading ??= (async () => {
      const started = generation;
      try {
        // A read-only transaction of its own, like every other read the server makes outside a call.
        const { rows } = await options.sql.transaction(
          (tx) =>
            tx.query<{ tenant_id: string; state: TenantState }>(
              `SELECT tenant_id, state FROM compute_tenant_states WHERE state <> 'active'`,
            ),
          { readOnly: true },
        );
        states = new Map(rows.map((row) => [row.tenant_id, row.state]));
        loaded = true;
        loadedGeneration = started;
      } catch (error) {
        // Before the tenancy migration ran (a store migrating right now): nobody is suspended yet.
        if (!undefinedTable(error)) throw error;
        states = new Map();
        loaded = true;
        loadedGeneration = started;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  };

  /** Reported once per run of failures (an outage logs when it starts, not every refresh). */
  let failing = false;
  const report = (error: unknown) => {
    if (failing) return;
    failing = true;
    try {
      options.onError?.(error);
    } catch {
      // A broken reporter changes nothing.
    }
  };
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const fresh = () => loaded && loadedGeneration === generation;
  const refresh = () =>
    load().then(
      () => {
        failing = false;
      },
      (error: unknown) => {
        // A process that closed its store without stopping compute (a one-shot CLI command) is done.
        if (error instanceof Error && /executor is closed/.test(error.message)) return stop();
        report(error);
      },
    );

  return {
    load,
    async start() {
      stopped = false;
      // A store that cannot answer yet does not stop the server from starting: the states stay unloaded, so
      // the first call loads them (and fails like any other statement while the store is down).
      await load().catch(report);
      if (timer) return;
      timer = setInterval(() => void refresh(), options.refreshMs ?? 5_000);
      timer.unref?.();
    },
    stop,
    async check(caller, tenantIds, mutation) {
      const root = caller.tenantId === options.rootTenantId;
      if (root && !mutation) return;
      // Twice at most: a load already in flight when a state changed is followed by one that sees it.
      for (let pass = 0; pass < 2 && !fresh(); pass++) await load();
      // A process whose tenancy module never started (an API-only replica) keeps the states fresh from here on.
      if (!timer && !stopped) {
        timer = setInterval(() => void refresh(), options.refreshMs ?? 5_000);
        timer.unref?.();
      }
      if (states.size === 0) return;
      const ids = [
        ...new Set(
          [caller.tenantId, ...tenantIds].filter(
            (id): id is string => typeof id === 'string' && id !== options.rootTenantId,
          ),
        ),
      ];
      for (const tenantId of ids) {
        const state = states.get(tenantId);
        if (!state) continue;
        // Root manages a suspended tenant (and reads a deleted one), but never writes into a deleted tenant: what
        // it created after the teardown would never be torn down.
        if (root && state === 'suspended') continue;
        if (state === 'deleted')
          throw new ComputeError('TENANT_SUSPENDED', `Tenant ${tenantId} was deleted`, undefined, {
            tenantId,
            state,
          });
        if (state === 'suspended' && mutation)
          throw new ComputeError(
            'TENANT_SUSPENDED',
            `Tenant ${tenantId} is suspended: nothing can be changed until it is reactivated`,
            undefined,
            { tenantId, state },
          );
      }
    },
    invalidate() {
      generation++;
    },
  };
}

// --- The IAM event handler ----------------------------------------------------------------------------------

/** One tenant as IAM reports it. `missing`: IAM no longer knows it (purged). */
export interface IamTenantStatus {
  tenantId: string;
  status: 'active' | 'pending' | 'suspended' | 'deleted' | 'missing';
}

/** Reads a tenant and every tenant below it from IAM, with their effective statuses. */
export type TenantReader = (tenantId: string) => Promise<readonly IamTenantStatus[]>;

export interface TenantStateHandlerOptions {
  /**
   * Reads the tenant and every tenant below it from IAM (level-triggered, §12.8): a suspension or deletion cascades
   * to descendants, and the audit event names only the tenant acted on. It is handed to `compute.tenants` and called
   * by the tenancy reconciler, never in the inbox transaction. Without one, only `iam:tenants:delete` is applied, to
   * the named tenant alone.
   */
  readTenants?: TenantReader;
}

/** The tenancy reconciler's view of the configured reader (set by `tenantStateHandler` or `compute.tenants`). */
export interface TenantReaderSlot {
  current?: TenantReader;
}

/** An IAM inbox event, structurally (the server never imports `@better-compute/iam`). */
export interface TenantEventLike {
  tenantId: string;
  action: string;
  subjectId?: string;
  metadata?: Record<string, Json>;
}

const stateOf = (status: IamTenantStatus['status']): TenantState =>
  status === 'suspended'
    ? 'suspended'
    : status === 'deleted' || status === 'missing'
      ? 'deleted'
      : 'active';

/**
 * Applies tenant states; returns the tenants whose state changed. A deletion enqueues the teardown. Replays change
 * nothing. The root tenant is never suspended or deleted here, and `missing` only confirms a tenant already recorded
 * as suspended or deleted (a purged tenant was deleted first): it never starts a teardown by itself.
 */
export async function applyTenantStates(
  tx: SqlTx,
  context: Pick<ModuleContext, 'work' | 'events'>,
  statuses: readonly IamTenantStatus[],
  reason: string,
  options: { rootTenantId?: string } = {},
): Promise<{ tenantId: string; state: TenantState }[]> {
  const changed: { tenantId: string; state: TenantState }[] = [];
  for (const status of statuses) {
    const state = stateOf(status.status);
    if (state !== 'active' && status.tenantId === options.rootTenantId) continue;
    const { rows } = await tx.query<{ state: TenantState }>(
      'SELECT state FROM compute_tenant_states WHERE tenant_id = $1 FOR UPDATE',
      [status.tenantId],
    );
    const previous: TenantState = rows[0]?.state ?? 'active';
    // Unchanged (an active tenant without a row is active too).
    if (previous === state) continue;
    if (status.status === 'missing' && previous === 'active') continue;
    await tx.query(
      `INSERT INTO compute_tenant_states (tenant_id, state, reason) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason,
              updated_at = compute_now(),
              teardown_done_at = CASE WHEN EXCLUDED.state = 'deleted' THEN compute_tenant_states.teardown_done_at END`,
      [status.tenantId, state, reason],
    );
    changed.push({ tenantId: status.tenantId, state });
    await context.events.publish(tx, {
      type: 'tenant.state-changed',
      tenantId: status.tenantId,
      subject: `tenant/${status.tenantId}`,
      data: { tenantId: status.tenantId, state, previous, reason },
    });
    if (state === 'deleted') await context.work.enqueue(tx, tenancyWorkKind, status.tenantId);
  }
  return changed;
}

/**
 * The IAM bridge's `tenant` handler: `bridge.setHandlers({ tenant: tenantStateHandler(compute, { readTenants }) })`.
 * Shaped like `IamEventHandlers.tenant` (`(tx, event) => Promise<void>`).
 */
export function tenantStateHandler(
  compute: {
    context: Pick<ModuleContext, 'work' | 'events'>;
    tenants?: { invalidate(): void; setReader?(reader: TenantReader): void };
  },
  options: TenantStateHandlerOptions = {},
): (tx: SqlTx, event: TenantEventLike) => Promise<void> {
  if (options.readTenants) compute.tenants?.setReader?.(options.readTenants);
  // With a reader, the reconciler re-reads the subtree (every process is configured alike, so it has one too).
  const sync = options.readTenants !== undefined;
  return async (tx, event) => {
    if (event.action !== 'iam:tenants:update' && event.action !== 'iam:tenants:delete') return;
    const tenantId = event.subjectId || event.tenantId;
    if (!tenantId) return;
    // Only SQL in the inbox transaction. A teardown cannot be undone, so the event alone is not trusted with one:
    // with a reader, every state (a deletion included) is applied only once the reconciler's IAM read confirms it
    // (IAM has already ended the tenant's sessions). Without one, only the deletion of the event's own tenant
    // applies (better-iam audits `tenants.setStatus` with tenant = resource = the target).
    const deleteNow =
      event.action === 'iam:tenants:delete' &&
      options.readTenants === undefined &&
      tenantId === event.tenantId;
    const changed = deleteNow
      ? await applyTenantStates(
          tx,
          compute.context,
          [{ tenantId, status: 'deleted' }],
          event.action,
        )
      : [];
    if (sync) await compute.context.work.enqueue(tx, tenancyWorkKind, `${syncPrefix}${tenantId}`);
    // This process reloads the gate before its next call; others within the gate's refresh (5 s).
    if (changed.length > 0) compute.tenants?.invalidate();
  };
}

const syncPrefix = 'sync:';

/**
 * Re-reads `tenantId`'s subtree through `reader` (outside any transaction) and applies it in a transaction of its
 * own. Throws when IAM cannot answer, so the reconciler retries with back-off.
 */
export async function syncTenantStates(
  context: Pick<ModuleContext, 'work' | 'events'> & { sql: Pick<SqlExecutor, 'transaction'> },
  reader: TenantReader,
  tenantId: string,
  reason: string,
  options: { rootTenantId?: string } = {},
): Promise<{ tenantId: string; state: TenantState }[]> {
  const statuses = await reader(tenantId);
  return context.sql.transaction((tx) => applyTenantStates(tx, context, statuses, reason, options));
}

// --- Teardown ------------------------------------------------------------------------------------------------

/** One teardown pass for a deleted tenant: every module's hook, then the record. */
export async function tearDownTenant(
  context: ReconcileContext,
  tenantId: string,
  modules: readonly ComputeModule[],
  options: { rootTenantId?: string } = {},
): Promise<'DONE' | 'SYNC_AGAIN' | 'WAIT'> {
  // The root tenant is never torn down, whatever a row says.
  if (tenantId === options.rootTenantId) return 'DONE';
  const { rows } = await context.sql.query<{ state: TenantState; done: boolean }>(
    `UPDATE compute_tenant_states SET teardown_attempted_at = compute_now() WHERE tenant_id = $1
     RETURNING state, teardown_done_at IS NOT NULL AS done`,
    [tenantId],
  );
  const row = rows[0];
  if (!row || row.state !== 'deleted' || row.done) return 'DONE';
  let pending = false;
  for (const module of modules) {
    if (!module.tenantDeleted || module.name === tenancyModuleName) continue;
    if ((await module.tenantDeleted(context, tenantId)) === 'SYNC_AGAIN') pending = true;
  }
  if (pending) return 'WAIT';
  await context.sql.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE compute_tenant_states SET teardown_done_at = compute_now()
        WHERE tenant_id = $1 AND state = 'deleted' AND teardown_done_at IS NULL`,
      [tenantId],
    );
    if (rowCount)
      await context.events.publish(tx, {
        type: 'tenant.torn-down',
        tenantId,
        subject: `tenant/${tenantId}`,
        data: { tenantId },
      });
  });
  return 'DONE';
}

/**
 * The built-in tenancy module (`modules` is read at run time: every hosted module, plugins included). It loads
 * the envelope's `gate` when the process starts and keeps it fresh.
 */
export function createTenancyModule(options: {
  modules: () => readonly ComputeModule[];
  gate?: Pick<TenantGate, 'start' | 'stop' | 'invalidate'>;
  /** The IAM reader (`compute.tenants.setReader`); without one, sync keys only log. */
  reader?: TenantReaderSlot;
  /** The IAM root tenant: `resync` re-reads the whole tree from it. */
  rootTenantId?: string;
}): ComputeModule<typeof tenancyModuleName> {
  const root = options.rootTenantId ? { rootTenantId: options.rootTenantId } : {};
  const apply = async (context: ReconcileContext, tenantId: string, reason: string) => {
    const reader = options.reader?.current;
    // A sync is only queued where a reader is configured: this process lacks it, so the key waits (with back-off)
    // rather than being dropped.
    if (!reader)
      throw new ComputeError(
        'UNAVAILABLE',
        'No IAM tenant reader is configured in this process (tenantStateHandler(compute, { readTenants }))',
      );
    const changed = await syncTenantStates(context, reader, tenantId, reason, root);
    if (changed.length > 0) options.gate?.invalidate();
  };
  return Object.freeze(
    defineModule<typeof tenancyModuleName>({
      name: tenancyModuleName,
      migrations: [tenantStatesMigration, tenantTeardownAttemptsMigration],
      ...(options.gate
        ? {
            start: async () => {
              await options.gate!.start();
            },
            stop: async () => {
              options.gate!.stop();
            },
          }
        : {}),
      reconcilers: [
        {
          name: tenancyWorkKind,
          shardBy: 'none',
          // Every unfinished teardown comes back from here: a module still releasing (SYNC_AGAIN) is asked again
          // on the next sweep, and a lost work item is recovered.
          periodic: [{ key: 'sweep', every: '30s' }],
          async run(context: ReconcileContext, key: string) {
            // IAM reads happen here, outside any transaction; a failure throws and is retried with back-off.
            if (key.startsWith(syncPrefix)) {
              await apply(context, key.slice(syncPrefix.length), 'iam:tenants:sync');
              return 'DONE';
            }
            if (key === 'sweep') {
              // The longest-waiting first, so a thousand stuck teardowns never starve the rest.
              const { rows } = await context.sql.query<{ tenant_id: string }>(
                `SELECT tenant_id FROM compute_tenant_states
                  WHERE state = 'deleted' AND teardown_done_at IS NULL
                  ORDER BY teardown_attempted_at NULLS FIRST, tenant_id LIMIT 1000`,
              );
              if (rows.length)
                await context.sql.transaction(async (tx) => {
                  for (const row of rows)
                    await context.work.enqueue(tx, tenancyWorkKind, row.tenant_id);
                });
              return 'DONE';
            }
            // Someone still releasing ('WAIT'): the next sweep (30 s) asks again, rather than spinning here.
            const outcome = await tearDownTenant(context, key, options.modules(), root);
            return outcome === 'WAIT' ? 'DONE' : outcome;
          },
        },
        {
          // The backstop: the whole tree from the root. Its own reconciler, so a long read never delays syncs and
          // teardowns. Past the reader's size limit it re-reads only the tenants already refused.
          name: tenancyResyncWorkKind,
          shardBy: 'none',
          periodic: [{ key: 'resync', every: '15m' }],
          async run(context: ReconcileContext) {
            if (!options.rootTenantId || !options.reader?.current) return 'DONE';
            try {
              await apply(context, options.rootTenantId, 'iam:tenants:resync');
            } catch (error) {
              if ((error as { code?: unknown }).code !== 'INVALID_STATE') throw error;
              const { rows } = await context.sql.query<{ tenant_id: string }>(
                `SELECT tenant_id FROM compute_tenant_states WHERE state <> 'active'
                  ORDER BY updated_at LIMIT 1000`,
              );
              for (const row of rows) await apply(context, row.tenant_id, 'iam:tenants:resync');
            }
            return 'DONE';
          },
        },
      ],
    }),
  );
}
