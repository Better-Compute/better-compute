import { ComputeError, isComputeError, type ProviderContext } from '@better-compute/core';
import {
  googleEndpoint,
  impersonatedTokenSource,
  mapGoogleError,
  stsExchange,
} from '@better-compute/gcp-common';
import type { GcpConfig, GcpProviderOptions } from './config.js';

// Workload identity federation for a GCP account: the preconditions both the client and the account
// check share, and `checkGcpAccount`, the probes run before a federated account is stored. They
// prove that the tenant's pool provider trusts exactly this account's subject (vps fixes it to
// `compute-account:<tenantId>/gcp/<name>`) and nothing broader, and that the token it yields can
// read the project. A tenant naming another tenant's pool provider is refused here too: that pool
// does not trust this account's subject. No token is ever logged, nor put in a message or `details`.

type AccountIdentity = NonNullable<ProviderContext['identity']>;

/** How long one network call of `checkGcpAccount` may take (ruling W5). */
export const defaultCheckTimeoutMs = 10_000;

function invalid(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'gcp',
    reason,
    ...extra,
  });
}

/**
 * The federated account's identity, or undefined for an account that does not federate. A
 * federated account names no `credentials`, and the host must run a workload issuer.
 */
export function federationOf(
  config: GcpConfig,
  context: ProviderContext,
): { audience: string; identity: AccountIdentity } | undefined {
  if (config.federationAudience === undefined) return undefined;
  if (config.credentials)
    throw invalid(
      'credentialsAndFederation',
      'A GCP account names either credentials (a service-account key) or federationAudience ' +
        '(keyless sign-in through workload identity federation), not both',
    );
  if (!context.identity)
    throw invalid(
      'noWorkloadIssuer',
      'federationAudience needs the host to run a workload issuer (better-compute has none ' +
        'configured), so this account cannot sign in',
    );
  return { audience: config.federationAudience, identity: context.identity };
}

/**
 * The audience the account's identity token is signed for: the pool provider's resource name as an
 * https URL (`//iam.googleapis.com/...` becomes `https://iam.googleapis.com/...`). Only call it with
 * an audience `stsExchange`/`federatedTokenSource` validates, before anything is minted.
 */
export function subjectTokenAudience(audience: string): string {
  return `https://${audience.slice(2)}`;
}

/** The IAM principal of the account's subject in the audience's pool, for grants. */
function principalOf(audience: string, subject: string): string {
  const pool = audience.slice(2, audience.lastIndexOf('/providers/'));
  return `principal://${pool}/subject/${subject}`;
}

/** The condition the pool provider must have, quoted in every message that asks for it. */
function exactCondition(subject: string): string {
  return `assertion.sub == "${subject}"`;
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
      throw new ComputeError(
        'UNAVAILABLE',
        `${what} did not answer within ${timeoutMs} ms`,
        undefined,
        { provider: 'gcp', reason: 'timeout' },
      );
    throw error;
  }
}

/**
 * `ProviderInput.checkAccount` for GCP. An account that does not federate is not checked here (a
 * key account keeps its lazy check on first use) and makes no call. A federated one, in order,
 * stopping at the first failure:
 *
 * 1. a stranger's probe (another tenant, the same name) must be refused by STS;
 * 2. a sibling's probe (this tenant, another name) must be refused;
 * 3. the account's own subject must be accepted (`federationRefused` otherwise);
 * 4. with `impersonate`, IAM Credentials must let it impersonate (`impersonationRefused`);
 * 5. the resulting token must read the project (`projectAccess` on 403/404).
 *
 * An accepted probe is `federationTrustsAnySubject`. A probe counts as refused only when STS
 * refuses it (UNAUTHENTICATED); anything else (UNAVAILABLE, a timeout) propagates, so the check
 * fails closed and a retry with the same idempotency key runs it again.
 */
export async function checkGcpAccount(
  config: GcpConfig,
  context: ProviderContext & { signal: AbortSignal },
  options: GcpProviderOptions = {},
): Promise<void> {
  const federation = federationOf(config, context);
  if (!federation) return;
  const { audience, identity } = federation;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.checkTimeoutMs ?? defaultCheckTimeoutMs;
  const universeDomain = options.universeDomain;
  const endpoint = (
    options.endpoint ?? `${googleEndpoint('compute', { universeDomain })}/compute/v1`
  ).replace(/\/+$/, '');
  const subject = identity.subject;
  const condition = exactCondition(subject);

  // Built before any call, so a malformed email is refused with no network call.
  let federatedToken = '';
  const impersonated = config.impersonate
    ? impersonatedTokenSource({ token: async () => federatedToken }, config.impersonate, {
        fetch: fetchImpl,
        universeDomain,
      })
    : undefined;

  const exchange = async (subjectToken: string) =>
    bounded(context.signal, timeoutMs, 'Google STS', (signal) =>
      stsExchange({ audience, subjectToken, fetch: fetchImpl, universeDomain, signal }),
    );
  const tokenAudience = subjectTokenAudience(audience);

  // 1, 2: subjects this account is not must be refused.
  for (const kind of ['stranger', 'sibling'] as const) {
    const probe = await identity.mintProbe(kind, { audience: tokenAudience });
    try {
      await exchange(probe.token);
    } catch (error) {
      if (isComputeError(error, 'UNAUTHENTICATED')) continue;
      throw error;
    }
    throw invalid(
      'federationTrustsAnySubject',
      `The workload identity pool provider trusts subjects other than this account's: it accepted ` +
        `${kind === 'stranger' ? "another tenant's account" : 'another account of this tenant'}. ` +
        `Set its attribute condition to an exact match on this account's subject: ${condition}`,
      { probe: kind },
    );
  }

  // 3: the account's own subject must be accepted.
  const minted = await identity.mint({ audience: tokenAudience });
  try {
    federatedToken = (await exchange(minted.token)).accessToken;
  } catch (error) {
    if (!isComputeError(error, 'UNAUTHENTICATED')) throw error;
    const stsError = typeof error.details?.reason === 'string' ? error.details.reason : 'unknown';
    throw invalid(
      'federationRefused',
      `Google STS refused this account's identity (${stsError}). The workload identity pool ` +
        `provider must trust this control plane's issuer and have the attribute condition ` +
        `${condition}`,
      { stsError },
    );
  }

  // 4: impersonation, when the account asks for it.
  let token = federatedToken;
  if (impersonated) {
    try {
      token = await bounded(context.signal, timeoutMs, 'IAM Credentials', (signal) =>
        impersonated.token({ signal, clock: context.clock }),
      );
    } catch (error) {
      if (!isComputeError(error, 'UNAUTHENTICATED') && !isComputeError(error, 'ACCESS_DENIED'))
        throw error;
      throw invalid(
        'impersonationRefused',
        `The federated identity cannot impersonate ${config.impersonate}: grant ` +
          `${principalOf(audience, subject)} roles/iam.workloadIdentityUser on that service account`,
        { status: error.details?.status },
      );
    }
  }

  // 5: the final token must read the project.
  const projectUrl = `${endpoint}/projects/${encodeURIComponent(config.projectId)}`;
  const response = await bounded(context.signal, timeoutMs, 'Compute Engine', async (signal) => {
    let answer: Response;
    try {
      answer = await fetchImpl(projectUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComputeError('UNAVAILABLE', 'Compute Engine unreachable', undefined, {
        provider: 'gcp',
        status: 0,
        reason: 'network',
      });
    }
    const text = await answer.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A non-JSON body is reported by status.
    }
    return { status: answer.status, ok: answer.ok, headers: answer.headers, body };
  });
  if (response.ok) return;
  const mapped = mapGoogleError(
    response.status,
    response.body,
    response.headers,
    `GET project ${config.projectId}`,
  );
  if (
    response.status === 404 ||
    (response.status === 403 &&
      (mapped.code === 'ACCESS_DENIED' || mapped.code === 'INVALID_CONFIG'))
  ) {
    const who = config.impersonate ?? principalOf(audience, subject);
    throw invalid(
      'projectAccess',
      `${who} cannot read project ${config.projectId} (HTTP ${response.status} ` +
        `${String(mapped.details?.reason)}): grant it a role with compute.projects.get on the ` +
        'project (for example roles/compute.viewer), and check that the project id is right and ' +
        'the Compute Engine API is enabled',
      {
        status: response.status,
        googleReason: mapped.details?.reason,
        ...(typeof mapped.details?.activationUrl === 'string'
          ? { activationUrl: mapped.details.activationUrl }
          : {}),
      },
    );
  }
  throw mapped;
}
