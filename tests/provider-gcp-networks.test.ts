import { describe, expect, it } from 'vitest';
import type { ProviderFirewallSpec, ProviderNetworks } from '@better-compute/core';
import { requestIdFor } from '@better-compute/provider-gcp';
import { GceEmulator } from './support/gce-emulator.js';
import { build, ctx } from './support/gcp-harness.js';

// provider-gcp tenant networking against the emulator: networks, subnets, firewalls and instance tags.

async function networksOf(emu: GceEmulator): Promise<ProviderNetworks> {
  const impl = await build(emu);
  return impl.networks!;
}

const posts = (emu: GceEmulator, suffix: string) =>
  emu.requests.filter((r) => r.method === 'POST' && r.url.pathname.endsWith(suffix));

const firewall: ProviderFirewallSpec = {
  network: 'bc-net',
  name: 'bc-allow-ssh',
  direction: 'ingress',
  action: 'allow',
  priority: 900,
  rules: [{ protocol: 'tcp', ports: ['22', '8000-8100'] }, { protocol: 'icmp' }],
  sources: ['10.0.0.0/8'],
  targetTags: ['bc-abc'],
};

describe('networks', () => {
  it('is offered by the provider', async () => {
    const impl = await build(new GceEmulator());
    expect(impl.networks).toBeDefined();
  });

  it('ensureNetwork is idempotent and pending until the operation is done', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    emu.operationDelayTicks = 2;
    const spec = { name: 'bc-net', description: 'tenant network', mtu: 1500 };
    const states = [];
    for (let i = 0; i < 5; i++) states.push((await networks.ensureNetwork(spec, ctx())).state);
    expect(states).toEqual(['pending', 'pending', 'ready', 'ready', 'ready']);
    expect(await networks.ensureNetwork(spec, ctx())).toEqual({ id: 'bc-net', state: 'ready' });
    expect(emu.networks.size).toBe(1);
    const insert = posts(emu, '/global/networks');
    expect(insert).toHaveLength(1);
    expect(insert[0]!.body).toEqual({
      name: 'bc-net',
      description: 'tenant network',
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: 'REGIONAL' },
      mtu: 1500,
    });
    expect(insert[0]!.url.searchParams.get('requestId')).toBe(requestIdFor('net:bc-net'));
  });

  it('ensureNetwork on an existing network posts nothing', async () => {
    const emu = new GceEmulator();
    emu.networks.set('bc-net', { name: 'bc-net' });
    const networks = await networksOf(emu);
    expect(await networks.ensureNetwork({ name: 'bc-net' }, ctx())).toEqual({
      id: 'bc-net',
      state: 'ready',
    });
    expect(posts(emu, '/global/networks')).toHaveLength(0);
  });

  it('ensureNetwork reports a failed operation as error with its message, and retries', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    emu.operationDelayTicks = 1;
    emu.failNextOperation = { code: 'QUOTA_EXCEEDED', message: 'Quota NETWORKS exceeded' };
    expect(await networks.ensureNetwork({ name: 'bc-net' }, ctx())).toMatchObject({
      state: 'pending',
    });
    expect(await networks.ensureNetwork({ name: 'bc-net' }, ctx())).toEqual({
      id: 'bc-net',
      state: 'error',
      message: 'Quota NETWORKS exceeded',
    });
    // The next call tries again, under a fresh requestId.
    emu.operationDelayTicks = 0;
    expect(await networks.ensureNetwork({ name: 'bc-net' }, ctx())).toMatchObject({
      state: 'ready',
    });
    const ids = posts(emu, '/global/networks').map((r) => r.url.searchParams.get('requestId'));
    expect(new Set(ids).size).toBe(2);
  });

  it('ensureSubnet creates a custom-mode subnet', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    const spec = {
      network: 'bc-net',
      name: 'bc-sub',
      region: 'us-central1',
      cidr: '10.10.0.0/24',
      privateGoogleAccess: true,
    };
    expect(await networks.ensureSubnet(spec, ctx())).toEqual({
      id: 'us-central1/bc-sub',
      state: 'ready',
    });
    const insert = posts(emu, '/regions/us-central1/subnetworks');
    expect(insert).toHaveLength(1);
    expect(insert[0]!.body).toEqual({
      name: 'bc-sub',
      network: 'global/networks/bc-net',
      ipCidrRange: '10.10.0.0/24',
      privateIpGoogleAccess: true,
    });
    // Again: nothing more is created.
    expect(await networks.ensureSubnet(spec, ctx())).toMatchObject({ state: 'ready' });
    expect(posts(emu, '/regions/us-central1/subnetworks')).toHaveLength(1);
    // The same name with another range is an error, not a silent change.
    expect(await networks.ensureSubnet({ ...spec, cidr: '10.11.0.0/24' }, ctx())).toMatchObject({
      state: 'error',
      message: expect.stringContaining('10.10.0.0/24'),
    });
  });

  it('ensureFirewall creates then patches on change', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    expect(await networks.ensureFirewall(firewall, ctx())).toEqual({
      id: 'bc-allow-ssh',
      state: 'ready',
    });
    const insert = posts(emu, '/global/firewalls');
    expect(insert).toHaveLength(1);
    expect(insert[0]!.body).toEqual({
      name: 'bc-allow-ssh',
      network: 'global/networks/bc-net',
      direction: 'INGRESS',
      priority: 900,
      allowed: [{ IPProtocol: 'tcp', ports: ['22', '8000-8100'] }, { IPProtocol: 'icmp' }],
      sourceRanges: ['10.0.0.0/8'],
      targetTags: ['bc-abc'],
      disabled: false,
    });
    // Unchanged: no patch.
    await networks.ensureFirewall(firewall, ctx());
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    // Changed sources and priority: one patch, then stable.
    const changed = { ...firewall, priority: 800, sources: ['10.0.0.0/8', '192.168.0.0/16'] };
    expect(await networks.ensureFirewall(changed, ctx())).toMatchObject({ state: 'ready' });
    const patches = emu.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url.pathname.endsWith('/global/firewalls/bc-allow-ssh')).toBe(true);
    expect(emu.firewalls.get('bc-allow-ssh')).toMatchObject({
      priority: 800,
      sourceRanges: ['10.0.0.0/8', '192.168.0.0/16'],
    });
    await networks.ensureFirewall(changed, ctx());
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    // Source order is not a change.
    await networks.ensureFirewall({ ...changed, sources: ['192.168.0.0/16', '10.0.0.0/8'] }, ctx());
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('ensureFirewall converges when the spec drops a field', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    await networks.ensureFirewall(firewall, ctx());
    expect(emu.firewalls.get('bc-allow-ssh')).toMatchObject({ targetTags: ['bc-abc'] });
    const { targetTags: _tags, sources: _sources, ...bare } = firewall;
    for (let i = 0; i < 3; i++)
      expect(await networks.ensureFirewall(bare, ctx())).toMatchObject({ state: 'ready' });
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    const patch = emu.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ targetTags: [], sourceRanges: [], destinationRanges: [] });
    // The rule now has no target tags, and GCE's default source.
    expect(emu.firewalls.get('bc-allow-ssh')).toMatchObject({
      targetTags: [],
      sourceRanges: ['0.0.0.0/0'],
    });
  });

  it('ensureFirewall converges for an egress rule without destinations', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    const egress: ProviderFirewallSpec = {
      network: 'bc-net',
      name: 'bc-out',
      direction: 'egress',
      action: 'allow',
      priority: 1000,
      rules: [{ protocol: 'all' }],
    };
    for (let i = 0; i < 3; i++)
      expect(await networks.ensureFirewall(egress, ctx())).toMatchObject({ state: 'ready' });
    expect(emu.firewalls.get('bc-out')).toMatchObject({ destinationRanges: ['0.0.0.0/0'] });
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('ensure after delete creates the resource again instead of reporting the old operation', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    const subnet = {
      network: 'bc-net',
      name: 'bc-sub',
      region: 'us-central1',
      cidr: '10.10.0.0/24',
    };
    for (let round = 0; round < 2; round++) {
      expect(await networks.ensureFirewall(firewall, ctx())).toMatchObject({ state: 'ready' });
      expect(emu.firewalls.has('bc-allow-ssh')).toBe(true);
      expect(await networks.ensureNetwork({ name: 'bc-net' }, ctx())).toMatchObject({
        state: 'ready',
      });
      expect(emu.networks.has('bc-net')).toBe(true);
      expect(await networks.ensureSubnet(subnet, ctx())).toMatchObject({ state: 'ready' });
      expect(emu.subnetworks.has('us-central1/bc-sub')).toBe(true);
      expect((await networks.deleteFirewall('bc-allow-ssh', ctx())).state).toBe('deleted');
      expect((await networks.deleteSubnet('us-central1', 'bc-sub', ctx())).state).toBe('deleted');
      expect((await networks.deleteNetwork('bc-net', ctx())).state).toBe('deleted');
    }
    // Once more, with the operation still running: pending, then it exists.
    emu.operationDelayTicks = 1;
    const states = [];
    for (let i = 0; i < 4; i++) states.push((await networks.ensureFirewall(firewall, ctx())).state);
    expect(states.at(-1)).toBe('ready');
    expect(emu.firewalls.has('bc-allow-ssh')).toBe(true);
    const ids = posts(emu, '/global/firewalls').map((r) => r.url.searchParams.get('requestId'));
    // Each reused requestId was spotted by the missing resource and replaced.
    expect(ids.slice(0, -1)).not.toContain(ids.at(-1));
  });

  it('ensureFirewall maps deny and egress rules, and refuses to flip the action', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    const deny: ProviderFirewallSpec = {
      network: 'bc-net',
      name: 'bc-deny-out',
      direction: 'egress',
      action: 'deny',
      priority: 100,
      rules: [{ protocol: 'all' }],
      destinations: ['0.0.0.0/0'],
      disabled: true,
    };
    await networks.ensureFirewall(deny, ctx());
    expect(posts(emu, '/global/firewalls')[0]!.body).toEqual({
      name: 'bc-deny-out',
      network: 'global/networks/bc-net',
      direction: 'EGRESS',
      priority: 100,
      denied: [{ IPProtocol: 'all' }],
      destinationRanges: ['0.0.0.0/0'],
      disabled: true,
    });
    expect(await networks.ensureFirewall({ ...deny, action: 'allow' }, ctx())).toMatchObject({
      state: 'error',
      message: expect.stringContaining('opposite action'),
    });
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('ensureFirewall is pending while its patch runs', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    await networks.ensureFirewall(firewall, ctx());
    emu.operationDelayTicks = 1;
    const changed = { ...firewall, priority: 700 };
    const states = [];
    for (let i = 0; i < 3; i++) states.push((await networks.ensureFirewall(changed, ctx())).state);
    expect(states).toEqual(['pending', 'ready', 'ready']);
    expect(emu.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('deleteNetwork in use reports pending, not an error', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    await networks.ensureNetwork({ name: 'bc-net' }, ctx());
    await networks.ensureSubnet(
      { network: 'bc-net', name: 'bc-sub', region: 'us-central1', cidr: '10.10.0.0/24' },
      ctx(),
    );
    const blocked = await networks.deleteNetwork('bc-net', ctx());
    expect(blocked).toMatchObject({ id: 'bc-net', state: 'pending' });
    expect(blocked.message).toContain('already being used');
    expect(emu.networks.has('bc-net')).toBe(true);
    expect(await networks.deleteSubnet('us-central1', 'bc-sub', ctx())).toEqual({
      id: 'us-central1/bc-sub',
      state: 'deleted',
    });
    expect(await networks.deleteNetwork('bc-net', ctx())).toEqual({
      id: 'bc-net',
      state: 'deleted',
    });
    expect(emu.networks.size).toBe(0);
  });

  it('deleteSubnet in use by an instance reports pending', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    await networks.ensureNetwork({ name: 'bc-net' }, ctx());
    await networks.ensureSubnet(
      { network: 'bc-net', name: 'bc-sub', region: 'us-central1', cidr: '10.10.0.0/24' },
      ctx(),
    );
    emu.addInstance('us-central1-a', 'vm1', {
      networkInterfaces: [
        { network: 'global/networks/bc-net', subnetwork: 'regions/us-central1/subnetworks/bc-sub' },
      ],
    });
    expect(await networks.deleteSubnet('us-central1', 'bc-sub', ctx())).toMatchObject({
      state: 'pending',
    });
    expect(await networks.deleteNetwork('bc-net', ctx())).toMatchObject({ state: 'pending' });
  });

  it('delete is deleting while the operation runs, and deleting what is gone is deleted', async () => {
    const emu = new GceEmulator();
    const networks = await networksOf(emu);
    await networks.ensureFirewall(firewall, ctx());
    emu.operationDelayTicks = 2;
    const states = [];
    for (let i = 0; i < 4; i++)
      states.push((await networks.deleteFirewall('bc-allow-ssh', ctx())).state);
    expect(states).toEqual(['deleting', 'deleting', 'deleted', 'deleted']);
    expect(emu.firewalls.size).toBe(0);
    expect(emu.requests.filter((r) => r.method === 'DELETE')).toHaveLength(2);
    expect(await networks.deleteNetwork('never-was', ctx())).toEqual({
      id: 'never-was',
      state: 'deleted',
    });
  });

  it('setTags keeps foreign tags and replaces bc- tags', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'vm1', {
      labels: { 'better-compute-instance': 'ins_1' },
      tags: { items: ['ssh', 'bc-old', 'web', 'bc-older'] },
    });
    const networks = await networksOf(emu);
    await networks.setTags('us-central1-a/vm1', ['bc-new-1', 'bc-new-2'], ctx());
    expect([...vm.tags.items].sort()).toEqual(['bc-new-1', 'bc-new-2', 'ssh', 'web']);
    const write = emu.requests.find((r) => r.url.pathname.endsWith('/setTags'))!;
    expect(write.body!.items.filter((tag: string) => !tag.startsWith('bc-'))).toEqual([
      'ssh',
      'web',
    ]);
    expect(typeof write.body!.fingerprint).toBe('string');
    // Same set again: nothing written.
    emu.requests.length = 0;
    await networks.setTags('us-central1-a/vm1', ['bc-new-2', 'bc-new-1'], ctx());
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/setTags'))).toBe(false);
    // Clearing the managed tags leaves the foreign ones.
    await networks.setTags('us-central1-a/vm1', [], ctx());
    expect([...vm.tags.items].sort()).toEqual(['ssh', 'web']);
  });

  it('setTags refuses a VM that is not an instance, a bad tag and a missing VM', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'legacy', { tags: { items: ['ssh'] } });
    const networks = await networksOf(emu);
    await expect(networks.setTags('us-central1-a/legacy', ['bc-x'], ctx())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(emu.instances.get('us-central1-a/legacy')!.tags.items).toEqual(['ssh']);
    emu.addInstance('us-central1-a', 'vm1', { labels: { 'better-compute-instance': 'ins_1' } });
    await expect(networks.setTags('us-central1-a/vm1', ['web'], ctx())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(networks.setTags('us-central1-a/vm1', ['BC-Upper'], ctx())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(networks.setTags('us-central1-a/ghost', ['bc-x'], ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('setTags retries once on a stale fingerprint', async () => {
    const emu = new GceEmulator();
    const vm = emu.addInstance('us-central1-a', 'vm1', {
      labels: { 'better-compute-instance': 'ins_1' },
      tags: { items: ['ssh'] },
    });
    const networks = await networksOf(emu);
    let stale = 1;
    emu.beforeAction = (action, instance) => {
      if (action === 'setTags' && stale-- > 0) {
        instance.tags = { items: ['ssh', 'added-by-someone'], fingerprint: `changed-${stale}` };
      }
    };
    await networks.setTags('us-central1-a/vm1', ['bc-x'], ctx());
    expect([...vm.tags.items].sort()).toEqual(['added-by-someone', 'bc-x', 'ssh']);
    stale = 2;
    await expect(networks.setTags('us-central1-a/vm1', ['bc-y'], ctx())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
