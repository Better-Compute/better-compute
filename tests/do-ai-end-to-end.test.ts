import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudResources } from '@better-compute/cloud-resources';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';
import { seedHarness, seedSignal } from './support/do-emulator/managed-agents.js';

// DigitalOcean's AI platform (P8) through betterCompute() on PGlite: a root DO account backs a provider pool offered
// to acme with a GPU quota, and acme runs a Dedicated Inference endpoint on it. Its GPUs are booked against that
// quota from the create (a second endpoint over it is refused), scaling books the difference, and deleting the
// endpoint returns them once DigitalOcean has let it go.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Api = any;

async function world(gpuQuota = 2, config: Record<string, unknown> = {}) {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token', 'acme-do-token']);
  // A path whose next POST DigitalOcean carries out but whose answer never comes back (a timeout after it accepted).
  const loseAnswer = { path: undefined as RegExp | undefined };
  // Once: runs after DigitalOcean answered a request to this path, before the provider reads the answer.
  const afterAnswer = {
    path: undefined as RegExp | undefined,
    fn: undefined as (() => Promise<void>) | undefined,
  };
  const fetch: typeof emu.fetch = async (input, init) => {
    const answer = await emu.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (afterAnswer.path?.test(url.pathname)) {
      const fn = afterAnswer.fn;
      afterAnswer.path = undefined;
      afterAnswer.fn = undefined;
      await fn?.();
    }
    if (loseAnswer.path?.test(url.pathname) && (init?.method ?? 'GET') === 'POST') {
      loseAnswer.path = undefined;
      throw new TypeError('fetch failed: the connection was reset');
    }
    return answer;
  };
  const provider = digitaloceanProvider({ fetch });
  const logs: string[] = [];
  const line = (message: string, fields?: unknown) =>
    void logs.push(JSON.stringify({ message, fields }));
  const fixture = await computeFixture({
    clock: 'sim',
    log: { debug: line, info: line, warn: line, error: line },
    modules: [vps({ providers: [provider] }), cloudResources({ providers: [provider] })],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const { ref } = await api.secrets.put(root, {
    tenantId: tenants.root.id,
    name: 'do',
    value: 'root-do-token',
    idempotencyKey: 'do-token',
  });
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'digitalocean',
    name: 'do-main',
    config: { token: ref, regions: ['nyc3'], ...config },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'nyc3',
    idempotencyKey: 'do-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'do-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: gpuQuota },
  });
  const acmeTenant = tenants.acme.id;
  // acme's own DigitalOcean account and pool (a BYO account): what only the tenant's own account may have.
  const ownPool = async () => {
    const { ref: acmeRef } = await api.secrets.put(acme, {
      tenantId: acmeTenant,
      name: 'acme-do',
      value: 'acme-do-token',
      idempotencyKey: 'acme-do-token',
    });
    const own = await api.providerAccounts.create(acme, {
      tenantId: acmeTenant,
      provider: 'digitalocean',
      name: 'acme-do',
      config: { token: acmeRef, regions: ['nyc3'], ...config },
    });
    const ownSite = await api.sites.create(acme, {
      tenantId: acmeTenant,
      kind: 'custom',
      region: 'nyc3',
      idempotencyKey: 'acme-do-site',
    });
    const created = await api.pools.create(acme, {
      tenantId: acmeTenant,
      siteId: ownSite.id,
      class: 'provider',
      providerAccountId: own.id,
      idempotencyKey: 'acme-do-pool',
    });
    return created.id as string;
  };
  const get = (resourceId: string) =>
    api.cloudResources.get(acme, { tenantId: acmeTenant, resourceId });
  const until = async (resourceId: string, state: string) => {
    for (let round = 0; round < 20; round++) {
      await fixture.advance(10_000);
      await compute.jobs['cloud.resources']!.tick();
      if ((await get(resourceId)).state === state) return;
    }
    throw new Error(
      `${resourceId} never reached ${state}: ${JSON.stringify(await get(resourceId))}`,
    );
  };
  const gpusUsed = async () => {
    const { rows } = await fixture.database.query<{ used: string | number }>(
      `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu'`,
      [acmeTenant, pool.id],
    );
    return Number(rows[0]?.used ?? 0);
  };
  return {
    emu,
    fixture,
    api,
    acme,
    acmeTenant,
    poolId: pool.id,
    ownPool,
    logs,
    get,
    until,
    gpusUsed,
    loseAnswer,
    afterAnswer,
  };
}

describe('DigitalOcean Dedicated Inference through cloudResources', () => {
  it('books the endpoint’s GPUs against the pool quota, scales in place, and returns them on delete', async () => {
    const w = await world(2);
    const kinds = await w.api.cloudResources.kinds(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(
      kinds.items.find((kind: { kind: string }) => kind.kind === 'do.dedicated-inference'),
    ).toMatchObject({ family: 'ai', updatable: ['replicas', 'maxReplicas'], available: true });

    const endpoint = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.dedicated-inference',
      name: 'chat',
      spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', gpuSize: 'gpu-h100x1-80gb' },
      idempotencyKey: 'chat',
    });
    expect(await w.gpusUsed()).toBe(1);
    await w.until(endpoint.id, 'ready');
    const ready = await w.get(endpoint.id);
    const atDo = w.emu.state.dedicatedInferences.get(ready.providerId)!;
    expect(atDo.name).toBe(endpoint.providerName);
    expect(ready.outputs).toMatchObject({
      endpoint: `https://${ready.providerId}.inference.do-ai.run`,
      replicas: '1',
    });
    const rates = await w.fixture.database.query<{ meter_rates: Record<string, number> }>(
      `SELECT meter_rates FROM cloud_resources WHERE id = $1`,
      [endpoint.id],
    );
    expect(rates.rows[0]!.meter_rates).toEqual({ 'gpu.h100.hours': 1 });

    // A second endpoint over the quota is refused, with nothing recorded and nothing sent.
    const posts = w.emu.requests.filter((r) => r.method === 'POST').length;
    await expect(
      w.api.cloudResources.create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.dedicated-inference',
        name: 'big',
        spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', gpuSize: 'gpu-h100x8-640gb' },
        idempotencyKey: 'big',
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(w.emu.requests.filter((r) => r.method === 'POST').length).toBe(posts);

    // Scaling to a maximum of two books one more GPU; three would be over the quota.
    await expect(
      w.api.cloudResources.update(w.acme, {
        tenantId: w.acmeTenant,
        resourceId: endpoint.id,
        spec: { maxReplicas: 3 },
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await w.api.cloudResources.update(w.acme, {
      tenantId: w.acmeTenant,
      resourceId: endpoint.id,
      spec: { maxReplicas: 2 },
    });
    expect(await w.gpusUsed()).toBe(2);
    await w.until(endpoint.id, 'ready');
    expect(atDo.scaling).toMatchObject({ min_replicas: 1, max_replicas: 2 });

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: endpoint.id });
    expect(await w.gpusUsed()).toBe(2);
    await w.until(endpoint.id, 'deleted');
    expect(w.emu.state.dedicatedInferences.has(ready.providerId)).toBe(false);
    expect(await w.gpusUsed()).toBe(0);
    expect(JSON.stringify(w.logs)).not.toContain('root-do-token');
  });

  it('an endpoint whose create answer was lost is found on delete, torn down, and its GPUs returned', async () => {
    const w = await world(2);
    w.loseAnswer.path = /\/v2\/dedicated-inferences$/;
    const endpoint = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.dedicated-inference',
      name: 'lost',
      spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', gpuSize: 'gpu-h100x1-80gb' },
      idempotencyKey: 'lost',
    });
    await w.fixture.advance(10_000);
    await w.fixture.compute.jobs['cloud.resources']!.tick();
    // DigitalOcean made it, but the row never learned its id.
    expect(w.emu.state.dedicatedInferences.size).toBe(1);
    expect((await w.get(endpoint.id)).providerId ?? null).toBeNull();
    expect(await w.gpusUsed()).toBe(1);

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: endpoint.id });
    await w.until(endpoint.id, 'deleted');
    expect(w.emu.state.dedicatedInferences.size).toBe(0);
    expect(w.emu.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(await w.gpusUsed()).toBe(0);
  });

  it('a model access key is refused on a shared pool, with no row and nothing sent', async () => {
    const w = await world(0);
    const sent = w.emu.requests.length;
    await expect(
      w.api.cloudResources.create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.inference-key',
        name: 'app-key',
        spec: {},
        idempotencyKey: 'app-key',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'accountWide', fields: ['rotation'] },
    });
    const { items } = await w.api.cloudResources.list(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(items).toEqual([]);
    expect(w.emu.requests.slice(sent).filter((r) => r.url.pathname.includes('gen-ai'))).toEqual(
      [],
    );
    expect(w.emu.state.modelKeys.size).toBe(0);
  });

  it('a model access key is sealed in the run that received it; a rotation seals the new one and destroys the old', async () => {
    const w = await world(0);
    const ownPoolId = await w.ownPool();
    const created = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: ownPoolId,
      kind: 'do.inference-key',
      name: 'app-key',
      spec: {},
      idempotencyKey: 'app-key',
    });
    await w.until(created.id, 'ready');
    const ready = await w.get(created.id);
    const atDo = w.emu.state.modelKeys.get(ready.providerId)!;
    const secrets = w.fixture.compute.context.secrets!;
    expect(ready.outputs).toEqual({ endpoint: 'https://inference.do-ai.run/v1' });
    expect(await secrets.resolve(ready.secretOutputs.key, { tenantId: w.acmeTenant })).toBe(
      atDo._secret,
    );
    const first = atDo._secret;

    await w.api.cloudResources.update(w.acme, {
      tenantId: w.acmeTenant,
      resourceId: created.id,
      spec: { rotation: 1 },
    });
    await w.until(created.id, 'ready');
    const rotated = await w.get(created.id);
    expect(rotated.secretOutputs.key).not.toBe(ready.secretOutputs.key);
    expect(await secrets.resolve(rotated.secretOutputs.key, { tenantId: w.acmeTenant })).toBe(
      atDo._secret,
    );
    expect(atDo._secret).not.toBe(first);
    await expect(secrets.resolve(ready.secretOutputs.key)).rejects.toBeDefined();

    // No key DigitalOcean handed out is in a row, an event or a log line.
    const rows = await w.fixture.database.query(`SELECT * FROM cloud_resources`);
    const outbox = await w.fixture.database.query(`SELECT payload FROM outbox`);
    const stored = JSON.stringify([rows.rows, outbox.rows, w.logs]);
    for (const secret of [first, atDo._secret]) expect(stored).not.toContain(secret);

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: created.id });
    await w.until(created.id, 'deleted');
    expect(w.emu.state.modelKeys.size).toBe(0);
  });

  it('a key rotated while its description changes keeps the one secret DigitalOcean answered', async () => {
    const w = await world(0);
    const ownPoolId = await w.ownPool();
    const created = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: ownPoolId,
      kind: 'do.inference-key',
      name: 'race-key',
      spec: {},
      idempotencyKey: 'race-key',
    });
    await w.until(created.id, 'ready');
    const ready = await w.get(created.id);
    const atDo = w.emu.state.modelKeys.get(ready.providerId)!;
    const secrets = w.fixture.compute.context.secrets!;
    await w.api.cloudResources.update(w.acme, {
      tenantId: w.acmeTenant,
      resourceId: created.id,
      spec: { rotation: 1 },
    });
    // A description-only update lands after DigitalOcean regenerated the key, before the run writes its answer.
    w.afterAnswer.path = /\/regenerate$/;
    w.afterAnswer.fn = async () => {
      await w.api.cloudResources.update(w.acme, {
        tenantId: w.acmeTenant,
        resourceId: created.id,
        description: 'meanwhile',
      });
    };
    await w.until(created.id, 'ready');
    const rotated = await w.get(created.id);
    expect(rotated.description).toBe('meanwhile');
    expect(atDo.name).toMatch(/-r1-bc/);
    // Regenerated once, and the sealed key is the live one.
    expect(w.emu.requests.filter((r) => r.url.pathname.endsWith('/regenerate'))).toHaveLength(1);
    expect(await secrets.resolve(rotated.secretOutputs.key, { tenantId: w.acmeTenant })).toBe(
      atDo._secret,
    );
    await expect(secrets.resolve(ready.secretOutputs.key)).rejects.toBeDefined();
  });
});

describe('DigitalOcean Managed Agents (preview) through cloudResources', () => {
  it('lists the preview kinds as unavailable and refuses them with no row and nothing sent', async () => {
    const w = await world(2);
    const kinds = await w.api.cloudResources.kinds(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    for (const name of ['do.agent-harness', 'do.action-gateway'])
      expect(kinds.items.find((kind: { kind: string }) => kind.kind === name)).toMatchObject({
        family: 'ai',
        preview: true,
        available: false,
      });
    const before = w.emu.requests.length;
    const error = await w.api.cloudResources
      .create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.agent-harness',
        name: 'helper',
        spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', instructions: 'Help.' },
        idempotencyKey: 'helper',
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'preview' } });
    const rows = await w.fixture.database.query(`SELECT id FROM cloud_resources`);
    expect(rows.rows).toEqual([]);
    expect(
      w.emu.requests.slice(before).filter((r) => r.url.pathname.includes('managed-agents')),
    ).toEqual([]);
  });
});

describe('DigitalOcean Managed Agents signals through cloudResources', () => {
  it('shows acme the signals about its own harness agent, read-only; refused where previews are off', async () => {
    const w = await world(2, { previews: true });
    const created = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.agent-harness',
      name: 'helper',
      spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', instructions: 'Help.' },
      idempotencyKey: 'helper',
    });
    await w.until(created.id, 'ready');
    const ready = await w.get(created.id);
    const byHand = seedHarness(w.emu.state);
    seedSignal(w.emu.state, {
      uuid: 'sig-acme',
      resource_uuid: ready.providerId,
      type: 'HUMAN_INPUT_REQUESTED',
      message: 'Approve a refund of 40 USD?',
    });
    seedSignal(w.emu.state, { uuid: 'sig-hand', resource_uuid: byHand.uuid, type: 'RUN_FAILED' });
    const before = w.emu.requests.length;
    const { items } = await w.api.cloudResources.signals(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: 'sig-acme',
        severity: 'warning',
        title: 'Human input requested',
        detail: 'Approve a refund of 40 USD?',
        kind: 'do.agent-harness',
        providerId: ready.providerId,
        resourceId: created.id,
      }),
    ]);
    expect(w.emu.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);

    const off = await world(2);
    const error = await off.api.cloudResources
      .signals(off.acme, { tenantId: off.acmeTenant, poolId: off.poolId })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'preview' } });
  });
});
