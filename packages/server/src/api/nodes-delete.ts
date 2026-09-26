import { rebuildPoolRollup } from '@better-compute/capacity';
import { ComputeError, defineMethod, type MethodDefinition } from '@better-compute/core';
import { fields, int, notFound, visibleIn } from './common.js';
import { parser, v } from './input.js';

// `nodes.delete` (PLAN.md §9.2, module server, v0.2), decided on `compute-node/{nodeId}` with
// `compute:nodes:delete`. Only a retired node, a cordoned adopted node (no retire workflow there), or
// one that never got past adoption or enrollment, can be deleted, and only with no open allocation. Its capacity rows are released first, in the
// capacity lock order (quota_usage → pools → nodes → devices → node_resources →
// pool_capacity_rollup). Then the node is tombstoned: audit rows, certs, inventory snapshots and
// past allocations keep referencing it. It leaves its pool and the projection (nobody sees it), its
// certs are revoked, and its trusted hardware key and attestor bindings (`node_bindings`) are freed, so
// the machine can join again as a new node.

export interface DeleteNodeInput {
  tenantId: string;
  nodeId: string;
  version?: number;
  reason?: string;
}
export interface DeletedNode {
  nodeId: string;
  /** False when the node was already deleted (a retry). */
  deleted: boolean;
}

export type NodesDeleteApi = {
  nodes: { delete: MethodDefinition<DeleteNodeInput, DeletedNode> };
};

const deleteInput: (input: unknown) => DeleteNodeInput = parser({
  tenantId: fields.tenantId,
  nodeId: fields.nodeId,
  version: v.optional(fields.version),
  reason: v.optional(fields.reason),
});

/** Nodes in these states never carried workloads, or are done for good. */
export const deletableStates = ['retired', 'adopting', 'enrolling'] as const;
const deletableFailures = ['adopting', 'enrolling'] as const;

interface NodeRow {
  id: string;
  pool_id: string | null;
  owner_tenant_id: string;
  provision_state: string;
  failed_from: string | null;
  cordoned: boolean;
  version: unknown;
}

export function nodesDeleteApi(): NodesDeleteApi {
  return {
    nodes: {
      delete: defineMethod<DeleteNodeInput, DeletedNode>({
        action: 'compute:nodes:delete',
        kind: 'mutation',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: deleteInput,
        async handler(context, input) {
          const sql = context.sql;
          // A retry after the delete: the projection row is gone, the tombstone is not.
          const { rows: gone } = await sql.query<{ id: string }>(
            'SELECT id FROM nodes WHERE id = $1 AND owner_tenant_id = $2 AND deleted_at IS NOT NULL',
            [input.nodeId, input.tenantId],
          );
          if (gone[0]) return { nodeId: input.nodeId, deleted: false };

          const read = async (lock: string) =>
            (
              await sql.query<NodeRow>(
                `SELECT n.id, n.pool_id, n.owner_tenant_id, n.provision_state, n.failed_from, n.cordoned, n.version
                   FROM nodes n
                  WHERE n.id = $2 AND n.deleted_at IS NULL AND ${visibleIn('node', 'n.id', '$1')} ${lock}`,
                [input.tenantId, input.nodeId],
              )
            ).rows[0];
          const seen = await read('');
          if (!seen) throw notFound('Node');
          // Lock order: the pool (the placement fence) before the node.
          let pool: { id: string; owner_tenant_id: string } | undefined;
          if (seen.pool_id !== null) {
            const { rows } = await sql.query<{ id: string; owner_tenant_id: string }>(
              'SELECT id, owner_tenant_id FROM pools WHERE id = $1 FOR UPDATE',
              [seen.pool_id],
            );
            pool = rows[0];
          }
          const row = await read('FOR UPDATE OF n');
          if (!row) throw notFound('Node');
          if (row.pool_id !== seen.pool_id)
            throw new ComputeError('CONFLICT', 'The node changed pools meanwhile; try again');
          if (input.version !== undefined && int(row.version) !== input.version)
            throw new ComputeError('CONFLICT', `The node changed (it is at version ${int(row.version)})`, undefined, {
              version: int(row.version),
            });
          const failedEarly =
            row.provision_state === 'failed' &&
            (deletableFailures as readonly string[]).includes(row.failed_from ?? '');
          // An adopted host (bcd installed on a machine metal does not manage) has no retire workflow:
          // it is removed by cordoning it and deleting it once it holds nothing, e.g. after its TPM or
          // disk was replaced, so the machine can join again under a new identity.
          const adoptedCordoned = row.provision_state === 'adopted' && row.cordoned;
          if (
            !(deletableStates as readonly string[]).includes(row.provision_state) &&
            !failedEarly &&
            !adoptedCordoned
          )
            throw new ComputeError(
              'INVALID_STATE',
              row.provision_state === 'adopted'
                ? 'Cordon the adopted node first (nodes.cordon), then delete it once it holds nothing'
                : `Only retired nodes, cordoned adopted nodes, or nodes never adopted or enrolled, can be deleted (this one is ${row.provision_state})`,
              undefined,
              { provisionState: row.provision_state, cordoned: row.cordoned },
            );
          const { rows: open } = await sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM allocations WHERE node_id = $1 AND released_at IS NULL`,
            [row.id],
          );
          if (open[0]!.n)
            throw new ComputeError('INVALID_STATE', 'The node still has open allocations', undefined, {
              allocations: open[0]!.n,
            });

          // Capacity: devices stop being bookable, scalar resources go, the pool's rollup follows.
          await sql.query('UPDATE devices SET bookable = false, healthy = false WHERE node_id = $1', [row.id]);
          await sql.query('DELETE FROM node_resources WHERE node_id = $1', [row.id]);
          await sql.query(
            `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = 'node-deleted'
              WHERE node_id = $1 AND revoked_at IS NULL`,
            [row.id],
          );
          await sql.query('DELETE FROM node_bindings WHERE node_id = $1', [row.id]);
          await sql.query(
            `UPDATE commands SET state = 'cancelled', reason = 'node-deleted', updated_at = compute_now()
              WHERE node_id = $1 AND state = 'pending'`,
            [row.id],
          );
          await sql.query(
            `UPDATE nodes SET deleted_at = compute_now(), pool_id = NULL, cordoned = true,
               hardware_key_trusted = false, identity_gen = identity_gen + 1, version = version + 1
              WHERE id = $1`,
            [row.id],
          );
          if (pool) await rebuildPoolRollup(sql, { id: pool.id, ownerTenantId: pool.owner_tenant_id });

          const { rows: viewers } = await sql.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM authz_projection WHERE type = 'node' AND id = $1`,
            [row.id],
          );
          for (const viewer of viewers)
            await context.authz.remove(sql, { type: 'node', id: row.id, tenantId: viewer.tenant_id });
          await context.events.publish(sql, {
            type: 'node.deleted',
            tenantId: row.owner_tenant_id,
            subject: `node/${row.id}`,
            data: {
              nodeId: row.id,
              poolId: row.pool_id,
              provisionState: row.provision_state,
              ...(input.reason ? { reason: input.reason } : {}),
            },
          });
          return { nodeId: row.id, deleted: true };
        },
      }),
    },
  };
}
