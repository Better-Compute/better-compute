import { ComputeError, type ProviderContext } from '@better-compute/core';
import {
  ambientCredentials,
  assumeRoleCredentials,
  cachedCredentials,
  getCallerIdentity,
  sharedFlight,
  staticCredentials,
  type CredentialContext,
  type CredentialSource,
  webIdentityCredentials,
} from '@better-compute/aws-core';
import {
  roleArnOf,
  webIdentityAudience,
  webIdentityRoleArnOf,
  type AwsConfig,
  type AwsProviderOptions,
} from './config.js';

export interface AccountCredentials {
  /** Credentials for EC2 calls (already cached). */
  source: CredentialSource;
  /** The ExternalId sent on AssumeRole, when a role is assumed. */
  externalId?: string;
  /** Runs once before the first EC2 call; memoized on success. Throws ACCESS_DENIED on a guard failure. */
  verify(context: CredentialContext): Promise<{ account: string }>;
}

function invalidConfig(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, { provider: 'aws', reason });
}

function accessDenied(message: string, reason: string): ComputeError {
  return new ComputeError('ACCESS_DENIED', message, undefined, { provider: 'aws', reason });
}

/** `bc-<account id>`, limited to the session-name alphabet and 64 characters. */
function sessionNameOf(accountId: string): string {
  return `bc-${accountId}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
}

/**
 * The credentials one provider account signs with (AD4):
 *
 * | account  | credentials | assumeRoleArn | result |
 * |----------|-------------|---------------|--------|
 * | platform | set         | –             | static |
 * | platform | –           | –             | the host's ambient identity |
 * | platform | any         | set           | AssumeRole from the above, platform-assigned ExternalId |
 * | tenant   | set         | –             | static |
 * | tenant   | set         | set           | AssumeRole from static, ExternalId |
 * | tenant   | –           | set           | AssumeRole from the platform identity, ExternalId |
 * | tenant   | –           | –             | INVALID_CONFIG (F1: ambient credentials are the platform's) |
 * | any      | –           | –, webIdentityRoleArn set | AssumeRoleWithWebIdentity with the account's workload identity |
 *
 * The ExternalId is `${externalIdPrefix}:${providerAccountId}` and never comes from config, so a
 * tenant naming another tenant's role gets AccessDenied from STS. A tenant role in a platform AWS
 * account is refused, and after AssumeRole the identity must be the role's own account.
 *
 * `webIdentityRoleArn` is the keyless path (A7, as provider-gcp's `federationAudience`): the
 * account's workload identity (`context.identity`, whose subject vps fixes to the account) is
 * minted for the audience `sts.amazonaws.com` and exchanged, unsigned, with
 * AssumeRoleWithWebIdentity. It never touches the host's AWS identity, so it satisfies F1 for a
 * tenant account; it excludes `credentials` and `assumeRoleArn` and needs a workload issuer. The
 * role's trust names the subject, so a tenant naming another account's role is refused by STS.
 */
export function accountCredentials(
  config: AwsConfig,
  context: ProviderContext,
  options: AwsProviderOptions,
): AccountCredentials {
  const account = context.account;
  const platform = account?.platform === true;
  const webRole = webIdentityRoleArnOf(config);
  if (webRole) return webIdentityAccount(config, context, options, webRole);
  const role = roleArnOf(config);
  if (role && !account)
    throw invalidConfig(
      'an AWS account with assumeRoleArn needs its provider account context (the ExternalId names it)',
      'account-context-required',
    );
  if (role && !platform && (options.platformAccounts ?? []).includes(role.account))
    throw invalidConfig(
      `assumeRoleArn names AWS account ${role.account}, which is the platform's`,
      'platform-account-role',
    );
  if (!config.credentials && !role && !platform)
    throw invalidConfig(
      `AWS account ${account?.id ?? '(unknown)'} is not the platform's: it must name an assumeRoleArn ` +
        '(or an access key in credentials); ambient credentials are the platform identity',
      'ambientCredentials',
    );

  const region = config.region;
  const fetchImpl = options.fetch;
  const stsEndpoint = options.endpoints?.sts;
  const ambient = () => options.credentials ?? ambientCredentials({ fetch: fetchImpl, region });
  const base: CredentialSource = config.credentials
    ? cachedCredentials(staticCredentials(() => context.secrets.resolve(config.credentials!)))
    : cachedCredentials(ambient());

  if (!role) {
    return {
      source: base,
      verify: verifyOnce(async (call) => {
        const { account: id } = await getCallerIdentity(base, {
          region,
          fetch: fetchImpl,
          ...(stsEndpoint !== undefined ? { endpoint: stsEndpoint } : {}),
          signal: call.signal,
          clock: call.clock,
        });
        return { account: id };
      }),
    };
  }

  const externalId = `${options.externalIdPrefix ?? 'better-compute'}:${account!.id}`;
  const source = cachedCredentials(
    assumeRoleCredentials(base, {
      roleArn: config.assumeRoleArn!,
      sessionName: sessionNameOf(account!.id),
      region,
      externalId,
      fetch: fetchImpl,
      ...(stsEndpoint !== undefined ? { endpoint: stsEndpoint } : {}),
    }),
  );
  const run = async (call: CredentialContext) => {
    const sts = {
      region,
      fetch: fetchImpl,
      ...(stsEndpoint !== undefined ? { endpoint: stsEndpoint } : {}),
      signal: call.signal,
      clock: call.clock,
    };
    // A tenant hopping from the platform's own identity must not land in the platform's account.
    // (A tenant's own key in its own account may assume a role there.)
    if (!platform && !config.credentials) {
      const caller = await getCallerIdentity(base, sts);
      if (caller.account === role.account)
        throw accessDenied(
          `assumeRoleArn names AWS account ${role.account}, the platform identity's own`,
          'platform-account-role',
        );
    }
    const assumed = await getCallerIdentity(source, sts);
    if (assumed.account !== role.account)
      throw accessDenied(
        `AssumeRole for account ${role.account} returned an identity in account ${assumed.account}`,
        'assumed-identity-mismatch',
      );
    return { account: assumed.account };
  };
  return { source, externalId, verify: verifyOnce(run) };
}

/**
 * Memoizes an account identity check on success. Concurrent callers share one check, which runs
 * on its own signal and timeout: the first caller aborting (a `listOffers` out of time) never fails
 * a create or a purchase waiting on the same check. A failed check is run again by the next call.
 */
function verifyOnce(
  run: (call: CredentialContext) => Promise<{ account: string }>,
): AccountCredentials['verify'] {
  let verified: { account: string } | undefined;
  const join = sharedFlight<{ account: string }>({ what: 'verifying the AWS account identity' });
  return async (call) =>
    verified ??
    join(async (signal) => (verified = await run({ signal, clock: call.clock })), call.signal);
}

/** `sts:GetCallerIdentity` must be the role's own account; memoized on success. */
function verifier(
  source: CredentialSource,
  roleAccount: string,
  config: AwsConfig,
  options: AwsProviderOptions,
): AccountCredentials['verify'] {
  return verifyOnce(async (call) => {
    const { account } = await getCallerIdentity(source, {
      region: config.region,
      fetch: options.fetch,
      ...(options.endpoints?.sts !== undefined ? { endpoint: options.endpoints.sts } : {}),
      signal: call.signal,
      clock: call.clock,
    });
    if (account !== roleAccount)
      throw accessDenied(
        `AssumeRoleWithWebIdentity for account ${roleAccount} returned an identity in account ${account}`,
        'assumed-identity-mismatch',
      );
    return { account };
  });
}

/** The keyless account (A7): see `accountCredentials`. */
function webIdentityAccount(
  config: AwsConfig,
  context: ProviderContext,
  options: AwsProviderOptions,
  role: NonNullable<ReturnType<typeof webIdentityRoleArnOf>>,
): AccountCredentials {
  const account = context.account;
  if (config.credentials !== undefined || config.assumeRoleArn !== undefined)
    throw invalidConfig(
      'An AWS account names either webIdentityRoleArn (keyless sign-in with its workload identity) ' +
        'or credentials / assumeRoleArn, not both',
      'webIdentityExclusive',
    );
  if (!account)
    throw invalidConfig(
      'an AWS account with webIdentityRoleArn needs its provider account context (the session names it)',
      'account-context-required',
    );
  if (!context.identity)
    throw invalidConfig(
      'webIdentityRoleArn needs the host to run a workload issuer (better-compute has none ' +
        'configured), so this account cannot sign in',
      'noWorkloadIssuer',
    );
  if (!account.platform && (options.platformAccounts ?? []).includes(role.account))
    throw invalidConfig(
      `webIdentityRoleArn names AWS account ${role.account}, which is the platform's`,
      'platform-account-role',
    );
  const identity = context.identity;
  const source = cachedCredentials(
    webIdentityCredentials({
      roleArn: config.webIdentityRoleArn!,
      sessionName: sessionNameOf(account.id),
      token: async () => (await identity.mint({ audience: webIdentityAudience })).token,
      region: config.region,
      fetch: options.fetch,
      ...(options.endpoints?.sts !== undefined ? { endpoint: options.endpoints.sts } : {}),
    }),
  );
  return { source, verify: verifier(source, role.account, config, options) };
}
