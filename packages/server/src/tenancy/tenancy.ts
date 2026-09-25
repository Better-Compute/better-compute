// Tenancy (PLAN.md §12.8 `iam:tenants:update|delete` → "suspend admissions; schedule teardown and purge"), hosted:
// - `compute_tenant_states` mirrors the IAM tenants that are not active (suspended or deleted), written by the IAM
//   bridge's `tenant` handler (`tenantStateHandler`), which re-reads the tenant's subtree from IAM (a suspension or
//   deletion cascades to descendants, and the audit event names only the tenant acted on);
// - the envelope's gate (`createTenantGate`) refuses a suspended tenant's mutations and everything of a deleted
//   tenant, root callers exempt, with `TENANT_SUSPENDED`;
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
/** The teardown reconciler's work kind (key: the tenant id; periodic key `sweep`). */
export const tenancyWorkKind = 'tenancy';

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
   * (anything). Root callers are exempt (they manage suspended tenants). Memory only, so a refusal costs no SQL,
   * except right after `invalidate()` (this process changed a state), when it reloads first.
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

export function createTenantGate(options: TenantGateOptions): TenantGate {
  let states = new Map<string, TenantState>();
  let stale = false;
  let loading: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const load = (): Promise<void> => {
    loading ??= (async () => {
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
        stale = false;
      } catch (error) {
        // Before the tenancy migration ran (a store migrating right now): nobody is suspended yet.
        if (!undefinedTable(error)) throw error;
        states = new Map();
        stale = false;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  };

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // A broken reporter changes nothing.
    }
  };

  return {
    load,
    async start() {
      // A store that cannot answer yet does not stop the server from starting: the states stay stale, so
      // the first call reloads them (and fails like any other statement while the store is down).
      await load().catch((error: unknown) => {
        stale = true;
        report(error);
      });
      if (timer) return;
      timer = setInterval(() => {
        load().catch(report);
      }, options.refreshMs ?? 5_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async check(caller, tenantIds, mutation) {
      if (caller.tenantId === options.rootTenantId) return;
      if (stale) await load();
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
      stale = true;
    },
  };
}

// --- The IAM event handler ----------------------------------------------------------------------------------

/** One tenant as IAM reports it. `missing`: IAM no longer knows it (purged). */
export interface IamTenantStatus {
  tenantId: string;
  status: 'active' | 'pending' | 'suspended' | 'deleted' | 'missing';
}

export interface TenantStateHandlerOptions {
  /**
   * Reads the tenant and every tenant below it from IAM (level-triggered, §12.8): a suspension or deletion cascades
   * to descendants, and the audit event names only the tenant acted on. Without it, only `iam:tenants:delete` is
   * applied, to the named tenant alone.
   */
  readTenants?(tenantId: string): Promise<readonly IamTenantStatus[]>;
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
 * Applies tenant states in the inbox transaction; returns the tenants whose state changed. A deletion enqueues the
 * teardown. Replays change nothing.
 */
export async function applyTenantStates(
  tx: SqlTx,
  context: Pick<ModuleContext, 'work' | 'events'>,
  statuses: readonly IamTenantStatus[],
  reason: string,
): Promise<{ tenantId: string; state: TenantState }[]> {
  const changed: { tenantId: string; state: TenantState }[] = [];
  for (const status of statuses) {
    const state = stateOf(status.status);
    const { rows } = await tx.query<{ state: TenantState }>(
      'SELECT state FROM compute_tenant_states WHERE tenant_id = $1 FOR UPDATE',
      [status.tenantId],
    );
    const previous: TenantState = rows[0]?.state ?? 'active';
    // Unchanged (an active tenant without a row is active too).
    if (previous === state) continue;
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
  compute: { context: Pick<ModuleContext, 'work' | 'events'>; tenants?: { invalidate(): void } },
  options: TenantStateHandlerOptions = {},
): (tx: SqlTx, event: TenantEventLike) => Promise<void> {
  return async (tx, event) => {
    if (event.action !== 'iam:tenants:update' && event.action !== 'iam:tenants:delete') return;
    const tenantId = event.subjectId || event.tenantId;
    if (!tenantId) return;
    const statuses: readonly IamTenantStatus[] = options.readTenants
      ? await options.readTenants(tenantId)
      : event.action === 'iam:tenants:delete'
        ? [{ tenantId, status: 'deleted' }]
        : [];
    const changed = await applyTenantStates(tx, compute.context, statuses, event.action);
    // This process reloads the gate before its next call; others within the gate's refresh (5 s).
    if (changed.length > 0) compute.tenants?.invalidate();
  };
}

// --- Teardown ------------------------------------------------------------------------------------------------

/** One teardown pass for a deleted tenant: every module's hook, then the record. */
export async function tearDownTenant(
  context: ReconcileContext,
  tenantId: string,
  modules: readonly ComputeModule[],
): Promise<'DONE' | 'SYNC_AGAIN' | 'WAIT'> {
  const { rows } = await context.sql.query<{ state: TenantState; done: boolean }>(
    `SELECT state, teardown_done_at IS NOT NULL AS done FROM compute_tenant_states WHERE tenant_id = $1`,
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
  gate?: Pick<TenantGate, 'start' | 'stop'>;
}): ComputeModule<typeof tenancyModuleName> {
  return Object.freeze(
    defineModule<typeof tenancyModuleName>({
      name: tenancyModuleName,
      migrations: [tenantStatesMigration],
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
            if (key === 'sweep') {
              const { rows } = await context.sql.query<{ tenant_id: string }>(
                `SELECT tenant_id FROM compute_tenant_states
                  WHERE state = 'deleted' AND teardown_done_at IS NULL ORDER BY tenant_id LIMIT 1000`,
              );
              if (rows.length)
                await context.sql.transaction(async (tx) => {
                  for (const row of rows)
                    await context.work.enqueue(tx, tenancyWorkKind, row.tenant_id);
                });
              return 'DONE';
            }
            // Someone still releasing ('WAIT'): the next sweep (30 s) asks again, rather than spinning here.
            const outcome = await tearDownTenant(context, key, options.modules());
            return outcome === 'WAIT' ? 'DONE' : outcome;
          },
        },
      ],
    }),
  );
}
