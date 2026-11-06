import { ComputeError, type ProviderContext } from '@better-compute/core';
import {
  ambientCredentials,
  assumeRoleCredentials,
  cachedCredentials,
  getCallerIdentity,
  staticCredentials,
  type CredentialContext,
  type CredentialSource,
} from '@better-compute/aws-core';
import { roleArnOf, type AwsConfig, type AwsProviderOptions } from './config.js';

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
 *
 * The ExternalId is `${externalIdPrefix}:${providerAccountId}` and never comes from config, so a
 * tenant naming another tenant's role gets AccessDenied from STS. A tenant role in a platform AWS
 * account is refused, and after AssumeRole the identity must be the role's own account.
 */
export function accountCredentials(
  config: AwsConfig,
  context: ProviderContext,
  options: AwsProviderOptions,
): AccountCredentials {
  const account = context.account;
  const platform = account?.platform === true;
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
    let verified: Promise<{ account: string }> | undefined;
    return {
      source: base,
      verify(call) {
        verified ??= getCallerIdentity(base, {
          region,
          fetch: fetchImpl,
          ...(stsEndpoint !== undefined ? { endpoint: stsEndpoint } : {}),
          signal: call.signal,
          clock: call.clock,
        }).then(
          ({ account: id }) => ({ account: id }),
          (error: unknown) => {
            verified = undefined;
            throw error;
          },
        );
        return verified;
      },
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
  let verified: Promise<{ account: string }> | undefined;
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
  return {
    source,
    externalId,
    verify(call) {
      verified ??= run(call).catch((error: unknown) => {
        verified = undefined;
        throw error;
      });
      return verified;
    },
  };
}
