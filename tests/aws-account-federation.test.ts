import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';

// AWS A7 through vps: before a keyless (webIdentityRoleArn) AWS account is stored, checkAccount
// proves that the tenant's role trusts exactly the account's subject (a stranger's and a sibling's
// probes are refused, the account's own subject is accepted), that the federated identity is the
// role's own account, and that it can read EC2. Mirrors gcp-federation.test.ts.

afterEach(closeFixtures);

const ISSUER = 'https://compute.example.test/api/compute/workload';
const ROLE = 'arn:aws:iam::222222222222:role/better-compute';

interface WorldOptions {
  issuer?: boolean;
  /** The role's trust over `sub`. Default: exactly the subjects of the accounts these tests create. */
  trust?: (sub: string, ids: { acme: string }) => boolean;
}

async function world(options: WorldOptions = {}) {
  const emu = new AwsEmulator();
  new Ec2Emulator(emu);
  const issuer = workloadIssuer({ issuer: ISSUER, signingKey: generateP256KeyPair().privateKey });
  const ids = { acme: '' };
  const trust =
    options.trust ??
    ((sub: string) => ['keyless', 'retry'].some((n) => sub === `compute-account:${ids.acme}/aws/${n}`));
  emu.sts.webRoles.set(ROLE, {
    issuer: ISSUER,
    jwks: () => issuer.jwks(),
    trust: (sub) => trust(sub, ids),
  });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [
          awsProvider({
            fetch: emu.fetch,
            credentials: {
              kind: 'ambient:forbidden',
              credentials: async () => {
                throw new Error('the ambient identity was used');
              },
            },
          }),
        ],
      }),
    ],
    ...(options.issuer === false ? {} : { pki: { workloadIssuer: issuer } }),
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  ids.acme = tenants.acme.id;
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const acme = { token: tenants.acme.token };
  const createAccount = (name: string, idempotencyKey?: string) =>
    api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'aws',
      name,
      config: { region: 'us-east-1', zones: ['us-east-1a'], webIdentityRoleArn: ROLE },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  const accounts = async () =>
    (await api.providerAccounts.list(acme, { tenantId: tenants.acme.id })).items as {
      name: string;
    }[];
  return { emu, ids, createAccount, accounts };
}

describe('keyless AWS accounts (A7)', () => {
  it('a tenant account is stored once its role trusts exactly its subject', async () => {
    const { emu, ids, createAccount, accounts } = await world();
    const account = await createAccount('keyless');
    expect(account.config.webIdentityRoleArn).toBe(ROLE);
    expect(account.config.credentials).toBeUndefined();
    const subjects = emu.sts.webExchanges.map((entry) => [entry.sub, entry.accepted]);
    expect(subjects).toHaveLength(3);
    // Stranger (another tenant, this name), sibling (this tenant, another name), then itself.
    expect(subjects[0]![0]).toMatch(/^compute-account:.+\/aws\/keyless$/);
    expect(subjects[0]![0]).not.toBe(`compute-account:${ids.acme}/aws/keyless`);
    expect(subjects[0]![1]).toBe(false);
    expect(subjects[1]![0]).toMatch(new RegExp(`^compute-account:${ids.acme}/aws/`));
    expect(subjects[1]![1]).toBe(false);
    expect(subjects[2]).toEqual([`compute-account:${ids.acme}/aws/keyless`, true]);
    // EC2 was read with the federated (temporary) credentials, never a platform key.
    const [zones] = emu.calls('DescribeAvailabilityZones');
    expect(zones!.accessKeyId).toMatch(/^ASIA/);
    expect(await accounts()).toHaveLength(1);
  });

  it("a role trusting any of the tenant's accounts is refused", async () => {
    const { createAccount, accounts } = await world({
      trust: (sub, ids) => sub.startsWith(`compute-account:${ids.acme}/aws/`),
    });
    await expect(createAccount('keyless')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationTrustsAnySubject', probe: 'sibling' },
    });
    expect(await accounts()).toHaveLength(0);
  });

  it('a role trusting any subject is refused', async () => {
    const { createAccount } = await world({ trust: () => true });
    await expect(createAccount('keyless')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationTrustsAnySubject', probe: 'stranger' },
    });
  });

  it("a role that does not trust the account's subject is refused", async () => {
    const { createAccount } = await world({ trust: () => false });
    await expect(createAccount('keyless')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'federationRefused', stsError: 'AccessDenied' },
    });
  });

  it('a role that cannot read EC2 is refused', async () => {
    const { emu, createAccount } = await world();
    emu.failNext('DescribeAvailabilityZones', 'UnauthorizedOperation', 403);
    await expect(createAccount('keyless')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'ec2Access', awsError: 'UnauthorizedOperation' },
    });
  });

  it('a throttled STS fails closed, and a retry with the same key runs the check again', async () => {
    const { emu, createAccount, accounts } = await world();
    emu.failNext('AssumeRoleWithWebIdentity', 'Throttling', 400);
    await expect(createAccount('retry', 'k-retry')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await accounts()).toHaveLength(0);
    const account = await createAccount('retry', 'k-retry');
    expect(account.name).toBe('retry');
    expect(await accounts()).toHaveLength(1);
  });

  it('without a workload issuer the account is refused', async () => {
    const { emu, createAccount } = await world({ issuer: false });
    await expect(createAccount('keyless')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'noWorkloadIssuer' },
    });
    expect(emu.requests).toHaveLength(0);
  });
});
