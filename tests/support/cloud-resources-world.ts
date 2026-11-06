import type { Logger } from '@better-compute/core';
import { cloudResources, type CloudResourcesOptions } from '@better-compute/cloud-resources';
import { computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import {
  fakeResourcesCloud,
  fakeResourcesProvider,
  noResourcesProvider,
  type FakeResourcesCloud,
} from './fake-resources.js';

// A control plane with vps and cloud-resources over the fake long-tail provider: a root (platform) account in nyc3
// and ams3, a provider pool on it offered to acme and other (the hosted model), a pool on a provider without
// resources, and acme's own (BYO) account and pool. Every log line is kept, to check no secret is ever logged.

type Api = any;

export interface CloudResourcesWorld {
  fixture: ComputeFixture;
  /** The cloud-resources module instance the fixture runs. */
  module: ReturnType<typeof cloudResources>;
  api: Api;
  cloud: FakeResourcesCloud;
  /** acme's own account and a pool on it (BYO). */
  acmeAccountId: string;
  acmePoolId: string;
  root: { token: string };
  acme: { token: string };
  other: { token: string };
  rootTenant: string;
  acmeTenant: string;
  otherTenant: string;
  accountId: string;
  poolId: string;
  plainPoolId: string;
  siteId: string;
  logs: string[];
  /** Advances the sim clock by `ms` (default 10 s) and runs the job's due keys, `rounds` times. */
  tick(job?: string, rounds?: number, ms?: number): Promise<void>;
  /** Ticks the resource reconciler until `done` holds (at most `limit` rounds). */
  until(done: () => Promise<boolean>, limit?: number): Promise<number>;
  /** Outbox events, oldest first, of one type prefix. */
  events(
    prefix?: string,
  ): Promise<{ type: string; subject: string; data: any; tenantId: string }[]>;
}

export async function cloudResourcesWorld(
  options: Omit<CloudResourcesOptions, 'providers'> = {},
): Promise<CloudResourcesWorld> {
  const cloud = fakeResourcesCloud();
  const providers = [fakeResourcesProvider(cloud), noResourcesProvider];
  const logs: string[] = [];
  const module = cloudResources({ providers, ...options });
  const log: Logger = {
    debug: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
  } as Logger;
  const fixture = await computeFixture({
    clock: 'sim',
    log,
    modules: [vps({ providers }), module],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  iam.allow({ token: tenants.other.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-cloud',
    name: 'cloud-main',
    config: { regions: ['nyc3', 'ams3'] },
  });
  const plainAccount = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-plain',
    name: 'plain',
    config: { regions: ['nyc3'] },
  });
  const acmeAccount = await api.providerAccounts.create(
    { token: tenants.acme.token },
    {
      tenantId: tenants.acme.id,
      provider: 'fake-cloud',
      name: 'acme-own',
      config: { regions: ['nyc3'], previews: true },
    },
  );
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'nyc3',
    idempotencyKey: 'cr-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'cr-pool',
  });
  const plainPool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: plainAccount.id,
    idempotencyKey: 'plain-pool',
  });
  const acmeSite = await api.sites.create(
    { token: tenants.acme.token },
    { tenantId: tenants.acme.id, kind: 'custom', region: 'nyc3', idempotencyKey: 'acme-site' },
  );
  const acmePool = await api.pools.create(
    { token: tenants.acme.token },
    {
      tenantId: tenants.acme.id,
      siteId: acmeSite.id,
      class: 'provider',
      providerAccountId: acmeAccount.id,
      idempotencyKey: 'acme-pool',
    },
  );
  for (const tenant of [tenants.acme.id, tenants.other.id])
    for (const poolId of [pool.id, plainPool.id])
      await api.pools.offer(root, {
        tenantId: tenants.root.id,
        poolId,
        toTenantId: tenant,
        quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 0 },
      });
  const tick = async (job = 'cloud.resources', rounds = 1, ms = 10_000) => {
    for (let round = 0; round < rounds; round++) {
      await fixture.advance(ms);
      await compute.jobs[job]!.tick();
    }
  };
  return {
    fixture,
    module,
    api,
    cloud,
    acmeAccountId: acmeAccount.id,
    acmePoolId: acmePool.id,
    root,
    acme: { token: tenants.acme.token },
    other: { token: tenants.other.token },
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    otherTenant: tenants.other.id,
    accountId: account.id,
    poolId: pool.id,
    plainPoolId: plainPool.id,
    siteId: site.id,
    logs,
    tick,
    async until(done, limit = 12) {
      for (let round = 1; round <= limit; round++) {
        await tick();
        if (await done()) return round;
      }
      throw new Error(`not settled after ${limit} rounds; calls: ${cloud.calls.join(', ')}`);
    },
    async events(prefix = '') {
      const { rows } = await fixture.database.query<{
        topic: string;
        payload: { data: unknown; tenantId: string; subject: string };
      }>(`SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`, [`${prefix}%`]);
      return rows.map((row) => ({
        type: row.topic,
        subject: row.payload.subject,
        data: row.payload.data,
        tenantId: row.payload.tenantId,
      }));
    },
  };
}
