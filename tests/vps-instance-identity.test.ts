import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, newId, type Check, type Credential } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  labelSelectorSql,
  labelsNotAppliedCondition,
  parseLabelSelector,
  reservedKey,
} from '@better-compute/vps';
import { gceVm, gceWorld, instanceLabel, managedLabel, type GceWorld } from './support/vps-gce.js';

// U-04: what a tenant calls its instances (a mutable name, metadata and labels, on create and through
// instances.update, labels reaching a provider machine through the reconciler), the platform's provenance
// (issuedBy, root callers only), instances.list (deleted rows skipped before the per-item checks, server-side
// filters, a cursor), the platform's issued list across tenants, and the disks a provider reports.

afterEach(closeFixtures);

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

const details = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: ComputeError) => ({ code: error.code, details: error.details }),
  );

/** A few instance reconciler steps, a second of sim time apart. */
async function settle(w: GceWorld, rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await w.fixture.advance(1_000);
    await w.tick('vps.instances', 1);
  }
}

/** Steps until the next steady poll is due (the reconciler re-reads a settled instance every minute). */
async function poll(w: GceWorld): Promise<void> {
  await w.fixture.advance(61_000);
  await w.tick('vps.instances', 1);
}

const create = (w: GceWorld, extra: Record<string, unknown> = {}, key = 'vm-1', who = w.acme) =>
  w.api.instances.create(who, {
    tenantId: w.acmeTenant,
    poolId: w.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
    ...extra,
  });

const vmOf = (w: GceWorld, instanceId: string) =>
  w.cloud.machines.get(`us-central1-a/${instanceId.replaceAll('_', '-')}`);

describe('instances.create: name, metadata and labels', () => {
  it('keeps them on the instance, and writes the labels on the machine with ownership labels last', async () => {
    const w = await gceWorld();
    const instance = await create(w, {
      name: 'Training box #1',
      metadata: { 'team/owner': 'Ada Lovelace', 'cost.center': 'R&D 42' },
      labels: { team: 'ml', env: 'prod' },
    });
    expect(instance).toMatchObject({
      name: 'Training box #1',
      metadata: { 'team/owner': 'Ada Lovelace', 'cost.center': 'R&D 42' },
      labels: { team: 'ml', env: 'prod' },
    });
    expect(instance.createdAt).toBe(w.fixture.clock.now());
    expect(instance.issuedBy).toBeUndefined();
    await settle(w);
    expect(vmOf(w, instance.id)!.labels).toEqual({
      team: 'ml',
      env: 'prod',
      [managedLabel]: 'true',
      [instanceLabel]: instance.id,
    });
    // What create wrote is what the instance holds: no label write follows.
    await poll(w);
    expect(w.cloud.requests.filter((request) => request.startsWith('setLabels'))).toEqual([]);
    // The same key with another name is another request.
    expect(await code(create(w, { name: 'Other' }))).toBe('CONFLICT');
  });

  it('refuses reserved keys, bad names and bad metadata', async () => {
    const w = await gceWorld();
    let n = 0;
    const refused = (extra: Record<string, unknown>) => code(create(w, extra, `bad-${++n}`));
    expect(await refused({ labels: { 'bc-net': 'x' } })).toBe('INVALID_INPUT');
    expect(await refused({ labels: { 'better-compute-managed': 'false' } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { 'better-compute-owner': 'x' } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { 'BC-tag': 'x' } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { 'Better-Compute-x': 'x' } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { team: 7 } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { '/team': 'x' } })).toBe('INVALID_INPUT');
    expect(await refused({ metadata: { team: 'v'.repeat(1025) } })).toBe('INVALID_INPUT');
    expect(
      await refused({
        metadata: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v'])),
      }),
    ).toBe('INVALID_INPUT');
    expect(await refused({ name: '' })).toBe('INVALID_INPUT');
    expect(await refused({ name: ' padded' })).toBe('INVALID_INPUT');
    expect(await refused({ name: 'line\nbreak' })).toBe('INVALID_INPUT');
    expect(await refused({ name: 'x'.repeat(129) })).toBe('INVALID_INPUT');
    expect(reservedKey('Better-Compute-Instance')).toBe(true);
    expect(reservedKey('bcx')).toBe(false);
    // Nothing was written for any of them.
    const { rows } = await w.fixture.database.query(`SELECT 1 FROM instances`);
    expect(rows).toEqual([]);
  });

  it('takes issuedBy from the platform only', async () => {
    const w = await gceWorld();
    expect(await details(create(w, { issuedBy: 'legionedge:admin' }))).toEqual({
      code: 'ACCESS_DENIED',
      details: { reason: 'issued-by-platform-only', field: 'issuedBy' },
    });
    expect(await code(create(w, { issuedBy: 'has space' }, 'vm-2'))).toBe('INVALID_INPUT');
    const issued = await create(w, { issuedBy: 'legionedge:admin' }, 'issued', w.root);
    expect(issued).toMatchObject({ tenantId: w.acmeTenant, issuedBy: 'legionedge:admin' });
    expect(
      (await w.api.instances.get(w.acme, { tenantId: w.acmeTenant, instanceId: issued.id }))
        .issuedBy,
    ).toBe('legionedge:admin');
  });
});

describe('instances.update', () => {
  it('renames, replaces metadata and labels, and publishes instance.updated', async () => {
    const w = await gceWorld();
    const instance = await create(w, { name: 'one', labels: { team: 'ml' } });
    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    const updated = await w.api.instances.update(w.acme, {
      ...ref,
      name: 'two',
      metadata: { note: 'hello' },
      labels: { team: 'infra', env: 'dev' },
    });
    expect(updated).toMatchObject({
      name: 'two',
      metadata: { note: 'hello' },
      labels: { team: 'infra', env: 'dev' },
      version: instance.version + 1,
    });
    const events = await w.events('instance.updated');
    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ changed: ['name', 'metadata', 'labels'] }),
      }),
    ]);
    // Nothing to change: the instance as it is, no new version or event.
    const same = await w.api.instances.update(w.acme, {
      ...ref,
      name: 'two',
      labels: { env: 'dev', team: 'infra' },
    });
    expect(same.version).toBe(updated.version);
    expect(await w.events('instance.updated')).toHaveLength(1);
    // A stale version is CONFLICT; null and {} clear.
    expect(
      await code(w.api.instances.update(w.acme, { ...ref, name: 'x', expectedVersion: 1 })),
    ).toBe('CONFLICT');
    const cleared = await w.api.instances.update(w.acme, {
      ...ref,
      name: null,
      metadata: {},
      labels: null,
      expectedVersion: updated.version,
    });
    expect(cleared.name).toBeUndefined();
    expect(cleared.metadata).toBeUndefined();
    expect(cleared.labels).toBeUndefined();
    // Something to change is required; reserved keys and unknown fields are refused.
    expect(await code(w.api.instances.update(w.acme, ref))).toBe('INVALID_INPUT');
    expect(await code(w.api.instances.update(w.acme, { ...ref, labels: { 'bc-x': 'y' } }))).toBe(
      'INVALID_INPUT',
    );
    expect(await code(w.api.instances.update(w.acme, { ...ref, flavor: 'x' }))).toBe(
      'INVALID_INPUT',
    );
  });

  it('lets only the platform record or change issuedBy', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    expect(await code(w.api.instances.update(w.acme, { ...ref, issuedBy: 'me' }))).toBe(
      'ACCESS_DENIED',
    );
    expect(
      (await w.api.instances.update(w.root, { ...ref, issuedBy: 'legionedge' })).issuedBy,
    ).toBe('legionedge');
    expect(await code(w.api.instances.update(w.acme, { ...ref, issuedBy: null }))).toBe(
      'ACCESS_DENIED',
    );
    expect(
      (await w.api.instances.update(w.root, { ...ref, issuedBy: null })).issuedBy,
    ).toBeUndefined();
  });

  it('writes new labels on the machine, keeps better-compute’s own, and removes the old ones', async () => {
    const w = await gceWorld();
    const instance = await create(w, { labels: { team: 'ml', env: 'prod' } });
    await settle(w);
    const vm = vmOf(w, instance.id)!;
    // Someone else's label on the VM is left alone.
    vm.labels = { ...vm.labels, 'owner-set': 'yes' };
    await w.api.instances.update(w.acme, {
      tenantId: w.acmeTenant,
      instanceId: instance.id,
      labels: { team: 'infra', tier: 'gpu' },
    });
    await settle(w, 1);
    expect(vmOf(w, instance.id)!.labels).toEqual({
      team: 'infra',
      tier: 'gpu',
      'owner-set': 'yes',
      [managedLabel]: 'true',
      [instanceLabel]: instance.id,
    });
    expect(w.cloud.requests.filter((request) => request.startsWith('setLabels'))).toHaveLength(1);
    // Written once: later polls only read the machine.
    await poll(w);
    expect(w.cloud.requests.filter((request) => request.startsWith('setLabels'))).toHaveLength(1);
  });

  it('keeps a refused label write as a condition and tries again', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    await settle(w);
    w.cloud.failSetLabels = new ComputeError('PROVIDER_ERROR', 'labels refused');
    await w.api.instances.update(w.acme, {
      tenantId: w.acmeTenant,
      instanceId: instance.id,
      labels: { team: 'ml' },
    });
    await settle(w, 1);
    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    const failed = await w.api.instances.get(w.acme, ref);
    expect(failed.state).toBe('running');
    expect(failed.conditions).toEqual([
      expect.objectContaining({ type: labelsNotAppliedCondition, reason: 'PROVIDER_ERROR' }),
    ]);
    await poll(w);
    const fixed = await w.api.instances.get(w.acme, ref);
    expect(fixed.conditions).toEqual([]);
    expect(vmOf(w, instance.id)!.labels).toMatchObject({
      team: 'ml',
      [instanceLabel]: instance.id,
    });
  });

  it('refuses deleted instances', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    await w.api.instances.delete(w.acme, ref);
    expect(await code(w.api.instances.update(w.acme, { ...ref, name: 'x' }))).toBe('INVALID_STATE');
    expect(
      await code(w.api.instances.update(w.acme, { ...ref, instanceId: newId('inst'), name: 'x' })),
    ).toBe('NOT_FOUND');
  });
});

describe('instances.attach: identity', () => {
  it('keeps the name, metadata and issuedBy, and writes the labels once the machine is claimed', async () => {
    const w = await gceWorld({ discovery: { every: '1m' } });
    w.cloud.machines.set('us-central1-a/legacy', gceVm('legacy', { labels: { site: 'dc1' } }));
    await w.discover(0);
    const attach = (who: { token: string }, extra: Record<string, unknown>, key = 'attach') =>
      w.api.instances.attach(who, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        externalId: 'us-central1-a/legacy',
        idempotencyKey: key,
        ...extra,
      });
    expect(await code(attach(w.acme, { issuedBy: 'legionedge' }))).toBe('ACCESS_DENIED');
    const instance = await attach(w.root, {
      name: 'Legacy box',
      metadata: { rack: 'r1' },
      labels: { team: 'ml' },
      issuedBy: 'legionedge',
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
    });
    expect(instance).toMatchObject({
      name: 'Legacy box',
      metadata: { rack: 'r1' },
      labels: { team: 'ml' },
      issuedBy: 'legionedge',
      origin: 'attached',
    });
    await settle(w, 4);
    // Adopted with labels still to write: the next pass, ten seconds on, writes them.
    await w.fixture.advance(10_000);
    await w.tick('vps.instances', 1);
    expect(w.cloud.machines.get('us-central1-a/legacy')!.labels).toEqual({
      site: 'dc1',
      team: 'ml',
      [instanceLabel]: instance.id,
    });
  });
});

describe('instances.list', () => {
  async function three(w: GceWorld) {
    // A second apart, so newest-first is a stable order.
    const a = await create(w, { labels: { env: 'prod', tier: 'gpu' } }, 'a');
    await w.fixture.advance(1_000);
    const b = await create(w, { labels: { env: 'dev' } }, 'b');
    await w.fixture.advance(1_000);
    const c = await create(w, {}, 'c');
    await w.fixture.advance(1_000);
    return { a, b, c };
  }
  const list = (w: GceWorld, extra: Record<string, unknown> = {}) =>
    w.api.instances.list(w.acme, { tenantId: w.acmeTenant, scope: 'all', ...extra });
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

  it('leaves deleted instances out before the per-item checks', async () => {
    const w = await gceWorld();
    const { a, b, c } = await three(w);
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: b.id });
    await settle(w, 4);
    expect(
      (await w.api.instances.get(w.acme, { tenantId: w.acmeTenant, instanceId: b.id })).state,
    ).toBe('deleted');
    // IAM as better-iam answers it: an instance whose access row is gone is NOT_FOUND to its resolver.
    const checked: string[] = [];
    const iam = w.fixture.iam;
    const authorizeMany = iam.authorizeMany.bind(iam);
    iam.authorizeMany = async (credential: Credential, tenantId: string, checks: Check[]) => {
      checked.push(...checks.map((check) => check.resource.id));
      if (checks.some((check) => check.resource.id === b.id))
        throw new ComputeError('NOT_FOUND', 'compute-instance not found');
      return authorizeMany(credential, tenantId, checks);
    };
    expect(ids(await list(w))).toEqual([c.id, a.id]);
    expect(checked).toEqual([c.id, a.id]);
    // Deleted ones are the caller's own to list (no per-item check), never scope 'all'.
    expect(await code(list(w, { state: 'deleted' }))).toBe('INVALID_INPUT');
    expect(ids(await list(w, { scope: 'mine', state: 'deleted' }))).toEqual([b.id]);
    expect(ids(await list(w, { scope: 'mine' }))).toEqual([c.id, a.id]);
  });

  it('filters by label selector, project and pool, and pages with a cursor', async () => {
    const w = await gceWorld();
    const { a, b, c } = await three(w);
    expect(ids(await list(w, { labelSelector: 'env=prod' }))).toEqual([a.id]);
    expect(ids(await list(w, { labelSelector: 'env==dev' }))).toEqual([b.id]);
    expect(ids(await list(w, { labelSelector: 'env!=prod' }))).toEqual([c.id, b.id]);
    expect(ids(await list(w, { labelSelector: 'env' }))).toEqual([b.id, a.id]);
    expect(ids(await list(w, { labelSelector: '!env' }))).toEqual([c.id]);
    expect(ids(await list(w, { labelSelector: 'env in (prod, dev),tier' }))).toEqual([a.id]);
    expect(ids(await list(w, { labelSelector: 'env notin (prod)' }))).toEqual([c.id, b.id]);
    expect(ids(await list(w, { labelSelector: ' ' }))).toEqual([c.id, b.id, a.id]);
    for (const bad of ['Env=prod', 'env=Prod', 'env in (prod', 'a,,b', 'env=prod=x', 'x in ()'])
      expect(await code(list(w, { labelSelector: bad })), bad).toBe('INVALID_INPUT');

    const project = newId('prj');
    const d = await create(w, { projectId: project }, 'd');
    expect(ids(await list(w, { projectId: project }))).toEqual([d.id]);
    expect(ids(await list(w, { poolId: w.poolId, labelSelector: 'tier=gpu' }))).toEqual([a.id]);

    const first = await list(w, { limit: 2 });
    expect(ids(first)).toEqual([d.id, c.id]);
    const second = await list(w, { limit: 2, cursor: first.cursor });
    expect(ids(second)).toEqual([b.id, a.id]);
    expect(second.cursor).toBeUndefined();
  });

  it('compiles selectors to SQL parameters, never into the text', () => {
    const params: unknown[] = ['tenant'];
    const sql = labelSelectorSql(
      parseLabelSelector('env=prod,team notin (a,b),!x,y,k!=v,z in (q)'),
      'i.labels',
      params,
    );
    expect(sql).not.toMatch(/prod|team|'/);
    expect(params).toEqual([
      'tenant',
      'env',
      'prod',
      'team',
      ['a', 'b'],
      'x',
      'y',
      'k',
      'v',
      'z',
      ['q'],
    ]);
    expect(labelSelectorSql([], 'i.labels', [])).toBe('TRUE');
  });
});

describe('instances.issued', () => {
  it('lists the platform’s instances in other tenants, root only, with filters and a cursor', async () => {
    const w = await gceWorld();
    const mine = await create(w, { labels: { env: 'prod' } }, 'mine');
    await w.fixture.advance(1_000);
    const issued = await create(w, { issuedBy: 'legionedge' }, 'issued', w.root);
    // Root's own instance on its own pool is not issued.
    for (const [resource, max] of Object.entries({
      vcpu: 64,
      memoryGiB: 512,
      diskGiB: 1000,
      gpu: 4,
    }))
      await w.api.quotas.set(w.root, { tenantId: w.rootTenant, poolId: w.poolId, resource, max });
    await w.api.instances.create(w.root, {
      tenantId: w.rootTenant,
      poolId: w.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'root-own',
    });
    const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

    expect(await code(w.api.instances.issued(w.acme, {}))).toBe('ACCESS_DENIED');
    expect(ids(await w.api.instances.issued(w.root, {}))).toEqual([issued.id, mine.id]);
    expect(ids(await w.api.instances.issued(w.root, { issuedBy: 'legionedge' }))).toEqual([
      issued.id,
    ]);
    expect(ids(await w.api.instances.issued(w.root, { issuedBy: '*' }))).toEqual([issued.id]);
    expect(ids(await w.api.instances.issued(w.root, { labelSelector: 'env=prod' }))).toEqual([
      mine.id,
    ]);
    expect(ids(await w.api.instances.issued(w.root, { tenantId: w.rootTenant }))).toEqual([]);
    expect(
      ids(await w.api.instances.issued(w.root, { tenantId: w.acmeTenant, poolId: w.poolId })),
    ).toEqual([issued.id, mine.id]);
    const first = await w.api.instances.issued(w.root, { limit: 1 });
    expect(ids(first)).toEqual([issued.id]);
    expect(ids(await w.api.instances.issued(w.root, { limit: 1, cursor: first.cursor }))).toEqual([
      mine.id,
    ]);
    // Deleted ones leave the list unless asked for.
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: mine.id });
    await settle(w, 4);
    expect(ids(await w.api.instances.issued(w.root, {}))).toEqual([issued.id]);
    expect(ids(await w.api.instances.issued(w.root, { state: 'deleted' }))).toEqual([mine.id]);
    expect(await code(w.api.instances.issued(w.root, { limit: 501 }))).toBe('INVALID_INPUT');
  });
});

describe('instance disks', () => {
  it('shows the disks the provider reports for the machine', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    await settle(w);
    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    expect((await w.api.instances.get(w.acme, ref)).disks).toBeUndefined();
    vmOf(w, instance.id)!.disks = [
      { type: 'hyperdisk-balanced', sizeGiB: 100, boot: true },
      { type: 'local-ssd', sizeGiB: 375 },
    ];
    await poll(w);
    expect((await w.api.instances.get(w.acme, ref)).disks).toEqual([
      { type: 'hyperdisk-balanced', sizeGiB: 100, boot: true },
      { type: 'local-ssd', sizeGiB: 375 },
    ]);
  });
});
