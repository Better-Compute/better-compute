import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudResources } from '@better-compute/cloud-resources';
import {
  deploymentTag,
  digitaloceanProvider,
  managedTag,
  resetBudgets,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';

// The real provider-digitalocean under the cloud-resources module, through betterCompute() on PGlite: a root DO
// account (its token in the fixture's sealed secret store) backs a provider pool offered to acme, and acme runs a
// Managed PostgreSQL cluster with a user and trusted sources on it. The passwords DigitalOcean hands back are
// sealed into the host's SecretStore by the reconciler and only their refs are stored or returned.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Api = any;

async function world() {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token']);
  const provider = digitaloceanProvider({ fetch: emu.fetch });
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
    config: { token: ref, regions: ['nyc3', 'ams3'] },
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
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 0 },
  });
  const acmeTenant = tenants.acme.id;
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
  return { emu, fixture, api, acme, acmeTenant, poolId: pool.id, logs, get, until };
}

describe('DigitalOcean Managed Databases through cloudResources', () => {
  it('a tenant runs a PostgreSQL cluster with a user and trusted sources; secrets are sealed; delete cleans up', async () => {
    const w = await world();
    const kinds = await w.api.cloudResources.kinds(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(kinds.items.map((kind: { kind: string }) => kind.kind)).toContain('do.database.pg');

    const database = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg',
      name: 'orders',
      spec: { region: 'nyc3', version: '16', size: 'db-s-1vcpu-1gb' },
      idempotencyKey: 'orders',
    });
    await w.until(database.id, 'ready');
    const ready = await w.get(database.id);
    const cluster = w.emu.state.databases.get(ready.providerId)!;
    expect(cluster.name).toBe(database.providerName);
    expect(cluster.tags).toEqual(
      expect.arrayContaining([
        managedTag,
        deploymentTag('default'),
        tagFor('better-compute-resource', database.id),
        tagFor('better-compute-tenant', w.acmeTenant),
      ]),
    );
    expect(ready.outputs).toMatchObject({ port: '25060', user: 'doadmin', engine: 'pg' });
    expect(Object.keys(ready.secretOutputs).sort()).toEqual(['password', 'privateUri', 'uri']);
    const secrets = w.fixture.compute.context.secrets!;
    expect(await secrets.resolve(ready.secretOutputs.password, { tenantId: w.acmeTenant })).toBe(
      cluster._admin.password,
    );

    const user = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg.user',
      name: 'app',
      parentId: database.id,
      spec: { name: 'app' },
      idempotencyKey: 'app-user',
    });
    const firewall = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg.firewall',
      name: 'trusted',
      parentId: database.id,
      spec: { ipAddresses: ['203.0.113.0/24'] },
      idempotencyKey: 'trusted',
    });
    await w.until(user.id, 'ready');
    await w.until(firewall.id, 'ready');
    const readyUser = await w.get(user.id);
    expect(readyUser.providerId).toBe(`${cluster.id}/app`);
    const appPassword = cluster._users.find(
      (entry: { name: string }) => entry.name === 'app',
    ).password;
    expect(
      await secrets.resolve(readyUser.secretOutputs.password, { tenantId: w.acmeTenant }),
    ).toBe(appPassword);
    expect(cluster._firewall.map((rule: { value: string }) => rule.value)).toEqual([
      '203.0.113.0/24',
    ]);

    // No password DigitalOcean handed out is in a row, an event or a log line; nor is the token.
    const rows = await w.fixture.database.query(`SELECT * FROM cloud_resources`);
    const outbox = await w.fixture.database.query(`SELECT payload FROM outbox`);
    const stored = JSON.stringify([rows.rows, outbox.rows, w.logs]);
    for (const secret of [cluster._admin.password, appPassword, 'root-do-token'])
      expect(stored).not.toContain(secret);

    // The tenant's resize goes through in place.
    await w.api.cloudResources.update(w.acme, {
      tenantId: w.acmeTenant,
      resourceId: database.id,
      spec: { size: 'db-s-2vcpu-4gb' },
    });
    await w.until(database.id, 'ready');
    expect(cluster.size).toBe('db-s-2vcpu-4gb');

    // Deleting the cluster takes the user and the trusted sources first, then the cluster.
    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: database.id });
    await w.until(database.id, 'deleted');
    expect((await w.get(user.id)).state).toBe('deleted');
    expect((await w.get(firewall.id)).state).toBe('deleted');
    expect(w.emu.state.databases.has(cluster.id)).toBe(false);
    const order = w.emu.requests
      .filter((request) => request.method === 'DELETE' || request.method === 'PUT')
      .map((request) => `${request.method} ${request.url.pathname}`);
    expect(order.indexOf(`DELETE /v2/databases/${cluster.id}`)).toBeGreaterThan(
      order.indexOf(`DELETE /v2/databases/${cluster.id}/users/app`),
    );
    await expect(secrets.resolve(ready.secretOutputs.password)).rejects.toBeDefined();
  });

  it('a tenant cannot discover or adopt on the platform account it is offered', async () => {
    const w = await world();
    await expect(
      w.api.cloudResources.discover(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.database.pg',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(w.emu.requests.filter((request) => request.url.pathname === '/v2/databases')).toEqual(
      [],
    );
  });
});
