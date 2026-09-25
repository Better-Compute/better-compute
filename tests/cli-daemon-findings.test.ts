import { afterEach, describe, expect, it } from 'vitest';
import { createDeployment, unconfiguredIam, type Deployment } from '@better-compute/cli';
import { pglite } from '@better-compute/postgres/pglite';
import { daemonFindings } from '../packages/cli/src/commands/daemon.js';

// doctor's daemon checks: a connected site agent whose Hello lacks site.bmc-networks has no local deny list for
// site.httpProxy ([site] bmc_networks in its own config, which the control plane cannot set).

let deployment: Deployment | undefined;
afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
});

describe('daemon findings', () => {
  it('warns about connected site agents without a BMC network deny list', async () => {
    deployment = createDeployment(
      {
        database: pglite(),
        iam: unconfiguredIam(),
        secret: 'better-compute-daemon-findings-secret-0123456789',
        baseURL: 'http://127.0.0.1:3000',
        rootTenantId: 'root',
      },
      'test',
    );
    await deployment.compute.initialize();
    const sql = deployment.compute.context.sql;
    expect(await daemonFindings(sql)).toEqual([]);
    await sql.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'root', 'shared', 'eu', 1)`);
    const node = async (id: string, role: string, capabilities: string[], connected = true) => {
      await sql.query(
        `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
           trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, 'site_a', 'root', $2, 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
        [id, role],
      );
      await sql.query(
        `INSERT INTO node_sessions (node_id, session_epoch, gateway_id, capabilities, disconnected_at, last_seen)
         VALUES ($1, 1, 'gw', $2, CASE WHEN $3 THEN NULL ELSE compute_now() END, compute_now())`,
        [id, capabilities, connected],
      );
    };
    await node('node_site_ok', 'site', ['site.bmc-networks']);
    await node('node_host', 'host', []);
    await node('node_site_gone', 'site', [], false);
    expect(await daemonFindings(sql)).toEqual([]);
    await node('node_site_open', 'site', ['tunnel.instance-dial']);
    const findings = await daemonFindings(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'daemon.site-bmc-networks', severity: 'warning' });
    expect(findings[0]!.message).toMatch(/1 connected site agent\(s\).*node_site_open/);
    expect(findings[0]!.fix).toMatch(/--bmc-networks/);
  });
});
