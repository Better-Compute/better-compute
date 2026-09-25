import {
  ComputeError,
  defineMethod,
  describedBy,
  fleetResourceId,
  type ComputeModule,
  type Duration,
  type MethodContext,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import { validateFleetConfig, type FleetConfig } from './config.js';
import { schemas } from './schemas.js';
import {
  fleetAppliedMigration,
  fleetDriftReconciler,
  planAs,
  readFleetStatus,
  recordApplied,
  type FleetStatus,
} from './drift.js';
import type { FleetCall, FleetPlan } from './plan.js';
import { exportFleetConfig, fleetNamesMigration, readFleetState } from './state.js';

export interface ExportInput {
  tenantId: string;
}

export interface PlanInput {
  tenantId: string;
  config: FleetConfig;
  /** Delete (archive) what the document no longer lists. Default false. */
  prune?: boolean;
}

export interface ApplyInput extends PlanInput {
  /** The `planHash` of the plan the caller reviewed; apply refuses with `CONFIG_DRIFT` if it moved. */
  planHash?: string;
}

export interface PlanResult extends FleetPlan {
  /** SHA-256 over the canonical call list: pass it to `apply` to apply exactly this plan. */
  planHash: string;
}

export interface ApplyResult {
  plan: PlanResult;
  /** How many calls ran. */
  applied: number;
}

export type FleetApi = {
  fleet: {
    export: MethodDefinition<ExportInput, { config: FleetConfig; missing: string[] }>;
    plan: MethodDefinition<PlanInput, PlanResult>;
    apply: MethodDefinition<ApplyInput, ApplyResult>;
    status: MethodDefinition<ExportInput, FleetStatus>;
  };
};

export interface FleetModuleOptions {
  /** How often `fleet.drift` re-plans every applied document (default 15m). */
  driftEvery?: Duration;
}

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputeError('INVALID_INPUT', 'input must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw new ComputeError('INVALID_INPUT', `${key} is not a known field`);
  if (typeof input.tenantId !== 'string' || !tenantPattern.test(input.tenantId))
    throw new ComputeError('INVALID_INPUT', 'tenantId is invalid');
  return input;
}

function parsePlan(value: unknown, keys: readonly string[]): PlanInput & Record<string, unknown> {
  const input = object(value, keys);
  if (input.prune !== undefined && typeof input.prune !== 'boolean')
    throw new ComputeError('INVALID_INPUT', 'prune must be true or false');
  return {
    ...input,
    tenantId: input.tenantId as string,
    config: validateFleetConfig(input.config),
    prune: (input.prune as boolean | undefined) ?? false,
  };
}

const drift = (message: string) => new ComputeError('CONFIG_DRIFT', message);

// Creates run as this caller, so their draft ids derive from this caller's identity.
const plan = (context: MethodContext, tx: SqlTx, input: PlanInput): Promise<PlanResult> =>
  planAs(tx, input.tenantId, context.caller?.identityId, input.config, input.prune ?? false);

async function recordNames(
  tx: SqlTx,
  tenantId: string,
  call: FleetCall,
  result: unknown,
): Promise<void> {
  if (call.names) {
    const returned = (result as { id?: unknown } | null)?.id;
    const id = typeof returned === 'string' ? returned : call.names.id;
    await tx.query(
      `INSERT INTO fleet_names (tenant_id, kind, name, object_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, kind, name) DO UPDATE SET object_id = EXCLUDED.object_id, updated_at = compute_now()`,
      [tenantId, call.names.kind, call.names.name, id],
    );
  }
  if (call.forgets)
    await tx.query(
      'DELETE FROM fleet_names WHERE tenant_id = $1 AND kind = $2 AND object_id = $3',
      [tenantId, call.forgets.kind, call.forgets.id],
    );
}

/**
 * The fleet module (PLAN.md §9.2 `fleet`): FleetConfig as code. `export` writes the tenant's sites,
 * provider accounts, pools, owner quotas, offers and flavors as a document; `plan` diffs a document
 * against them; `apply` runs the plan through the owning modules' own methods, each decided for the
 * caller (`ctx.check`, no transaction open) and then run in one transaction (`ctx.invoke`), after
 * re-planning inside it: if the state moved in between, nothing is applied (`CONFIG_DRIFT`).
 * The applied document is kept; `fleet.status` and the `fleet.drift` reconciler report when the
 * fleet no longer matches it (events `fleet.drifted` / `fleet.converged`).
 */
export function fleetModule(options: FleetModuleOptions = {}): ComputeModule<'fleet', FleetApi> {
  const resource = () => ({ type: 'fleet', id: fleetResourceId });
  const api = (): FleetApi => ({
    fleet: {
      export: defineMethod<ExportInput, { config: FleetConfig; missing: string[] }>({
        action: 'compute:fleet:admin',
        kind: 'read',
        resource,
        validate: describedBy(schemas.tenant, (value) => ({
          tenantId: object(value, ['tenantId']).tenantId as string,
        })),
        async handler(context, input) {
          const state = await readFleetState(context.sql as SqlTx, input.tenantId);
          return { config: exportFleetConfig(state), missing: state.missing };
        },
      }),
      plan: defineMethod<PlanInput, PlanResult>({
        action: 'compute:fleet:admin',
        kind: 'read',
        resource,
        validate: describedBy(schemas.plan, (value) =>
          parsePlan(value, ['tenantId', 'config', 'prune']),
        ),
        handler: (context, input) => plan(context, context.sql as SqlTx, input),
      }),
      apply: defineMethod<ApplyInput, ApplyResult>({
        action: 'compute:fleet:admin',
        kind: 'mutation',
        resource,
        transaction: 'manual',
        validate: describedBy(schemas.apply, (value) => {
          const input = parsePlan(value, ['tenantId', 'config', 'prune', 'planHash']);
          if (
            input.planHash !== undefined &&
            (typeof input.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.planHash))
          )
            throw new ComputeError('INVALID_INPUT', 'planHash must be a SHA-256 hex digest');
          return input as ApplyInput;
        }),
        async handler(context, input) {
          if (!context.check || !context.invoke)
            throw new ComputeError(
              'UNSUPPORTED',
              'fleet.apply needs a host with composite methods (check/invoke)',
            );
          const first = await context.sql.transaction((tx) => plan(context, tx, input));
          if (first.blocked)
            throw new ComputeError(
              'INVALID_STATE',
              'The plan has changes that cannot be applied',
              undefined,
              {
                blocked: first.changes.filter((change) => change.blocked),
              },
            );
          if (input.planHash !== undefined && input.planHash !== first.planHash)
            throw drift('The fleet changed since the plan was made; plan again');
          const applied = {
            tenantId: input.tenantId,
            config: input.config,
            prune: input.prune ?? false,
            planHash: first.planHash,
            identityId: context.caller!.identityId,
          };
          if (!first.calls.length) {
            // Nothing to change: the document still becomes the one drift is checked against.
            await context.sql.transaction((tx) => recordApplied(tx, applied));
            return { plan: first, applied: 0 };
          }

          // Phase 1: one decision per call, as the caller, with no transaction open.
          for (const call of first.calls) await context.check(call.path, call.input);

          // Phase 2: re-plan and run everything in one transaction.
          const invoke = context.invoke.bind(context);
          await context.sql.transaction(async (tx) => {
            const second = await plan(context, tx, input);
            if (second.planHash !== first.planHash)
              throw drift('The fleet changed while the plan was being authorized; plan again');
            for (const call of second.calls) {
              const result = await invoke(tx, call.path, call.input);
              await recordNames(tx, input.tenantId, call, result);
            }
            await recordApplied(tx, applied);
          });
          return { plan: first, applied: first.calls.length };
        },
      }),
      status: defineMethod<ExportInput, FleetStatus>({
        action: 'compute:fleet:admin',
        kind: 'read',
        resource,
        validate: describedBy(schemas.tenant, (value) => ({
          tenantId: object(value, ['tenantId']).tenantId as string,
        })),
        handler: (context, input) => readFleetStatus(context.sql as SqlTx, input.tenantId),
      }),
    },
  });
  return {
    name: 'fleet',
    migrations: [fleetNamesMigration, fleetAppliedMigration],
    api,
    reconcilers: [fleetDriftReconciler(options.driftEvery ? { every: options.driftEvery } : {})],
  };
}
