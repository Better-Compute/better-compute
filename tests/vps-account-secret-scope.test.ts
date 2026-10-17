import { afterEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  field,
  manifest,
  newId,
  type SecretResolveContext,
  type SecretResolver,
} from '@better-compute/core';
import { gcpProvider } from '@better-compute/provider-gcp';
import { hetznerCloud } from '@better-compute/provider-hetzner';
import { proxmox } from '@better-compute/provider-proxmox';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import {
  accountRefRefusal,
  defineProvider,
  parseTenantVaultPaths,
  vps,
  type TenantVaultPaths,
} from '@better-compute/vps';

// Provider-account secret refs are scoped to the account's tenant. A tenant's account names only
// `secret://<its tenant>/…` (and `vault://` paths the host allow-lists for it), never `env://` (the
// control plane's own environment) nor another tenant's or the platform's secrets: otherwise it would
// run as the platform. Refused at providerAccounts.create/update (INVALID_CONFIG), and again when the
// client resolves (ACCESS_DENIED), with the tenant handed to the store as the resolve context.

afterEach(closeFixtures);

/** What the probe provider resolved, and with which context. */
const resolved: Array<{ ref: string; value: string }> = [];

const probe = defineProvider({
  id: 'probe',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({ token: field.secret() }),
  create: async (config, context) => ({
    async listOffers() {
      resolved.push({ ref: config.token, value: await context.secrets.resolve(config.token) });
      return [];
    },
    async create() {
      throw new ComputeError('UNIMPLEMENTED', 'probe');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});

/** A resolver standing in for the host's stores (env://, vault://): it records each context. */
function recordingResolver() {
  const calls: Array<{ ref: string; context?: SecretResolveContext }> = [];
  const resolver: SecretResolver = {
    resolve: async (ref, context) => {
      calls.push(context ? { ref, context } : { ref });
      return `value-of:${ref}`;
    },
  };
  return { calls, resolver };
}

async function world(
  options: { secrets?: SecretResolver; tenantVaultPaths?: TenantVaultPaths } = {},
) {
  resolved.length = 0;
  const fixture = await computeFixture({
    modules: [
      vps({
        providers: [probe, gcpProvider(), hetznerCloud, proxmox],
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.tenantVaultPaths ? { tenantVaultPaths: options.tenantVaultPaths } : {}),
      }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const as = (who: 'root' | 'acme') => ({ token: tenants[who].token });
  const create = (who: 'root' | 'acme', token: string, name = 'main') =>
    api.providerAccounts.create(as(who), {
      tenantId: tenants[who].id,
      provider: 'probe',
      name,
      config: { token },
    });
  const offers = (who: 'root' | 'acme', accountId: string) =>
    api.providerAccounts.offers(as(who), { tenantId: tenants[who].id, accountId });
  const put = async (who: 'root' | 'acme', name: string, value: string) =>
    (
      (await api.secrets.put(as(who), {
        tenantId: tenants[who].id,
        name,
        value,
        idempotencyKey: name,
      })) as { ref: string }
    ).ref;
  return { fixture, api, tenants, as, create, offers, put };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved' }),
    (error: ComputeError) => ({ code: error.code, details: error.details }),
  );

describe('providerAccounts.create/update: secret refs of a tenant account', () => {
  it('refuses env://, vault:// and other tenants’ secret:// refs; nothing is stored', async () => {
    const { tenants, create, api, as } = await world();
    for (const ref of [
      'env://HCLOUD_TOKEN',
      'vault://kv/platform/hcloud',
      `secret://${tenants.root.id}/platform-token`,
      `secret://${tenants.other.id}/their-token`,
    ])
      expect(await refusal(create('acme', ref)), ref).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { path: 'config.token', reason: 'secretRefScope' },
      });
    expect(
      (await api.providerAccounts.list(as('acme'), { tenantId: tenants.acme.id })).items,
    ).toEqual([]);
  });

  it('accepts the tenant’s own secret:// ref, and refuses an update to the platform’s', async () => {
    const { tenants, create, api, as } = await world();
    const account = await create('acme', `secret://${tenants.acme.id}/hcloud`);
    expect(account).toMatchObject({
      tenantId: tenants.acme.id,
      config: { token: `secret://${tenants.acme.id}/hcloud` },
    });
    for (const ref of ['env://HCLOUD_TOKEN', `secret://${tenants.root.id}/platform-token`])
      expect(
        await refusal(
          api.providerAccounts.update(as('acme'), {
            tenantId: tenants.acme.id,
            accountId: account.id,
            config: { token: ref },
          }),
        ),
        ref,
      ).toMatchObject({ code: 'INVALID_CONFIG' });
    const stored = await api.providerAccounts.get(as('acme'), {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(stored).toMatchObject({
      version: 1,
      config: { token: `secret://${tenants.acme.id}/hcloud` },
    });
  });

  it('holds for every provider, not only gcp: hetzner, proxmox and gcp accounts alike', async () => {
    const { tenants, api, as } = await world();
    const configs: Record<string, Record<string, unknown>> = {
      'hetzner-cloud': { token: 'env://HCLOUD_TOKEN' },
      proxmox: { url: 'https://pve.example.com:8006', token: 'env://PVE_TOKEN' },
      gcp: { projectId: 'platform', zones: ['us-central1-a'], credentials: 'env://GCP_KEY' },
    };
    for (const [provider, config] of Object.entries(configs))
      expect(
        await refusal(
          api.providerAccounts.create(as('acme'), {
            tenantId: tenants.acme.id,
            provider,
            name: provider,
            config,
          }),
        ),
        provider,
      ).toMatchObject({ code: 'INVALID_CONFIG', details: { reason: 'secretRefScope' } });
  });

  it('allows a tenant the vault:// paths the host lists for it, and nothing outside them', async () => {
    const { calls, resolver } = recordingResolver();
    const { tenants, create, offers } = await world({
      secrets: resolver,
      tenantVaultPaths: { 'tenant-acme': ['kv/tenants/acme/', 'kv/shared/acme-token'] },
    });
    expect(tenants.acme.id).toBe('tenant-acme');
    const under = await create('acme', 'vault://kv/tenants/acme/hcloud', 'under');
    await create('acme', 'vault://kv/shared/acme-token', 'exact');
    for (const ref of [
      'vault://kv/tenants/acme', // the prefix itself is not under it
      'vault://kv/tenants/acme-evil/hcloud',
      'vault://kv/tenants/acme/../platform/hcloud',
      'vault://kv/tenants/acme/%2e%2e/platform/hcloud',
      'vault://kv/tenants/acme//hcloud',
      'vault://kv/shared/acme-token/more',
      'vault://kv/platform/hcloud',
    ])
      expect(await refusal(create('acme', ref, 'bad')), ref).toMatchObject({
        code: 'INVALID_CONFIG',
      });
    await offers('acme', under.id);
    // Resolved with the account's tenant as the context, so the vault store can scope it too.
    expect(calls).toEqual([
      { ref: 'vault://kv/tenants/acme/hcloud', context: { tenantId: 'tenant-acme' } },
    ]);
  });
});

describe('root (platform) accounts', () => {
  it('still use env://, vault:// and secret:// refs', async () => {
    const { calls, resolver } = recordingResolver();
    const { tenants, create, offers } = await world({ secrets: resolver });
    const refs = [
      'env://HCLOUD_TOKEN',
      'vault://kv/platform/hcloud',
      `secret://${tenants.root.id}/x`,
    ];
    for (const [index, ref] of refs.entries()) {
      const account = await create('root', ref, `root-${index}`);
      await offers('root', account.id);
    }
    expect(resolved.map(({ ref }) => ref)).toEqual(refs);
    // The platform's refs are served as before: no tenant context.
    expect(calls).toEqual(refs.map((ref) => ({ ref })));
  });
});

describe('resolve time (defence in depth)', () => {
  it('a tenant account row naming the platform’s refs, written around the API, never resolves them', async () => {
    const { calls, resolver } = recordingResolver();
    const { fixture, tenants, offers } = await world({ secrets: resolver });
    for (const ref of [
      'env://HCLOUD_TOKEN',
      'vault://kv/platform/hcloud',
      `secret://${tenants.root.id}/platform-token`,
    ]) {
      const id = newId('pacct');
      await fixture.database.query(
        `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
         VALUES ($1, $2, 'probe', $1, $3::jsonb, 1)`,
        [id, tenants.acme.id, JSON.stringify({ token: ref })],
      );
      expect(await refusal(offers('acme', id)), ref).toMatchObject({
        code: 'ACCESS_DENIED',
        details: { reason: 'secretRefScope' },
      });
    }
    expect(calls).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('the sealed store checks the secret is the tenant’s: a tenant resolves its own, never root’s', async () => {
    // The host's own secret broker: secret:// refs live in the local sealed store.
    const { fixture, tenants, create, offers, put } = await world();
    const mine = await put('acme', 'hcloud', 'acme-token');
    const platform = await put('root', 'hcloud', 'platform-token');
    expect(mine).toBe(`secret://${tenants.acme.id}/${mine.split('/').pop()}`);
    const account = await create('acme', mine);
    await offers('acme', account.id);
    expect(resolved).toEqual([{ ref: mine, value: 'acme-token' }]);
    // A row copied under the tenant's ref that is the platform's (tenant_id root) does not open for it.
    await fixture.database.query(`UPDATE sealed_secrets SET tenant_id = $2 WHERE ref = $1`, [
      mine,
      tenants.root.id,
    ]);
    const fresh = await create('acme', mine, 'second');
    expect(await refusal(offers('acme', fresh.id))).toMatchObject({ code: 'ACCESS_DENIED' });
    // Root still resolves its own.
    const rootAccount = await create('root', platform);
    await offers('root', rootAccount.id);
    expect(resolved.at(-1)).toEqual({ ref: platform, value: 'platform-token' });
  });
});

describe('accountRefRefusal and parseTenantVaultPaths', () => {
  const scope = { rootTenantId: 'root', tenantVaultPaths: { acme: ['kv/acme/'] } };
  it('scopes by tenant; without a known root tenant no account is the platform’s', () => {
    expect(accountRefRefusal('env://X', { tenantId: 'root' }, scope)).toBeUndefined();
    expect(accountRefRefusal('secret://acme/x', { tenantId: 'acme' }, scope)).toBeUndefined();
    expect(accountRefRefusal('vault://kv/acme/x', { tenantId: 'acme' }, scope)).toBeUndefined();
    expect(accountRefRefusal('vault://kv/acme/x', { tenantId: 'other' }, scope)).toMatch(
      /not allowed/,
    );
    expect(accountRefRefusal('secret://acme/x', { tenantId: 'acme-2' }, scope)).toMatch(
      /secret:\/\/acme-2\//,
    );
    expect(accountRefRefusal('secret://acme/x/y', { tenantId: 'acme' }, scope)).toBeDefined();
    expect(accountRefRefusal('file:///etc/passwd', { tenantId: 'acme' }, scope)).toMatch(
      /file:\/\//,
    );
    expect(accountRefRefusal('env://X', { tenantId: 'root' }, {})).toMatch(/env:\/\//);
  });

  it('refuses allow-list entries that could leave their prefix', () => {
    expect(parseTenantVaultPaths({ acme: ['kv/acme/', 'kv/one'] })).toEqual({
      acme: ['kv/acme/', 'kv/one'],
    });
    for (const bad of [{ acme: ['kv/../x'] }, { acme: [''] }, { acme: ['/'] }, { acme: 'kv/' }, []])
      expect(() => parseTenantVaultPaths(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() => vps({ tenantVaultPaths: { acme: ['kv//x'] } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});
