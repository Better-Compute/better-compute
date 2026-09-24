import {
  ComputeError,
  defineMethod,
  defineModule,
  field,
  idPrefixes,
  manifest,
  notImplemented,
  type ComputeModule,
  type InventorySnapshot,
  type Json,
  type MethodDefinition,
  type Phase,
  type ReconcileContext,
  type Reconciler,
} from '@better-compute/core';
import type { InventoryChangeType } from './conditions.js';
import { applyInventory, inventoryWorkKind, latestInventory } from './store.js';

/** Addresses one node's inventory. `tenantId` scopes the call (the §3.4 tenant pre-check). */
export interface InventoryNodeInput {
  tenantId: string;
  nodeId: string;
}

/** A page of a node's append-only snapshot history, newest first. */
export interface InventoryHistory {
  items: InventorySnapshot[];
  cursor?: string;
}

/** One difference between two snapshots. */
export interface InventoryChange {
  type: InventoryChangeType;
  /** The stable device id: GPU UUID, disk WWN or MAC. */
  deviceId?: string;
  before?: Json;
  after?: Json;
}

/** What changed between two snapshots of a node, identified by their hashes. */
export interface InventoryDiff {
  nodeId: string;
  from: string;
  to: string;
  changes: InventoryChange[];
}

/** The `inventory` API group (§9.2): every method reads `compute:nodes:read` on the node. */
export type InventoryApi = {
  inventory: {
    get: MethodDefinition<InventoryNodeInput, InventorySnapshot>;
    history: MethodDefinition<InventoryNodeInput, InventoryHistory>;
    diff: MethodDefinition<InventoryNodeInput, InventoryDiff>;
  };
};

const nodeInput = manifest({
  tenantId: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
  nodeId: field.string({ pattern: `^${idPrefixes.node}_[0-9a-hjkmnp-tv-z]{26,52}$` }),
});

function readMethod<O>(
  method: string,
  phase: Phase,
  handler?: MethodDefinition<InventoryNodeInput, O>['handler'],
): MethodDefinition<InventoryNodeInput, O> {
  return defineMethod<InventoryNodeInput, O>({
    action: 'compute:nodes:read',
    kind: 'read',
    resource: (input) => ({ type: 'node', id: input.nodeId }),
    validate: (input) => nodeInput.parse(input),
    handler:
      handler ??
      (async () => {
        throw notImplemented(`inventory.${method}`, phase);
      }),
  });
}

const api: InventoryApi = Object.freeze({
  inventory: Object.freeze({
    get: readMethod<InventorySnapshot>('get', 'v0.1', async (context, input) => {
      // The node must be the caller's tenant's; the resolver already decided on it, and this keeps
      // an allow rule on another tenant's node id from reading it.
      const owned = await context.sql.query(
        'SELECT 1 FROM nodes WHERE id = $1 AND owner_tenant_id = $2',
        [input.nodeId, input.tenantId],
      );
      const snapshot = owned.rowCount ? await latestInventory(context.sql, input.nodeId) : undefined;
      if (!snapshot)
        throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} has no inventory yet`);
      return snapshot;
    }),
    history: readMethod<InventoryHistory>('history', 'v0.2'),
    diff: readMethod<InventoryDiff>('diff', 'v0.2'),
  }),
});

/**
 * The Inventory reconciler (§8.4, sharded by node): applies a node's complete, changed section set.
 * An incomplete set is not retried here: the ingest of the missing section enqueues the node again.
 */
export const inventoryReconciler: Reconciler = Object.freeze({
  name: inventoryWorkKind,
  shardBy: 'node' as const,
  async run(context: ReconcileContext, nodeId: string): Promise<'DONE' | 'SYNC_AGAIN'> {
    try {
      await applyInventory(context.sql, nodeId, { events: context.events, work: context.work });
    } catch (error) {
      // A node deleted after its work was queued has nothing left to reconcile.
      if (error instanceof ComputeError && error.code === 'NOT_FOUND') return 'DONE';
      throw error;
    }
    return 'DONE';
  },
});

/**
 * The always-on built-in inventory module; the server registers it before any injected module.
 * Its actions are part of compute's own catalog, so it adds no catalog fragment. `inventory.get`
 * returns the latest snapshot; `history` and `diff` arrive in v0.2 and throw `NOT_IMPLEMENTED`.
 */
export const inventoryModule: ComputeModule<'inventory', InventoryApi> = Object.freeze(
  defineModule({ name: 'inventory', api: () => api, reconcilers: [inventoryReconciler] }),
);
