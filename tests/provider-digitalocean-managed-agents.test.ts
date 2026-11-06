import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ComputeError } from '@better-compute/core';
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/vps';
import { deploymentTag, digitaloceanProvider } from '@better-compute/provider-digitalocean';
import {
  seedActionGateway,
  seedHarness,
  seedSignal,
} from './support/do-emulator/managed-agents.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean's Managed Agents kinds (P8 task 5, preview) against the emulator: Harness Runtime agents
// (do.agent-harness, on a container or a MicroVM) and Action Gateways (do.action-gateway). Both are DigitalOcean
// previews, so they are refused, with nothing sent, unless the account sets previews: true.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const previewAccount = { ...doAccount, regions: ['tor1'], previews: true };
const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_agent',
  'better-compute-tenant': 'acme',
};
const hash = deploymentTag('default').split(':')[1]!;
const mutations = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

async function settle(resources: any, req: any, call: CallContext) {
  let state = await resources.ensure(req, call);
  for (let round = 0; round < 10 && !['ready', 'error'].includes(state.state); round++)
    state = await resources.ensure({ ...req, id: state.id }, call);
  return state;
}

beforeEach(freshBudgets);

const harnessSpec = {
  region: 'tor1',
  model: 'llama3.3-70b-instruct',
  instructions: 'You answer billing questions.',
};
const gatewaySpec = { region: 'tor1', upstreams: ['https://tools.example.com/v1/'] };

describe('Managed Agents are previews', () => {
  it('both kinds say so, and every call is refused with nothing sent unless the account enables previews', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const kinds = resources.kinds().filter((entry) => entry.preview === true);
    expect(kinds.map((entry) => entry.kind).sort()).toEqual([
      'do.action-gateway',
      'do.agent-harness',
    ]);
    const before = emu.requests.length;
    for (const [kind, spec] of [
      ['do.agent-harness', harnessSpec],
      ['do.action-gateway', gatewaySpec],
    ] as const) {
      const refusals = [
        await failure(resources.ensure({ kind, name: 'bc-r-a', spec, labels }, ctx())),
        await failure(resources.get(kind, '0b6c3a4e-1111-4222-8333-444455556666', ctx())),
        await failure(resources.delete(kind, '0b6c3a4e-1111-4222-8333-444455556666', ctx())),
        await failure(
          (async () => {
            for await (const _ of resources.discover!(kind, ctx())) void _;
          })(),
        ),
      ];
      for (const error of refusals) {
        expect(error.code).toBe('UNSUPPORTED');
        expect(error.details?.reason).toBe('preview');
      }
    }
    expect(emu.requests.slice(before)).toEqual([]);
  });
});

describe('ProviderResources conformance: do.agent-harness', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedHarness(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: previewAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.agent-harness',
      spec: harnessSpec,
      updatedSpec: { ...harnessSpec, instructions: 'You answer support questions.' },
      replaceSpec: { ...harnessSpec, runtime: 'microvm' },
      unmanaged: unmanaged.uuid,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('ProviderResources conformance: do.action-gateway', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedActionGateway(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: previewAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.action-gateway',
      spec: gatewaySpec,
      updatedSpec: { ...gatewaySpec, upstreams: ['https://tools.example.com/v2/'] },
      replaceSpec: { ...gatewaySpec, region: 'nyc3' },
      unmanaged: unmanaged.uuid,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.agent-harness', () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.agent-harness',
    name: 'bc-r-agent',
    spec: harnessSpec,
    labels,
    ...extra,
  });
  const call = (): CallContext => ctx('crs_agent');

  it('is a regional ai preview; MicroVM is a runtime choice; attachments are account-wide', async () => {
    const { resources } = await build(emulator(), previewAccount);
    const kind = resources.kinds().find((entry) => entry.kind === 'do.agent-harness')!;
    expect(kind).toMatchObject({
      family: 'ai',
      regional: true,
      preview: true,
      outputs: ['status', 'endpoint'],
      updatable: ['model', 'instructions', 'knowledgeBases', 'guardrails', 'actionGateway'],
      meters: [{ meter: 'do.agent-harness.hours', unit: 'hour' }],
    });
    expect(kind.accountWide!(harnessSpec)).toEqual([]);
    expect(
      kind.accountWide!({
        ...harnessSpec,
        knowledgeBases: ['5a4981aa-9653-4bd1-bef5-d6bff52042e4'],
        actionGateway: '6b4981aa-9653-4bd1-bef5-d6bff52042e4',
      }),
    ).toEqual(['knowledgeBases', 'actionGateway']);
  });

  it('creates a harness named for this deployment on a MicroVM; ready once running; a retry finds it', async () => {
    const emu = emulator();
    const { resources } = await build(emu, previewAccount);
    const spec = { ...harnessSpec, runtime: 'microvm' };
    const first = await resources.ensure(request({ spec }), call());
    expect(first.state).toBe('pending');
    expect(mutations(emu, 'POST', /harnesses$/).map((r) => r.body)).toEqual([
      {
        name: `bc-r-agent-bc${hash}`,
        region: 'tor1',
        model: 'llama3.3-70b-instruct',
        instructions: 'You answer billing questions.',
        runtime: 'MICROVM',
        knowledge_base_uuids: [],
        guardrail_uuids: [],
      },
    ]);
    const ready = await settle(resources, request({ id: first.id, spec }), call());
    expect(ready).toMatchObject({
      state: 'ready',
      outputs: { status: 'RUNNING', endpoint: emu.state.harnesses.get(first.id)!.endpoint },
      usage: { 'do.agent-harness.hours': 1 },
      spec: { ...spec },
    });
    expect((await resources.ensure(request({ spec }), call())).id).toBe(first.id);
    expect(mutations(emu, 'POST', /harnesses/)).toHaveLength(1);
    expect((await resources.get('do.agent-harness', first.id, call()))?.managedBy).toBe('this');
  });

  it('a model or instructions change is one PUT, then updating; region and runtime are replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu, previewAccount);
    const ready = await settle(resources, request(), call());
    const changed = { ...harnessSpec, model: 'deepseek-r1-distill-llama-70b' };
    const updating = await resources.ensure(request({ id: ready.id, spec: changed }), call());
    expect(updating.state).toBe('updating');
    expect(mutations(emu, 'PUT', /harnesses\//).map((r) => r.body)).toEqual([
      { model: 'deepseek-r1-distill-llama-70b' },
    ]);
    const after = await settle(resources, request({ id: ready.id, spec: changed }), call());
    expect(after).toMatchObject({ state: 'ready', spec: changed });
    expect(mutations(emu, 'PUT', /harnesses\//)).toHaveLength(1);
    for (const [field, spec] of [
      ['region', { ...changed, region: 'nyc3' }],
      ['runtime', { ...changed, runtime: 'microvm' }],
    ] as const)
      expect(
        (await failure(resources.ensure(request({ id: ready.id, spec }), call()))).details,
      ).toMatchObject({ reason: 'replaceRequired', field });
    expect(mutations(emu, 'PUT', /harnesses\//)).toHaveLength(1);
  });

  it('knowledge bases, guardrails and a gateway only on the tenant’s own account; there they attach and detach', async () => {
    const emu = emulator();
    const { resources } = await build(emu, previewAccount);
    const kb = '5a4981aa-9653-4bd1-bef5-d6bff52042e4';
    const gateway = '6b4981aa-9653-4bd1-bef5-d6bff52042e4';
    const attached = { ...harnessSpec, knowledgeBases: [kb], actionGateway: gateway };
    const shared = await failure(resources.ensure(request({ spec: attached }), call()));
    expect(shared.details).toMatchObject({
      reason: 'accountWide',
      fields: ['knowledgeBases', 'actionGateway'],
    });
    expect(mutations(emu, 'POST', /harnesses/)).toEqual([]);
    const own = { accountScope: 'tenant' as const };
    const ready = await settle(resources, request({ ...own, spec: attached }), call());
    expect(mutations(emu, 'POST', /harnesses$/)[0]!.body).toMatchObject({
      knowledge_base_uuids: [kb],
      action_gateway_uuid: gateway,
    });
    expect(ready.spec).toEqual(attached);
    await resources.ensure(request({ ...own, id: ready.id, spec: harnessSpec }), call());
    expect(mutations(emu, 'PUT', /harnesses\//).map((r) => r.body)).toEqual([
      { knowledge_base_uuids: [], action_gateway_uuid: null },
    ]);
    expect(emu.state.harnesses.get(ready.id)).not.toHaveProperty('action_gateway_uuid');
  });

  it('leaves harnesses made by hand or by another deployment alone', async () => {
    const emu = emulator();
    const { resources } = await build(emu, previewAccount);
    const byHand = seedHarness(emu.state);
    const foreign = seedHarness(emu.state, { name: 'bc-r-agent-bc0123456789ab' });
    const created = await resources.ensure(request(), call());
    expect(created.id).not.toBe(foreign.uuid);
    for (const id of [byHand.uuid, foreign.uuid])
      expect(
        (await failure(resources.delete('do.agent-harness', id, call()))).details?.reason,
      ).toBe('notManaged');
    expect(
      (await failure(resources.ensure(request({ id: foreign.uuid }), call()))).details?.reason,
    ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /harnesses/)).toEqual([]);
    expect(mutations(emu, 'PUT', /harnesses/)).toEqual([]);
  });
});

describe('do.action-gateway', () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.action-gateway',
    name: 'bc-r-tools',
    spec: gatewaySpec,
    labels,
    ...extra,
  });
  const call = (): CallContext => ctx('crs_tools');

  it('is a regional ai preview whose upstreams and description change in place', async () => {
    const { resources } = await build(emulator(), previewAccount);
    expect(resources.kinds().find((entry) => entry.kind === 'do.action-gateway')).toMatchObject({
      family: 'ai',
      regional: true,
      preview: true,
      outputs: ['status', 'endpoint'],
      updatable: ['upstreams', 'description'],
      meters: [{ meter: 'do.action-gateway.hours', unit: 'hour' }],
    });
  });

  it('creates, settles, and changes its upstreams with one PUT', async () => {
    const emu = emulator();
    const { resources } = await build(emu, previewAccount);
    const ready = await settle(resources, request(), call());
    expect(mutations(emu, 'POST', /action-gateways$/).map((r) => r.body)).toEqual([
      {
        name: `bc-r-tools-bc${hash}`,
        region: 'tor1',
        upstreams: [{ url: 'https://tools.example.com/v1/' }],
      },
    ]);
    expect(ready).toMatchObject({
      state: 'ready',
      outputs: { status: 'ACTIVE' },
      spec: gatewaySpec,
    });
    const changed = {
      ...gatewaySpec,
      upstreams: ['https://tools.example.com/v1/', 'https://crm.example.com/'],
      description: 'Billing tools',
    };
    expect((await resources.ensure(request({ id: ready.id, spec: changed }), call())).state).toBe(
      'updating',
    );
    expect(mutations(emu, 'PUT', /action-gateways\//).map((r) => r.body)).toEqual([
      {
        upstreams: [{ url: 'https://tools.example.com/v1/' }, { url: 'https://crm.example.com/' }],
        description: 'Billing tools',
      },
    ]);
    expect(await settle(resources, request({ id: ready.id, spec: changed }), call())).toMatchObject(
      { state: 'ready', spec: changed },
    );
  });

  it('only https upstreams validate, at least one', async () => {
    const { resources } = await build(emulator(), previewAccount);
    const kind = resources.kinds().find((entry) => entry.kind === 'do.action-gateway')!;
    for (const upstreams of [[], ['http://tools.example.com/'], ['file:///etc/passwd']])
      expect(
        (await kind.spec['~standard'].validate({ ...gatewaySpec, upstreams })).issues,
      ).toBeDefined();
  });
});

describe('Managed Agents signals (read-only)', () => {
  it('are refused with nothing sent unless the account enables previews', async () => {
    const emu = emulator();
    seedSignal(emu.state);
    const { resources } = await build(emu);
    const before = emu.requests.length;
    const error = await failure(resources.signals!(ctx()));
    expect(error).toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'preview' } });
    expect(emu.requests.slice(before)).toEqual([]);
  });

  it('map to provider-neutral signals with GETs only; malformed and unknown ones are dropped', async () => {
    const emu = emulator();
    const harness = seedHarness(emu.state);
    const gateway = seedActionGateway(emu.state);
    seedSignal(emu.state, {
      uuid: 'sig-1',
      resource_uuid: harness.uuid,
      type: 'RUN_FAILED',
      message: 'The run stopped: the model timed out.',
      created_at: '2026-11-05T09:00:00Z',
    });
    seedSignal(emu.state, {
      uuid: 'sig-2',
      resource_type: 'ACTION_GATEWAY',
      resource_uuid: gateway.uuid,
      type: 'UPSTREAM_UNREACHABLE',
      severity: 'WARNING',
      message: `line one\u0000\u001b[31m${'x'.repeat(2000)}`,
      created_at: '2026-11-05T09:30:00Z',
    });
    seedSignal(emu.state, { uuid: 'sig-3', type: 'HUMAN_INPUT_REQUESTED', message: undefined });
    // Dropped: an unknown resource type, an id that is not one, a time that is not one.
    seedSignal(emu.state, { uuid: 'sig-4', resource_type: 'DATABASE' });
    seedSignal(emu.state, { uuid: 'bad id with spaces' });
    seedSignal(emu.state, { uuid: 'sig-6', created_at: 'yesterday' });
    const { resources } = await build(emu, previewAccount);
    const before = emu.requests.length;
    const signals = await resources.signals!(ctx());
    expect(emu.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);
    expect(signals.map((s) => s.id)).toEqual(['sig-1', 'sig-2', 'sig-3']);
    expect(signals[0]).toEqual({
      id: 'sig-1',
      kind: 'do.agent-harness',
      resourceId: harness.uuid,
      severity: 'critical',
      title: 'Run failed',
      detail: 'The run stopped: the model timed out.',
      at: Date.parse('2026-11-05T09:00:00Z'),
    });
    expect(signals[1]).toMatchObject({
      kind: 'do.action-gateway',
      resourceId: gateway.uuid,
      severity: 'warning',
      title: 'Upstream unreachable',
    });
    expect(signals[1]!.detail).toHaveLength(500);
    expect(signals[1]!.detail).not.toMatch(/[\u0000-\u001f]/);
    expect(signals[2]).toMatchObject({ severity: 'warning', title: 'Human input requested' });
    expect(signals[2]).not.toHaveProperty('detail');
  });

  it('over 500 signals, every page is read and the newest 500 are kept', async () => {
    const emu = emulator();
    const harness = seedHarness(emu.state);
    const base = Date.parse('2026-11-01T00:00:00Z');
    for (let n = 0; n < 650; n++)
      seedSignal(emu.state, {
        uuid: `sig-${n}`,
        resource_uuid: harness.uuid,
        type: 'RUN_FAILED',
        created_at: new Date(base + n * 60_000).toISOString(),
      });
    const { resources } = await build(emu, previewAccount);
    const before = emu.requests.length;
    const signals = await resources.signals!(ctx());
    expect(signals).toHaveLength(500);
    // Oldest first, as DigitalOcean lists them: the 150 oldest are the ones left out.
    expect(signals[0]!.id).toBe('sig-150');
    expect(signals.at(-1)!.id).toBe('sig-649');
    const reads = emu.requests.slice(before);
    expect(reads.every((r) => r.method === 'GET')).toBe(true);
    expect(reads.length).toBeGreaterThan(1);
  });
});
