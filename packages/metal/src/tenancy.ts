import { provisionStateTable, type ModuleContext, type ProvisionState, type ProvisionVerb } from '@better-compute/core';
import { metalWorkKind } from './reconcile.js';
import { applyProvisionVerb, readMetalNode, setMetalWorkflow } from './store.js';

// A deleted tenant's machines (the server's tenancy teardown): every bare-metal node the tenant
// owns ends up `retired` (crypto-erase, identity revoked, BMC credentials forgotten), one legal
// transition per sweep:
// - where `retire` is allowed (ready, adopted, enrolling, failed), it retires;
// - a deployed or rescued machine is released first (wiped), then retired once ready;
// - a machine mid-workflow (inspecting, commissioning, deploying) is aborted (it fails with
//   maintenance on), then retired;
// - releasing and retiring machines are left to finish.
// A dedicated-root lease the tenant held is capacity's to release (capacityTenantDeleted).

const allowed = (state: ProvisionState, verb: ProvisionVerb) =>
  Boolean((provisionStateTable.transitions[state] as Partial<Record<ProvisionVerb, unknown>> | undefined)?.[verb]);

export interface MetalTenantTeardown {
  retiring: number;
  releasing: number;
  aborted: number;
  /** Machines not yet retired after this pass. */
  remaining: number;
}

export async function teardownTenantMetal(
  context: Pick<ModuleContext, 'sql' | 'work' | 'events'> & Partial<Pick<ModuleContext, 'workflows'>>,
  tenantId: string,
  options: { limit?: number } = {},
): Promise<MetalTenantTeardown> {
  const result: MetalTenantTeardown = { retiring: 0, releasing: 0, aborted: 0, remaining: 0 };
  const { rows } = await context.sql.query<{ node_id: string }>(
    `SELECT m.node_id FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.owner_tenant_id = $1 AND n.provision_state <> 'retired' AND n.deleted_at IS NULL
      ORDER BY m.node_id LIMIT $2`,
    [tenantId, options.limit ?? 100],
  );
  for (const { node_id: nodeId } of rows) {
    await context.sql.transaction(async (tx) => {
      const node = await readMetalNode(tx, nodeId, { lock: true });
      const from = node.provision_state;
      let verb: ProvisionVerb | undefined;
      if (allowed(from, 'retire')) verb = 'retire';
      else if (allowed(from, 'release') && from !== 'releasing') verb = 'release';
      else if (allowed(from, 'abort') && from !== 'releasing') verb = 'abort';
      if (!verb) return; // releasing or retiring: its workflow finishes first
      if (verb === 'abort' && node.workflow_id && context.workflows) await context.workflows.abort(tx, node.workflow_id);
      const to = await applyProvisionVerb(tx, node, verb, verb === 'abort' ? { error: { code: 'TENANT_DELETED', message: 'the owning tenant was deleted' } } : {});
      await setMetalWorkflow(tx, nodeId, null, null);
      await context.work.enqueue(tx, metalWorkKind, nodeId);
      await context.events.publish(tx, {
        type: `node.provision.${to}`,
        tenantId,
        subject: `node/${nodeId}`,
        data: { nodeId, from, verb, reason: 'tenant deleted' },
      });
      if (verb === 'retire') result.retiring++;
      else if (verb === 'release') result.releasing++;
      else result.aborted++;
    });
  }
  const { rows: left } = await context.sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.owner_tenant_id = $1 AND n.provision_state <> 'retired' AND n.deleted_at IS NULL`,
    [tenantId],
  );
  result.remaining = Number(left[0]?.n ?? 0);
  return result;
}
