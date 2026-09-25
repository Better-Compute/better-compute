import type { DesiredState, ModuleContext, NodeRecord, NodeSpecPart, SqlTx } from '@better-compute/core';

// What `site.httpProxy` may reach through a site agent (security review 7, HIGH-1): the agentless
// machines of its site (pools with agent 'none': Talos, appliances) and their own addresses, from
// Redfish inspection or the operator (`metal_nodes.addresses`). The site agent refuses a target whose
// host is not one of `target_node_id`'s addresses, so a request can never reach a BMC (a machine's BMC
// host is left out even if it was recorded) or another machine.

/** One reachable machine, as `SiteSpec.proxyTargets` carries it. */
export interface ProxyTarget {
  nodeId: string;
  addresses: string[];
}

const hostOf = (address: string): string => {
  try {
    return new URL(address.includes('://') ? address : `https://${address}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return address.toLowerCase();
  }
};

/** The proxy targets of a site agent, sorted by node (and addresses sorted), so the spec hash is stable. */
export async function siteProxyTargets(tx: Pick<SqlTx, 'query'>, siteAgentId: string): Promise<ProxyTarget[]> {
  const { rows } = await tx.query<{ node_id: string; addresses: string[]; bmc_address: string }>(
    `SELECT m.node_id, m.addresses, m.bmc_address
       FROM nodes agent
       JOIN nodes n ON n.site_id = agent.site_id AND n.deleted_at IS NULL AND n.provision_state <> 'retired'
       JOIN metal_nodes m ON m.node_id = n.id
       JOIN pools p ON p.id = n.pool_id AND p.agent = 'none'
      WHERE agent.id = $1 AND agent.role = 'site' AND cardinality(m.addresses) > 0
      ORDER BY m.node_id`,
    [siteAgentId],
  );
  return rows.flatMap((row) => {
    const bmc = hostOf(row.bmc_address);
    const addresses = [...new Set(row.addresses.map((address) => address.trim().toLowerCase()))].filter((address) => address && address !== bmc).sort();
    return addresses.length > 0 ? [{ nodeId: row.node_id, addresses }] : [];
  });
}

/** `ComputeModule.nodeSpec` for metal: site agents get `site.proxyTargets`. */
export async function metalNodeSpec(context: Pick<ModuleContext, 'sql'>, node: NodeRecord): Promise<NodeSpecPart> {
  if (node.role !== 'site') return {};
  return { site: { proxyTargets: await siteProxyTargets(context.sql, node.id) } };
}

/** Recomputes the specs of a site's agents (a machine's addresses or its agentless pool changed). */
export async function invalidateSiteProxyTargets(tx: SqlTx, desired: DesiredState | undefined, siteId: string): Promise<void> {
  if (!desired) return;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM nodes WHERE site_id = $1 AND role = 'site' AND deleted_at IS NULL ORDER BY id`,
    [siteId],
  );
  for (const row of rows) await desired.invalidate(tx, row.id);
}
