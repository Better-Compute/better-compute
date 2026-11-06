import { describe, expect, it } from 'vitest';
import { ComputeError, isComputeError, type Logger, type ProviderContext } from '@better-compute/core';
import { accountCredentials, awsConfig, type AwsConfig } from '@better-compute/provider-aws';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const roleA = 'arn:aws:iam::222222222222:role/better-compute';
const roleB = 'arn:aws:iam::333333333333:role/better-compute';

function world() {
  const emu = new AwsEmulator();
  emu.sts.roles.set(roleA, { externalId: 'better-compute:pa_tenantA' });
  emu.sts.roles.set(roleB, { externalId: 'better-compute:pa_tenantB' });
  const context = (id: string, platform: boolean): ProviderContext => ({
    clock: emu.clock,
    log: quiet,
    secrets: {
      resolve: async () => JSON.stringify({ accessKeyId: 'AKIATESTKEY0000000077', secretAccessKey: 'testsecret' }),
    },
    account: { id, tenantId: platform ? 'root' : `t_${id}`, platform },
  });
  const options = { fetch: emu.fetch, credentials: emu.ambient };
  const call = { signal: new AbortController().signal, clock: emu.clock };
  return { emu, context, options, call };
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

describe('provider-aws account credentials', () => {
  it('platform account without credentials uses the ambient source', async () => {
    const { emu, context, options, call } = world();
    const account = accountCredentials(config(), context('pa_platform', true), options);
    expect(account.externalId).toBeUndefined();
    expect((await account.source.credentials(call)).accessKeyId).toBe('AKIATESTKEY0000000001');
    expect(await account.verify(call)).toEqual({ account: platformAccount });
    expect(emu.calls('AssumeRole')).toHaveLength(0);
  });

  it('tenant account without credentials or role is refused (F1)', () => {
    const { context, options } = world();
    expect(() => accountCredentials(config(), context('pa_tenantA', false), options)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', details: expect.objectContaining({ reason: 'ambientCredentials' }) }),
    );
  });

  it('a tenant static key is used as it is', async () => {
    const { context, options, call } = world();
    const account = accountCredentials(
      config({ credentials: 'secret://aws/tenant' }),
      context('pa_tenantA', false),
      options,
    );
    expect((await account.source.credentials(call)).accessKeyId).toBe('AKIATESTKEY0000000077');
  });

  it('external id is platform-assigned', async () => {
    const { emu, context, options, call } = world();
    expect('externalId' in awsConfig.fields).toBe(false);
    const account = accountCredentials(config({ assumeRoleArn: roleA }), context('pa_tenantA', false), options);
    expect(account.externalId).toBe('better-compute:pa_tenantA');
    expect(await account.verify(call)).toEqual({ account: '222222222222' });
    expect(emu.sts.assumed).toEqual([
      expect.objectContaining({ roleArn: roleA, externalId: 'better-compute:pa_tenantA', sessionName: 'bc-pa_tenantA', caller: platformAccount }),
    ]);
    const prefixed = accountCredentials(
      config({ assumeRoleArn: roleA }),
      context('pa_tenantA', false),
      { ...options, externalIdPrefix: 'acme' },
    );
    expect(prefixed.externalId).toBe('acme:pa_tenantA');
  });

  it('refuses an assumeRoleArn in a platform account', async () => {
    const { context, options, call } = world();
    const platformRole = `arn:aws:iam::${platformAccount}:role/admin`;
    expect(() =>
      accountCredentials(config({ assumeRoleArn: platformRole }), context('pa_tenantA', false), {
        ...options,
        platformAccounts: [platformAccount],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', details: expect.objectContaining({ reason: 'platform-account-role' }) }));
    const account = accountCredentials(config({ assumeRoleArn: platformRole }), context('pa_tenantA', false), options);
    const error = await failure(() => account.verify(call));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.details?.reason).toBe('platform-account-role');
  });

  it('refuses when the assumed identity is another account', async () => {
    const { emu, context, options, call } = world();
    emu.sts.roles.set(roleB, { externalId: 'better-compute:pa_tenantB', identityAccount: '444444444444' });
    const account = accountCredentials(config({ assumeRoleArn: roleB }), context('pa_tenantB', false), options);
    const error = await failure(() => account.verify(call));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.details?.reason).toBe('assumed-identity-mismatch');
  });

  it("tenant A cannot use tenant B's role", async () => {
    const { context, options, call } = world();
    const account = accountCredentials(config({ assumeRoleArn: roleB }), context('pa_tenantA', false), options);
    const error = await failure(() => account.verify(call));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.details).toMatchObject({ provider: 'aws', service: 'sts', code: 'AccessDenied' });
  });

  it('a role without an account context is refused', () => {
    const { emu, options } = world();
    expect(() =>
      accountCredentials(config({ assumeRoleArn: roleA }), { clock: emu.clock, log: quiet, secrets: { resolve: async () => '' } }, options),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', details: expect.objectContaining({ reason: 'account-context-required' }) }));
  });

  it('verify runs once', async () => {
    const { emu, context, options, call } = world();
    const account = accountCredentials(config({ assumeRoleArn: roleA }), context('pa_tenantA', false), options);
    await Promise.all([account.verify(call), account.verify(call)]);
    await account.verify(call);
    expect(emu.calls('GetCallerIdentity')).toHaveLength(2);
    expect(emu.calls('AssumeRole')).toHaveLength(1);
  });
});
