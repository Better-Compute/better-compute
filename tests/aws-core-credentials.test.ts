import { describe, expect, it } from 'vitest';
import { ComputeError, isComputeError, type Logger } from '@better-compute/core';
import {
  ambientCredentials,
  assumeRoleCredentials,
  cachedCredentials,
  containerCredentials,
  ec2Client,
  envCredentials,
  getCallerIdentity,
  imdsCredentials,
  staticCredentials,
  webIdentityCredentials,
  type CredentialSource,
} from '@better-compute/aws-core';
import { AwsEmulator, platformAccount, platformKeys } from './support/aws-emulator/index.js';
import { ContainerCredentialsEmulator, ImdsEmulator } from './support/aws-emulator/imds.js';
import { ec2Response } from './support/aws-emulator/xml.js';

// Every log record and every thrown error of this file, swept for secrets at the end.
const records: string[] = [];
const log: Logger = {
  debug: (message, fields) => records.push(`${message} ${JSON.stringify(fields ?? {})}`),
  info: (message, fields) => records.push(`${message} ${JSON.stringify(fields ?? {})}`),
  warn: (message, fields) => records.push(`${message} ${JSON.stringify(fields ?? {})}`),
  error: (message, fields) => records.push(`${message} ${JSON.stringify(fields ?? {})}`),
};
const signal = new AbortController().signal;

async function failure(run: () => Promise<unknown>): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(isComputeError(error)).toBe(true);
    const failed = error as ComputeError;
    records.push(failed.message, JSON.stringify(failed.details ?? {}));
    return failed;
  }
  throw new Error('expected a failure');
}

function world() {
  const emu = new AwsEmulator();
  const context = { signal, clock: emu.clock };
  return { emu, context };
}

const tenantRole = 'arn:aws:iam::222222222222:role/better-compute';

describe('aws-core credentials', () => {
  it('static credentials parse the secret JSON and refuse missing fields', async () => {
    const { context } = world();
    const ok = staticCredentials(async () =>
      JSON.stringify({ accessKeyId: 'AKIATESTKEY0000000009', secretAccessKey: 'testsecret' }),
    );
    expect((await ok.credentials(context)).accessKeyId).toBe('AKIATESTKEY0000000009');
    const missing = staticCredentials(async () => JSON.stringify({ accessKeyId: 'AKIATESTKEY0000000009' }));
    const error = await failure(() => missing.credentials(context));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain('secretAccessKey');
    expect(error.message).not.toContain('AKIATESTKEY');
    expect((await failure(() => staticCredentials(async () => 'nope').credentials(context))).code).toBe(
      'INVALID_CONFIG',
    );
  });

  it('env credentials read the three variables', async () => {
    const { context } = world();
    const source = envCredentials({
      AWS_ACCESS_KEY_ID: 'AKIATESTKEY0000000002',
      AWS_SECRET_ACCESS_KEY: 'testsecret',
      AWS_SESSION_TOKEN: 'env-session-token',
    });
    expect(await source.credentials(context)).toEqual({
      accessKeyId: 'AKIATESTKEY0000000002',
      secretAccessKey: 'testsecret',
      sessionToken: 'env-session-token',
    });
    expect((await failure(() => envCredentials({}).credentials(context))).code).toBe('UNAUTHENTICATED');
  });

  it('IMDS requires a token and never falls back to v1', async () => {
    const { emu, context } = world();
    const imds = new ImdsEmulator(emu);
    const creds = await imdsCredentials({ fetch: emu.fetch }).credentials(context);
    expect(creds.accessKeyId).toBe('ASIAIMDS000000000001');
    expect(creds.sessionToken).toBe('imds-role-session-token');
    expect(creds.expiresAt).toBe(emu.now() + 6 * 3_600_000);
    expect(imds.tokenRequests).toBe(1);

    const v1 = world();
    new ImdsEmulator(v1.emu, { v1Only: true });
    const error = await failure(() => imdsCredentials({ fetch: v1.emu.fetch }).credentials(v1.context));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.details?.reason).toBe('imds-unavailable');
    // No v1 request after the refused token.
    expect(v1.emu.requests.map((r) => r.url.pathname)).toEqual(['/latest/api/token']);
  });

  it('container credentials refuse a non-allowed full URI', async () => {
    const { emu, context } = world();
    const container = new ContainerCredentialsEmulator(emu);
    for (const uri of ['http://10.0.0.5/creds', 'http://169.254.169.254/x', 'http://127.0.0.1.evil.com/', 'http://u:p@127.0.0.1/'])
      expect(
        (
          await failure(() =>
            containerCredentials({ fetch: emu.fetch, env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: uri } }).credentials(context),
          )
        ).code,
      ).toBe('INVALID_CONFIG');
    expect(container.requests).toBe(0);
    const podIdentity = containerCredentials({
      fetch: emu.fetch,
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token',
      },
      readFile: async () => 'pod-identity-token\n',
    });
    expect((await podIdentity.credentials(context)).accessKeyId).toBe('ASIACONTAINER0000001');
    const injected = containerCredentials({
      fetch: emu.fetch,
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'a\r\nx-evil: 1',
      },
    });
    expect((await failure(() => injected.credentials(context))).code).toBe('INVALID_CONFIG');
    const ecs = containerCredentials({
      fetch: emu.fetch,
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' },
    });
    expect((await ecs.credentials(context)).secretAccessKey).toBe('container-secret');
  });

  it('web identity exchanges the token without signing', async () => {
    const { emu, context } = world();
    emu.sts.webTokens.set('oidc-token', tenantRole);
    const source = webIdentityCredentials({
      roleArn: tenantRole,
      sessionName: 'bc-test',
      token: async () => 'oidc-token',
      region: 'us-east-1',
      fetch: emu.fetch,
    });
    const creds = await source.credentials(context);
    expect(creds.accessKeyId).toMatch(/^ASIA/);
    const [request] = emu.calls('AssumeRoleWithWebIdentity');
    expect(request!.headers.get('authorization')).toBeNull();
    const bad = webIdentityCredentials({
      roleArn: tenantRole,
      sessionName: 'bc-test',
      token: async () => 'forged',
      region: 'us-east-1',
      fetch: emu.fetch,
    });
    expect((await failure(() => bad.credentials(context))).code).toBe('PROVIDER_ERROR');
    expect(() =>
      webIdentityCredentials({ roleArn: tenantRole, sessionName: 'x', token: async () => 't', region: 'us-east-1' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('assume role passes the external id and session name', async () => {
    const { emu, context } = world();
    emu.sts.roles.set(tenantRole, { externalId: 'better-compute:pa_tenantA' });
    const source = assumeRoleCredentials(emu.ambient, {
      roleArn: tenantRole,
      sessionName: 'bc-pa_tenantA',
      region: 'us-east-1',
      externalId: 'better-compute:pa_tenantA',
      fetch: emu.fetch,
    });
    const creds = await source.credentials(context);
    expect(creds.sessionToken).toBeTruthy();
    expect(emu.sts.assumed).toEqual([
      { roleArn: tenantRole, externalId: 'better-compute:pa_tenantA', sessionName: 'bc-pa_tenantA', caller: platformAccount },
    ]);
    const wrong = assumeRoleCredentials(emu.ambient, {
      roleArn: tenantRole,
      sessionName: 'bc-pa_tenantB',
      region: 'us-east-1',
      externalId: 'better-compute:pa_tenantB',
      fetch: emu.fetch,
    });
    expect((await failure(() => wrong.credentials(context))).code).toBe('ACCESS_DENIED');
    const identity = await getCallerIdentity(source, { region: 'us-east-1', fetch: emu.fetch, signal, clock: emu.clock });
    expect(identity.account).toBe('222222222222');
  });

  it('ambient chain picks web identity before container before IMDS and sticks to the winner', async () => {
    const { emu, context } = world();
    new ImdsEmulator(emu);
    const container = new ContainerCredentialsEmulator(emu);
    emu.sts.webTokens.set('oidc-token', tenantRole);
    const env = {
      AWS_WEB_IDENTITY_TOKEN_FILE: '/token',
      AWS_ROLE_ARN: tenantRole,
      AWS_REGION: 'us-east-1',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'pod-identity-token',
    };
    const web = ambientCredentials({ env, fetch: emu.fetch, readFile: async () => 'oidc-token' });
    await web.credentials(context);
    expect(web.kind).toBe('ambient:web-identity');
    expect(container.requests).toBe(0);

    // The web identity token is refused: the chain falls through to the container.
    const second = world();
    new ImdsEmulator(second.emu);
    const container2 = new ContainerCredentialsEmulator(second.emu);
    const fallthrough = ambientCredentials({ env, fetch: second.emu.fetch, readFile: async () => 'unknown' });
    expect((await fallthrough.credentials(second.context)).accessKeyId).toBe('ASIACONTAINER0000001');
    expect(fallthrough.kind).toBe('ambient:container');
    await fallthrough.credentials(second.context);
    expect(second.emu.calls('AssumeRoleWithWebIdentity')).toHaveLength(1);
    expect(container2.requests).toBe(2);

    const third = world();
    new ImdsEmulator(third.emu);
    const imdsOnly = ambientCredentials({ env: {}, fetch: third.emu.fetch });
    expect((await imdsOnly.credentials(third.context)).accessKeyId).toBe('ASIAIMDS000000000001');
    expect(imdsOnly.kind).toBe('ambient:imds');

    const envFirst = ambientCredentials({
      env: { ...env, AWS_ACCESS_KEY_ID: 'AKIATESTKEY0000000003', AWS_SECRET_ACCESS_KEY: 'testsecret' },
      fetch: third.emu.fetch,
    });
    await envFirst.credentials(third.context);
    expect(envFirst.kind).toBe('ambient:env');
  });

  it('cache is single-flight and refreshes before expiry', async () => {
    const { emu, context } = world();
    emu.sts.roles.set(tenantRole, {});
    const cached = cachedCredentials(
      assumeRoleCredentials(emu.ambient, { roleArn: tenantRole, sessionName: 'bc-cache', region: 'us-east-1', fetch: emu.fetch }),
    );
    const all = await Promise.all(Array.from({ length: 10 }, () => cached.credentials(context)));
    expect(new Set(all.map((c) => c.accessKeyId)).size).toBe(1);
    expect(emu.calls('AssumeRole')).toHaveLength(1);
    emu.clock.advance(50 * 60_000);
    await cached.credentials(context);
    expect(emu.calls('AssumeRole')).toHaveLength(1);
    // expiresAt - 4 min: inside the 5 min refresh margin.
    emu.clock.advance(6 * 60_000);
    await cached.credentials(context);
    expect(emu.calls('AssumeRole')).toHaveLength(2);
    cached.invalidate!();
    await cached.credentials(context);
    expect(emu.calls('AssumeRole')).toHaveLength(3);

    let loads = 0;
    const forever = cachedCredentials(
      staticCredentials(async () => {
        loads += 1;
        return JSON.stringify({ accessKeyId: 'AKIATESTKEY0000000004', secretAccessKey: 'testsecret' });
      }),
    );
    await forever.credentials(context);
    emu.clock.advance(365 * 86_400_000);
    await forever.credentials(context);
    expect(loads).toBe(1);
  });

  it('getCallerIdentity returns the account', async () => {
    const { emu } = world();
    const identity = await getCallerIdentity(emu.ambient, { region: 'us-east-1', fetch: emu.fetch, signal, clock: emu.clock });
    expect(identity).toMatchObject({ account: platformAccount, arn: expect.stringContaining(platformAccount) });
    const unknown: CredentialSource = {
      kind: 'test',
      credentials: async () => ({ accessKeyId: 'AKIATESTKEY0000000005', secretAccessKey: 'testsecret' }),
    };
    expect(
      (await failure(() => getCallerIdentity(unknown, { region: 'us-east-1', fetch: emu.fetch, signal, clock: emu.clock })))
        .code,
    ).toBe('UNAUTHENTICATED');
  });

  it('never logs credentials', async () => {
    // A client with a recording logger, through a failing and a succeeding call.
    const { emu } = world();
    emu.register(/^ec2\./, { service: 'ec2', protocol: 'ec2', handle: (r) => ec2Response(r.operation, '') });
    const ec2 = ec2Client({ region: 'us-east-1', credentials: emu.ambient, fetch: emu.fetch, clock: emu.clock, log });
    await ec2.call('DescribeInstances', {}, { signal });
    emu.failNext('DescribeInstances', 'AuthFailure', 401);
    await failure(() => ec2.call('DescribeInstances', {}, { signal }));
    const joined = records.join('\n');
    expect(records.length).toBeGreaterThan(5);
    for (const secret of [
      'AKIATESTKEY',
      'ASIA',
      'testsecret',
      platformKeys.secretAccessKey,
      'imds-session-token',
      'imds-role-session-token',
      'minted-session-token',
      'container-session-token',
      'Signature=',
    ])
      expect(joined).not.toContain(secret);
  });
});
