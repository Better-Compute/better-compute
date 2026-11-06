import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import type { ProviderResourceSignal } from '@better-compute/core';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets } from './support/memory-secrets.js';

// cloudResources.signals through the real envelope (fake IAM, PGlite): the read-only signals a pool's provider raises
// about its resources, for an attention list. A tenant of a shared pool sees the signals about its own resources only;
// the pool's owner (the root tenant for the platform's pool, acme for its own account) sees every signal.

let world: CloudResourcesWorld;
let acmeDb: { id: string; providerId: string };
let otherDb: { id: string; providerId: string };

const signal = (fields: Partial<ProviderResourceSignal>): ProviderResourceSignal => ({
  id: 'sig',
  kind: 'fake.database',
  resourceId: 'f-0',
  severity: 'warning',
  title: 'Needs a human',
  at: Date.parse('2026-11-05T09:00:00Z'),
  ...fields,
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved', details: undefined as any }),
    (error: { code?: string; details?: any }) => ({ code: error.code, details: error.details }),
  );

async function readyDb(who: 'acme' | 'other', name: string) {
  const tenantId = who === 'acme' ? world.acmeTenant : world.otherTenant;
  const created = await world.api.cloudResources.create(world[who], {
    tenantId,
    poolId: world.poolId,
    kind: 'fake.database',
    name,
    spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small' },
    idempotencyKey: name,
  });
  await world.until(
    async () =>
      (await world.api.cloudResources.get(world[who], { tenantId, resourceId: created.id }))
        .state === 'ready',
  );
  const view = await world.api.cloudResources.get(world[who], { tenantId, resourceId: created.id });
  return { id: view.id as string, providerId: view.providerId as string };
}

beforeAll(async () => {
  world = await cloudResourcesWorld({ secrets: memorySecrets() });
  acmeDb = await readyDb('acme', 'acme-db');
  otherDb = await readyDb('other', 'other-db');
  world.cloud.signals = [
    signal({ id: 'a-1', resourceId: acmeDb.providerId, at: Date.parse('2026-11-05T09:00:00Z') }),
    signal({
      id: 'a-2',
      resourceId: acmeDb.providerId,
      severity: 'critical',
      title: 'Run\u0000 failed\n\u001b[31m',
      detail: `x${'y'.repeat(900)}`,
      at: Date.parse('2026-11-05T10:00:00Z'),
    }),
    signal({ id: 'o-1', resourceId: otherDb.providerId }),
    // About something no one records, and one about acme's provider id under another kind.
    signal({ id: 'n-1', resourceId: 'f-by-hand' }),
    signal({ id: 'k-1', resourceId: acmeDb.providerId, kind: 'fake.app' }),
    // Malformed: dropped.
    signal({ id: 'bad id', resourceId: acmeDb.providerId }),
    signal({ id: 'm-1', resourceId: acmeDb.providerId, severity: 'urgent' as never }),
    signal({ id: 'm-2', resourceId: acmeDb.providerId, at: Number.NaN }),
    signal({ id: 'm-3', resourceId: acmeDb.providerId, title: '\u0000' }),
  ];
});
afterAll(closeFixtures);

describe('cloudResources.signals', () => {
  it('shows a tenant of a shared pool the signals about its own resources, newest first', async () => {
    world.cloud.calls.length = 0;
    const { items } = await world.api.cloudResources.signals(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
    });
    expect(items.map((item: { id: string }) => item.id)).toEqual(['a-2', 'a-1']);
    expect(items[0]).toEqual({
      id: 'a-2',
      severity: 'critical',
      title: 'Run failed [31m',
      detail: `x${'y'.repeat(499)}`,
      at: Date.parse('2026-11-05T10:00:00Z'),
      kind: 'fake.database',
      providerId: acmeDb.providerId,
      resourceId: acmeDb.id,
    });
    // Read-only: the provider is asked for its signals and nothing else.
    expect(world.cloud.calls).toEqual(['signals']);
    const other = await world.api.cloudResources.signals(world.other, {
      tenantId: world.otherTenant,
      poolId: world.poolId,
    });
    expect(other.items.map((item: { id: string }) => item.id)).toEqual(['o-1']);
  });

  it('shows the pool’s owner every signal, recorded or not', async () => {
    const { items } = await world.api.cloudResources.signals(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
    });
    expect(items.map((item: { id: string }) => item.id).sort()).toEqual([
      'a-1',
      'a-2',
      'k-1',
      'n-1',
      'o-1',
    ]);
    const unrecorded = items.find((item: { id: string }) => item.id === 'n-1');
    expect(unrecorded).not.toHaveProperty('resourceId');
    expect(items.find((item: { id: string }) => item.id === 'o-1').resourceId).toBe(otherDb.id);
  });

  it('narrows to one resource', async () => {
    const { items } = await world.api.cloudResources.signals(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      resourceId: otherDb.id,
    });
    expect(items.map((item: { id: string }) => item.id)).toEqual(['o-1']);
    const none = await world.api.cloudResources.signals(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      resourceId: otherDb.id,
    });
    expect(none.items).toEqual([]);
  });

  it('refuses a provider without signals, a pool the tenant cannot see, and a bad resource id', async () => {
    expect(
      (
        await failure(
          world.api.cloudResources.signals(world.acme, {
            tenantId: world.acmeTenant,
            poolId: world.plainPoolId,
          }),
        )
      ).code,
    ).toBe('UNSUPPORTED');
    expect(
      (
        await failure(
          world.api.cloudResources.signals(world.other, {
            tenantId: world.otherTenant,
            poolId: world.acmePoolId,
          }),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await failure(
          world.api.cloudResources.signals(world.acme, {
            tenantId: world.acmeTenant,
            poolId: world.poolId,
            resourceId: 'db_1',
          }),
        )
      ).code,
    ).toBe('INVALID_INPUT');
  });
});
