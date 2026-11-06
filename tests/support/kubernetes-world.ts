import type { ComputeModule, Logger } from '@better-compute/core';
import { kubernetes, type KubernetesOptions } from '@better-compute/kubernetes';
import { computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import {
  fakeKubernetes,
  fakeKubernetesProvider,
  noKubernetesProvider,
  type FakeKubernetes,
} from './fake-kubernetes.js';

// A control plane with vps and kubernetes over the fake managed-Kubernetes provider: a root (platform) account in
// three us-central1 zones and europe-west4-a, a provider pool on it offered to acme and other (the hosted model),
// and a pool on a provider without Kubernetes. Every log line is kept, to check no token is ever logged.

type Api = any;

export interface KubernetesWorld {
  fixture: ComputeFixture;
  /** The kubernetes module instance the fixture runs. */
  module: ReturnType<typeof kubernetes>;
  api: Api;
  cloud: FakeKubernetes;
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
  /** Ticks the cluster reconciler until `done` holds (at most `limit` rounds). */
  until(done: () => Promise<boolean>, limit?: number): Promise<number>;
  /** Outbox events, oldest first, of one type prefix. */
  events(
    prefix?: string,
  ): Promise<{ type: string; subject: string; data: any; tenantId: string }[]>;
}

export async function kubernetesWorld(
  options: Omit<KubernetesOptions, 'providers'> = {},
  /** More modules the control plane runs (e.g. fleet). */
  extra: { modules?: readonly ComputeModule[] } = {},
): Promise<KubernetesWorld> {
  const cloud = fakeKubernetes();
  const providers = [fakeKubernetesProvider(cloud), noKubernetesProvider];
  const logs: string[] = [];
  const module = kubernetes({ providers, ...options });
  const log: Logger = {
    debug: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
  } as Logger;
  const fixture = await computeFixture({
    clock: 'sim',
    log,
    modules: [vps({ providers }), module, ...(extra.modules ?? [])],
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
    provider: 'fake-gke',
    name: 'gke-main',
    config: { zones: ['us-central1-a', 'us-central1-b', 'us-central1-c', 'europe-west4-a'] },
  });
  const plainAccount = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-plain',
    name: 'plain',
    config: { zones: ['us-central1-a'] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'k8s-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'k8s-pool',
  });
  const plainPool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: plainAccount.id,
    idempotencyKey: 'plain-pool',
  });
  for (const tenant of [tenants.acme.id, tenants.other.id])
    for (const poolId of [pool.id, plainPool.id])
      await api.pools.offer(root, {
        tenantId: tenants.root.id,
        poolId,
        toTenantId: tenant,
        quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 0 },
      });
  const tick = async (job = 'kubernetes.clusters', rounds = 1, ms = 10_000) => {
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
