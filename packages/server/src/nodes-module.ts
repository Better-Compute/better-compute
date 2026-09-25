import {
  defineModule,
  type ComputeModule,
  type ModuleContext,
  type ReconcileContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { schedulableSql, wakePendingForNode } from '@better-compute/capacity';
import { reconcileDrain } from './controllers/drain.js';
import { lifecycleIn } from './controllers/lifecycle.js';
import {
  createLivenessState,
  createLivenessSweep,
  livenessIn,
  sweepLiveness,
  type LivenessOptions,
  type LivenessSweep,
} from './controllers/liveness.js';
import {
  drainWorkKind,
  nodeSpecWorkKind,
  nodeWorkKind,
  refreshNodeAuthz,
} from './controllers/node-state.js';
import { reconcileNodeSpec } from './controllers/nodespec.js';

// The built-in node controllers (PLAN.md §3.3, §7.5, §8.4, §11.1), registered before every other
// module. Reconcilers, so `start()` runs them under shard leases and tests step them with
// `compute.jobs.<name>.tick()`:
// - `node` (sharded by node): NodeLifecycle, then the event side of Liveness. The gateway enqueues
//   it on connect, disconnect, settled commands and status; the CommandSweeper on swept commands.
// - `nodespec` (sharded by node): NodeSpec. `ctx.desired.invalidate` and NodeLifecycle enqueue it; a
//   new generation pokes the node's gateway after commit.
// - `drain` (sharded by node): Drain. `nodes.drain` enqueues it.
// - `liveness` (singleton, periodic key `sweep` every 5 s): the Liveness sweep's timed transitions.
// The v0.1 command kinds are the server's built-ins (`builtinCommandKinds`), not registered here.

export const nodesModuleName = 'node-controllers';
/** The Liveness sweep's reconciler name and its one periodic key. */
export const livenessReconciler = { name: 'liveness', key: 'sweep', every: '5s' } as const;

export interface NodesModuleOptions {
  /**
   * Every registered module and plugin, read when NodeSpec runs (their `nodeSpec()` hooks
   * contribute sections). A thunk, because this module is itself in the list.
   */
  modules: () => readonly ComputeModule[];
  liveness?: LivenessOptions;
  /** Runs in the transaction that wrote a node's new spec generation (gateway pokes). */
  specChanged?(tx: SqlTx, nodeId: string, generation: number): Promise<void>;
}

/**
 * The `node` reconciler: NodeLifecycle, then the event side of Liveness (a dead gateway's
 * disconnect, clean-up after a reconnect), then the node's authz projection row (GPU count and
 * lifecycle converge within one level-trigger resync). Timed transitions are the sweep's. With
 * `schedulable` (the nodes this worker last saw schedulable), a node that became schedulable wakes
 * its pool's pending reservations (uncordon, adoption, first converged spec, a cleared NoSchedule
 * reason) instead of leaving them to their back-off.
 */
export async function reconcileNode(
  context: ModuleContext,
  nodeId: string,
  schedulable?: Set<string>,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  // One fenced transaction for the whole pass: a join storm runs this ~4 times per node, and each
  // transaction costs a fence and a round trip on top of its statements.
  const { lifecycle, nowSchedulable } = await context.sql.transaction(async (tx) => {
    const lifecycle = await lifecycleIn(context, tx, nodeId);
    await livenessIn(context, tx, nodeId, { timeouts: false });
    await refreshNodeAuthz(tx, context.authz, nodeId);
    if (!schedulable) return { lifecycle, nowSchedulable: undefined };
    const ok = await isSchedulable(tx, nodeId);
    // The wake commits with the pass; `schedulable` records the edge only once it has.
    if (ok && !schedulable.has(nodeId)) await wakePendingForNode(tx, context.work, nodeId);
    return { lifecycle, nowSchedulable: ok };
  });
  if (schedulable && nowSchedulable !== undefined) {
    if (nowSchedulable) schedulable.add(nodeId);
    else schedulable.delete(nodeId);
  }
  return lifecycle;
}

/** Whether the node is schedulable now (capacity's definition), read in the pass's transaction. */
async function isSchedulable(tx: SqlTx, nodeId: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT (${schedulableSql}) AS ok FROM nodes n JOIN pools p ON p.id = n.pool_id WHERE n.id = $1`,
    [nodeId],
  );
  return rows[0]?.ok === true;
}

/** The built-in node controllers module. */
export function createNodesModule(
  options: NodesModuleOptions,
): ComputeModule<typeof nodesModuleName> {
  // The sweep's memory (heartbeat owner, outage grace) lives as long as the module; each tick runs
  // on the context of the run, whose transactions the singleton lease fences.
  const liveness = createLivenessState();
  // Per worker: a restart forgets it, so the first pass over a schedulable node wakes once more.
  const schedulable = new Set<string>();
  const reconcilers: Reconciler[] = [
    {
      name: nodeWorkKind,
      shardBy: 'node',
      run: (context: ReconcileContext, key: string) => reconcileNode(context, key, schedulable),
    },
    {
      name: nodeSpecWorkKind,
      shardBy: 'node',
      async run(context: ReconcileContext, key: string) {
        await reconcileNodeSpec(
          context,
          key,
          options.modules(),
          options.specChanged ? { changed: options.specChanged } : {},
        );
        return 'DONE';
      },
    },
    {
      name: drainWorkKind,
      shardBy: 'node',
      async run(context: ReconcileContext, key: string) {
        await reconcileDrain(context, key);
        return 'DONE';
      },
    },
    {
      name: livenessReconciler.name,
      shardBy: 'none',
      periodic: [{ key: livenessReconciler.key, every: livenessReconciler.every }],
      async run(context: ReconcileContext, key: string) {
        if (key === livenessReconciler.key)
          await sweepLiveness(context, liveness, options.liveness);
        return 'DONE';
      },
    },
  ];
  return Object.freeze(
    defineModule<typeof nodesModuleName>({ name: nodesModuleName, reconcilers }),
  );
}

/** A standalone Liveness sweep (hosts that schedule it themselves, tests). */
export function nodeControllerJobs(
  context: ModuleContext,
  options: LivenessOptions = {},
): { liveness: LivenessSweep } {
  return { liveness: createLivenessSweep(context, options) };
}
