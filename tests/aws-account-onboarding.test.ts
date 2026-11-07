import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { defineProvider, describedAccount, vps } from '@better-compute/vps';
import { field, manifest } from '@better-compute/core';
import { AwsEmulator } from './support/aws-emulator/index.js';

// AWS A7 onboarding through vps: `providerAccounts.get` returns what a console shows a tenant to
// finish setting up its AWS account (`onboarding`, from the provider's pure `describeAccount`): the
// platform-assigned ExternalId and the platform principal for a role the control plane assumes, or
// the subject and audience its role must trust for a keyless account. Never a secret.

afterEach(closeFixtures);

const ISSUER = 'https://compute.example.test/api/compute/workload';
const PLATFORM = 'arn:aws:iam::111111111111:role/bc-control-plane';

async function world(providerOptions: Parameters<typeof awsProvider>[0] = {}) {
  const emu = new AwsEmulator();
  const issuer = workloadIssuer({ issuer: ISSUER, signingKey: generateP256KeyPair().privateKey });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [
          awsProvider({ fetch: emu.fetch, credentials: emu.ambient, ...providerOptions }),
        ],
      }),
    ],
    pki: { workloadIssuer: issuer },
  });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.acme.token });
  iam.allow({ token: tenants.root.token });
  const api = compute.api as any;
  const acme = { token: tenants.acme.token };
  return { emu, api, acme, tenants, root: { token: tenants.root.token } };
}

describe('provider account onboarding (A7)', () => {
  it('a role account shows the platform-assigned ExternalId and the platform principal', async () => {
    const { api, acme, tenants } = await world({
      platformPrincipalArn: PLATFORM,
      externalIdPrefix: 'acme-cloud',
    });
    const created = await api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'aws',
      name: 'role',
      config: {
        region: 'us-east-1',
        zones: ['us-east-1a'],
        assumeRoleArn: 'arn:aws:iam::222222222222:role/better-compute',
      },
    });
    const account = await api.providerAccounts.get(acme, {
      tenantId: tenants.acme.id,
      accountId: created.id,
    });
    expect(account.onboarding).toEqual({
      mode: 'assume-role',
      roleArn: 'arn:aws:iam::222222222222:role/better-compute',
      externalId: `acme-cloud:${created.id}`,
      platformPrincipalArn: PLATFORM,
    });
  });

  it('a malformed platformPrincipalArn is refused when the provider is built, never shown', () => {
    for (const platformPrincipalArn of [
      'bc-control-plane',
      'arn:aws:s3:::bucket',
      'arn:aws:iam::1111:role/x',
      'arn:aws:iam::111111111111:group/ops',
    ])
      expect(() => awsProvider({ platformPrincipalArn }), platformPrincipalArn).toThrow(
        expect.objectContaining({
          code: 'INVALID_CONFIG',
          details: expect.objectContaining({ provider: 'aws', reason: 'platformPrincipalArn' }),
        }),
      );
    expect(() => awsProvider({ platformPrincipalArn: PLATFORM })).not.toThrow();
    // Unset, a role account shows the ExternalId only: the principal is the host's to name.
    const describe = awsProvider().describeAccount!;
    expect(
      describe(
        {
          region: 'us-east-1',
          zones: ['us-east-1a'],
          assumeRoleArn: 'arn:aws:iam::222222222222:role/better-compute',
          rootVolumeGiB: 100,
          rootVolumeType: 'gp3',
          metadataHopLimit: 1,
          associatePublicIp: true,
        },
        { id: 'pa_3', tenantId: 't_acme', name: 'role', platform: false },
      ),
    ).toEqual({
      mode: 'assume-role',
      roleArn: 'arn:aws:iam::222222222222:role/better-compute',
      externalId: 'better-compute:pa_3',
    });
  });

  it('a keyless account shows the subject and audience its role trusts', () => {
    // The keyless account's check is covered by aws-account-federation.test.ts; the hook is pure.
    const describe = awsProvider().describeAccount!;
    expect(
      describe(
        {
          region: 'us-east-1',
          zones: ['us-east-1a'],
          webIdentityRoleArn: 'arn:aws:iam::222222222222:role/keyless',
          rootVolumeGiB: 100,
          rootVolumeType: 'gp3',
          metadataHopLimit: 1,
          associatePublicIp: true,
        },
        { id: 'pa_1', tenantId: 't_acme', name: 'keyless', platform: false },
      ),
    ).toEqual({
      mode: 'web-identity',
      roleArn: 'arn:aws:iam::222222222222:role/keyless',
      subject: 'compute-account:t_acme/aws/keyless',
      audience: 'sts.amazonaws.com',
    });
  });

  it("a keyless account shows the host's issuer URL, the --issuer of its onboarding template", () => {
    const config = {
      region: 'us-east-1',
      zones: ['us-east-1a'],
      webIdentityRoleArn: 'arn:aws:iam::222222222222:role/keyless',
      rootVolumeGiB: 100,
      rootVolumeType: 'gp3',
      metadataHopLimit: 1,
      associatePublicIp: true,
    };
    const account = {
      id: 'pa_1',
      tenantId: 't_acme',
      provider: 'aws',
      name: 'keyless',
      config,
      version: 1,
    } as never;
    const providers = new Map([['aws', awsProvider() as never]]);
    expect(describedAccount(providers, account, 'root', ISSUER).onboarding).toEqual({
      mode: 'web-identity',
      roleArn: 'arn:aws:iam::222222222222:role/keyless',
      subject: 'compute-account:t_acme/aws/keyless',
      audience: 'sts.amazonaws.com',
      issuer: ISSUER,
    });
    // Without a host issuer, nothing is invented.
    expect(describedAccount(providers, account, 'root').onboarding).not.toHaveProperty('issuer');
  });

  it('a platform account on ambient credentials says so, and a key account names no secret', async () => {
    const { api, root, tenants } = await world();
    const created = await api.providerAccounts.create(root, {
      tenantId: tenants.root.id,
      provider: 'aws',
      name: 'platform',
      config: { region: 'us-east-1', zones: ['us-east-1a'] },
    });
    const account = await api.providerAccounts.get(root, {
      tenantId: tenants.root.id,
      accountId: created.id,
    });
    expect(account.onboarding).toEqual({ mode: 'ambient' });
    const describe = awsProvider().describeAccount!;
    const keyed = describe(
      {
        region: 'us-east-1',
        zones: ['us-east-1a'],
        credentials: 'secret://aws/key',
        rootVolumeGiB: 100,
        rootVolumeType: 'gp3',
        metadataHopLimit: 1,
        associatePublicIp: true,
      },
      { id: 'pa_2', tenantId: 't', name: 'key', platform: false },
    );
    expect(keyed).toEqual({ mode: 'access-key' });
  });

  it("a provider without describeAccount adds nothing, and a throwing one never fails the read", async () => {
    const plain = defineProvider({
      id: 'plain',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ zone: field.string().optional() }),
      create: () => ({}) as any,
    });
    const broken = defineProvider({
      id: 'broken',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ zone: field.string().optional() }),
      create: () => ({}) as any,
      describeAccount: () => {
        throw new Error('boom');
      },
    });
    const bigint = defineProvider({
      id: 'bigint',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ zone: field.string().optional() }),
      create: () => ({}) as any,
      describeAccount: () => ({ n: 1n }) as any,
    });
    const circular = defineProvider({
      id: 'circular',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ zone: field.string().optional() }),
      create: () => ({}) as any,
      describeAccount: () => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        return loop as any;
      },
    });
    expect(() =>
      defineProvider({
        id: 'bad',
        version: '1.0.0',
        provides: ['vps'],
        config: manifest({}),
        create: () => ({}) as any,
        describeAccount: 'nope' as any,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const fixture = await computeFixture({
      clock: 'sim',
      modules: [vps({ providers: [plain, broken, bigint, circular] })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    const api = compute.api as any;
    const root = { token: tenants.root.token };
    for (const provider of ['plain', 'broken', 'bigint', 'circular']) {
      const created = await api.providerAccounts.create(root, {
        tenantId: tenants.root.id,
        provider,
        name: provider,
        config: {},
      });
      const account = await api.providerAccounts.get(root, {
        tenantId: tenants.root.id,
        accountId: created.id,
      });
      expect(account.onboarding).toBeUndefined();
      expect(account.name).toBe(provider);
    }
  });
});
