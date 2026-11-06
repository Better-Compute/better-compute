import { describe, expect, it } from 'vitest';
import {
  ComputeError,
  isComputeError,
  type Logger,
  type ProviderContext,
} from '@better-compute/core';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import {
  accountCredentials,
  awsConfig,
  validateAwsConfig,
  webIdentityAudience,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { accountIdentity } from '@better-compute/vps';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';

// AWS A7: a tenant's AWS account signs in with no key, mirroring provider-gcp's workload identity
// federation. vps fixes the account's subject (compute-account:<tenant>/aws/<name>); provider-aws
// mints a JWT for it with the audience sts.amazonaws.com and exchanges it with STS
// AssumeRoleWithWebIdentity for the tenant's role. Federation is never ambient: the control plane's
// own AWS identity is not used at all.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ISSUER = 'https://compute.example.test/api/compute/workload';
const ROLE = 'arn:aws:iam::222222222222:role/better-compute';

function world(options: { issuer?: boolean } = {}) {
  const emu = new AwsEmulator();
  const issuer = workloadIssuer({
    issuer: ISSUER,
    signingKey: generateP256KeyPair().privateKey,
    clock: emu.clock,
  });
  const trusted = new Set(['compute-account:t_acme/aws/keyless']);
  emu.sts.webRoles.set(ROLE, {
    issuer: ISSUER,
    jwks: () => issuer.jwks(),
    trust: (sub) => trusted.has(sub),
  });
  const context = (
    name = 'keyless',
    platform = false,
    tenantId = platform ? 't_root' : 't_acme',
  ): ProviderContext => ({
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: `pa_${name}`, tenantId, platform },
    ...(options.issuer === false
      ? {}
      : { identity: accountIdentity(issuer, { tenantId, provider: 'aws', name }) }),
  });
  // No ambient identity at all: a keyless account must never reach for one.
  const options_ = {
    fetch: emu.fetch,
    credentials: {
      kind: 'ambient:forbidden',
      credentials: async () => {
        throw new Error('the ambient identity was used');
      },
    },
  };
  const call = { signal: new AbortController().signal, clock: emu.clock };
  return { emu, context, options: options_, call, trusted };
}

const config = (overrides: Partial<AwsConfig> = {}): AwsConfig => ({
  ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig),
  ...overrides,
});

async function failure(run: () => Promise<unknown>): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(isComputeError(error)).toBe(true);
    return error as ComputeError;
  }
  throw new Error('expected a failure');
}

describe('provider-aws web identity federation', () => {
  it('a tenant account signs in with no key through its workload identity', async () => {
    const { emu, context, options, call } = world();
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      context(),
      options,
    );
    expect(account.externalId).toBeUndefined();
    expect(await account.verify(call)).toEqual({ account: '222222222222' });
    const credentials = await account.source.credentials(call);
    expect(credentials.accessKeyId).toMatch(/^ASIA/);
    expect(emu.sts.webExchanges).toEqual([
      {
        roleArn: ROLE,
        sessionName: 'bc-pa_keyless',
        sub: 'compute-account:t_acme/aws/keyless',
        accepted: true,
      },
    ]);
    // The exchange is unsigned; nothing used the platform's identity.
    const [exchange] = emu.calls('AssumeRoleWithWebIdentity');
    expect(exchange!.headers.get('authorization')).toBeNull();
    expect(emu.calls('AssumeRole')).toHaveLength(0);
    expect(webIdentityAudience).toBe('sts.amazonaws.com');
  });

  it("the role refuses another account's subject", async () => {
    const { emu, context, options, call } = world();
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      context('other'),
      options,
    );
    const error = await failure(() => account.verify(call));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.details).toMatchObject({ provider: 'aws', service: 'sts', code: 'AccessDenied' });
    expect(emu.sts.webExchanges[0]).toMatchObject({
      sub: 'compute-account:t_acme/aws/other',
      accepted: false,
    });
  });

  it('needs a workload issuer', () => {
    const { context, options } = world({ issuer: false });
    expect(() =>
      accountCredentials(config({ webIdentityRoleArn: ROLE }), context(), options),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({ reason: 'noWorkloadIssuer' }),
      }),
    );
  });

  it('excludes credentials and assumeRoleArn', () => {
    const { context, options } = world();
    for (const extra of [
      { credentials: 'secret://aws/tenant' },
      { assumeRoleArn: 'arn:aws:iam::222222222222:role/other' },
    ])
      expect(() =>
        accountCredentials(config({ webIdentityRoleArn: ROLE, ...extra }), context(), options),
      ).toThrow(
        expect.objectContaining({
          code: 'INVALID_CONFIG',
          details: expect.objectContaining({ reason: 'webIdentityExclusive' }),
        }),
      );
  });

  it('refuses a tenant role in a platform AWS account', () => {
    const { context, options } = world();
    expect(() =>
      accountCredentials(
        config({ webIdentityRoleArn: `arn:aws:iam::${platformAccount}:role/admin` }),
        context(),
        { ...options, platformAccounts: [platformAccount] },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({ reason: 'platform-account-role' }),
      }),
    );
  });

  it('a platform account may federate too', async () => {
    const { context, options, call, trusted } = world();
    trusted.add('compute-account:t_root/aws/platform');
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      context('platform', true),
      { ...options, platformAccounts: ['222222222222'] },
    );
    expect(await account.verify(call)).toEqual({ account: '222222222222' });
  });

  it('refuses when the federated identity is another account', async () => {
    const { emu, context, options, call } = world();
    emu.sts.webRoles.get(ROLE)!.identityAccount = '444444444444';
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      context(),
      options,
    );
    const error = await failure(() => account.verify(call));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.details?.reason).toBe('assumed-identity-mismatch');
  });

  it('validates the role ARN like assumeRoleArn', () => {
    expect(() =>
      validateAwsConfig(config({ webIdentityRoleArn: 'arn:aws:iam::222222222222:user/bob' })),
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'webIdentityRoleArn' }) }));
    expect(() =>
      validateAwsConfig(
        config({ webIdentityRoleArn: 'arn:aws-cn:iam::222222222222:role/better-compute' }),
      ),
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'webIdentityRoleArn' }) }));
    expect(() => validateAwsConfig(config({ webIdentityRoleArn: ROLE }))).not.toThrow();
  });

  it('credentials are cached and refreshed before expiry', async () => {
    const { emu, context, options, call } = world();
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      context(),
      options,
    );
    const first = await account.source.credentials(call);
    expect((await account.source.credentials(call)).accessKeyId).toBe(first.accessKeyId);
    emu.clock.advance(56 * 60_000);
    expect((await account.source.credentials(call)).accessKeyId).not.toBe(first.accessKeyId);
    expect(emu.sts.webExchanges.filter((entry) => entry.accepted)).toHaveLength(2);
  });

  it('never logs or reports the web identity token', async () => {
    const { emu, context, options, call } = world();
    const lines: string[] = [];
    const log: Logger = {
      debug: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
      info: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
      warn: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
      error: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
    };
    const account = accountCredentials(
      config({ webIdentityRoleArn: ROLE }),
      { ...context('other'), log },
      options,
    );
    const error = await failure(() => account.verify(call));
    const [exchange] = emu.calls('AssumeRoleWithWebIdentity');
    const token = exchange!.params.get('WebIdentityToken')!;
    expect(token.split('.')).toHaveLength(3);
    const seen = [error.message, JSON.stringify(error.details), ...lines].join('\n');
    expect(seen).not.toContain(token);
    expect(seen).not.toContain(token.split('.')[2]!);
  });
});
