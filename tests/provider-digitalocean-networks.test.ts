import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  manualClock,
  type ComputeError,
  type ExternalMachine,
  type ProviderFirewallSpec,
} from '@better-compute/core';
import {
  baseFirewallName,
  compileDoFirewall,
  deploymentTag,
  labels,
  networkMemberTag,
  refusePriorityInversion,
  tagFor,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { isoSeconds } from './support/do-emulator/actions.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { failFirewall } from './support/do-emulator/firewalls.js';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, doAccount, freshBudgets, noopLog } from './support/do-harness.js';

// provider-digitalocean tenant networking against the emulator: the base firewall, VPCs as
// subnets, tenant rules as Cloud Firewalls, Droplet tags, and creates on a network.

const t0 = Date.parse('2026-10-18T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });

// Generated once with ssh-keygen.
const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

const net = 'bc-net1';
const member = networkMemberTag(net);
const net16 = (network: string) => createHash('sha256').update(network).digest('hex').slice(0, 16);
const deployment = deploymentTag('default');
const instanceTag = (instance: string) => tagFor(labels.instance, instance);

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const calls = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));
const firewallWrites = (emu: DoEmulator) =>
  emu.requests.filter((r) => r.method !== 'GET' && r.url.pathname.startsWith('/v2/firewalls'));
const tagWrites = (emu: DoEmulator) =>
  emu.requests.filter((r) => r.method !== 'GET' && r.url.pathname.startsWith('/v2/tags'));
const firewallsNamed = (emu: DoEmulator, prefix: string) =>
  [...emu.state.firewalls.values()].filter((f) => f.name.startsWith(prefix));

const rule: ProviderFirewallSpec = {
  network: net,
  name: 'bc-r1',
  direction: 'ingress',
  action: 'allow',
  priority: 1000,
  rules: [{ protocol: 'tcp', ports: ['22', '8000-8100'] }, { protocol: 'icmp' }],
  sources: ['10.0.0.0/8'],
};
const subnet = { network: net, name: 'bc-sub1', region: 'nyc3', cidr: '10.100.0.0/24' };

describe('networks', () => {
  beforeEach(freshBudgets);

  it('is offered by the provider', async () => {
    const compute = await build(emulator());
    expect(compute.networks).toBeDefined();
  });

  it("a network's base firewall denies ingress and allows egress before any rule", async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    expect(baseFirewallName(net)).toBe(`bc-base-${net16(net)}`);
    // Ready once the base firewall exists, while DO still applies it: the network's subnets and
    // rules need it there, not applied.
    emu.firewallReads = 2;
    expect(await networks.ensureNetwork({ name: net, mtu: 1500 }, ctx())).toEqual({
      id: net,
      state: 'ready',
    });
    const [base, ...others] = [...emu.state.firewalls.values()];
    expect(others).toHaveLength(0);
    expect(base!.name).toBe(`bc-base-${net16(net)}`);
    // No inbound rules: DO denies every ingress. Egress is all ports ("0", never "all").
    expect(base!.inbound_rules).toEqual([]);
    const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };
    expect(base!.outbound_rules).toEqual([
      { protocol: 'tcp', ports: '0', destinations: everywhere },
      { protocol: 'udp', ports: '0', destinations: everywhere },
      { protocol: 'icmp', ports: '0', destinations: everywhere },
    ]);
    expect(base!.tags).toEqual([member]);
    expect(base!.droplet_ids).toEqual([]);
    // The member tag object exists before the firewall names it.
    expect(emu.state.tags.has(member)).toBe(true);

    expect(emu.state.firewalls.get(base!.id)!.status).toBe('waiting');
    // Again: ready, and nothing is written again.
    const writes = firewallWrites(emu).length;
    expect(await networks.ensureNetwork({ name: net }, ctx())).toEqual({ id: net, state: 'ready' });
    expect(firewallWrites(emu)).toHaveLength(writes);

    // DO promises no MTU other than Ethernet's: refused before any call.
    const before = emu.requests.length;
    const mtu = await failure(networks.ensureNetwork({ name: net, mtu: 9000 }, ctx()));
    expect(mtu.code).toBe('UNSUPPORTED');
    expect(mtu.details).toMatchObject({ provider: 'digitalocean', reason: 'mtu' });
    expect(emu.requests).toHaveLength(before);
  });

  it('a base firewall that drifted is put back in place', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureNetwork({ name: net }, ctx());
    const base = [...emu.state.firewalls.values()][0]!;
    base.inbound_rules = [{ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } }];
    expect((await networks.ensureNetwork({ name: net }, ctx())).state).toBe('ready');
    expect(calls(emu, 'PUT', /^\/v2\/firewalls\//).map((r) => r.url.pathname)).toEqual([
      `/v2/firewalls/${base.id}`,
    ]);
    expect(emu.state.firewalls.get(base.id)!.inbound_rules).toEqual([]);
  });

  it('ensureSubnet creates a VPC once and reports drift', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    expect(await networks.ensureSubnet(subnet, ctx())).toEqual({
      id: 'nyc3/bc-sub1',
      state: 'ready',
    });
    const posts = () => calls(emu, 'POST', /^\/v2\/vpcs$/);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      name: 'bc-sub1',
      region: 'nyc3',
      ip_range: '10.100.0.0/24',
      description: 'bc:network=bc-net1',
    });
    // Again: found by name, nothing posted. privateGoogleAccess means nothing on DO.
    expect(
      (await networks.ensureSubnet({ ...subnet, privateGoogleAccess: true }, ctx())).state,
    ).toBe('ready');
    expect(posts()).toHaveLength(1);

    // The same name with another range, region or network is drift.
    for (const changed of [
      { ...subnet, cidr: '10.100.1.0/24' },
      { ...subnet, network: 'bc-net2' },
    ]) {
      const drift = await failure(networks.ensureSubnet(changed, ctx()));
      expect(drift.code).toBe('INVALID_STATE');
      expect(drift.details).toMatchObject({ provider: 'digitalocean', reason: 'subnetDrift' });
    }
    expect(posts()).toHaveLength(1);

    // A create that raced ours: DO's name-in-use 422 is answered by comparing what is there.
    emu.beforeAction('POST /vpcs', ({ state }) => {
      seedVpc(state, {
        name: 'bc-sub2',
        region: 'nyc3',
        ip_range: '10.101.0.0/24',
        description: 'bc:network=bc-net1',
      });
    });
    expect(
      (await networks.ensureSubnet({ ...subnet, name: 'bc-sub2', cidr: '10.101.0.0/24' }, ctx()))
        .state,
    ).toBe('ready');
    emu.beforeAction('POST /vpcs', ({ state }) => {
      seedVpc(state, {
        name: 'bc-sub3',
        region: 'nyc3',
        ip_range: '10.102.0.0/24',
        description: 'bc:network=bc-net1',
      });
    });
    const raced = await failure(
      networks.ensureSubnet({ ...subnet, name: 'bc-sub3', cidr: '10.103.0.0/24' }, ctx()),
    );
    expect(raced.details).toMatchObject({ reason: 'subnetDrift' });

    // A range that overlaps another VPC of the account is DO's 422: INVALID_INPUT, cidrOverlap.
    const overlap = await failure(
      networks.ensureSubnet({ ...subnet, name: 'bc-sub4', cidr: '10.100.0.128/25' }, ctx()),
    );
    expect(overlap.code).toBe('INVALID_INPUT');
    expect(overlap.details).toMatchObject({
      provider: 'digitalocean',
      status: 422,
      reason: 'cidrOverlap',
    });
  });

  it('ensureSubnet refuses a public or out-of-range CIDR before any call', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    for (const cidr of [
      '8.8.8.0/24',
      '10.0.0.0/8',
      '10.0.0.0/29',
      '172.32.0.0/16',
      'fd00::/64',
      '10.0.0.5/24',
      'not-a-cidr',
    ]) {
      const error = await failure(networks.ensureSubnet({ ...subnet, cidr }, ctx()));
      expect(error.code, cidr).toBe('INVALID_INPUT');
      expect(error.details, cidr).toMatchObject({ provider: 'digitalocean', reason: 'cidr' });
    }
    // A region the account does not use is refused too.
    const region = await failure(networks.ensureSubnet({ ...subnet, region: 'tor1' }, ctx()));
    expect(region.details).toMatchObject({ reason: 'region' });
    expect(emu.requests).toHaveLength(0);
    // The edges are fine.
    for (const [name, cidr] of [
      ['bc-a', '10.200.0.0/16'],
      ['bc-b', '172.16.0.0/28'],
      ['bc-c', '192.168.255.0/24'],
    ] as const)
      expect((await networks.ensureSubnet({ ...subnet, name, cidr }, ctx())).state).toBe('ready');
  });

  it('ensureFirewall is pending while DO applies it and error when it fails', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    emu.firewallReads = 2;
    const states: string[] = [];
    for (let i = 0; i < 4; i++) states.push((await networks.ensureFirewall(rule, ctx())).state);
    expect(states).toEqual(['pending', 'pending', 'pending', 'ready']);
    expect(calls(emu, 'POST', /^\/v2\/firewalls$/)).toHaveLength(1);

    const droplet = seedDroplet(emu.state, { tags: [member] });
    expect(failFirewall(emu.state, /^bc-r1\./)).toBe(1);
    const failed = await networks.ensureFirewall(rule, ctx());
    expect(failed).toEqual({
      id: 'bc-r1',
      state: 'error',
      message: expect.stringContaining(`failed to apply firewall bc-r1.n${net16(net)}.p1000`),
    });
    expect(failed.message).toContain(String(droplet.id));
    // A base firewall is ready once it exists, and an error only when DO failed to apply it.
    expect((await networks.ensureNetwork({ name: net }, ctx())).state).toBe('ready');
    failFirewall(emu.state, baseFirewallName(net));
    expect((await networks.ensureNetwork({ name: net }, ctx())).state).toBe('error');
  });

  it('a failed firewall with an unchanged spec is re-PUT on the next ensure', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureNetwork({ name: net }, ctx());
    await networks.ensureFirewall(rule, ctx());
    const puts = () => calls(emu, 'PUT', /^\/v2\/firewalls\//);
    const [base] = firewallsNamed(emu, 'bc-base-');
    const [ruleFw] = firewallsNamed(emu, 'bc-r1.');

    // The call that sees the failure reports it and applies the same firewall again.
    failFirewall(emu.state, /^bc-r1\./);
    expect((await networks.ensureFirewall(rule, ctx())).state).toBe('error');
    expect(puts().map((r) => r.url.pathname)).toEqual([`/v2/firewalls/${ruleFw!.id}`]);
    expect(puts()[0]!.body).toEqual(compileDoFirewall(rule, net));
    // DO tries again, and the rule heals with no change to it.
    expect((await networks.ensureFirewall(rule, ctx())).state).toBe('ready');
    expect(puts()).toHaveLength(1);

    // The same for the base firewall.
    failFirewall(emu.state, baseFirewallName(net));
    expect((await networks.ensureNetwork({ name: net }, ctx())).state).toBe('error');
    expect(puts().map((r) => r.url.pathname)).toEqual([
      `/v2/firewalls/${ruleFw!.id}`,
      `/v2/firewalls/${base!.id}`,
    ]);
    expect((await networks.ensureNetwork({ name: net }, ctx())).state).toBe('ready');
    expect(puts()).toHaveLength(2);
    expect(calls(emu, 'POST', /^\/v2\/firewalls$/)).toHaveLength(2);
  });

  it('only a firewall named exactly as the rule is the rule: a hand-made look-alike is never touched', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    // Firewalls a person made, whose names start like a rule's or a network rule's.
    const lookAlikes = [
      'bc-r1.prod',
      `bc-r1.n${net16(net)}.p1000.copy`,
      `bc-r1.n${net16(net)}.pfirst`,
      `hand.n${net16(net)}.px`,
    ];
    for (const [i, name] of lookAlikes.entries()) {
      const id = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
      emu.state.firewalls.set(id, {
        id,
        name,
        status: 'succeeded',
        created_at: isoSeconds(t0 - 3_600_000),
        pending_changes: [],
        inbound_rules: [
          { protocol: 'tcp', ports: '22', action: 'allow', sources: { addresses: ['0.0.0.0/0'] } },
        ],
        outbound_rules: [],
        droplet_ids: [],
        tags: [],
      });
    }
    await networks.ensureFirewall(rule, ctx());
    const [own] = firewallsNamed(emu, `bc-r1.n${net16(net)}.p1000`).filter(
      (f) => !lookAlikes.includes(f.name),
    );
    await networks.ensureFirewall({ ...rule, sources: ['10.1.0.0/16'] }, ctx());
    expect(calls(emu, 'PUT', /^\/v2\/firewalls\//).map((r) => r.url.pathname)).toEqual([
      `/v2/firewalls/${own!.id}`,
    ]);
    await networks.deleteFirewall('bc-r1', ctx());
    await networks.deleteNetwork(net, ctx());
    expect(calls(emu, 'DELETE', /^\/v2\/firewalls\//).map((r) => r.url.pathname)).toEqual([
      `/v2/firewalls/${own!.id}`,
    ]);
    // Every look-alike is still there, as it was.
    expect([...emu.state.firewalls.values()].map((f) => f.name).sort()).toEqual(
      [...lookAlikes].sort(),
    );
    for (const firewall of emu.state.firewalls.values())
      expect(firewall.inbound_rules[0].sources.addresses).toEqual(['0.0.0.0/0']);
  });

  it('ensureFirewall compiles allow and deny rules, expands all, and targets the network by default', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureFirewall(rule, ctx());
    const [allow] = firewallsNamed(emu, 'bc-r1.');
    expect(allow!.name).toBe(`bc-r1.n${net16(net)}.p1000`);
    const from = { addresses: ['10.0.0.0/8'] };
    expect(allow!.inbound_rules).toEqual([
      { protocol: 'tcp', ports: '22', action: 'allow', sources: from },
      { protocol: 'tcp', ports: '8000-8100', action: 'allow', sources: from },
      { protocol: 'icmp', ports: '0', action: 'allow', sources: from },
    ]);
    expect(allow!.outbound_rules).toEqual([]);
    // No targets: the whole network, by its member tag.
    expect(allow!.tags).toEqual([member]);
    expect(allow!.droplet_ids).toEqual([]);

    const deny: ProviderFirewallSpec = {
      network: net,
      name: 'bc-r2',
      direction: 'egress',
      action: 'deny',
      priority: 500,
      rules: [{ protocol: 'all' }],
      destinations: ['192.0.2.0/24'],
      targetTags: ['bc-0123456789abcdef'],
    };
    await networks.ensureFirewall(deny, ctx());
    const [stored] = firewallsNamed(emu, 'bc-r2.');
    const to = { addresses: ['192.0.2.0/24'] };
    // `all` is tcp, udp and icmp, each on every port: "0", never "all".
    expect(stored!.outbound_rules).toEqual([
      { protocol: 'tcp', ports: '0', action: 'deny', destinations: to },
      { protocol: 'udp', ports: '0', action: 'deny', destinations: to },
      { protocol: 'icmp', ports: '0', action: 'deny', destinations: to },
    ]);
    expect(stored!.inbound_rules).toEqual([]);
    expect(stored!.tags).toEqual(['bc-0123456789abcdef']);
    for (const firewall of emu.state.firewalls.values())
      for (const r of [...firewall.inbound_rules, ...firewall.outbound_rules])
        expect(r.ports).not.toBe('all');

    // A rule without addresses is everywhere, v4 and v6; the compiler is what was sent.
    const open = compileDoFirewall(
      { ...rule, sources: undefined, rules: [{ protocol: 'udp' }] },
      net,
    );
    expect(open.inbound_rules).toEqual([
      {
        protocol: 'udp',
        ports: '0',
        action: 'allow',
        sources: { addresses: ['0.0.0.0/0', '::/0'] },
      },
    ]);
    expect(calls(emu, 'POST', /^\/v2\/firewalls$/).map((r) => r.body)).toEqual([
      compileDoFirewall(rule, net),
      compileDoFirewall(deny, net),
    ]);

    // What DO can't express is refused before any call.
    const before = emu.requests.length;
    const refusals: [Partial<ProviderFirewallSpec>, string, string][] = [
      [{ rules: [{ protocol: 'tcp', ports: ['http'] }] }, 'INVALID_INPUT', 'ports'],
      [{ rules: [{ protocol: 'tcp', ports: ['90-80'] }] }, 'INVALID_INPUT', 'ports'],
      [{ sources: ['10.0.0.0/33'] }, 'INVALID_INPUT', 'address'],
      [{ destinations: ['10.0.0.0/8'] }, 'UNSUPPORTED', 'firewallAddresses'],
      [{ name: 'Bad.Name' }, 'INVALID_INPUT', 'firewallName'],
      [{ priority: -1 }, 'INVALID_INPUT', 'priority'],
      [{ targetTags: ['Not A Tag'] }, 'INVALID_INPUT', 'tag'],
    ];
    for (const [change, code, reason] of refusals) {
      const error = await failure(networks.ensureFirewall({ ...rule, ...change }, ctx()));
      expect(error.code, reason).toBe(code);
      expect(error.details, reason).toMatchObject({ provider: 'digitalocean', reason });
    }
    expect(emu.requests).toHaveLength(before);
  });

  it('ensureFirewall updates in place on change and is idempotent', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureFirewall(rule, ctx());
    const [created] = firewallsNamed(emu, 'bc-r1.');
    // The same rule again: no PUT, no POST.
    await networks.ensureFirewall(rule, ctx());
    expect(firewallWrites(emu).map((r) => r.method)).toEqual(['POST']);

    // Other sources: the same DO firewall, replaced.
    await networks.ensureFirewall({ ...rule, sources: ['10.1.0.0/16'] }, ctx());
    expect(firewallWrites(emu).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'POST /v2/firewalls',
      `PUT /v2/firewalls/${created!.id}`,
    ]);
    expect(emu.state.firewalls.get(created!.id)!.inbound_rules[0].sources).toEqual({
      addresses: ['10.1.0.0/16'],
    });
    // Another priority renames it, in place.
    await networks.ensureFirewall({ ...rule, sources: ['10.1.0.0/16'], priority: 900 }, ctx());
    expect(firewallsNamed(emu, 'bc-r1.').map((f) => f.name)).toEqual([`bc-r1.n${net16(net)}.p900`]);
    expect(calls(emu, 'PUT', /^\/v2\/firewalls\//)).toHaveLength(2);
    expect(calls(emu, 'POST', /^\/v2\/firewalls$/)).toHaveLength(1);

    // A second firewall of the rule (DO names are not unique: a racing create) is reaped, and
    // the oldest stays.
    const kept = emu.state.firewalls.get(created!.id)!;
    const twin: Json = {
      ...structuredClone(kept),
      id: 'f0000000-0000-4000-8000-000000000001',
      created_at: isoSeconds(t0 + 60_000),
    };
    emu.state.firewalls.set(twin.id, twin);
    await networks.ensureFirewall({ ...rule, sources: ['10.1.0.0/16'], priority: 900 }, ctx());
    expect(calls(emu, 'DELETE', /^\/v2\/firewalls\//).map((r) => r.url.pathname)).toEqual([
      `/v2/firewalls/${twin.id}`,
    ]);
    expect(firewallsNamed(emu, 'bc-r1.').map((f) => f.id)).toEqual([created!.id]);
  });

  it('an allow outranking an overlapping deny is refused', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    const deny: ProviderFirewallSpec = {
      network: net,
      name: 'bc-deny',
      direction: 'ingress',
      action: 'deny',
      priority: 200,
      rules: [{ protocol: 'tcp', ports: ['22'] }],
    };
    const allow: ProviderFirewallSpec = {
      ...deny,
      name: 'bc-allow',
      action: 'allow',
      priority: 100,
      sources: ['0.0.0.0/0'],
    };
    await networks.ensureFirewall(deny, ctx());
    const refused = await failure(networks.ensureFirewall(allow, ctx()));
    expect(refused.code).toBe('UNSUPPORTED');
    expect(refused.details).toMatchObject({ provider: 'digitalocean', reason: 'firewallPriority' });
    expect(firewallsNamed(emu, 'bc-allow.')).toHaveLength(0);

    // The other order ends the same way: the deny applies (DO's deny-wins over-restricts, which
    // fails closed) and the allow is in error on its next reconcile. The allow that was already
    // applied stays as it is: the deny wins at DO for the traffic they share.
    const emu2 = emulator();
    const second = (await build(emu2)).networks;
    await second.ensureFirewall(allow, ctx());
    const [applied] = firewallsNamed(emu2, 'bc-allow.');
    expect((await second.ensureFirewall(deny, ctx())).id).toBe('bc-deny');
    expect(firewallsNamed(emu2, 'bc-deny.')).toHaveLength(1);
    const writes = firewallWrites(emu2).length;
    const reversed = await failure(second.ensureFirewall(allow, ctx()));
    expect(reversed.code).toBe('UNSUPPORTED');
    expect(reversed.details).toMatchObject({
      provider: 'digitalocean',
      reason: 'firewallPriority',
    });
    // A changed allow is refused too, and the applied one is neither updated nor deleted.
    const changed = await failure(
      second.ensureFirewall({ ...allow, sources: ['10.0.0.0/8'] }, ctx()),
    );
    expect(changed.details).toMatchObject({ reason: 'firewallPriority' });
    expect(firewallWrites(emu2)).toHaveLength(writes);
    expect(firewallsNamed(emu2, 'bc-allow.')).toEqual([applied]);
    // The deny keeps applying on every pass, in both worlds.
    for (const [emu_, networks_] of [
      [emu, networks],
      [emu2, second],
    ] as const) {
      expect((await networks_.ensureFirewall(deny, ctx())).id).toBe('bc-deny');
      expect(firewallsNamed(emu_, 'bc-deny.')).toHaveLength(1);
    }

    // What doesn't overlap, or ranks below the deny, or sits in another network, is fine.
    for (const ok of [
      { ...allow, priority: 300 },
      { ...allow, rules: [{ protocol: 'tcp' as const, ports: ['23-80'] }] },
      { ...allow, rules: [{ protocol: 'udp' as const }] },
      { ...allow, direction: 'egress' as const, sources: undefined },
      { ...allow, network: 'bc-net2' },
    ])
      expect((await networks.ensureFirewall(ok, ctx())).id).toBe(ok.name);
  });

  it('refusePriorityInversion decides overlap by protocol, ports, addresses and targets', () => {
    const deny: ProviderFirewallSpec = {
      network: net,
      name: 'bc-d',
      direction: 'ingress',
      action: 'deny',
      priority: 500,
      rules: [{ protocol: 'tcp', ports: ['1000-2000'] }],
      sources: ['10.1.2.0/24', '2001:db8:1::/48'],
      targetTags: ['bc-aaaaaaaaaaaaaaaa'],
    };
    const allow = { ...deny, name: 'bc-a', action: 'allow' as const, priority: 100 };
    const refused = (a: Partial<ProviderFirewallSpec>, d: Partial<ProviderFirewallSpec> = {}) => {
      try {
        refusePriorityInversion([
          { ...allow, ...a },
          { ...deny, ...d },
        ]);
        return false;
      } catch (error) {
        expect(isComputeError(error, 'UNSUPPORTED')).toBe(true);
        return true;
      }
    };
    expect(refused({})).toBe(true);
    expect(refused({ rules: [{ protocol: 'all' }] })).toBe(true);
    expect(refused({ rules: [{ protocol: 'tcp' }] })).toBe(true);
    expect(refused({ rules: [{ protocol: 'tcp', ports: ['2000'] }] })).toBe(true);
    expect(refused({ rules: [{ protocol: 'tcp', ports: ['2001-3000'] }] })).toBe(false);
    expect(refused({ rules: [{ protocol: 'icmp' }] })).toBe(false);
    expect(refused({ rules: [{ protocol: 'icmp' }] }, { rules: [{ protocol: 'all' }] })).toBe(true);
    expect(refused({ sources: ['10.0.0.0/8'] })).toBe(true);
    expect(refused({ sources: ['10.1.3.0/24'] })).toBe(false);
    expect(refused({ sources: ['2001:db8::/32'] })).toBe(true);
    expect(refused({ sources: ['2001:db9::/32'] })).toBe(false);
    expect(refused({ sources: undefined })).toBe(true);
    expect(refused({ targetTags: ['bc-bbbbbbbbbbbbbbbb'] })).toBe(false);
    expect(refused({ targetTags: undefined })).toBe(true);
    expect(refused({}, { targetTags: undefined })).toBe(true);
    expect(refused({ priority: 500 })).toBe(false);
    expect(refused({ disabled: true })).toBe(false);
    expect(refused({}, { disabled: true })).toBe(false);
    expect(refused({ direction: 'egress', sources: undefined })).toBe(false);
  });

  it('a disabled rule removes the DO firewall', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureFirewall(rule, ctx());
    await networks.ensureFirewall({ ...rule, name: 'bc-r9' }, ctx());
    expect(firewallsNamed(emu, 'bc-r1.')).toHaveLength(1);
    expect(await networks.ensureFirewall({ ...rule, disabled: true }, ctx())).toEqual({
      id: 'bc-r1',
      state: 'ready',
    });
    expect(firewallsNamed(emu, 'bc-r1.')).toHaveLength(0);
    expect(firewallsNamed(emu, 'bc-r9.')).toHaveLength(1);
    // Disabled again: nothing to delete.
    const deletes = calls(emu, 'DELETE', /^\/v2\/firewalls\//).length;
    expect((await networks.ensureFirewall({ ...rule, disabled: true }, ctx())).state).toBe('ready');
    expect(calls(emu, 'DELETE', /^\/v2\/firewalls\//)).toHaveLength(deletes);
    // deleteFirewall: by name, at any priority; gone is deleted.
    expect(await networks.deleteFirewall('bc-r9', ctx())).toEqual({
      id: 'bc-r9',
      state: 'deleted',
    });
    expect(emu.state.firewalls.size).toBe(0);
    expect((await networks.deleteFirewall('bc-r9', ctx())).state).toBe('deleted');
  });

  it('deleteSubnet in use is pending; delete of what is gone is deleted', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureSubnet(subnet, ctx());
    const vpc = [...emu.state.vpcs.values()].find((v) => v.name === 'bc-sub1')!;
    const droplet = seedDroplet(emu.state, { vpc_uuid: vpc.id });
    const busy = await networks.deleteSubnet('nyc3', 'bc-sub1', ctx());
    expect(busy).toMatchObject({ id: 'nyc3/bc-sub1', state: 'pending' });
    expect(busy.message).toContain('members');
    expect(emu.state.vpcs.has(vpc.id)).toBe(true);
    // DO may say "in use" with a 422 instead of the 409: pending as well.
    const inUse = emu.error('422-vpc-in-use');
    emu.failNext({ method: 'DELETE', path: /^\/vpcs\// }, inUse.status, inUse.body as object);
    expect(await networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).toEqual({
      id: 'nyc3/bc-sub1',
      state: 'pending',
      message: expect.stringContaining('is in use'),
    });

    emu.state.droplets.delete(droplet.id);
    expect(await networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).toEqual({
      id: 'nyc3/bc-sub1',
      state: 'deleted',
    });
    expect(emu.state.vpcs.has(vpc.id)).toBe(false);
    expect((await networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('deleted');

    // A VPC of that name that no network owns is never deleted.
    seedVpc(emu.state, { name: 'bc-hand', region: 'nyc3', ip_range: '10.150.0.0/24' });
    const foreign = await failure(networks.deleteSubnet('nyc3', 'bc-hand', ctx()));
    expect(foreign.code).toBe('INVALID_STATE');
    expect(foreign.details).toMatchObject({ reason: 'notManaged' });
    // The in-use 409, the in-use 422 and the delete that took: never the hand-made VPC.
    expect(calls(emu, 'DELETE', /^\/v2\/vpcs\//)).toHaveLength(3);
  });

  it('deleteNetwork waits for its VPCs, then removes the base firewall', async () => {
    const emu = emulator();
    const { networks } = await build(emu);
    await networks.ensureNetwork({ name: net }, ctx());
    await networks.ensureSubnet(subnet, ctx());
    await networks.ensureFirewall(rule, ctx());
    await networks.ensureNetwork({ name: 'bc-net2' }, ctx());
    await networks.ensureFirewall({ ...rule, network: 'bc-net2', name: 'bc-other' }, ctx());

    expect(await networks.deleteNetwork(net, ctx())).toEqual({ id: net, state: 'deleting' });
    expect(firewallsNamed(emu, baseFirewallName(net))).toHaveLength(1);
    expect(calls(emu, 'DELETE', /^\/v2\/firewalls\//)).toHaveLength(0);

    await networks.deleteSubnet('nyc3', 'bc-sub1', ctx());
    expect(await networks.deleteNetwork(net, ctx())).toEqual({ id: net, state: 'deleted' });
    // The base firewall, and a rule of the network left behind, are gone; the other network's stay.
    expect([...emu.state.firewalls.values()].map((f) => f.name).sort()).toEqual(
      [baseFirewallName('bc-net2'), `bc-other.n${net16('bc-net2')}.p1000`].sort(),
    );
    expect((await networks.deleteNetwork(net, ctx())).state).toBe('deleted');
  });
});

describe('networks: tags', () => {
  beforeEach(freshBudgets);

  async function onNetwork(emu: DoEmulator, compute: DoCompute) {
    await compute.networks.ensureSubnet(subnet, ctx());
    return [...emu.state.vpcs.values()].find((v) => v.name === 'bc-sub1')!;
  }

  it('setTags keeps foreign tags, replaces the bc- tags better-compute writes and adds the network member tag', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const vpc = await onNetwork(emu, compute);
    const keep = [
      deployment,
      instanceTag('inst_1'),
      'better-compute-managed:true',
      'better-compute-tenant:acme',
      'web',
      'BC-Hand',
      // A user's own bc- tags are not shapes better-compute writes: a hand-made firewall may
      // target them, so they stay.
      'bc-web',
      'bc-net-web',
      'bc-0123',
      'bc-0123456789abcdef0',
    ];
    const droplet = seedDroplet(emu.state, {
      vpc_uuid: vpc.id,
      tags: [...keep, 'bc-0000000000000000'],
    });
    await compute.networks.setTags(String(droplet.id), ['bc-1111111111111111'], ctx(), 'inst_1');
    const tags = emu.state.droplets.get(droplet.id)!.tags as string[];
    expect([...tags].sort()).toEqual([...keep, 'bc-1111111111111111', member].sort());
    // Added before removed, one Droplet at a time; the tag objects are made first.
    expect(tagWrites(emu).map((r) => `${r.method} ${decodeURIComponent(r.url.pathname)}`)).toEqual([
      'POST /v2/tags',
      'POST /v2/tags/bc-1111111111111111/resources',
      'POST /v2/tags',
      `POST /v2/tags/${member}/resources`,
      'DELETE /v2/tags/bc-0000000000000000/resources',
    ]);
    // Current: nothing written.
    const writes = tagWrites(emu).length;
    await compute.networks.setTags(String(droplet.id), ['bc-1111111111111111'], ctx(), 'inst_1');
    expect(tagWrites(emu)).toHaveLength(writes);

    // A member tag fails closed: it stays when the Droplet's VPC names no network, can't be
    // found, or there is none, since without it the Droplet leaves its base firewall.
    for (const where of [
      {},
      { vpc_uuid: null },
      { vpc_uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    ] as const) {
      const kept = seedDroplet(emu.state, {
        ...where,
        tags: [deployment, instanceTag('inst_2'), member, 'bc-2222222222222222'],
      });
      await compute.networks.setTags(String(kept.id), [], ctx(), 'inst_2');
      expect(emu.state.droplets.get(kept.id)!.tags, JSON.stringify(where)).toEqual([
        deployment,
        instanceTag('inst_2'),
        member,
      ]);
    }
    // In a VPC of another network, the old network's member tag goes and the new one's comes.
    await compute.networks.ensureSubnet(
      { network: 'bc-net2', name: 'bc-sub-n2', region: 'nyc3', cidr: '10.120.0.0/24' },
      ctx(),
    );
    const n2 = [...emu.state.vpcs.values()].find((v) => v.name === 'bc-sub-n2')!;
    const moved = seedDroplet(emu.state, {
      vpc_uuid: n2.id,
      tags: [deployment, instanceTag('inst_3'), member],
    });
    await compute.networks.setTags(String(moved.id), [], ctx(), 'inst_3');
    expect(emu.state.droplets.get(moved.id)!.tags).toEqual([
      deployment,
      instanceTag('inst_3'),
      networkMemberTag('bc-net2'),
    ]);

    // Only bc- tags may be set.
    const bad = await failure(compute.networks.setTags(String(droplet.id), ['web'], ctx()));
    expect(bad.code).toBe('INVALID_INPUT');
    // A Droplet that is gone is NOT_FOUND.
    const gone = await failure(compute.networks.setTags('999999', [], ctx()));
    expect(gone.code).toBe('NOT_FOUND');
  });

  it("setTags with an instance id touches only that instance's droplet", async () => {
    const emu = emulator();
    const compute = await build(emu);
    const other = seedDroplet(emu.state, { tags: [deployment, instanceTag('inst_2')] });
    const refused = await failure(
      compute.networks.setTags(String(other.id), ['bc-1111111111111111'], ctx(), 'inst_1'),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details).toMatchObject({ provider: 'digitalocean', reason: 'notInstance' });
    // Not an instance's, or another deployment's: refused too, with or without an instance id.
    const bare = seedDroplet(emu.state, { tags: [deployment] });
    const foreign = seedDroplet(emu.state, {
      tags: [deploymentTag('other'), instanceTag('inst_1')],
    });
    for (const [id, instance] of [
      [bare.id, undefined],
      [bare.id, 'inst_1'],
      [foreign.id, undefined],
      [foreign.id, 'inst_1'],
    ] as const) {
      const error = await failure(compute.networks.setTags(String(id), [], ctx(), instance));
      expect(error.details).toMatchObject({ reason: 'notInstance' });
    }
    expect(tagWrites(emu)).toHaveLength(0);

    // The instance's own Droplet is tagged; without an id any instance's Droplet is.
    await compute.networks.setTags(String(other.id), ['bc-1111111111111111'], ctx(), 'inst_2');
    await compute.networks.setTags(String(other.id), ['bc-2222222222222222'], ctx());
    expect(emu.state.droplets.get(other.id)!.tags).toEqual([
      deployment,
      instanceTag('inst_2'),
      'bc-2222222222222222',
    ]);
  });

  it('create on a network subnet attaches the vpc and member tag; a subnet in another region is refused', async () => {
    const emu = emulator();
    const compute = await build(emu, { ...doAccount, regions: ['nyc3', 'tor1'] });
    const vpc = await onNetwork(emu, compute);
    await compute.networks.ensureSubnet(
      { ...subnet, name: 'bc-sub-tor', region: 'tor1', cidr: '10.101.0.0/24' },
      ctx(),
    );
    const request = (network: Record<string, unknown>) => ({
      offerId: 'nyc3/s-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      userData: '#cloud-config\n',
      name: 'inst_1',
      sshKeys: [testKey],
      network: network as never,
    });
    const posts = () => calls(emu, 'POST', /^\/v2\/droplets$/);

    const machine = await compute.create(
      request({ network: net, subnet: 'bc-sub1', tags: ['bc-1111111111111111'] }),
      ctx('on-net'),
    );
    expect(posts()[0]!.body).toMatchObject({ vpc_uuid: vpc.id });
    expect((posts()[0]!.body as { tags: string[] }).tags).toEqual(
      expect.arrayContaining([member, 'bc-1111111111111111', deployment]),
    );
    expect(emu.state.droplets.get(Number(machine.id))!.vpc_uuid).toBe(vpc.id);
    // Without a subnet: the network's VPC in the offer's region.
    await compute.create(request({ network: net }), ctx('no-subnet'));
    expect(posts()[1]!.body).toMatchObject({ vpc_uuid: vpc.id });

    const refusals: [Record<string, unknown>, string, string][] = [
      [{ network: net, subnet: 'bc-sub-tor' }, 'INVALID_INPUT', 'subnetRegion'],
      [{ network: net, subnet: 'bc-missing' }, 'INVALID_STATE', 'noSubnet'],
      [{ network: 'bc-net2' }, 'INVALID_STATE', 'noSubnetInRegion'],
      [{ network: 'bc-net2', subnet: 'bc-sub1' }, 'INVALID_STATE', 'subnetNetwork'],
    ];
    const keyCalls = () =>
      emu.requests.filter((r) => r.url.pathname.startsWith('/v2/account/keys'));
    const keysBefore = keyCalls().length;
    for (const [ref, code, reason] of refusals) {
      const error = await failure(compute.create(request(ref), ctx(`refused-${reason}`)));
      expect(error.code, reason).toBe(code);
      expect(error.details, reason).toMatchObject({ provider: 'digitalocean', reason });
    }
    // The VPC is resolved before the keys: a refused create touches no SSH key.
    expect(keyCalls()).toHaveLength(keysBefore);
    // A bad tag is refused before any call.
    const before = emu.requests.length;
    const tag = await failure(
      compute.create(request({ network: net, tags: ['Not A Tag'] }), ctx('bad-tag')),
    );
    expect(tag.details).toMatchObject({ reason: 'tag' });
    expect(emu.requests).toHaveLength(before);
    expect(posts()).toHaveLength(2);
  });

  it("get, list and discover name the network of a droplet's vpc (ruling R2)", async () => {
    const emu = emulator();
    const clock = manualClock(1_000_000);
    const lines: string[] = [];
    const log = {
      ...noopLog,
      warn: (message: string) => void lines.push(`warn ${message}`),
    };
    const compute = await build(emu, doAccount, {}, { clock, log });
    const vpc = await onNetwork(emu, compute);
    const ours = seedDroplet(emu.state, {
      vpc_uuid: vpc.id,
      tags: ['better-compute-managed:true', deployment],
    });
    const plain = seedDroplet(emu.state, { tags: ['better-compute-managed:true', deployment] });
    const network = (m: ExternalMachine | undefined) => m?.networks?.[0]?.network;
    const vpcLists = () => calls(emu, 'GET', /^\/v2\/vpcs$/).length;

    expect(network(await compute.get(String(ours.id), ctx()))).toBe(net);
    expect(network(await compute.get(String(plain.id), ctx()))).toBe('default-nyc3');
    const listed: ExternalMachine[] = [];
    for await (const m of compute.list(ctx())) listed.push(m);
    expect(listed.map(network)).toEqual([net, 'default-nyc3']);
    const discovered: ExternalMachine[] = [];
    for await (const m of compute.discover!(ctx())) discovered.push(m);
    expect(discovered.map(network)).toEqual([net, 'default-nyc3']);

    // The VPC list is reused for a minute: a VPC made since is found by one refresh.
    const reads = vpcLists();
    await compute.get(String(ours.id), ctx());
    expect(vpcLists()).toBe(reads);
    const late = seedVpc(emu.state, { name: 'late', region: 'nyc3', ip_range: '10.160.0.0/24' });
    const moved = seedDroplet(emu.state, { vpc_uuid: late.id });
    expect(network(await compute.get(String(moved.id), ctx()))).toBe('late');
    expect(vpcLists()).toBe(reads + 1);
    // A uuid no VPC has stays as it is, after one refresh per call, not one per Droplet.
    emu.state.droplets.get(moved.id)!.vpc_uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    expect(network(await compute.get(String(moved.id), ctx()))).toBe(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    expect(vpcLists()).toBe(reads + 2);
    // A list of Droplets on unknown uuids refreshes once, not once per Droplet.
    for (const d of [ours, plain])
      emu.state.droplets.get(d.id)!.vpc_uuid = late.id.replace(/^./, '0');
    const unknown: ExternalMachine[] = [];
    for await (const m of compute.list(ctx())) unknown.push(m);
    expect(unknown.map(network)).toEqual([late.id.replace(/^./, '0'), late.id.replace(/^./, '0')]);
    expect(vpcLists()).toBe(reads + 3);
    emu.state.droplets.get(ours.id)!.vpc_uuid = vpc.id;
    // After a minute the list is read again.
    clock.advance(60_000);
    expect(network(await compute.get(String(ours.id), ctx()))).toBe(net);
    expect(vpcLists()).toBe(reads + 4);

    // The name is for display: a VPC list DO won't give leaves the uuid, and the get works.
    clock.advance(60_000);
    emu.failNext({ method: 'GET', path: /^\/vpcs$/ }, 403, {
      id: 'forbidden',
      message: 'You do not have access for the attempted action.',
    });
    expect(network(await compute.get(String(ours.id), ctx()))).toBe(vpc.id);
    expect(lines).toEqual(['warn digitalocean.vpcListUnreadable']);
  });
});
