import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DesiredState, EventPublisher, SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  advanceWorkflow,
  bcdHostIgnition,
  defineProfile,
  hostSpecFor,
  provisionMigrations,
  provisionModule,
  renderTemplate,
  resolveHostConfig,
  startWorkflow,
} from '@better-compute/provision';

// Config units (PLAN.md §11.2): hostConfig → the NodeSpec host section, and the Ignition renderer.

describe('resolveHostConfig', () => {
  const labels = { nvswitch: 'true', 'gpu.model': 'H100' };

  it('validates each unit, applies defaults, and drops units whose when: is false', async () => {
    const host = await resolveHostConfig(
      {
        'nvidia-driver': { branch: '580' },
        'container-toolkit': {},
        'fabric-manager': { when: 'nvswitch' },
        sysctl: { 'vm.max_map_count': 262144 },
      },
      { labels },
    );
    expect(host).toEqual({
      config: {
        'nvidia-driver': { branch: '580' },
        'container-toolkit': { cdi: true },
        'fabric-manager': {},
        sysctl: { 'vm.max_map_count': 262144 },
      },
    });
    const noSwitch = await resolveHostConfig({ 'fabric-manager': { when: 'nvswitch' } }, { labels: {} });
    expect(noSwitch).toEqual({});
  });

  it("fills a MIG layout from the pool, and refuses what it cannot resolve", async () => {
    expect(await resolveHostConfig({ 'mig-layout': { from: 'pool' } }, { labels, poolPolicy: { migLayout: 'all-3g.40gb' } })).toEqual({
      config: { 'mig-layout': { from: 'pool', layout: 'all-3g.40gb' } },
    });
    await expect(resolveHostConfig({ 'mig-layout': { from: 'pool' } }, { labels, poolPolicy: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(resolveHostConfig({ 'nvidia-driver': { branch: 'latest' } }, { labels })).rejects.toThrow(/nvidia-driver/);
    await expect(resolveHostConfig({ 'kernel-module': {} }, { labels })).rejects.toThrow(/not a known config unit/);
    await expect(resolveHostConfig({ sysctl: { 'Bad Key': 1 } }, { labels })).rejects.toThrow(/sysctl/);
  });
});

describe('hostConfig as desired state', () => {
  let db: SqlExecutor;
  const invalidated: string[] = [];
  const desired: DesiredState = { async invalidate(_tx, nodeId) { invalidated.push(nodeId); } };
  const work: WorkQueue = { async enqueue() {} };
  const events: EventPublisher = { async publish() {} };
  const adopt = defineProfile({
    id: 'adopt-existing',
    version: 1,
    target: 'metal',
    entry: 'adopt',
    hostConfig: { 'container-toolkit': { cdi: true }, 'nvidia-driver': { branch: '580' } },
    acceptance: [{ use: 'wait.generationObserved' }],
  });
  const provision = provisionModule({ profiles: [adopt] });

  beforeAll(async () => {
    db = pglite();
    await db.migrate(provisionMigrations);
    await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('s', 't', 'shared', 'eu', 1)`);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_cfg', 's', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    );
  });
  afterAll(() => db.close());

  it('serves the last succeeded workflow hostConfig as the host section, and invalidates the spec', async () => {
    expect(await hostSpecFor(db, 'node_cfg')).toEqual({});
    const context = { sql: db, work, events, desired, commands: { async enqueue() { return { id: 'x', seq: 0 }; }, async cancel() {} } };
    const { id } = await db.transaction((tx) =>
      startWorkflow(context, provision.engineOptions, tx, { tenantId: 't', profileId: 'adopt-existing', profileVersion: 1, nodeId: 'node_cfg' }),
    );
    expect((await advanceWorkflow(context, provision.engineOptions, id)).done).toBe(true);
    expect(invalidated).toEqual(['node_cfg']);
    expect(await provision.nodeSpec!({ sql: db } as never, { id: 'node_cfg' } as never)).toEqual({
      host: { config: { 'container-toolkit': { cdi: true }, 'nvidia-driver': { branch: '580' } } },
    });
  });

  it("keeps a node at its frozen MIG layout until capacity grants the pool's new one (§10.4)", async () => {
    const mig = defineProfile({
      id: 'mig-host',
      version: 1,
      target: 'metal',
      entry: 'adopt',
      hostConfig: { 'mig-layout': { from: 'pool' } },
      acceptance: [{ use: 'wait.generationObserved' }],
    });
    const withMig = provisionModule({ profiles: [mig] });
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
       VALUES ('pool_mig', 't', 's', 'metal-host', 'exclusive', 'bcd', '{"migLayout":"all-1g.10gb"}', 1)`,
    );
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_mig', 's', 'pool_mig', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    );
    const context = { sql: db, work, events, desired, commands: { async enqueue() { return { id: 'x', seq: 0 }; }, async cancel() {} } };
    const { id } = await db.transaction((tx) =>
      startWorkflow(context, withMig.engineOptions, tx, { tenantId: 't', profileId: 'mig-host', profileVersion: 1, nodeId: 'node_mig' }),
    );
    await advanceWorkflow(context, withMig.engineOptions, id);
    const layout = async () => ((await hostSpecFor(db, 'node_mig')).host?.config?.['mig-layout'] as { layout?: string } | undefined)?.layout;
    // Without capacity installed (no capacity_mig_layouts), the pool's layout applies.
    expect(await layout()).toBe('all-1g.10gb');
    // capacity/0004's table: the pool moved to 3g, but the node is frozen at 1g until its atoms are free.
    await db.query(`CREATE TABLE capacity_mig_layouts (node_id text PRIMARY KEY, layout text NOT NULL)`);
    await db.query(`UPDATE pools SET policy = '{"migLayout":"all-3g.40gb"}' WHERE id = 'pool_mig'`);
    await db.query(`INSERT INTO capacity_mig_layouts (node_id, layout) VALUES ('node_mig', 'all-1g.10gb')`);
    expect(await layout()).toBe('all-1g.10gb');
    // Granted: capacity sets the frozen layout to the new one; then drops the row once converged.
    await db.query(`UPDATE capacity_mig_layouts SET layout = 'all-3g.40gb' WHERE node_id = 'node_mig'`);
    expect(await layout()).toBe('all-3g.40gb');
    await db.query(`DELETE FROM capacity_mig_layouts`);
    expect(await layout()).toBe('all-3g.40gb');
    await db.query(`DROP TABLE capacity_mig_layouts`);
  });
});

describe('Ignition', () => {
  it('renders valid JSON that pins the bcd download and keeps values as data', () => {
    const rendered = renderTemplate(bcdHostIgnition, {
      nodeId: 'node_1',
      hostname: 'node-1',
      joinToken: 'tok"en',
      controlPlaneUrl: 'https://gw',
      bcdUrl: 'https://dl/bcd',
      bcdSha256: 'ab'.repeat(32),
    });
    const config = JSON.parse(rendered);
    expect(config.ignition.version).toBe('3.4.0');
    const files = Object.fromEntries(config.storage.files.map((f: { path: string }) => [f.path, f]));
    expect(files['/etc/bcd/join-token']).toMatchObject({ mode: 0o600, contents: { source: 'data:,tok%22en' } });
    expect(files['/usr/local/bin/bcd'].contents.verification.hash).toBe(`sha256-${'ab'.repeat(32)}`);
    expect(config.systemd.units[0].contents).toContain('--node-id node_1');
  });
});
