import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@better-compute/core';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator } from './support/do-emulator/index.js';

// A DigitalOcean account owned by a tenant names only that tenant's own secrets. `env://` is the
// control plane's environment and another tenant's (or the platform's) `secret://` is theirs: either
// would let the tenant run as someone else against the platform's DO team. vps refuses them at
// providerAccounts.create (INVALID_CONFIG) and again at resolve time (ACCESS_DENIED); the token
// never reaches DigitalOcean.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

async function world() {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['platform-token', 'acme-token']);
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })] })],
  });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  // The platform's own Droplet in the platform's DO team.
  seedDroplet(emu.state, { name: 'platform-db', tags: ['role:db'] });
  const api = compute.api as any;
  const as = (who: 'root' | 'acme') => ({ token: tenants[who].token });
  const put = async (who: 'root' | 'acme', name: string, value: string) =>
    (
      (await api.secrets.put(as(who), {
        tenantId: tenants[who].id,
        name,
        value,
        idempotencyKey: name,
      })) as { ref: string }
    ).ref;
  const create = (token: string, name = 'mine') =>
    api.providerAccounts.create(as('acme'), {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name,
      config: { token, regions: ['nyc3'] },
    });
  return { emu, fixture, api, tenants, as, put, create };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved' }),
    (error: { code?: string; details?: unknown }) => ({ code: error.code, details: error.details }),
  );

describe('tenant-owned DigitalOcean accounts', () => {
  it("a tenant account cannot use env:// refs or another tenant's secret", async () => {
    const { emu, fixture, api, tenants, as, put, create } = await world();
    const platform = await put('root', 'do', 'platform-token');
    for (const ref of [
      'env://DIGITALOCEAN_TOKEN',
      platform,
      `secret://${tenants.other.id}/their-token`,
    ])
      expect(await refusal(create(ref)), ref).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { path: 'config.token', reason: 'secretRefScope' },
      });
    expect(
      (await api.providerAccounts.list(as('acme'), { tenantId: tenants.acme.id })).items,
    ).toEqual([]);
    expect(emu.requests).toEqual([]);

    // A row naming the platform's token, written around the API, never resolves it.
    for (const ref of ['env://DIGITALOCEAN_TOKEN', platform]) {
      const id = newId('pacct');
      await fixture.database.query(
        `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
         VALUES ($1, $2, 'digitalocean', $1, $3::jsonb, 1)`,
        [id, tenants.acme.id, JSON.stringify({ token: ref, regions: ['nyc3'] })],
      );
      expect(
        await refusal(
          api.providerAccounts.offers(as('acme'), {
            tenantId: tenants.acme.id,
            accountId: id,
            query: {},
          }),
        ),
        ref,
      ).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'secretRefScope' } });
    }
    expect(emu.requests).toEqual([]);

    // Its own secret is accepted and is what DigitalOcean is called with.
    const mine = await put('acme', 'do', 'acme-token');
    const account = await create(mine);
    expect(account).toMatchObject({ tenantId: tenants.acme.id, config: { token: mine } });
    const offers = await api.providerAccounts.offers(as('acme'), {
      tenantId: tenants.acme.id,
      accountId: account.id,
      query: {},
    });
    expect(offers.items ?? offers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'nyc3/s-1vcpu-1gb' })]),
    );
    expect(emu.requests.length).toBeGreaterThan(0);
    expect(
      emu.requests.every((request) => request.headers.authorization === 'Bearer acme-token'),
    ).toBe(true);
    // And an update to the platform's token is refused; the stored account is unchanged.
    expect(
      await refusal(
        api.providerAccounts.update(as('acme'), {
          tenantId: tenants.acme.id,
          accountId: account.id,
          config: { token: platform, regions: ['nyc3'] },
        }),
      ),
    ).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(
      await api.providerAccounts.get(as('acme'), {
        tenantId: tenants.acme.id,
        accountId: account.id,
      }),
    ).toMatchObject({ version: 1, config: { token: mine } });
  });
});
