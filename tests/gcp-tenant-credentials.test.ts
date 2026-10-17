import { afterEach, describe, expect, it } from 'vitest';
import { gcpProvider } from '@better-compute/provider-gcp';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { GceEmulator } from './support/gce-emulator.js';

// Ruling F1 (final review C1): a GCP account owned by a tenant must carry its own credentials. With
// none, provider-gcp would fall back on the control plane's own identity (the metadata server, the
// host's `tokenSource`, or `impersonate` on top of either), so a tenant naming the platform's project
// could list, attach and delete the platform's VMs. Ambient credentials are the root tenant's only.

afterEach(closeFixtures);

const ZONE = 'us-central1-a';

async function world() {
  const emu = new GceEmulator();
  emu.validTokens.add('host-token');
  // The host's own (workload-identity) token source, as the README recommends for the platform.
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [gcp], discovery: { every: '1m' } })],
  });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  // The platform's own VM in the platform's project.
  emu.addInstance(ZONE, 'platform-db', { labels: { role: 'db' } });
  return { emu, fixture, api: compute.api as any, compute, tenants };
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

describe('tenant-owned GCP accounts (ruling F1)', () => {
  it('refuses a tenant account without its own credentials at create; nothing reaches GCE', async () => {
    const { emu, api, tenants } = await world();
    const acme = { token: tenants.acme.token };
    const create = (name: string, config: Record<string, unknown>) =>
      api.providerAccounts.create(acme, {
        tenantId: tenants.acme.id,
        provider: 'gcp',
        name,
        config: { projectId: 'p', zones: [ZONE], ...config },
      });
    // No credentials: the metadata server / the host's tokenSource would be the platform's identity.
    await expect(create('mine', {})).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // impersonate without credentials impersonates through the platform's identity.
    await expect(
      create('mine', { impersonate: 'platform-admin@p.iam.gserviceaccount.com' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await api.providerAccounts.list(acme, { tenantId: tenants.acme.id })).items).toEqual(
      [],
    );
    // With its own key the account is accepted, and taking the key away again is refused.
    const keyed = await create('keyed', { credentials: `secret://${tenants.acme.id}/gcp-key` });
    expect(keyed).toMatchObject({ tenantId: tenants.acme.id, provider: 'gcp' });
    expect(
      await codeOf(
        api.providerAccounts.update(acme, {
          tenantId: tenants.acme.id,
          accountId: keyed.id,
          config: { projectId: 'p', zones: [ZONE] },
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(emu.requests).toEqual([]);
    expect(emu.instances.has(`${ZONE}/platform-db`)).toBe(true);
  });

  it('an account row that slipped in without credentials fails every call; the platform VM survives', async () => {
    const { emu, fixture, api, compute, tenants } = await world();
    const acme = { token: tenants.acme.token };
    // As if stored before the check existed: every client built for it is refused.
    await fixture.database.query(
      `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
       VALUES ('pacct_01jz000000000000000000000b', $1, 'gcp', 'byo', $2::jsonb, 1)`,
      [tenants.acme.id, JSON.stringify({ projectId: 'p', zones: [ZONE] })],
    );
    expect(
      await codeOf(
        api.providerAccounts.offers(acme, {
          tenantId: tenants.acme.id,
          accountId: 'pacct_01jz000000000000000000000b',
          query: {},
        }),
      ),
    ).toBe('INVALID_CONFIG');
    await api.providerAccounts
      .discover(acme, { tenantId: tenants.acme.id, accountId: 'pacct_01jz000000000000000000000b' })
      .catch(() => undefined);
    await fixture.advance(60_000);
    for (let round = 0; round < 2; round++) await compute.jobs['vps.discovery']!.tick();
    const machines = await api.providerAccounts.machines(acme, {
      tenantId: tenants.acme.id,
      accountId: 'pacct_01jz000000000000000000000b',
    });
    expect(machines.items).toEqual([]);
    expect(emu.requests).toEqual([]);
    expect(emu.instances.has(`${ZONE}/platform-db`)).toBe(true);
  });

  it('a root-owned account with no credentials still uses the host identity', async () => {
    const { emu, fixture, api, compute, tenants } = await world();
    const root = { token: tenants.root.token };
    const account = await api.providerAccounts.create(root, {
      tenantId: tenants.root.id,
      provider: 'gcp',
      name: 'platform',
      config: { projectId: 'p', zones: [ZONE] },
    });
    await api.providerAccounts.discover(root, { tenantId: tenants.root.id, accountId: account.id });
    await fixture.advance(60_000);
    for (let round = 0; round < 2; round++) await compute.jobs['vps.discovery']!.tick();
    const machines = await api.providerAccounts.machines(root, {
      tenantId: tenants.root.id,
      accountId: account.id,
    });
    expect(machines.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      `${ZONE}/platform-db`,
    ]);
    expect(emu.requests.length).toBeGreaterThan(0);
    expect(
      emu.requests.every((request) => request.headers.get('authorization') === 'Bearer host-token'),
    ).toBe(true);
  });
});
