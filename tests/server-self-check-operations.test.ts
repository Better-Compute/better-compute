import { afterEach, describe, expect, it } from 'vitest';
import { shardOf } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// selfCheck's §14 operations findings: stuck queues, sweeper lag, usage dead letters and backlog,
// gateway headroom, stale heartbeats, daemon protocol skew and certificates about to lapse. Each is a
// warning (selfCheck stays ok), and a quiet deployment reports none of them.

afterEach(closeFixtures);

const NODE = 'node_01k5w00000000000000000ps01';
const operations = (findings: { check: string }[]) =>
  findings
    .map((finding) => finding.check)
    .filter((check) => /^(workers|usage|fleet)\./.test(check))
    .sort();

describe('selfCheck operations findings', () => {
  it('stay quiet on a fresh deployment, then name each problem as a warning', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    const { compute, database, tenants } = fixture;
    expect(operations((await compute.selfCheck()).findings)).toEqual([]);

    await database.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_ps', $1, 'shared', 'eu', 1)`,
      [tenants.root.id],
    );
    await database.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_ps', $1, 'site_ps', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
      [tenants.root.id],
    );
    await database.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
         cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
         next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_ps', 'pool_ps', $2, 'host', 'adopted', false, false, 'connected', 'platform',
         '{}', 1, 1, 1, 1, $3, 1)`,
      [NODE, tenants.root.id, shardOf(NODE)],
    );
    // Connected, silent for 10 minutes, and no certificate at all. (Daemon skew needs a protocol
    // minimum above 1, which this release does not have.)
    await database.query(
      `INSERT INTO node_sessions (node_id, session_epoch, last_seen)
       VALUES ($1, 1, compute_now() - interval '10 minutes')`,
      [NODE],
    );
    await database.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before) VALUES ('node', $1, 0, 1, compute_now() - interval '1 hour')`,
      [NODE],
    );
    await database.query(
      `INSERT INTO gateways (id, region, internal_url, software_version, max_streams, sessions)
       VALUES ('gw_ps', 'eu', 'https://gw.test', '0.1.0', 10, 9)`,
    );
    await database.query(
      `INSERT INTO usage_dead_letters (idempotency_key, tenant_id, event, error_code, error_message)
       VALUES ('cmp:x:0', $1, '{}', 'CONFLICT', 'key reused')`,
      [tenants.root.id],
    );
    const report = await compute.selfCheck();
    expect(operations(report.findings)).toEqual([
      'fleet.cert-expiry',
      'fleet.gateway-headroom',
      'fleet.heartbeats',
      'usage.dead-letters',
      'workers.queue',
    ]);
    expect(report.findings.find((finding) => finding.check === 'workers.queue')).toMatchObject({
      severity: 'warning',
      count: 1,
      message: expect.stringContaining('no worker is alive'),
    });
    // Warnings only: the deployment still counts as ok.
    expect(report.ok).toBe(true);
  });
});
