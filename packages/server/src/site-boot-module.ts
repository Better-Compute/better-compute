import {
  defineModule,
  type ComputeModule,
  type ModuleContext,
  type NodeRecord,
  type NodeSpec,
  type ReconcileContext,
} from '@better-compute/core';
import { siteBootLeaseName, tickSiteBoot } from './controllers/site-boot.js';

// SiteBoot (PLAN.md §8.5 "Site routing"), hosted: the `site-boot` singleton ticks every site's boot
// lease every 5 s (renew the connected holder, promote the first connected standby once it ran
// out), and on a change invalidates the NodeSpec of the new and the old holder and publishes
// `site.boot`. Every site agent's NodeSpec carries `site.boot = { active, epoch }` from the lease,
// so exactly one agent answers proxyDHCP/iPXE and vouches for discovery at any epoch.

export const siteBootModuleName = 'site-boot';
/** The singleton reconciler and its one periodic key. */
export const siteBootReconciler = { name: 'site-boot', key: 'tick', every: '5s' } as const;

/** One pass over every site that has (or had) a site agent or a boot lease. */
export async function tickSiteBoots(context: ModuleContext): Promise<void> {
  const { rows: sites } = await context.sql.query<{ site_id: string; owner_tenant_id: string }>(
    `SELECT s.id AS site_id, s.owner_tenant_id FROM sites s
      WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.site_id = s.id AND n.role = 'site' AND n.deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM leases l WHERE l.name = 'site:' || s.id || ':boot' AND l.owner IS NOT NULL)
      ORDER BY s.id`,
  );
  for (const site of sites)
    await context.sql.transaction(async (tx) => {
      const state = await tickSiteBoot(tx, site.site_id);
      if (!state.changed) return;
      for (const nodeId of [state.active, state.previous])
        if (nodeId !== undefined) await context.desired.invalidate(tx, nodeId);
      await context.events.publish(tx, {
        type: 'site.boot',
        tenantId: site.owner_tenant_id,
        subject: `site/${site.site_id}`,
        data: {
          siteId: site.site_id,
          active: state.active ?? null,
          previous: state.previous ?? null,
          epoch: state.epoch,
        },
      });
    });
}

/** A site agent's `site.boot` section: whether it holds the live lease, and the lease's epoch. */
export async function siteBootSpec(
  context: Pick<ModuleContext, 'sql'>,
  node: Pick<NodeRecord, 'id' | 'siteId' | 'role'>,
): Promise<Partial<NodeSpec>> {
  if (node.role !== 'site') return {};
  const { rows } = await context.sql.query<{ owner: string | null; epoch: unknown; live: boolean }>(
    `SELECT owner, epoch, expires_at > compute_now() AS live FROM leases WHERE name = $1`,
    [siteBootLeaseName(node.siteId)],
  );
  const lease = rows[0];
  return {
    site: {
      boot: {
        active: lease !== undefined && lease.live && lease.owner === node.id,
        epoch: lease ? Number(lease.epoch) : 0,
      },
    },
  };
}

/** The built-in SiteBoot module. */
export function createSiteBootModule(): ComputeModule<typeof siteBootModuleName> {
  return Object.freeze(
    defineModule<typeof siteBootModuleName>({
      name: siteBootModuleName,
      reconcilers: [
        {
          name: siteBootReconciler.name,
          shardBy: 'none',
          periodic: [{ key: siteBootReconciler.key, every: siteBootReconciler.every }],
          async run(context: ReconcileContext, key: string) {
            if (key === siteBootReconciler.key) await tickSiteBoots(context);
            return 'DONE';
          },
        },
      ],
      nodeSpec: (context, node) => siteBootSpec(context, node),
    }),
  );
}
