import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type ComputeError,
  type ProviderLoadBalancerSpec,
} from '@better-compute/core';
import {
  deploymentHash,
  certificateName,
  deploymentTag,
  labels,
  loadBalancerName,
  tagFor,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { seedLoadBalancer } from './support/do-emulator/load-balancers.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean regional load balancers (P4) against the emulator: found by a name that
// carries this deployment's hash, explicit Droplet targets that must be instances of this
// deployment in the load balancer's region, in-place changes as one replace (PUT), and deletes
// only of load balancers of ours.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const deployment = deploymentTag('default');
const instanceTag = (instance: string) => tagFor(labels.instance, instance);
const certId = '2a9d9a3c-0000-4000-8000-00000000c0de';

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
const writes = (emu: DoEmulator) => emu.requests.filter((r) => r.method !== 'GET');

function host(
  emu: DoEmulator,
  extra: { region?: string; tags?: string[]; instance?: string; size_slug?: string } = {},
): Json {
  return seedDroplet(emu.state, {
    region: extra.region ?? 'nyc3',
    ...(extra.size_slug ? { size_slug: extra.size_slug } : {}),
    tags: extra.tags ?? [deployment, instanceTag(extra.instance ?? 'ins_1')],
  });
}

function spec(targets: readonly Json[], extra: Partial<ProviderLoadBalancerSpec> = {}) {
  return {
    name: 'bc-lb1',
    scope: 'regional',
    region: 'nyc3',
    forwarding: [
      { entryProtocol: 'http', entryPort: 80, targetProtocol: 'http', targetPort: 8080 },
    ],
    healthCheck: { protocol: 'http', port: 8080, path: '/healthz' },
    targets: { machines: targets.map((d) => String(d.id)) },
    ...extra,
  } as ProviderLoadBalancerSpec;
}

async function setup(
  emu = emulator(),
  config: Record<string, unknown> = { ...doAccount, regions: ['nyc3', 'sfo3'] },
): Promise<{ emu: DoEmulator; impl: DoCompute }> {
  return { emu, impl: await build(emu, config) };
}

beforeEach(freshBudgets);

describe('provider-digitalocean load balancers: create and find', () => {
  it('names a load balancer with the deployment hash', () => {
    expect(loadBalancerName('bc-lb1', 'default')).toBe(`bc-lb1-${deploymentHash('default')}`);
    expect(deploymentHash('default')).toMatch(/^[0-9a-f]{12}$/);
    expect(deployment).toBe(`better-compute-deployment:${deploymentHash('default')}`);
  });

  it('creates a regional load balancer in front of instance Droplets, pending until it serves', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const b = host(emu, { instance: 'ins_2' });
    const made = await impl.loadBalancers.ensureLoadBalancer(spec([a, b]), ctx());
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: 'pending',
      outputs: { scope: 'regional', region: 'nyc3' },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/load_balancers$/);
    expect(post!.body).toEqual({
      name: loadBalancerName('bc-lb1', 'default'),
      type: 'REGIONAL',
      region: 'nyc3',
      network: 'EXTERNAL',
      forwarding_rules: [
        { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 8080 },
      ],
      health_check: { protocol: 'http', port: 8080, path: '/healthz' },
      sticky_sessions: { type: 'none' },
      redirect_http_to_https: false,
      firewall: { allow: [], deny: [] },
      droplet_ids: [a.id, b.id].sort((x, y) => x - y),
    });
    const ready = await impl.loadBalancers.ensureLoadBalancer(
      { ...spec([a, b]), id: made.id },
      ctx(),
    );
    expect(ready).toEqual({
      id: made.id,
      state: 'ready',
      outputs: {
        scope: 'regional',
        region: 'nyc3',
        address: expect.stringMatching(/^192\.0\.2\./),
      },
    });
    expect(await impl.loadBalancers.getLoadBalancer(made.id, ctx())).toEqual(ready);
    // By name alone, and through findLoadBalancer: the same one, and no second create.
    expect((await impl.loadBalancers.ensureLoadBalancer(spec([a, b]), ctx())).id).toBe(made.id);
    expect((await impl.loadBalancers.findLoadBalancer!('bc-lb1', ctx()))?.id).toBe(made.id);
    expect(await impl.loadBalancers.findLoadBalancer!('bc-other', ctx())).toBe(undefined);
    expect(writes(emu)).toHaveLength(1);
  });

  it('maps TLS, stickiness, source ranges, redirects and a subnet', async () => {
    const { emu, impl } = await setup();
    emu.state.certificates.set(certId, { id: certId, name: certificateName('c', 'default') });
    const vpc = seedVpc(emu.state, {
      name: 'bc-sub1',
      region: 'nyc3',
      ip_range: '10.20.0.0/20',
      description: 'bc:network=bc-net1',
    });
    const a = seedDroplet(emu.state, {
      region: 'nyc3',
      vpc_uuid: vpc.id,
      tags: [deployment, instanceTag('ins_1')],
    });
    await impl.loadBalancers.ensureLoadBalancer(
      spec([a], {
        forwarding: [
          {
            entryProtocol: 'https',
            entryPort: 443,
            targetProtocol: 'http',
            targetPort: 8080,
            certificate: certId,
          },
          {
            entryProtocol: 'https',
            entryPort: 8443,
            targetProtocol: 'https',
            targetPort: 8443,
            tlsPassthrough: true,
          },
        ],
        stickySessions: { cookieName: 'bc_sticky', ttlSeconds: 300 },
        sourceRanges: { allow: ['198.51.100.0/24', '203.0.113.7'], deny: ['198.51.100.9'] },
        redirectHttpToHttps: true,
        network: { network: 'bc-net1', subnet: 'bc-sub1' },
        internal: true,
      }),
      ctx(),
    );
    const [post] = calls(emu, 'POST', /^\/v2\/load_balancers$/);
    expect(post!.body).toMatchObject({
      vpc_uuid: vpc.id,
      network: 'INTERNAL',
      forwarding_rules: [
        {
          entry_protocol: 'https',
          entry_port: 443,
          target_protocol: 'http',
          target_port: 8080,
          certificate_id: certId,
        },
        {
          entry_protocol: 'https',
          entry_port: 8443,
          target_protocol: 'https',
          target_port: 8443,
          tls_passthrough: true,
        },
      ],
      sticky_sessions: { type: 'cookies', cookie_name: 'bc_sticky', cookie_ttl_seconds: 300 },
      firewall: { allow: ['cidr:198.51.100.0/24', 'ip:203.0.113.7'], deny: ['ip:198.51.100.9'] },
      redirect_http_to_https: true,
    });
  });

  it('refuses what it can before any request', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    emu.requests.length = 0;
    const base = spec([a]);
    const refusals: [ProviderLoadBalancerSpec, string, string][] = [
      [{ ...base, region: 'ams3' }, 'INVALID_INPUT', 'region'],
      [{ ...base, region: undefined }, 'INVALID_INPUT', 'region'],
      [{ ...base, name: 'Bad_Name' }, 'INVALID_INPUT', 'name'],
      [{ ...base, forwarding: [] }, 'INVALID_INPUT', 'forwarding'],
      [
        {
          ...base,
          forwarding: [
            { entryProtocol: 'https', entryPort: 443, targetProtocol: 'http', targetPort: 80 },
          ],
        },
        'INVALID_INPUT',
        'certificate',
      ],
      [
        {
          ...base,
          forwarding: [
            { entryProtocol: 'http', entryPort: 0, targetProtocol: 'http', targetPort: 80 },
          ],
        },
        'INVALID_INPUT',
        'port',
      ],
      [
        {
          ...base,
          forwarding: [
            { entryProtocol: 'gopher', entryPort: 70, targetProtocol: 'http', targetPort: 80 },
          ],
        } as never,
        'INVALID_INPUT',
        'protocol',
      ],
      [
        { ...base, healthCheck: { protocol: 'http', port: 80, path: 'healthz' } },
        'INVALID_INPUT',
        'healthCheck',
      ],
      [{ ...base, sourceRanges: { allow: ['not-a-cidr'] } }, 'INVALID_INPUT', 'sourceRanges'],
      [
        { ...base, stickySessions: { cookieName: 'a b', ttlSeconds: 1 } },
        'INVALID_INPUT',
        'stickySessions',
      ],
      [{ ...base, targets: { machines: ['x1'] } }, 'INVALID_INPUT', 'machineId'],
      [
        { ...base, targets: { loadBalancers: ['3c6d6c1a-0000-4000-8000-000000000001'] } },
        'INVALID_INPUT',
        'targets',
      ],
      [{ ...base, domains: [{ name: 'example.com' }] }, 'INVALID_INPUT', 'domains'],
      [{ ...base, id: 'nope' }, 'INVALID_INPUT', 'loadBalancerId'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.loadBalancers.ensureLoadBalancer(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('a target that is not an instance of this deployment, or in another region, is refused before any write', async () => {
    const { emu, impl } = await setup();
    const ours = host(emu);
    const bare = host(emu, { tags: [] });
    const foreign = host(emu, { tags: [deploymentTag('other'), instanceTag('ins_9')] });
    const managedOnly = host(emu, { tags: [deployment] });
    const elsewhere = host(emu, { region: 'sfo3' });
    for (const target of [bare, foreign, managedOnly]) {
      const error = await failure(
        impl.loadBalancers.ensureLoadBalancer(spec([ours, target]), ctx()),
      );
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notInstance']);
    }
    const region = await failure(
      impl.loadBalancers.ensureLoadBalancer(spec([ours, elsewhere]), ctx()),
    );
    expect([region.code, region.details?.reason]).toEqual(['INVALID_INPUT', 'region']);
    const gone = await failure(
      impl.loadBalancers.ensureLoadBalancer(
        { ...spec([ours]), targets: { machines: ['999999'] } },
        ctx(),
      ),
    );
    expect([gone.code, gone.details?.reason]).toEqual(['NOT_FOUND', 'machine']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('a target outside the load balancer VPC is refused before any write (DO balances only to its own VPC)', async () => {
    const { emu, impl } = await setup();
    const vpc = seedVpc(emu.state, {
      name: 'bc-sub1',
      region: 'nyc3',
      ip_range: '10.20.0.0/20',
      description: 'bc:network=bc-net1',
    });
    const inSubnet = seedDroplet(emu.state, {
      region: 'nyc3',
      vpc_uuid: vpc.id,
      tags: [deployment, instanceTag('ins_1')],
    });
    const inDefault = host(emu, { instance: 'ins_2' });
    const subnet = { network: { network: 'bc-net1', subnet: 'bc-sub1' } };
    // No network: the region's default VPC, which the subnet's Droplet is not in.
    const outside = await failure(impl.loadBalancers.ensureLoadBalancer(spec([inSubnet]), ctx()));
    expect([outside.code, outside.details?.reason]).toEqual(['INVALID_INPUT', 'vpc']);
    // On the subnet: the default VPC's Droplet is outside it.
    const mixed = await failure(
      impl.loadBalancers.ensureLoadBalancer(spec([inSubnet, inDefault], subnet), ctx()),
    );
    expect([mixed.code, mixed.details?.reason]).toEqual(['INVALID_INPUT', 'vpc']);
    expect(writes(emu)).toHaveLength(0);
    // The emulator answers as DO does when asked anyway: a 422.
    const raw = await emu.fetch('https://api.digitalocean.com/v2/load_balancers', {
      method: 'POST',
      headers: { authorization: 'Bearer do-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'raw',
        region: 'nyc3',
        forwarding_rules: [
          { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 },
        ],
        droplet_ids: [inSubnet.id],
      }),
    });
    expect(raw.status).toBe(422);
    emu.requests.length = 0;
    // Each in its own VPC is made, and an existing one keeps refusing a Droplet of another VPC.
    const onSubnet = await impl.loadBalancers.ensureLoadBalancer(spec([inSubnet], subnet), ctx());
    expect(emu.state.loadBalancers.get(onSubnet.id!)!.vpc_uuid).toBe(vpc.id);
    const later = await failure(
      impl.loadBalancers.ensureLoadBalancer(
        { ...spec([inSubnet, inDefault]), id: onSubnet.id! },
        ctx(),
      ),
    );
    expect([later.code, later.details?.reason]).toEqual(['INVALID_INPUT', 'vpc']);
    await impl.loadBalancers.ensureLoadBalancer(
      { ...spec([inDefault]), name: 'bc-lb2' },
      ctx(),
    );
    expect(writes(emu)).toHaveLength(2);
  });

  it('a certificate that is not one of this deployment, or is gone, is refused before any write', async () => {
    const { emu, impl } = await setup();
    const ours = host(emu);
    const foreignId = '2a9d9a3c-0000-4000-8000-00000000f00d';
    emu.state.certificates.set(foreignId, { id: foreignId, name: 'operator-cert' });
    const tls = (certificate: string) =>
      spec([ours], {
        forwarding: [
          { entryProtocol: 'https', entryPort: 443, targetProtocol: 'http', targetPort: 80, certificate },
        ],
      });
    const foreign = await failure(impl.loadBalancers.ensureLoadBalancer(tls(foreignId), ctx()));
    expect([foreign.code, foreign.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const gone = await failure(
      impl.loadBalancers.ensureLoadBalancer(tls('2a9d9a3c-0000-4000-8000-0000000000aa'), ctx()),
    );
    expect([gone.code, gone.details?.reason]).toEqual(['NOT_FOUND', 'certificate']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('finds a GPU Droplet target that a tag list leaves out', async () => {
    const { emu, impl } = await setup();
    const targets = [host(emu), host(emu, { instance: 'ins_2' }), host(emu, { instance: 'ins_3' })];
    const gpu = host(emu, { instance: 'ins_4', size_slug: 'gpu-h100x1-80gb' });
    const made = await impl.loadBalancers.ensureLoadBalancer(spec([...targets, gpu]), ctx());
    expect(made.state).toBe('pending');
    expect(calls(emu, 'GET', /^\/v2\/droplets$/)).toHaveLength(1);
    expect(calls(emu, 'GET', new RegExp(`^/v2/droplets/${gpu.id}$`))).toHaveLength(1);
    expect(calls(emu, 'POST', /^\/v2\/load_balancers$/)[0]!.body.droplet_ids).toContain(gpu.id);
  });

  it('keeps the oldest of two load balancers of ours with one name and deletes the other', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const name = loadBalancerName('bc-lb1', 'default');
    const older = seedLoadBalancer(emu.state, {
      name,
      created_at: '2026-11-05T09:00:00Z',
      droplet_ids: [a.id],
    });
    const younger = seedLoadBalancer(emu.state, {
      name,
      created_at: '2026-11-05T09:30:00Z',
      droplet_ids: [a.id],
    });
    // A hand-made one with the bare name is not ours and is never touched.
    const hand = seedLoadBalancer(emu.state, {
      name: 'bc-lb1',
      created_at: '2026-11-05T08:00:00Z',
    });
    const found = await impl.loadBalancers.ensureLoadBalancer(spec([a]), ctx());
    expect(found.id).toBe(older.id);
    expect(calls(emu, 'DELETE', /load_balancers/).map((r) => r.url.pathname)).toEqual([
      `/v2/load_balancers/${younger.id}`,
    ]);
    expect(emu.state.loadBalancers.has(hand.id)).toBe(true);
    expect(calls(emu, 'POST', /load_balancers/)).toHaveLength(0);
  });

  it('an id that names a load balancer of another deployment or name is INVALID_STATE', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const hand = seedLoadBalancer(emu.state, { name: 'bc-lb1' });
    const other = seedLoadBalancer(emu.state, { name: loadBalancerName('bc-lb9', 'default') });
    for (const lb of [hand, other]) {
      const error = await failure(
        impl.loadBalancers.ensureLoadBalancer({ ...spec([a]), id: lb.id }, ctx()),
      );
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    }
    expect(writes(emu)).toHaveLength(0);
  });

  it('an id that is gone falls back to the name, and creates when nothing has it', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const made = await impl.loadBalancers.ensureLoadBalancer(
      { ...spec([a]), id: '3c6d6c1a-0000-4000-8000-000000000001' },
      ctx(),
    );
    expect(made.state).toBe('pending');
    expect(calls(emu, 'POST', /load_balancers/)).toHaveLength(1);
  });

  it('maps the account load balancer limit to QUOTA_EXCEEDED', async () => {
    const emu = emulator();
    emu.loadBalancerLimit = 0;
    const { impl } = await setup(emu);
    const error = await failure(impl.loadBalancers.ensureLoadBalancer(spec([host(emu)]), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['QUOTA_EXCEEDED', 'loadBalancerLimit']);
  });

  it('reports an errored load balancer as error', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const lb = seedLoadBalancer(emu.state, {
      name: loadBalancerName('bc-lb1', 'default'),
      status: 'errored',
      droplet_ids: [a.id],
    });
    const state = await impl.loadBalancers.ensureLoadBalancer(spec([a]), ctx());
    expect(state).toMatchObject({
      id: lb.id,
      state: 'error',
      message: expect.stringContaining('errored'),
    });
  });
});

describe('provider-digitalocean load balancers: change in place', () => {
  async function made(emu: DoEmulator, impl: DoCompute, targets: Json[]) {
    const first = await impl.loadBalancers.ensureLoadBalancer(spec(targets), ctx());
    await impl.loadBalancers.getLoadBalancer(first.id, ctx());
    emu.requests.length = 0;
    return first.id;
  }

  it('replaces the forwarding rules and targets in one PUT that keeps what the spec does not set', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const b = host(emu, { instance: 'ins_2' });
    const id = await made(emu, impl, [a]);
    emu.state.loadBalancers.get(id)!.http_idle_timeout_seconds = 120;
    emu.state.loadBalancers.get(id)!.size_unit = 3;
    const changed = spec([a, b], {
      forwarding: [
        { entryProtocol: 'tcp', entryPort: 5432, targetProtocol: 'tcp', targetPort: 5432 },
      ],
    });
    const state = await impl.loadBalancers.ensureLoadBalancer({ ...changed, id }, ctx());
    expect(state).toMatchObject({ id, state: 'updating' });
    const [put] = calls(emu, 'PUT', /load_balancers/);
    expect(put!.body).toMatchObject({
      name: loadBalancerName('bc-lb1', 'default'),
      region: 'nyc3',
      network: 'EXTERNAL',
      vpc_uuid: emu.state.loadBalancers.get(id)!.vpc_uuid,
      size_unit: 3,
      http_idle_timeout_seconds: 120,
      forwarding_rules: [
        { entry_protocol: 'tcp', entry_port: 5432, target_protocol: 'tcp', target_port: 5432 },
      ],
      droplet_ids: [a.id, b.id].sort((x, y) => x - y),
    });
    expect(emu.state.loadBalancers.get(id)!.health_check.path).toBe('/healthz');
    expect(await impl.loadBalancers.ensureLoadBalancer({ ...changed, id }, ctx())).toMatchObject({
      state: 'ready',
    });
    expect(calls(emu, 'PUT', /load_balancers/)).toHaveLength(1);
  });

  it('keeps the provider health check when the spec gives none, and sends no PUT when nothing changed', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const id = await made(emu, impl, [a]);
    const { healthCheck: _, ...noCheck } = spec([a]);
    expect((await impl.loadBalancers.ensureLoadBalancer({ ...noCheck, id }, ctx())).state).toBe(
      'ready',
    );
    expect(writes(emu)).toHaveLength(0);
  });

  it('a load balancer still being made is pending and is not changed yet', async () => {
    const emu = emulator();
    emu.loadBalancerReads = 5;
    const { impl } = await setup(emu);
    const a = host(emu);
    const first = await impl.loadBalancers.ensureLoadBalancer(spec([a]), ctx());
    const again = await impl.loadBalancers.ensureLoadBalancer(
      { ...spec([a], { redirectHttpToHttps: true }), id: first.id },
      ctx(),
    );
    expect(again.state).toBe('pending');
    expect(calls(emu, 'PUT', /load_balancers/)).toHaveLength(0);
  });

  it('a different region, network or internal flag is INVALID_STATE (replace), with no write', async () => {
    const { emu, impl } = await setup();
    const a = host(emu);
    const id = await made(emu, impl, [a]);
    seedVpc(emu.state, {
      name: 'bc-sub2',
      region: 'nyc3',
      ip_range: '10.30.0.0/20',
      description: 'bc:network=bc-net2',
    });
    const sfo = host(emu, { region: 'sfo3', instance: 'ins_5' });
    const changes: ProviderLoadBalancerSpec[] = [
      { ...spec([a], { internal: true }), id },
      { ...spec([a], { network: { network: 'bc-net2', subnet: 'bc-sub2' } }), id },
      { ...spec([sfo], { region: 'sfo3' }), id },
    ];
    for (const change of changes) {
      const error = await failure(impl.loadBalancers.ensureLoadBalancer(change, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(change)).toEqual([
        'INVALID_STATE',
        'replace',
      ]);
    }
    expect(writes(emu)).toHaveLength(0);
  });
});

describe('provider-digitalocean load balancers: delete', () => {
  it('deletes a load balancer of ours, and a gone one counts as deleted', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.loadBalancers.ensureLoadBalancer(spec([host(emu)]), ctx());
    expect(await impl.loadBalancers.deleteLoadBalancer(id, ctx())).toEqual({
      id,
      state: 'deleted',
    });
    expect(emu.state.loadBalancers.has(id)).toBe(false);
    expect(await impl.loadBalancers.deleteLoadBalancer(id, ctx())).toEqual({
      id,
      state: 'deleted',
    });
    expect(await impl.loadBalancers.getLoadBalancer(id, ctx())).toBe(undefined);
    expect(calls(emu, 'DELETE', /load_balancers/)).toHaveLength(1);
  });

  it('never deletes a load balancer that is not ours; no DELETE is sent', async () => {
    const { emu, impl } = await setup();
    const hand = seedLoadBalancer(emu.state, { name: 'bc-lb1' });
    const otherDeployment = seedLoadBalancer(emu.state, {
      name: loadBalancerName('bc-lb1', 'other'),
    });
    for (const lb of [hand, otherDeployment]) {
      const error = await failure(impl.loadBalancers.deleteLoadBalancer(lb.id, ctx()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    }
    expect(calls(emu, 'DELETE', /load_balancers/)).toHaveLength(0);
    const malformed = await failure(impl.loadBalancers.deleteLoadBalancer('../droplets/1', ctx()));
    expect([malformed.code, malformed.details?.reason]).toEqual([
      'INVALID_INPUT',
      'loadBalancerId',
    ]);
    expect(await impl.loadBalancers.getLoadBalancer('../droplets/1', ctx())).toBe(undefined);
  });

  it('a regional load balancer a global one still targets is CONFLICT', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.loadBalancers.ensureLoadBalancer(spec([host(emu)]), ctx());
    seedLoadBalancer(emu.state, { type: 'GLOBAL', name: 'g', target_load_balancer_ids: [id] });
    const error = await failure(impl.loadBalancers.deleteLoadBalancer(id, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['CONFLICT', 'inUse']);
  });
});

it('never logs the token', async () => {
  const lines: string[] = [];
  const log = {
    debug: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
    info: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
    warn: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
    error: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
  };
  const emu = emulator();
  const impl = await build(emu, { ...doAccount, regions: ['nyc3'] }, {}, { log });
  const a = host(emu);
  const { id } = await impl.loadBalancers.ensureLoadBalancer(spec([a]), ctx());
  await impl.loadBalancers.deleteLoadBalancer(id, ctx());
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join('\n')).not.toContain('do-token');
});

describe('provider-digitalocean load balancers: global', () => {
  async function regional(emu: DoEmulator, impl: DoCompute, name = 'bc-lb1', region = 'nyc3') {
    const target = host(emu, { region, instance: `ins-${name}` });
    const made = await impl.loadBalancers.ensureLoadBalancer(
      spec([target], { name, region }),
      ctx(),
    );
    await impl.loadBalancers.getLoadBalancer(made.id, ctx());
    return made.id;
  }

  const global = (targets: string[], extra: Partial<ProviderLoadBalancerSpec> = {}) =>
    ({
      name: 'bc-glb1',
      scope: 'global',
      forwarding: [
        { entryProtocol: 'http', entryPort: 80, targetProtocol: 'http', targetPort: 80 },
      ],
      targets: { loadBalancers: targets },
      domains: [{ name: 'app.example.com' }],
      ...extra,
    }) as ProviderLoadBalancerSpec;

  it('fronts regional load balancers of ours, with unmanaged domains', async () => {
    const { emu, impl } = await setup();
    emu.state.certificates.set(certId, { id: certId, name: certificateName('c', 'default') });
    const nyc = await regional(emu, impl);
    const sfo = await regional(emu, impl, 'bc-lb2', 'sfo3');
    emu.requests.length = 0;
    const made = await impl.loadBalancers.ensureLoadBalancer(
      global([sfo, nyc], { domains: [{ name: 'App.Example.com', certificate: certId }] }),
      ctx(),
    );
    expect(made).toEqual({
      id: expect.any(String),
      state: 'pending',
      outputs: { scope: 'global' },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/load_balancers$/);
    expect(post!.body).toEqual({
      name: loadBalancerName('bc-glb1', 'default'),
      type: 'GLOBAL',
      forwarding_rules: [
        { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 },
      ],
      redirect_http_to_https: false,
      domains: [{ name: 'app.example.com', is_managed: false, certificate_id: certId }],
      glb_settings: { target_protocol: 'http', target_port: 80 },
      target_load_balancer_ids: [nyc, sfo].sort(),
    });
    const ready = await impl.loadBalancers.getLoadBalancer(made.id, ctx());
    expect(ready).toEqual({
      id: made.id,
      state: 'ready',
      outputs: { scope: 'global', address: expect.stringMatching(/^192\.0\.2\./) },
    });
    // The regional one it fronts is in use: deleting it is CONFLICT until the global one goes.
    expect((await failure(impl.loadBalancers.deleteLoadBalancer(nyc, ctx()))).code).toBe(
      'CONFLICT',
    );
    expect(await impl.loadBalancers.deleteLoadBalancer(made.id, ctx())).toEqual({
      id: made.id,
      state: 'deleted',
    });
    expect((await impl.loadBalancers.deleteLoadBalancer(nyc, ctx())).state).toBe('deleted');
  });

  it('changes targets and domains in one PUT that keeps the CDN and region priorities', async () => {
    const { emu, impl } = await setup();
    const nyc = await regional(emu, impl);
    const sfo = await regional(emu, impl, 'bc-lb2', 'sfo3');
    const { id } = await impl.loadBalancers.ensureLoadBalancer(global([nyc]), ctx());
    await impl.loadBalancers.getLoadBalancer(id, ctx());
    const stored = emu.state.loadBalancers.get(id)!;
    stored.glb_settings = {
      ...stored.glb_settings,
      cdn: { is_enabled: true },
      region_priorities: { nyc3: 1 },
    };
    emu.requests.length = 0;
    const changed = global([nyc, sfo], {
      domains: [{ name: 'app.example.com' }, { name: 'www.example.com' }],
    });
    expect((await impl.loadBalancers.ensureLoadBalancer({ ...changed, id }, ctx())).state).toBe(
      'updating',
    );
    const [put] = calls(emu, 'PUT', /load_balancers/);
    expect(put!.body).toMatchObject({
      type: 'GLOBAL',
      target_load_balancer_ids: [nyc, sfo].sort(),
      glb_settings: {
        target_protocol: 'http',
        target_port: 80,
        cdn: { is_enabled: true },
        region_priorities: { nyc3: 1 },
      },
    });
    expect(put!.body).not.toHaveProperty('region');
    expect((await impl.loadBalancers.ensureLoadBalancer({ ...changed, id }, ctx())).state).toBe(
      'ready',
    );
    expect(calls(emu, 'PUT', /load_balancers/)).toHaveLength(1);
  });

  it('never fronts a load balancer that is not ours, a global one, or a missing one', async () => {
    const { emu, impl } = await setup();
    const hand = seedLoadBalancer(emu.state, { name: 'their-lb' });
    const otherGlobal = seedLoadBalancer(emu.state, {
      type: 'GLOBAL',
      name: loadBalancerName('bc-glb9', 'default'),
    });
    emu.requests.length = 0;
    const foreign = await failure(impl.loadBalancers.ensureLoadBalancer(global([hand.id]), ctx()));
    expect([foreign.code, foreign.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const nested = await failure(
      impl.loadBalancers.ensureLoadBalancer(global([otherGlobal.id]), ctx()),
    );
    expect([nested.code, nested.details?.reason]).toEqual(['INVALID_INPUT', 'targets']);
    const missing = await failure(
      impl.loadBalancers.ensureLoadBalancer(
        global(['3c6d6c1a-0000-4000-8000-000000000001']),
        ctx(),
      ),
    );
    expect([missing.code, missing.details?.reason]).toEqual(['NOT_FOUND', 'loadBalancer']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('refuses what only a regional one has, before any request', async () => {
    const { emu, impl } = await setup();
    const target = '3c6d6c1a-0000-4000-8000-000000000001';
    const tcp = [{ entryProtocol: 'tcp', entryPort: 80, targetProtocol: 'tcp', targetPort: 80 }];
    const refusals: [ProviderLoadBalancerSpec, string, string][] = [
      [global([target], { region: 'nyc3' }), 'INVALID_INPUT', 'region'],
      [global([target], { internal: true }), 'INVALID_INPUT', 'globalField'],
      [
        global([target], { sourceRanges: { allow: ['198.51.100.0/24'] } }),
        'INVALID_INPUT',
        'globalField',
      ],
      [
        global([target], { stickySessions: { cookieName: 'c', ttlSeconds: 1 } }),
        'INVALID_INPUT',
        'globalField',
      ],
      [global([target], { network: { network: 'n' } }), 'INVALID_INPUT', 'globalField'],
      [{ ...global([]), targets: { machines: ['1'] } }, 'INVALID_INPUT', 'targets'],
      [global([]), 'INVALID_INPUT', 'targets'],
      [global([target], { domains: [] }), 'INVALID_INPUT', 'domains'],
      [global([target], { domains: [{ name: 'not a host' }] }), 'INVALID_INPUT', 'domains'],
      [
        global([target], { domains: [{ name: 'a.example.com', certificate: 'x' }] }),
        'INVALID_INPUT',
        'certificate',
      ],
      [global([target], { forwarding: tcp } as never), 'INVALID_INPUT', 'protocol'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.loadBalancers.ensureLoadBalancer(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('a regional spec for a global load balancer, or the other way round, is INVALID_STATE (replace)', async () => {
    const { emu, impl } = await setup();
    const nyc = await regional(emu, impl);
    const { id } = await impl.loadBalancers.ensureLoadBalancer(global([nyc]), ctx());
    const toRegional = await failure(
      impl.loadBalancers.ensureLoadBalancer(
        { ...spec([host(emu)], { name: 'bc-glb1' }), id },
        ctx(),
      ),
    );
    expect([toRegional.code, toRegional.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    const toGlobal = await failure(
      impl.loadBalancers.ensureLoadBalancer(
        { ...global([nyc], { name: 'bc-lb1' }), id: nyc },
        ctx(),
      ),
    );
    expect([toGlobal.code, toGlobal.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
  });
});
