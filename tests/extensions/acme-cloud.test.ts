import { afterEach, describe, expect, it } from 'vitest';
import type { SqlTx } from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import {
  providerConformanceCases,
  vps,
  type ProviderConformanceSubject,
} from '@better-compute/vps';
import { createAcmeCloud } from './acme-cloud/cloud.js';
import { acmeCloudProvider } from './acme-cloud/provider.js';
import { recording, replaying } from './acme-cloud/record-replay.js';

// PLAN.md §5.6 walkthrough 2 — a VPS provider "acme-cloud", with zero edits to @better-compute/*:
// a third party's `defineProvider` over its HTTP API (./acme-cloud/provider.ts) passes
// providerConformance live against the cloud (here its emulator) and again offline from the
// recording; a provider account, a `class: 'provider'` pool (agent 'none') offered to a tenant and a
// flavor then run instances through the generic provider steps: created once (idempotently), followed
// to running, stopped, deleted, with quota returned. No machine ever runs bcd or gets a join token.

afterEach(closeFixtures);

const TOKEN = 'acme-api-token-0123456789';
const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcmeCloudWalkthroughKey alice@laptop';

describe('walkthrough 2: the acme-cloud provider', () => {
  it('passes providerConformance live, then replays the recording offline', async () => {
    const cloud = createAcmeCloud({ token: TOKEN });
    const tape = recording(cloud.fetch);
    const subject = (fetch: typeof globalThis.fetch): ProviderConformanceSubject => ({
      provider: acmeCloudProvider({ fetch }),
      config: { token: 'secret://acme/token' },
      offerId: 'a1.small',
      image: 'ubuntu-24.04',
      prefix: 'walkthrough-2',
      context: { secrets: { resolve: async () => TOKEN } },
    });
    const live = await runConformance(providerConformanceCases(), subject(tape.transport));
    expect(live.failed).toEqual([]);
    expect(live.passed.length).toBe(providerConformanceCases().length);
    expect(cloud.servers.size).toBe(0); // every case cleaned up after itself

    const replay = replaying(tape.exchanges);
    const offline = await runConformance(providerConformanceCases(), subject(replay.transport));
    expect(offline.failed).toEqual([]);
    expect(replay.remaining).toEqual([]);

    // A wrong token is a configuration error, not a provider outage.
    const refused = await runConformance(providerConformanceCases().slice(1, 2), {
      ...subject(cloud.fetch),
      context: { secrets: { resolve: async () => 'wrong-token' } },
    });
    expect(String((refused.failed[0]?.error as Error | undefined)?.message)).toMatch(
      /refused the account token/,
    );
  });

  it('runs tenant instances on a provider pool through the generic provider steps', async () => {
    const cloud = createAcmeCloud({ token: TOKEN });
    const images = {
      async resolve(_tx: SqlTx, _tenantId: string, imageId: string) {
        if (imageId !== 'ubuntu-24.04') return undefined;
        return {
          url: 'https://images.example/ubuntu-24.04.qcow2',
          sha256: 'ab'.repeat(32),
          format: 'qcow2' as const,
          verified: true,
        };
      },
    };
    const fixture: ComputeFixture = await computeFixture({
      clock: 'sim',
      modules: [
        vps({
          runtimes: ['libvirt-kvm'],
          providers: [acmeCloudProvider({ fetch: cloud.fetch })],
          images,
        }),
      ],
    });
    const { compute, tenants, iam } = fixture;
    const api = compute.api as any;
    const root = { token: tenants.root.token };
    const acme = { token: tenants.acme.token };
    iam.allow({ token: tenants.root.token });
    iam.allow({ token: tenants.acme.token });

    // The platform: the account (its token sealed in the secret store), a provider pool, an offer
    // to acme, and a flavor mapped onto the provider's offer.
    const tokenRef = await compute.context.secrets!.put(tenants.root.id, TOKEN);
    const account = await api.providerAccounts.create(root, {
      tenantId: tenants.root.id,
      provider: 'acme-cloud',
      name: 'acme-main',
      config: { token: tokenRef },
    });
    const offers = await api.providerAccounts.offers(root, {
      tenantId: tenants.root.id,
      accountId: account.id,
    });
    expect(JSON.stringify(offers)).toContain('a1.small');
    const site = await api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region: 'ams',
      idempotencyKey: 'acme-site',
    });
    const pool = await api.pools.create(root, {
      tenantId: tenants.root.id,
      siteId: site.id,
      class: 'provider',
      providerAccountId: account.id,
      idempotencyKey: 'acme-pool',
    });
    expect(pool.agent).toBe('none');
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      toTenantId: tenants.acme.id,
      quota: { vcpu: 4, memoryGiB: 8, diskGiB: 80 },
    });
    await api.flavors.create(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      name: 'a1.small',
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
      offerId: 'a1.small',
    });

    // A tenant creates an instance; the instance reconciler drives the provider.
    const instance = await api.instances.create(acme, {
      tenantId: tenants.acme.id,
      poolId: pool.id,
      flavor: 'a1.small',
      imageId: 'ubuntu-24.04',
      sshKeys: [SSH_KEY],
      idempotencyKey: 'acme-vm-1',
    });
    const tick = async () => {
      await fixture.advance(15_000);
      await compute.jobs['vps.instances']!.tick();
    };
    const view = () =>
      api.instances.get(acme, { tenantId: tenants.acme.id, instanceId: instance.id });
    await tick();
    await tick(); // a retried step creates nothing new
    expect(cloud.servers.size).toBe(1);
    const server = [...cloud.servers.values()][0]!;
    expect(server).toMatchObject({ offer: 'a1.small', idempotency_key: instance.id });
    expect(server.user_data).toContain(SSH_KEY);
    expect(server.user_data).not.toMatch(/join|token|bcd/i);
    expect(await view()).toMatchObject({ state: 'provisioning', addresses: [server.ipv4] });

    cloud.tick(); // the cloud finished booting it
    await tick();
    expect((await view()).state).toBe('running');

    // Over quota: a third small instance does not fit acme's 4 vCPU.
    await api.instances.create(acme, {
      tenantId: tenants.acme.id,
      poolId: pool.id,
      flavor: 'a1.small',
      imageId: 'ubuntu-24.04',
      idempotencyKey: 'acme-vm-2',
    });
    await expect(
      api.instances.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        flavor: 'a1.small',
        imageId: 'ubuntu-24.04',
        idempotencyKey: 'acme-vm-3',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/QUOTA|CAPACITY|INSUFFICIENT/) });

    const until = async (state: string) => {
      for (let passes = 0; passes < 5 && (await view()).state !== state; passes++) await tick();
      return (await view()).state;
    };
    await api.instances.stop(acme, { tenantId: tenants.acme.id, instanceId: instance.id });
    expect(await until('stopped')).toBe('stopped');
    expect(server.status).toBe('off');

    await api.instances.delete(acme, { tenantId: tenants.acme.id, instanceId: instance.id });
    expect(await until('deleted')).toBe('deleted');
    expect(cloud.servers.has(server.id)).toBe(false);
    expect((await view()).state).toBe('deleted');
    // Nothing on the provider path ever calls a daemon: the pool has no nodes.
    const { rows } = await fixture.database.query('SELECT 1 FROM nodes WHERE pool_id = $1', [
      pool.id,
    ]);
    expect(rows).toEqual([]);
  });
});
