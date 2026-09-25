import {
  ComputeError,
  defineMethod,
  defineModule,
  field,
  idPrefixes,
  manifest,
  type ComputeModule,
  type InventorySnapshot,
  type Json,
  type MethodDefinition,
  type ReconcileContext,
  type Reconciler,
} from '@better-compute/core';
import type { InventoryChangeType } from './conditions.js';
import { hygieneReconciler } from './hygiene.js';
import { applyInventory, inventoryDiff, inventoryHistory, inventoryWorkKind, latestInventory } from './store.js';

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

/** A page of history: newest first, `limit` (default 20, at most 100) after `cursor`. */
export interface InventoryHistoryInput extends InventoryNodeInput {
  limit?: number;
  cursor?: string;
}

/** Two snapshots to compare, by snapshot id or hash; default: the latest against the one before. */
export interface InventoryDiffInput extends InventoryNodeInput {
  from?: string;
  to?: string;
}

/** The `inventory` API group (§9.2): every method reads `compute:nodes:read` on the node. */
export type InventoryApi = {
  inventory: {
    get: MethodDefinition<InventoryNodeInput, InventorySnapshot>;
    history: MethodDefinition<InventoryHistoryInput, InventoryHistory>;
    diff: MethodDefinition<InventoryDiffInput, InventoryDiff>;
  };
};

const tenantPattern = '^[A-Za-z0-9._:-]{1,128}$';
const nodePattern = `^${idPrefixes.node}_[0-9a-hjkmnp-tv-z]{26,52}$`;
const snapshotRef = field.string({ pattern: '^(inv_[0-9a-hjkmnp-tv-z]{26,52}|[0-9a-f]{64})$' });
const nodeInput = manifest({ tenantId: field.string({ pattern: tenantPattern }), nodeId: field.string({ pattern: nodePattern }) });
const historyInput = manifest({
  tenantId: field.string({ pattern: tenantPattern }),
  nodeId: field.string({ pattern: nodePattern }),
  limit: field.int({ min: 1, max: 100 }).optional(),
  cursor: field.string({ pattern: '^inv_[0-9a-hjkmnp-tv-z]{26,52}$' }).optional(),
});
const diffInput = manifest({
  tenantId: field.string({ pattern: tenantPattern }),
  nodeId: field.string({ pattern: nodePattern }),
  from: snapshotRef.optional(),
  to: snapshotRef.optional(),
});

function readMethod<I extends InventoryNodeInput, O>(
  validate: (input: unknown) => I,
  handler: MethodDefinition<I, O>['handler'],
): MethodDefinition<I, O> {
  return defineMethod<I, O>({
    action: 'compute:nodes:read',
    kind: 'read',
    resource: (input) => ({ type: 'node', id: input.nodeId }),
    validate,
    async handler(context, input) {
      // The node must be the caller's tenant's; the resolver already decided on it, and this keeps
      // an allow rule on another tenant's node id from reading it.
      const owned = await context.sql.query('SELECT 1 FROM nodes WHERE id = $1 AND owner_tenant_id = $2', [
        input.nodeId,
        input.tenantId,
      ]);
      if (!owned.rowCount) throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} has no inventory yet`);
      return handler(context, input);
    },
  });
}

const api: InventoryApi = Object.freeze({
  inventory: Object.freeze({
    get: readMethod<InventoryNodeInput, InventorySnapshot>(
      (input) => nodeInput.parse(input),
      async (context, input) => {
        const snapshot = await latestInventory(context.sql, input.nodeId);
        if (!snapshot) throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} has no inventory yet`);
        return snapshot;
      },
    ),
    history: readMethod<InventoryHistoryInput, InventoryHistory>(
      (input) => historyInput.parse(input) as InventoryHistoryInput,
      (context, input) =>
        inventoryHistory(context.sql, input.nodeId, { limit: input.limit ?? 20, ...(input.cursor ? { cursor: input.cursor } : {}) }),
    ),
    diff: readMethod<InventoryDiffInput, InventoryDiff>(
      (input) => diffInput.parse(input) as InventoryDiffInput,
      (context, input) =>
        inventoryDiff(context.sql, input.nodeId, { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) }),
    ),
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

/** The hygiene sweep with its defaults (DriverMismatch, CertExpiring, DaemonOutdated every 5 min). */
export const inventoryHygieneReconciler: Reconciler = hygieneReconciler();

/**
 * The always-on built-in inventory module; the server registers it before any injected module.
 * Its actions are part of compute's own catalog, so it adds no catalog fragment. `inventory.get`
 * returns the latest snapshot, `history` pages the append-only snapshots and `diff` compares two.
 */
export const inventoryModule: ComputeModule<'inventory', InventoryApi> = Object.freeze(
  defineModule({ name: 'inventory', api: () => api, reconcilers: [inventoryReconciler, inventoryHygieneReconciler] }),
);
