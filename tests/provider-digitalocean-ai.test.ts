import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ComputeError } from '@better-compute/core';
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/vps';
import {
  deploymentTag,
  digitaloceanProvider,
  keyTag,
  managedTag,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { seedModelKey } from './support/do-emulator/genai.js';
import { seedEndpoint } from './support/do-emulator/inference.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean's AI platform kinds (P8) against the emulator. Dedicated Inference endpoints: a model on
// dedicated GPUs, booked against the tenant's GPU quota (`quota`), billed by GPU hours of the size's model (`usage`),
// scaled in place and replaced for anything else.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_ep',
  'better-compute-tenant': 'acme',
};
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

beforeEach(freshBudgets);

const endpointSpec = {
  region: 'nyc3',
  model: 'llama3.3-70b-instruct',
  gpuSize: 'gpu-h100x1-80gb',
  replicas: 1,
};

describe('ProviderResources conformance: do.dedicated-inference', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedEndpoint(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.dedicated-inference',
      spec: endpointSpec,
      updatedSpec: { ...endpointSpec, replicas: 2 },
      replaceSpec: { ...endpointSpec, model: 'deepseek-r1-distill-llama-70b' },
      unmanaged: unmanaged.id,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.dedicated-inference', () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.dedicated-inference',
    name: 'bc-r-ep',
    spec: endpointSpec,
    labels,
    ...extra,
  });
  const call = (key = 'crs_ep'): CallContext => ctx(key);
  async function settle(resources: any, req: any, key = 'crs_ep') {
    let state = await resources.ensure(req, call(key));
    for (let round = 0; round < 10 && !['ready', 'error'].includes(state.state); round++)
      state = await resources.ensure({ ...req, id: state.id }, call(key));
    return state;
  }

  it('is an ai kind: regional, scaling in place, GPU meters per model, the GPUs booked against quota', async () => {
    const { resources } = await build(emulator());
    const kind = resources.kinds().find((entry) => entry.kind === 'do.dedicated-inference')!;
    expect(kind).toMatchObject({
      family: 'ai',
      regional: true,
      updatable: ['replicas', 'maxReplicas'],
      outputs: ['status', 'endpoint', 'privateEndpoint', 'model', 'gpuSize', 'replicas'],
    });
    expect(kind.secretOutputs ?? []).toEqual([]);
    expect(kind.meters!.map((meter) => meter.meter)).toEqual(
      expect.arrayContaining([
        'gpu.h100.hours',
        'gpu.h200.hours',
        'gpu.mi300x.hours',
        'gpu.l40s.hours',
      ]),
    );
    // The booking is the most it can scale to: GPUs per replica times the maximum.
    expect(
      kind.quota!({ ...endpointSpec, gpuSize: 'gpu-h100x8-640gb', replicas: 1, maxReplicas: 2 }),
    ).toEqual({
      gpu: 16,
    });
    expect(kind.quota!(endpointSpec)).toEqual({ gpu: 1 });
    expect(
      kind.accountWide!({ ...endpointSpec, vpc: '5a4981aa-9653-4bd1-bef5-d6bff52042e4' }),
    ).toEqual(['vpc']);
    expect(kind.accountWide!(endpointSpec)).toEqual([]);
    const issues = await kind.spec['~standard'].validate({ ...endpointSpec, gpuSize: 'gpu-tiny' });
    expect(issues.issues).toBeDefined();
  });

  it('creates with the ownership tags and scaling; ready has its endpoints and bills GPUs in service', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const first = await resources.ensure(request(), call());
    expect(first.state).toBe('pending');
    const [create] = mutations(emu, 'POST', /\/dedicated-inferences$/);
    expect(create!.body).toEqual({
      name: 'bc-r-ep',
      region: 'nyc3',
      model_slug: 'llama3.3-70b-instruct',
      gpu_size: 'gpu-h100x1-80gb',
      scaling: { min_replicas: 1, max_replicas: 1 },
      public: true,
      tags: expect.arrayContaining([
        managedTag,
        deploymentTag('default'),
        keyTag('crs_ep'),
        tagFor('better-compute-resource', 'crs_ep'),
        tagFor('better-compute-tenant', 'acme'),
      ]),
    });
    // Nothing runs yet: nothing bills.
    expect(first.usage ?? { 'gpu.h100.hours': 0 }).toEqual({ 'gpu.h100.hours': 0 });
    const ready = await settle(resources, request({ id: first.id }));
    expect(ready).toMatchObject({
      id: first.id,
      state: 'ready',
      outputs: {
        status: 'ACTIVE',
        endpoint: `https://${first.id}.inference.do-ai.run`,
        privateEndpoint: `https://${first.id}.private.inference.do-ai.run`,
        model: 'llama3.3-70b-instruct',
        gpuSize: 'gpu-h100x1-80gb',
        replicas: '1',
      },
      usage: { 'gpu.h100.hours': 1 },
      spec: { ...endpointSpec, publicEndpoint: true },
    });
    // A retry without the id finds it by its key tag: one endpoint.
    expect((await resources.ensure(request(), call())).id).toBe(first.id);
    expect(mutations(emu, 'POST', /\/dedicated-inferences$/)).toHaveLength(1);
    // get says who manages it.
    expect((await resources.get('do.dedicated-inference', first.id, call()))?.managedBy).toBe(
      'this',
    );
  });

  it('an 8-GPU size bills eight GPU hours per replica in service', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const spec = { ...endpointSpec, gpuSize: 'gpu-mi300x8-1536gb', replicas: 2, maxReplicas: 3 };
    const ready = await settle(resources, request({ spec }));
    expect(ready.usage).toEqual({ 'gpu.mi300x.hours': 16 });
    expect(ready.spec).toEqual({ ...spec, publicEndpoint: true });
  });

  it('scaling is one PATCH; model, GPU size, region and VPC are replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const ready = await settle(resources, request());
    const scaled = await resources.ensure(
      request({ id: ready.id, spec: { ...endpointSpec, replicas: 2, maxReplicas: 4 } }),
      call(),
    );
    expect(scaled.state).toBe('updating');
    expect(mutations(emu, 'PATCH', /dedicated-inferences/).map((r) => r.body)).toEqual([
      { scaling: { min_replicas: 2, max_replicas: 4 } },
    ]);
    const after = await settle(
      resources,
      request({ id: ready.id, spec: { ...endpointSpec, replicas: 2, maxReplicas: 4 } }),
    );
    expect(after.outputs?.replicas).toBe('2');
    expect(mutations(emu, 'PATCH', /dedicated-inferences/)).toHaveLength(1);
    for (const change of [
      { model: 'mistral-nemo-instruct-2407' },
      { gpuSize: 'gpu-h200x1-141gb' },
      { region: 'ams3' },
    ]) {
      const error = await failure(
        resources.ensure(request({ id: ready.id, spec: { ...endpointSpec, ...change } }), call()),
      );
      expect(error.details).toMatchObject({
        reason: 'replaceRequired',
        field: Object.keys(change)[0],
      });
    }
  });

  it('refuses before any call: a maximum below the minimum, and a VPC on a shared account', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const low = await failure(
      resources.ensure(request({ spec: { ...endpointSpec, replicas: 3, maxReplicas: 2 } }), call()),
    );
    expect(low.code).toBe('INVALID_INPUT');
    expect(low.details?.reason).toBe('replicas');
    const vpc = await failure(
      resources.ensure(
        request({ spec: { ...endpointSpec, vpc: '5a4981aa-9653-4bd1-bef5-d6bff52042e4' } }),
        call(),
      ),
    );
    expect(vpc.details?.reason).toBe('accountWide');
    expect(mutations(emu, 'POST', /dedicated-inferences/)).toEqual([]);
    // On the tenant's own account the VPC goes through as the endpoint's private network.
    await resources.ensure(
      request({
        accountScope: 'tenant',
        spec: { ...endpointSpec, vpc: '5a4981aa-9653-4bd1-bef5-d6bff52042e4' },
      }),
      call(),
    );
    expect(mutations(emu, 'POST', /dedicated-inferences/)[0]!.body.vpc_uuid).toBe(
      '5a4981aa-9653-4bd1-bef5-d6bff52042e4',
    );
  });

  it('a sold-out GPU size is CAPACITY_UNAVAILABLE; a racing create under the name converges on it', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    emu.inferenceSoldOut.add('gpu-h100x1-80gb');
    expect((await failure(resources.ensure(request(), call()))).code).toBe('CAPACITY_UNAVAILABLE');
    emu.inferenceSoldOut.clear();
    // Another worker's create (same key) lands between the lookup and this create.
    emu.beforeAction('POST /dedicated-inferences', () => {
      seedEndpoint(emu.state, {
        name: 'bc-r-ep',
        status: 'PROVISIONING',
        tags: [managedTag, deploymentTag('default'), keyTag('crs_ep')],
      });
    });
    const state = await resources.ensure(request(), call());
    expect(emu.state.dedicatedInferences.size).toBe(1);
    expect(state.id).toBe([...emu.state.dedicatedInferences.keys()][0]);
  });

  it('delete refuses an endpoint made by hand or by another deployment, and sends no DELETE', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedEndpoint(emu.state);
    const foreign = seedEndpoint(emu.state, {
      tags: [managedTag, 'better-compute-deployment:0123456789ab'],
    });
    for (const id of [byHand.id, foreign.id])
      expect(
        (await failure(resources.delete('do.dedicated-inference', id, call()))).details?.reason,
      ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /dedicated-inferences/)).toEqual([]);
    const discovered: any[] = [];
    for await (const found of resources.discover!('do.dedicated-inference', call()))
      discovered.push(found);
    expect(discovered.find((entry) => entry.id === byHand.id)?.managedBy).toBeUndefined();
    expect(discovered.find((entry) => entry.id === foreign.id)?.managedBy).toBe('other');
  });
});

describe('ProviderResources conformance: do.inference-key', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedModelKey(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.inference-key',
      spec: { rotation: 0 },
      updatedSpec: { rotation: 1 },
      unmanaged: unmanaged.uuid,
      // A model access key reaches the whole account: only the tenant's own account may have one.
      accountScope: 'tenant',
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.inference-key (a model access key)', () => {
  const hash = deploymentTag('default').split(':')[1]!;
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.inference-key',
    name: 'bc-r-key',
    spec: { rotation: 0 },
    labels,
    accountScope: 'tenant' as const,
    ...extra,
  });
  const call = (key = 'crs_key'): CallContext => ctx(key);
  const secretOf = (emu: DoEmulator, uuid: string) => emu.state.modelKeys.get(uuid)!._secret;

  it('is an ai kind whose only secret output is the key; rotation is the one updatable field', async () => {
    const { resources } = await build(emulator());
    const kind = resources.kinds().find((entry) => entry.kind === 'do.inference-key')!;
    expect(kind).toMatchObject({
      family: 'ai',
      regional: false,
      outputs: ['endpoint'],
      secretOutputs: ['key'],
      updatable: ['rotation'],
    });
    expect(kind.quota).toBeUndefined();
    // Tokens are not an hourly rate (what kind meters bill): they reach billing through the proxy's record.
    expect(kind.meters ?? []).toEqual([]);
    // An account-wide bearer: declared so the API refuses it on a shared account before recording anything.
    expect(kind.accountWide?.({ rotation: 0 })).toEqual(['rotation']);
  });

  it('is refused on a shared account before any call: the key would reach the whole operator account', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    for (const accountScope of [undefined, 'shared'] as const) {
      const refused = await failure(resources.ensure(request({ accountScope }), call()));
      expect(refused.code).toBe('INVALID_INPUT');
      expect(refused.details).toMatchObject({ reason: 'accountWide', fields: ['rotation'] });
    }
    expect(emu.requests).toEqual([]);
    expect(emu.state.modelKeys.size).toBe(0);
  });

  it('creates a key named for this deployment; its secret comes back once, as a secret output only', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    expect(created.state).toBe('ready');
    const key = emu.state.modelKeys.get(created.id)!;
    expect(key.name).toBe(`bc-r-key-r0-bc${hash}`);
    expect(created.secretOutputs).toEqual({ key: key._secret });
    expect(created.outputs).toEqual({ endpoint: 'https://inference.do-ai.run/v1' });
    expect(JSON.stringify([created.outputs, created.spec, created.message])).not.toContain(
      key._secret,
    );
    // With its id, the key is as it was: no secret, nothing regenerated.
    const again = await resources.ensure(request({ id: created.id }), call());
    expect(again).toMatchObject({ id: created.id, state: 'ready' });
    expect(again.secretOutputs).toBeUndefined();
    expect(mutations(emu, 'PUT', /api_keys/)).toEqual([]);
    expect((await resources.get('do.inference-key', created.id, call()))?.managedBy).toBe('this');
  });

  it('a create whose answer was lost regenerates the key it finds: the unseen secret is never live', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const lost = await resources.ensure(request(), call());
    const unseen = secretOf(emu, lost.id);
    const retried = await resources.ensure(request(), call());
    expect(retried.id).toBe(lost.id);
    expect(emu.state.modelKeys.size).toBe(1);
    expect(retried.secretOutputs?.key).toBe(secretOf(emu, lost.id));
    expect(retried.secretOutputs?.key).not.toBe(unseen);
  });

  it('find answers the key whatever rotation its name carries, never one of another deployment, and sends nothing', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    // Another deployment's key under the same base name, made first: never this deployment's.
    seedModelKey(emu.state, { name: 'bc-r-key-r0-bc0123456789ab' });
    const created = await resources.ensure(request(), call());
    await resources.ensure(request({ id: created.id, spec: { rotation: 2 } }), call());
    const before = emu.requests.length;
    // A teardown whose spec is the stored one (rotation 0) still finds the key renamed to r2.
    expect(await resources.find!(request(), call())).toBe(created.id);
    expect(await resources.find!(request({ name: 'bc-r-none' }), call('crs_none'))).toBe(undefined);
    expect(emu.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('a rotation regenerates the secret and records the rotation in the name', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    const first = created.secretOutputs!.key;
    const rotated = await resources.ensure(
      request({ id: created.id, spec: { rotation: 1 } }),
      call(),
    );
    expect(rotated.state).toBe('ready');
    expect(rotated.secretOutputs?.key).toBe(secretOf(emu, created.id));
    expect(rotated.secretOutputs?.key).not.toBe(first);
    expect(emu.state.modelKeys.get(created.id)!.name).toBe(`bc-r-key-r1-bc${hash}`);
    // Settled: the next ensure regenerates nothing.
    const puts = mutations(emu, 'PUT', /api_keys/).length;
    await resources.ensure(request({ id: created.id, spec: { rotation: 1 } }), call());
    expect(mutations(emu, 'PUT', /api_keys/)).toHaveLength(puts);
  });

  it('a key the caller holds no sealed secret for is minted again; one it holds is left alone', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    const first = secretOf(emu, created.id);
    const held = await resources.ensure(
      request({ id: created.id, secretOutputs: ['key'] }),
      call(),
    );
    expect(held.secretOutputs).toBeUndefined();
    expect(mutations(emu, 'PUT', /api_keys/)).toEqual([]);
    // Its seal failed: the secret DigitalOcean answered is lost, so the key is regenerated and the new one returned.
    const minted = await resources.ensure(request({ id: created.id, secretOutputs: [] }), call());
    expect(minted.state).toBe('ready');
    expect(minted.secretOutputs?.key).toBe(secretOf(emu, created.id));
    expect(minted.secretOutputs?.key).not.toBe(first);
    expect(emu.state.modelKeys.get(created.id)!.name).toBe(`bc-r-key-r0-bc${hash}`);
  });

  it('a rename whose answer is lost after DigitalOcean applied it still returns the new secret', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    // The rename is applied, then its answer is lost (a 5xx after commit).
    emu.beforeAction('PUT /gen-ai/models/api_keys/*', (context) => {
      emu.state.modelKeys.get(decodeURIComponent(context.match[0]!.split('/').pop()!))!.name =
        context.body!.name;
    });
    emu.failNext({ method: 'PUT', path: /^\/gen-ai\/models\/api_keys\/[^/]+$/ }, 500, {
      id: 'server_error',
      message: 'Server Error',
    });
    const rotated = await resources.ensure(
      request({ id: created.id, spec: { rotation: 1 }, secretOutputs: ['key'] }),
      call(),
    );
    expect(rotated.state).toBe('updating');
    expect(rotated.spec).toEqual({ rotation: 0 });
    expect(rotated.secretOutputs?.key).toBe(secretOf(emu, created.id));
    expect(emu.state.modelKeys.get(created.id)!.name).toBe(`bc-r-key-r1-bc${hash}`);
    // The next run reads the applied name and stops: the sealed secret is the live one.
    const puts = mutations(emu, 'PUT', /api_keys/).length;
    const settled = await resources.ensure(
      request({ id: created.id, spec: { rotation: 1 }, secretOutputs: ['key'] }),
      call(),
    );
    expect(settled.state).toBe('ready');
    expect(mutations(emu, 'PUT', /api_keys/)).toHaveLength(puts);
  });

  it('two racing creates converge on the key the caller recorded; the other bearer is deleted', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    // Two runs (a claim that expired mid-call) both found nothing and both created.
    const kept = await resources.ensure(request(), call());
    const racing = seedModelKey(emu.state, { name: `bc-r-key-r0-bc${hash}` });
    const foreign = seedModelKey(emu.state, { name: 'bc-r-key-r0-bc0123456789ab' });
    const other = seedModelKey(emu.state, { name: `bc-r-other-r0-bc${hash}` });
    const again = await resources.ensure(
      request({ id: kept.id, secretOutputs: ['key'] }),
      call(),
    );
    expect(again).toMatchObject({ id: kept.id, state: 'ready' });
    expect(emu.state.modelKeys.has(racing.uuid)).toBe(false);
    expect(mutations(emu, 'DELETE', /api_keys/).map((r) => r.url.pathname)).toEqual([
      `/v2/gen-ai/models/api_keys/${racing.uuid}`,
    ]);
    // Another deployment's key and another resource's key are never touched.
    expect(emu.state.modelKeys.has(foreign.uuid)).toBe(true);
    expect(emu.state.modelKeys.has(other.uuid)).toBe(true);
  });

  it('delete and discover leave a key made by hand or by another deployment alone', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedModelKey(emu.state);
    const foreign = seedModelKey(emu.state, { name: 'bc-r-x-r0-bc0123456789ab' });
    for (const uuid of [byHand.uuid, foreign.uuid])
      expect(
        (await failure(resources.delete('do.inference-key', uuid, call()))).details?.reason,
      ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /api_keys/)).toEqual([]);
    const mine = await resources.ensure(request(), call());
    const discovered: any[] = [];
    for await (const found of resources.discover!('do.inference-key', call()))
      discovered.push(found);
    expect(
      Object.fromEntries(discovered.map((entry) => [entry.id, entry.managedBy ?? 'none'])),
    ).toEqual({ [byHand.uuid]: 'none', [foreign.uuid]: 'other', [mine.id]: 'this' });
    expect((await resources.delete('do.inference-key', mine.id, call())).state).toBe('deleted');
    expect((await resources.delete('do.inference-key', mine.id, call())).state).toBe('deleted');
    expect(emu.state.modelKeys.has(mine.id)).toBe(false);
  });
});
