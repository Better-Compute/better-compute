import {
  defineModule,
  type ComputeModule,
  type ModuleContext,
  type ReconcileContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { reconcileDrain } from './controllers/drain.js';
import { reconcileLifecycle } from './controllers/lifecycle.js';
import {
  createLivenessState,
  createLivenessSweep,
  reconcileLiveness,
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
 * lifecycle converge within one level-trigger resync). Timed transitions are the sweep's.
 */
export async function reconcileNode(
  context: ModuleContext,
  nodeId: string,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  const lifecycle = await reconcileLifecycle(context, nodeId);
  await reconcileLiveness(context, nodeId, { timeouts: false });
  await context.sql.transaction((tx) => refreshNodeAuthz(tx, context.authz, nodeId));
  return lifecycle;
}

/** The built-in node controllers module. */
export function createNodesModule(
  options: NodesModuleOptions,
): ComputeModule<typeof nodesModuleName> {
  // The sweep's memory (heartbeat owner, outage grace) lives as long as the module; each tick runs
  // on the context of the run, whose transactions the singleton lease fences.
  const liveness = createLivenessState();
  const reconcilers: Reconciler[] = [
    {
      name: nodeWorkKind,
      shardBy: 'node',
      run: (context: ReconcileContext, key: string) => reconcileNode(context, key),
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
