import { ComputeError, isComputeError, type ProviderContext } from '@better-compute/core';
import { ec2Client, webIdentityCredentials } from '@better-compute/aws-core';
import { accountCredentials } from './account.js';
import {
  webIdentityAudience,
  webIdentityRoleArnOf,
  type AwsConfig,
  type AwsProviderOptions,
} from './config.js';

// The network checks run before a keyless (web identity) AWS account is stored (A7), mirroring
// provider-gcp's `checkGcpAccount`. They prove that the tenant's role trusts exactly this account's
// subject (vps fixes it to `compute-account:<tenantId>/aws/<name>`) and nothing broader, that the
// federated identity is the role's own account, and that it can read EC2. A tenant naming another
// tenant's role is refused here too: that role does not trust this account's subject. No token or
// credential is ever logged, nor put in a message or `details`.

/** How long one network call of `checkAwsAccount` may take (ruling W5). */
export const defaultAwsCheckTimeoutMs = 10_000;

/** What STS answers when it refuses a web identity (the trust, the token, the claims). */
const refusalCodes: ReadonlySet<unknown> = new Set([
  'AccessDenied',
  'InvalidIdentityToken',
  'IDPRejectedClaim',
]);

function invalid(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'aws',
    reason,
    ...extra,
  });
}

/** An STS refusal of a web identity: AccessDenied, InvalidIdentityToken or IDPRejectedClaim. */
export function isWebIdentityRefusal(error: unknown): error is ComputeError {
  return (
    isComputeError(error) &&
    error.details?.service === 'sts' &&
    refusalCodes.has(error.details?.code)
  );
}

/** The trust condition the role must have, quoted in every message that asks for it. */
function exactTrust(subject: string): string {
  return `"StringEquals": { "<issuer host>/<path>:sub": "${subject}", "<issuer host>/<path>:aud": "${webIdentityAudience}" }`;
}

/**
 * Runs one network call under the caller's signal and a timeout of its own. A timeout is
 * UNAVAILABLE `timeout` (retryable), never a raw abort; a caller's abort propagates as it is.
 */
async function bounded<T>(
  signal: AbortSignal,
  timeoutMs: number,
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await run(AbortSignal.any([signal, timeout]));
  } catch (error) {
    if (timeout.aborted && !signal.aborted)
      throw new ComputeError('UNAVAILABLE', `${what} did not answer within ${timeoutMs} ms`, undefined, {
        provider: 'aws',
        reason: 'timeout',
      });
    throw error;
  }
}

/**
 * `ProviderInput.checkAccount` for AWS. An account that does not federate is not checked here (a
 * key or role account keeps its lazy check on first use) and makes no call. A federated one, in
 * order, stopping at the first failure:
 *
 * 1. a stranger's probe (another tenant, the same name) must be refused by STS;
 * 2. a sibling's probe (this tenant, another name) must be refused;
 * 3. the account's own subject must be accepted (`federationRefused` otherwise);
 * 4. the federated identity must be the role's own account (`assumed-identity-mismatch`);
 * 5. it must be able to read EC2 in the region (`ec2Access` on AccessDenied/UnauthorizedOperation).
 *
 * An accepted probe is `federationTrustsAnySubject`. A probe counts as refused, and step 3 as
 * INVALID_CONFIG, only on an STS refusal (`isWebIdentityRefusal`); anything else (throttling, a 5xx,
 * a timeout, an expired token) propagates as it is, so the check fails closed and a retry with the
 * same idempotency key runs it again.
 */
export async function checkAwsAccount(
  config: AwsConfig,
  context: ProviderContext & { signal: AbortSignal },
  options: AwsProviderOptions = {},
): Promise<void> {
  const role = webIdentityRoleArnOf(config);
  if (!role) return;
  // The same preconditions the client has (exclusive fields, an issuer, no platform role), before
  // anything is minted.
  const account = accountCredentials(config, context, options);
  const identity = context.identity!;
  const timeoutMs = options.checkTimeoutMs ?? defaultAwsCheckTimeoutMs;
  const call = (signal: AbortSignal) => ({ signal, clock: context.clock });
  const stsEndpoint = options.endpoints?.sts;
  const exchange = (token: string, sessionName: string) =>
    bounded(context.signal, timeoutMs, 'AWS STS', (signal) =>
      webIdentityCredentials({
        roleArn: config.webIdentityRoleArn!,
        sessionName,
        token: async () => token,
        region: config.region,
        fetch: options.fetch,
        durationSeconds: 900,
        ...(stsEndpoint !== undefined ? { endpoint: stsEndpoint } : {}),
      }).credentials(call(signal)),
    );
  const subject = identity.subject;

  // 1, 2: subjects this account is not must be refused.
  for (const kind of ['stranger', 'sibling'] as const) {
    const probe = await identity.mintProbe(kind, { audience: webIdentityAudience });
    try {
      await exchange(probe.token, 'bc-probe');
    } catch (error) {
      if (isWebIdentityRefusal(error)) continue;
      throw error;
    }
    throw invalid(
      'federationTrustsAnySubject',
      `The role ${config.webIdentityRoleArn} trusts subjects other than this account's: it accepted ` +
        `${kind === 'stranger' ? "another tenant's account" : 'another account of this tenant'}. ` +
        `Make its trust policy an exact match on this account's subject: ${exactTrust(subject)}`,
      { probe: kind },
    );
  }

  // 3, 4: the account's own subject must be accepted, as the role's own account.
  try {
    await bounded(context.signal, timeoutMs, 'AWS STS', (signal) => account.verify(call(signal)));
  } catch (error) {
    if (isWebIdentityRefusal(error))
      throw invalid(
        'federationRefused',
        `AWS STS refused this account's identity (${String(error.details?.code)}). The account ` +
          `${role.account} must have an IAM OIDC provider for this control plane's issuer with the ` +
          `client id ${webIdentityAudience}, and ${config.webIdentityRoleArn} must trust it with ` +
          exactTrust(subject),
        { stsError: error.details?.code },
      );
    if (isComputeError(error, 'ACCESS_DENIED') && error.details?.reason === 'assumed-identity-mismatch')
      throw invalid('assumed-identity-mismatch', error.message);
    throw error;
  }

  // 5: the federated identity must read EC2 in the account's region.
  const ec2 = ec2Client({
    region: config.region,
    credentials: account.source,
    fetch: options.fetch,
    clock: context.clock,
    log: context.log,
    ...(options.endpoints?.ec2 !== undefined ? { endpoint: options.endpoints.ec2 } : {}),
  });
  try {
    await bounded(context.signal, timeoutMs, 'Amazon EC2', (signal) =>
      ec2.call('DescribeAvailabilityZones', {}, { signal }),
    );
  } catch (error) {
    if (isComputeError(error, 'ACCESS_DENIED'))
      throw invalid(
        'ec2Access',
        `${config.webIdentityRoleArn} cannot read EC2 in ${config.region} ` +
          `(${String(error.details?.code ?? 'AccessDenied')}): attach the policy \`better-compute aws ` +
          'iam-policy` prints to the role, and check that the region is enabled for the account',
        { awsError: error.details?.code },
      );
    throw error;
  }
}
