import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DesiredState, EventPublisher, SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  advanceWorkflow,
  bcdHostIgnition,
  defineProfile,
  hostSpecFor,
  poolHostConfig,
  provisionMigrations,
  provisionModule,
  renderTemplate,
  resolveHostConfig,
  startWorkflow,
  validatePoolHostPolicy,
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

describe('hugepages, kernel-modules and k8s-join (PLAN.md §3.8)', () => {
  const token = 'secret://tenant-root/k8s-bootstrap';
  const join = { server: 'https://k8s.example:6443', caCertSha256: `sha256:${'AB'.repeat(32)}`, tokenRef: token };

  it('validates hugepages and normalizes kernel modules', async () => {
    expect(await resolveHostConfig({ hugepages: { pages2m: 4096, pages1g: 16, transparent: 'madvise' } }, { labels: {} })).toEqual({
      config: { hugepages: { pages2m: 4096, pages1g: 16, transparent: 'madvise' } },
    });
    await expect(resolveHostConfig({ hugepages: { pages1g: -1 } }, { labels: {} })).rejects.toThrow(/hugepages/);
    await expect(resolveHostConfig({ hugepages: { transparent: 'sometimes' } }, { labels: {} })).rejects.toThrow(/hugepages/);
    expect(
      await resolveHostConfig(
        { 'kernel-modules': { load: ['vhost_net', 'kvm_intel', 'tun', 'tun'], options: { kvm_intel: 'nested=1' } } },
        { labels: {} },
      ),
    ).toEqual({ config: { 'kernel-modules': { load: ['kvm_intel', 'tun', 'vhost_net'], options: { kvm_intel: 'nested=1' } } } });
    await expect(resolveHostConfig({ 'kernel-modules': { load: ['../evil'] } }, { labels: {} })).rejects.toThrow(/module name/);
    await expect(resolveHostConfig({ 'kernel-modules': { options: { kvm: 'a=1; reboot' } } }, { labels: {} })).rejects.toThrow(/options/);
  });

  it('validates k8s-join: an https server, the CA pin, the token by reference, labels and taints', async () => {
    expect(
      await resolveHostConfig(
        { 'k8s-join': { ...join, nodeLabels: { 'bc.dev/pool': 'h100', tier: 'gpu' }, taints: ['nvidia.com/gpu=present:NoSchedule'], kubernetesVersion: '1.34.1' } },
        { labels: {} },
      ),
    ).toEqual({
      config: {
        'k8s-join': {
          server: 'https://k8s.example:6443',
          caCertSha256: 'ab'.repeat(32),
          tokenRef: token,
          gpu: true,
          kubernetesVersion: '1.34.1',
          nodeLabels: { 'bc.dev/pool': 'h100', tier: 'gpu' },
          taints: ['nvidia.com/gpu=present:NoSchedule'],
        },
      },
    });
    const refused = async (patch: Record<string, unknown>, pattern: RegExp) =>
      expect(resolveHostConfig({ 'k8s-join': { ...join, ...patch } as never }, { labels: {} })).rejects.toThrow(pattern);
    await refused({ server: 'http://k8s.example:6443' }, /server/);
    await refused({ server: 'https://user:pw@k8s.example' }, /server/);
    await refused({ caCertSha256: 'abc' }, /caCertSha256/);
    // A bootstrap token itself, never a reference: refused, it would sit in every signed spec.
    await refused({ tokenRef: 'abcdef.0123456789abcdef' }, /tokenRef/);
    await refused({ nodeLabels: { 'node-role.kubernetes.io/worker': '' } }, /reserved/);
    await refused({ nodeLabels: { tier: 'has space' } }, /label value/);
    await refused({ taints: ['gpu:Sometimes'] }, /NoSchedule/);
    await refused({ kubeconfig: '...' }, /not a setting/);
  });

  it('refuses sysctls that run programs as root or lower host defenses, as bcd does', async () => {
    for (const key of ['kernel.core_pattern', 'kernel.usermodehelper.bset', 'fs.protected_symlinks', 'user.max_user_namespaces', 'kernel.yama.ptrace_scope'])
      await expect(resolveHostConfig({ sysctl: { [key]: '0' } }, { labels: {} })).rejects.toThrow(/not settable/);
    expect(await resolveHostConfig({ sysctl: { 'vm.swappiness': 10, 'net.core.somaxconn': 4096 } }, { labels: {} })).toEqual({
      config: { sysctl: { 'vm.swappiness': 10, 'net.core.somaxconn': 4096 } },
    });
  });

  it("renders gpu-sharing from a shared pool's mode, with default replicas", () => {
    expect(poolHostConfig({}, 'mps')['gpu-sharing']).toEqual({ mode: 'mps', replicas: 10 });
    expect(poolHostConfig({ sharing: { replicas: 8 } }, 'timeslice')['gpu-sharing']).toEqual({ mode: 'timeslice', replicas: 8 });
    expect(poolHostConfig({}, 'timeslice')['gpu-sharing']).toEqual({ mode: 'timeslice', replicas: 4 });
    expect(poolHostConfig({}, 'exclusive')['gpu-sharing']).toBeUndefined();
    expect(poolHostConfig({}, 'mig')['gpu-sharing']).toBeUndefined();
  });

  it('never joins a hosted pool (bcd as a DaemonSet inside the cluster already)', async () => {
    expect(poolHostConfig({ kubernetes: { platformOperated: true } })).toEqual({});
    await expect(validatePoolHostPolicy({ kubernetes: { platformOperated: 'yes' } })).rejects.toThrow(/platformOperated/);
    // All three join settings, or none.
    await expect(validatePoolHostPolicy({ kubernetes: { apiServer: 'https://k8s.example:6443' } })).rejects.toThrow(/together/);
  });

  it("renders a pool's policy into units that win over the profile's", async () => {
    const db = pglite();
    try {
      await db.migrate(provisionMigrations);
      await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('s', 't', 'shared', 'eu', 1)`);
      const policy = {
        kubernetes: { apiServer: 'https://k8s.example:6443', caCertSha256: 'cd'.repeat(32), joinTokenRef: token, labels: { tier: 'gpu' } },
        hugepages: { size: '1Gi', count: 8, perNuma: true },
        kernelModules: { load: ['vhost_net'] },
      };
      await db.query(
        `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
         VALUES ('pool_k8s', 't', 's', 'metal-host', 'exclusive', 'bcd', $1::jsonb, 1)`,
        [JSON.stringify(policy)],
      );
      // An adopted node no workflow ran on still gets the pool's units.
      await db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
           generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ('node_k8s', 's', 'pool_k8s', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      );
      expect(await hostSpecFor(db, 'node_k8s')).toEqual({
        host: {
          config: {
            'k8s-join': { server: 'https://k8s.example:6443', caCertSha256: 'cd'.repeat(32), tokenRef: token, gpu: true, nodeLabels: { tier: 'gpu' } },
            hugepages: { pages1g: 8, perNuma: true },
            'kernel-modules': { load: ['vhost_net'] },
          },
        },
      });
      await expect(validatePoolHostPolicy({ hugepages: { size: '4Ki', count: 1 } })).rejects.toThrow(/size/);
      await expect(validatePoolHostPolicy({ hugepages: { size: '2Mi', count: -3 } })).rejects.toThrow(/hugepages/);
      await expect(validatePoolHostPolicy({ kubernetes: { ...policy.kubernetes, joinTokenRef: 'plain-token' } })).rejects.toThrow(/tokenRef/);
      await expect(validatePoolHostPolicy({ kubernetes: { ...policy.kubernetes, kubeconfig: 'x' } })).rejects.toThrow(/not a setting/);
      await expect(validatePoolHostPolicy(policy)).resolves.toBeUndefined();
      await expect(validatePoolHostPolicy({ sharing: { replicas: 99 } }, 'mps')).rejects.toThrow(/gpu-sharing/);
      // The pool's hugepages win over a profile's (the operator's memory layout).
      expect(poolHostConfig(policy).hugepages).toEqual({ pages1g: 8, perNuma: true });
    } finally {
      await db.close();
    }
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
    // Joins once (while the token file exists), then runs the node agent.
    const units = Object.fromEntries(config.systemd.units.map((u: { name: string; contents: string }) => [u.name, u.contents]));
    expect(units['bcd-join.service']).toContain(
      'ExecStart=/usr/local/bin/bcd join --server https://gw --token-file /etc/bcd/join-token --node-id node_1',
    );
    expect(units['bcd-join.service']).toContain('ConditionPathExists=/etc/bcd/join-token');
    expect(units['bcd.service']).toContain('ExecStart=/usr/local/bin/bcd node');
    expect(units['bcd.service']).toContain('After=network-online.target bcd-join.service');
    expect(config.systemd.units.every((u: { enabled: boolean }) => u.enabled)).toBe(true);
  });
});
