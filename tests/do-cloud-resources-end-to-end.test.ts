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
import { providerResourceName, vps } from '@better-compute/vps';
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
  return { emu, fixture, api, root, acme, acmeTenant, poolId: pool.id, logs, get, until };
}

describe('DigitalOcean Managed Databases through cloudResources', () => {
  it('a tenant runs a PostgreSQL cluster with a user and trusted sources; secrets are sealed; delete cleans up', async () => {
    const w = await world();
    const kinds = await w.api.cloudResources.kinds(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(kinds.items.map((kind: { kind: string }) => kind.kind)).toContain('do.database.pg');
    // The 1-Click catalog: Droplet images and DOKS add-ons, installed through those surfaces.
    const catalog = await w.api.cloudResources.catalog(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      installsOn: 'instance',
    });
    expect(catalog.items).toContainEqual({ slug: 'wordpress-20-04', installsOn: 'instance' });

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
    // Its node count is the rate the usage pass bills do.database.pg.node.hours at (when kindMeters names it).
    const rates = await w.fixture.database.query<{ meter_rates: Record<string, number> }>(
      `SELECT meter_rates FROM cloud_resources WHERE id = $1`,
      [database.id],
    );
    expect(rates.rows[0]!.meter_rates).toEqual({ 'do.database.pg.node.hours': cluster.num_nodes });

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

  it('a user resource naming the admin user never holds the cluster up; trusted Droplet tags are refused on a hosted pool', async () => {
    const w = await world();
    const database = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg',
      name: 'billing',
      spec: { region: 'nyc3', version: '16', size: 'db-s-1vcpu-1gb' },
      idempotencyKey: 'billing',
    });
    await w.until(database.id, 'ready');
    const providerId = (await w.get(database.id)).providerId;
    const admin = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg.user',
      name: 'admin',
      parentId: database.id,
      spec: { name: 'doadmin' },
      idempotencyKey: 'admin-user',
    });
    await w.until(admin.id, 'error');
    const refused = await w.get(admin.id);
    expect(refused.message).toMatch(/admin user/);
    expect(refused.providerId).toBeUndefined();
    expect(refused.secretOutputs).toEqual({});

    // Droplet tags and ids reach every tenant's Droplets on the platform's account: refused at the API.
    for (const spec of [{ tags: ['bc-net-someone-else'] }, { droplets: ['424242'] }]) {
      const error = await w.api.cloudResources
        .create(w.acme, {
          tenantId: w.acmeTenant,
          poolId: w.poolId,
          kind: 'do.database.pg.firewall',
          name: `fw-${Object.keys(spec)[0]}`,
          parentId: database.id,
          spec,
          idempotencyKey: `fw-${Object.keys(spec)[0]}`,
        })
        .then(
          () => undefined,
          (failure: { code?: string; details?: Record<string, unknown> }) => failure,
        );
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'accountWide' } });
    }
    expect(
      w.emu.requests.filter((request) => request.url.pathname.endsWith('/firewall')),
    ).toEqual([]);

    // A cluster has one firewall: a second trusted-sources resource on it is refused, so two never fight over it.
    const trusted = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg.firewall',
      name: 'fw-a',
      parentId: database.id,
      spec: { ipAddresses: ['203.0.113.0/24'] },
      idempotencyKey: 'fw-a',
    });
    const second = await w.api.cloudResources
      .create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.database.pg.firewall',
        name: 'fw-b',
        parentId: database.id,
        spec: { ipAddresses: ['198.51.100.0/24'] },
        idempotencyKey: 'fw-b',
      })
      .then(
        () => undefined,
        (failure: { code?: string; details?: Record<string, unknown> }) => failure,
      );
    expect(second).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'identity', resourceId: trusted.id },
    });
    await w.until(trusted.id, 'ready');
    const cluster = w.emu.state.databases.get(providerId)!;
    expect(cluster._firewall.map((rule: { value: string }) => rule.value)).toEqual([
      '203.0.113.0/24',
    ]);

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: database.id });
    await w.until(database.id, 'deleted');
    expect((await w.get(admin.id)).state).toBe('deleted');
    expect(w.emu.state.databases.has(providerId)).toBe(false);
  });

  it('trusted instances on a hosted pool: only the tenant’s own, on the pool’s account, become instance-tag rules', async () => {
    const w = await world();
    const database = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.database.pg',
      name: 'ledger',
      spec: { region: 'nyc3', version: '16', size: 'db-s-1vcpu-1gb' },
      idempotencyKey: 'ledger',
    });
    await w.until(database.id, 'ready');
    const { provider_account_id: accountId } = (
      await w.fixture.database.query<{ provider_account_id: string }>(
        `SELECT provider_account_id FROM cloud_resources WHERE id = $1`,
        [database.id],
      )
    ).rows[0]!;
    const ours = 'inst_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const theirs = 'inst_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    // Instance rows as vps admits them (the pool and flavor rows they reference are not needed here).
    await w.fixture.database.query(`SET session_replication_role = replica`);
    try {
      for (const [id, tenantId] of [
        [ours, w.acmeTenant],
        [theirs, w.fixture.tenants.other.id],
      ])
        await w.fixture.database.query(
          `INSERT INTO instances (id, tenant_id, pool_id, flavor_id, flavor, image_id, runtime, draft, state,
                                  desired_state, provider_account_id, owner_identity_id, idempotency_key,
                                  request_hash, version)
           VALUES ($1, $2, $3, 'flv_x', '{}'::jsonb, 'img', 'provider', false, 'running', 'running', $4, 'idn_x',
                   $1, '\\x00'::bytea, 1)`,
          [id, tenantId, w.poolId, accountId],
        );
    } finally {
      await w.fixture.database.query(`SET session_replication_role = DEFAULT`);
    }
    const trust = (instances: string[], key: string) =>
      w.api.cloudResources.create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.database.pg.firewall',
        name: key,
        parentId: database.id,
        spec: { instances },
        idempotencyKey: key,
      });
    for (const named of [[theirs], ['inst_cccccccccccccccccccccccccc']]) {
      const error = await trust(named, `fw-${named[0]!.slice(-4)}`).then(
        () => undefined,
        (failure: { code?: string; details?: Record<string, unknown> }) => failure,
      );
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'instance' } });
    }
    const trusted = await trust([ours], 'fw-ours');
    await w.until(trusted.id, 'ready');
    const cluster = w.emu.state.databases.get((await w.get(database.id)).providerId)!;
    expect(
      cluster._firewall.map((rule: { type: string; value: string }) => [rule.type, rule.value]),
    ).toEqual([['tag', tagFor('better-compute-instance', ours)]]);
    // Naming another tenant's instance later is refused the same way.
    const changed = await w.api.cloudResources
      .update(w.acme, {
        tenantId: w.acmeTenant,
        resourceId: trusted.id,
        spec: { instances: [ours, theirs] },
      })
      .then(
        () => undefined,
        (failure: { code?: string; details?: Record<string, unknown> }) => failure,
      );
    expect(changed).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'instance' } });
  });

  it('a cluster on a hosted pool joins the tenant’s own network; another tenant’s network is refused', async () => {
    const w = await world();
    const network = async (who: { token: string }, tenantId: string, name: string, cidr: string) => {
      const created = await w.api.networks.create(who, {
        tenantId,
        poolId: w.poolId,
        name,
        idempotencyKey: `net-${name}`,
      });
      await w.api.networks.addSubnet(who, {
        tenantId,
        networkId: created.id,
        name: `${name}-nyc3`,
        region: 'nyc3',
        cidr,
      });
      for (let round = 0; round < 8; round++) {
        if ((await w.api.networks.get(who, { tenantId, networkId: created.id })).state === 'ready')
          return created.id as string;
        await w.fixture.advance(5_000);
        await w.fixture.compute.jobs['vps.networks']!.tick();
      }
      throw new Error(`network ${name} never became ready`);
    };
    const ours = await network(w.acme, w.acmeTenant, 'prod', '10.30.0.0/24');
    const theirs = await network(w.root, w.fixture.tenants.root.id, 'ops', '10.31.0.0/24');
    const create = (net: string, key: string) =>
      w.api.cloudResources.create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.database.pg',
        name: key,
        spec: { region: 'nyc3', version: '16', size: 'db-s-1vcpu-1gb', network: net },
        idempotencyKey: key,
      });
    for (const [net, key] of [
      [theirs, 'db-theirs'],
      ['net_zzzzzzzzzzzzzzzzzzzzzzzzzz', 'db-none'],
    ] as const) {
      const error = await create(net, key).then(
        () => undefined,
        (failure: { code?: string; details?: Record<string, unknown> }) => failure,
      );
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'network' } });
    }
    expect(w.emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/databases')).toEqual([]);
    const database = await create(ours, 'db-ours');
    await w.until(database.id, 'ready');
    const cluster = w.emu.state.databases.get((await w.get(database.id)).providerId)!;
    const vpc = w.emu.state.vpcs.get(cluster.private_network_uuid);
    expect(vpc?.description).toBe(`bc:network=${providerResourceName(ours)}`);
    // The network cannot change in place.
    const moved = await w.api.cloudResources
      .update(w.acme, { tenantId: w.acmeTenant, resourceId: database.id, spec: { network: theirs } })
      .then(
        () => undefined,
        (failure: { code?: string; details?: Record<string, unknown> }) => failure,
      );
    expect(moved).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'network' } });
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

describe('DigitalOcean App Platform and Functions through cloudResources', () => {
  it('an app’s SECRET env is a tenant SecretRef resolved at DO only; account-wide sources are refused on a hosted pool', async () => {
    const w = await world();
    const { ref } = await w.api.secrets.put(w.acme, {
      tenantId: w.acmeTenant,
      name: 'stripe',
      value: 'sk_live_plaintext_4242',
      idempotencyKey: 'stripe',
    });
    const spec = {
      region: 'nyc',
      services: [{ name: 'web', image: { registry_type: 'DOCKER_HUB', repository: 'nginx' } }],
      envs: [{ key: 'STRIPE_KEY', type: 'SECRET', value: ref }],
    };
    const app = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.app',
      name: 'shop',
      spec,
      idempotencyKey: 'shop',
    });
    await w.until(app.id, 'ready');
    const ready = await w.get(app.id);
    const atDo = w.emu.state.apps.get(ready.providerId)!;
    expect(atDo.spec.name).toBe(app.providerName);
    expect(atDo._secrets.STRIPE_KEY).toBe('sk_live_plaintext_4242');
    expect(ready.outputs.liveUrl).toMatch(/^https:/);
    expect(ready.spec.envs).toEqual([{ key: 'STRIPE_KEY', type: 'SECRET', value: ref }]);
    const rows = await w.fixture.database.query(`SELECT * FROM cloud_resources`);
    const outbox = await w.fixture.database.query(`SELECT payload FROM outbox`);
    expect(JSON.stringify([rows.rows, outbox.rows, w.logs])).not.toContain(
      'sk_live_plaintext_4242',
    );

    // A linked repository of the platform's account is out of reach on the hosted pool: refused at the API,
    // before anything is recorded or sent.
    const linked = await w.api.cloudResources
      .create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.app',
        name: 'linked',
        spec: { services: [{ name: 'web', github: { repo: 'platform/private', branch: 'main' } }] },
        idempotencyKey: 'linked',
      })
      .then(
        () => undefined,
        (error: { code?: string; details?: Record<string, unknown> }) => error,
      );
    expect(linked).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'accountWide' } });
    const named = await w.fixture.database.query(
      `SELECT id FROM cloud_resources WHERE name = 'linked'`,
    );
    expect(named.rows).toEqual([]);
    expect([...w.emu.state.apps.values()].map((entry) => entry.spec.name)).toEqual([
      app.providerName,
    ]);

    // A ref to another tenant's secret (here the root's DO token) does not resolve for acme.
    const { ref: rootRef } = await w.api.secrets.put(w.root, {
      tenantId: w.fixture.tenants.root.id,
      name: 'root-only',
      value: 'root-only-value-77',
      idempotencyKey: 'root-only',
    });
    const stolen = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.app',
      name: 'stolen',
      spec: { ...spec, envs: [{ key: 'X', type: 'SECRET', value: rootRef }] },
      idempotencyKey: 'stolen',
    });
    await w.until(stolen.id, 'error');
    expect(JSON.stringify([...w.emu.state.apps.values()])).not.toContain('root-only-value-77');

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: app.id });
    await w.until(app.id, 'deleted');
    expect(w.emu.state.apps.size).toBe(0);
  });

  it('an app whose first deployment failed keeps its id, so deleting it deletes the app at DigitalOcean', async () => {
    const w = await world();
    w.emu.failDeployments = true;
    const app = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.app',
      name: 'broken',
      spec: {
        region: 'nyc',
        services: [{ name: 'web', image: { registry_type: 'DOCKER_HUB', repository: 'nginx' } }],
      },
      idempotencyKey: 'broken',
    });
    await w.until(app.id, 'error');
    const failed = await w.get(app.id);
    expect(failed.message).toMatch(/ended ERROR/);
    expect(w.emu.state.apps.size).toBe(1);
    expect(failed.providerId).toBe([...w.emu.state.apps.keys()][0]);
    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: app.id });
    await w.until(app.id, 'deleted');
    expect(w.emu.state.apps.size).toBe(0);
  });

  it('a Functions namespace’s key is sealed; a trigger lives in it and goes first on delete', async () => {
    const w = await world();
    const namespace = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.functions-namespace',
      name: 'jobs',
      spec: { region: 'ams3' },
      idempotencyKey: 'jobs',
    });
    await w.until(namespace.id, 'ready');
    const ready = await w.get(namespace.id);
    const atDo = w.emu.state.functionsNamespaces.get(ready.providerId)!;
    const secrets = w.fixture.compute.context.secrets!;
    expect(await secrets.resolve(ready.secretOutputs.key, { tenantId: w.acmeTenant })).toBe(
      atDo.key,
    );
    const trigger = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.functions-trigger',
      name: 'nightly',
      parentId: namespace.id,
      spec: { name: 'nightly', function: 'jobs/cleanup', cron: '0 3 * * *' },
      idempotencyKey: 'nightly',
    });
    await w.until(trigger.id, 'ready');
    expect(atDo._triggers.map((entry: { name: string }) => entry.name)).toEqual(['nightly']);
    const rows = await w.fixture.database.query(`SELECT * FROM cloud_resources`);
    expect(JSON.stringify([rows.rows, w.logs])).not.toContain(atDo.key);
    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: namespace.id });
    await w.until(namespace.id, 'deleted');
    expect((await w.get(trigger.id)).state).toBe('deleted');
    expect(w.emu.state.functionsNamespaces.size).toBe(0);
  });
});
