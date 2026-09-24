import type { SqlTx } from '@better-compute/core';

// What pki's attestors ask the host about provisioning (PLAN.md §3.3 step 4, §3.6). Hosts wire them:
//
//   provisionedAttestor({ resolveTarget: provisionedTargetResolver() })
//   discoveryAttestor({ resolveWorkflowNode: discoveryWorkflowNodeResolver() })
//
// Both answer only for workflows still running. A token or assertion from a finished (or aborted)
// workflow names no node, so the machine cannot re-key a node that has moved on.

/** Workflow states in which a node is still being provisioned. */
const running = ['pending', 'running', 'paused'] as const;

/** The node a `provisioned` token was minted for, and its product UUID when inventory knows it. */
export interface ProvisionedTargetMatch {
  nodeId?: string;
  productUuid?: string;
}

/**
 * `provisionedAttestor({ resolveTarget })`: finds the running workflow whose `userdata.render`
 * step minted this token (its result's `joinTokenId`), in the token's tenant, and answers with that
 * workflow's node. It adds the node's product UUID from the newest inventory snapshot, if any.
 */
export function provisionedTargetResolver() {
  return async (
    tx: SqlTx,
    token: { id: string; tenantId: string; poolId?: string; siteId?: string },
  ): Promise<ProvisionedTargetMatch | undefined> => {
    const { rows } = await tx.query<{ node_id: string; product_uuid: string | null }>(
      `SELECT w.node_id,
              (SELECT i.sections->'system'->>'productUuid' FROM inventory_snapshots i
                WHERE i.node_id = w.node_id ORDER BY i.collected_at DESC LIMIT 1) AS product_uuid
         FROM workflow_steps s
         JOIN workflows w ON w.id = s.workflow_id
         JOIN nodes n ON n.id = w.node_id
        WHERE s.action = 'userdata.render' AND s.state = 'succeeded'
          AND s.result->>'joinTokenId' = $1
          AND w.state = ANY($2::text[])
          AND n.owner_tenant_id = $3 AND n.deleted_at IS NULL
          AND ($4::text IS NULL OR n.site_id = $4)
        ORDER BY w.id DESC LIMIT 1`,
      [token.id, [...running], token.tenantId, token.siteId ?? null],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { nodeId: row.node_id, ...(row.product_uuid ? { productUuid: row.product_uuid } : {}) };
  };
}

/**
 * `discoveryAttestor({ resolveWorkflowNode })`: the node of a running workflow
 * (`DiscoveryAssertion.workflow_id`), so a known machine re-commissions as itself.
 */
export function discoveryWorkflowNodeResolver() {
  return async (tx: SqlTx, workflowId: string): Promise<string | undefined> => {
    const { rows } = await tx.query<{ node_id: string }>(
      `SELECT w.node_id FROM workflows w JOIN nodes n ON n.id = w.node_id
        WHERE w.id = $1 AND w.state = ANY($2::text[]) AND n.deleted_at IS NULL`,
      [workflowId, [...running]],
    );
    return rows[0]?.node_id;
  };
}
