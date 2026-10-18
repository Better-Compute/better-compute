// `embedded(iam)`: the IamPort over a better-iam instance in the same process (PLAN.md §12.1). Every call is
// one trip through IAM's serialized lane, so this adapter adds none of its own: `require` is authenticate +
// decide (2 acquisitions), batches go out in chunks of 50, flags come from the cache.

import {
  ComputeError,
  isErrorCode,
  systemClock,
  type Caller,
  type Check,
  type Clock,
  type Credential,
  type Decision,
  type ErrorCode,
  type IamCapabilities,
  type IamPort,
  type SpendCheck,
  type SpendCheckInput,
  type UsageEvent,
  type UsageResult,
} from '@better-compute/core';
import { confirmationValidSeconds } from './confirmation.js';
import { sessionAuthorization, type ListedSession } from './sessions.js';
import { createFlagCache, type FlagCache } from './flags.js';
import { recordUsageIsolated, type UsageBilling } from './usage.js';
import { billingPort, type BillingCalls } from './billing-port.js';

type Headers = Credential['headers'];
interface CredentialInput {
  headers?: Headers;
  token?: string;
}
interface AuthorizationRequest extends CredentialInput {
  tenantId: string;
  action: string;
  resource: { type: string; id: string };
}

/**
 * The part of a `BetterIam` instance the embedded port uses. Structural, so the port does not depend on
 * `@better-iam/server` types; `betterIam()`'s result satisfies it.
 */
export interface EmbeddedIamHost {
  authenticate(input: CredentialInput): Promise<{
    identity: { id: string; tenantId: string; kind: string };
    session: {
      id: string;
      /** The tenant the session acts in: the role's tenant for assumed roles. */
      tenantId?: string;
      kind: string;
      mfa: boolean;
      /** When the session expires, and when it was last used (for the idle timeout), epoch ms. */
      expiresAt?: number;
      lastSeenAt?: number;
      agentId?: string;
      delegationId?: string;
    };
  }>;
  require(request: AuthorizationRequest): Promise<void>;
  authorize(request: AuthorizationRequest): Promise<{ allowed: boolean }>;
  authorizeMany(
    request: CredentialInput & {
      tenantId: string;
      checks: { action: string; resource: { type: string; id: string } }[];
    },
  ): Promise<{ results: { allowed: boolean }[] }>;
  billing: UsageBilling & {
    check(input: { tenantId: string; identityId?: string; meter?: string }): Promise<{
      allowed: boolean;
      budgets: { budgetId: string; name: string; spent: number; amount: number }[];
      blockedBy?: { budgetId: string; name: string; spent: number; amount: number };
    }>;
    /** The trusted spend report (better-iam 0.2+): no credential. */
    spend?: BillingCalls['spend'];
  };
  features: { isEnabled(tenantId: string, key: string): Promise<boolean> };
  api: {
    /**
     * Meters, prices, quotes and spend for the IamPort's billing members (with `serviceCredential`). Each call takes
     * the credential first, as better-iam's API does.
     */
    billing?: {
      [Name in keyof BillingCalls]: (
        credential: CredentialInput,
        input: Parameters<BillingCalls[Name]>[0],
      ) => ReturnType<BillingCalls[Name]>;
    };
    /** Administrator reads for `authorizeSession` (with `sessionReviewer`). */
    identities?: {
      listSessions(
        credential: CredentialInput,
        input: { tenantId: string; identityId: string },
      ): Promise<ListedSession[]>;
      get(
        credential: CredentialInput,
        input: { tenantId: string; identityId: string },
      ): Promise<{ status?: string }>;
    };
    policies?: {
      simulate(
        credential: CredentialInput,
        input: {
          tenantId: string;
          identityId: string;
          action: string;
          resource: { type: string; id: string };
          assumeMfa?: boolean;
        },
      ): Promise<{ allowed: boolean }>;
    };
    delegations: {
      requestConfirmation(
        credential: CredentialInput,
        input: {
          tenantId: string;
          action: string;
          resource: { type: string; id: string };
          reason: string;
          validSeconds?: number;
        },
      ): Promise<{ id: string; expiresAt?: number }>;
      /** Used to reuse a pending request for the same action and resource instead of asking twice. */
      listConfirmations?(
        credential: CredentialInput,
        input: { tenantId: string; status?: 'pending' },
      ): Promise<
        {
          id: string;
          action: string;
          resource: { type: string; id: string };
          status: string;
          expired?: boolean;
          expiresAt?: number;
        }[]
      >;
    };
  };
}

export interface EmbeddedIamOptions {
  /** The IAM root tenant (platform). */
  rootTenantId?: string;
  clock?: Clock;
  /** Flag cache TTL backstop; default 5 minutes. */
  flagTtlMs?: number;
  /** A shared flag cache (the bridge passes its own, so inbox events can invalidate it). */
  flags?: FlagCache;
  /** Events per `recordMany`; default 200. */
  usageBatchSize?: number;
  /** Successor lookup for offboarded identities (the IAM module's `iam_successors`). */
  successorOf?(tenantId: string, identityId: string): Promise<string | undefined>;
  /**
   * A credential of compute's service account for `authorizeSession` (§7.6 tunnel re-authorization): it needs
   * `iam:identities:read` and `iam:policies:simulate` in the tenants it re-decides for (root: every tenant).
   * Without it the port has no `authorizeSession`.
   */
  sessionReviewer?: Credential | (() => Credential | Promise<Credential>);
  /**
   * The credential of compute's root service account for the billing members (`ensureMeters`, `setPrice`,
   * `listPrices`, `quote`, `spend`): it needs `iam:billing:manage` and `iam:billing:read` on the root tenant.
   * Defaults to `sessionReviewer`. Without a credential the port has no `ensureMeters`, `setPrice`, `listPrices`
   * or `quote`, and `spend` only where better-iam's trusted `iam.billing.spend` exists.
   */
  serviceCredential?: Credential | (() => Credential | Promise<Credential>);
  /**
   * better-iam's `authentication.sessionIdleTimeoutMs`: with it, `Caller.sessionExpiresAt` is the earlier of the
   * session's expiry and its idle deadline (`lastSeenAt` + this); without it, the expiry alone.
   */
  sessionIdleTimeoutMs?: number;
}

/** The embedded port, with its flag cache exposed for invalidation. */
export interface EmbeddedIam extends IamPort {
  readonly flags: FlagCache;
}

/** The chunk size of better-iam's `authorizeMany`. */
export const authorizeManyLimit = 50;

const identityKinds: ReadonlySet<string> = new Set(['user', 'service', 'agent']);
const sessionKinds: ReadonlySet<string> = new Set([
  'user',
  'role',
  'api-key',
  'session-token',
  'delegated',
]);

/**
 * Converts a better-iam error to a `ComputeError` with the same code when compute knows it; otherwise a
 * 401/403 keeps its meaning (`UNAUTHENTICATED`/`ACCESS_DENIED`) and anything else is `INTERNAL_ERROR` with
 * `details.iamCode`. Non-IAM errors pass through unchanged.
 */
export function fromIamError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (typeof code !== 'string' || error.name === 'ComputeError') return error;
  const httpStatus = typeof status === 'number' ? status : undefined;
  let mapped: ErrorCode;
  if (isErrorCode(code)) mapped = code;
  else if (httpStatus === 401) mapped = 'UNAUTHENTICATED';
  else if (httpStatus === 403) mapped = 'ACCESS_DENIED';
  else if (httpStatus === 404) mapped = 'NOT_FOUND';
  else if (httpStatus === 429) mapped = 'RATE_LIMITED';
  else mapped = 'INTERNAL_ERROR';
  const details: Record<string, unknown> = { iamCode: code };
  const retry = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retry === 'number') details.retryAfterMs = retry;
  const converted = new ComputeError(mapped, error.message, undefined, details);
  (converted as { cause?: unknown }).cause = error;
  return converted;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw fromIamError(error);
  }
}

function credentialInput(credential: Credential): CredentialInput {
  const input: CredentialInput = {};
  if (credential.headers !== undefined) input.headers = credential.headers;
  if (credential.token !== undefined) input.token = credential.token;
  return input;
}

/** Maps better-iam's authenticated principal to compute's `Caller`, failing closed on unknown kinds. */
export function toCaller(
  principal: Awaited<ReturnType<EmbeddedIamHost['authenticate']>>,
  options: { idleTimeoutMs?: number } = {},
): Caller {
  const { identity, session } = principal;
  if (!identityKinds.has(identity.kind) || !sessionKinds.has(session.kind))
    throw new ComputeError(
      'UNAUTHENTICATED',
      `Unsupported identity or session kind ${identity.kind}/${session.kind}`,
    );
  const caller: Caller = {
    identityId: identity.id,
    identityKind: identity.kind as Caller['identityKind'],
    // The acting tenant (§3.4 step 3 pre-checks it): a role session acts in the role's tenant.
    tenantId: session.tenantId ?? identity.tenantId,
    sessionId: session.id,
    sessionKind: session.kind as Caller['sessionKind'],
    mfa: session.mfa === true,
  };
  // When the session ends: its absolute expiry, or sooner its idle deadline (the deployment's idle timeout).
  const ends = [
    session.expiresAt,
    options.idleTimeoutMs !== undefined && session.lastSeenAt !== undefined
      ? session.lastSeenAt + options.idleTimeoutMs
      : undefined,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (ends.length) caller.sessionExpiresAt = Math.min(...ends);
  const agentId = session.agentId ?? (identity.kind === 'agent' ? identity.id : undefined);
  if (agentId !== undefined) caller.agentId = agentId;
  if (session.delegationId !== undefined) caller.delegationId = session.delegationId;
  return caller;
}

/** The IamPort over an embedded better-iam. */
export function embeddedIam(iam: EmbeddedIamHost, options: EmbeddedIamOptions = {}): EmbeddedIam {
  const clock = options.clock ?? systemClock;
  const flags =
    options.flags ??
    createFlagCache({
      isEnabled: (tenantId, key) => iam.features.isEnabled(tenantId, key),
      clock,
      ...(options.flagTtlMs === undefined ? {} : { ttlMs: options.flagTtlMs }),
    });
  const request = (credential: Credential, decision: Decision): AuthorizationRequest => ({
    ...credentialInput(credential),
    tenantId: decision.tenantId,
    action: decision.action,
    resource: { type: decision.resource.type, id: decision.resource.id },
  });
  const capabilities: IamCapabilities = Object.freeze({
    pluginResolver: false,
    eventDetail: false,
    evaluate: false,
    readOnlyDecisions: false,
  });

  const port: EmbeddedIam = {
    ...(options.rootTenantId === undefined ? {} : { rootTenantId: options.rootTenantId }),
    flags,
    authenticate: (credential) =>
      mapped(async () =>
        toCaller(await iam.authenticate(credentialInput(credential)), {
          ...(options.sessionIdleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: options.sessionIdleTimeoutMs }),
        }),
      ),
    require: (credential, decision) => mapped(() => iam.require(request(credential, decision))),
    authorize: (credential, decision) =>
      mapped(async () => (await iam.authorize(request(credential, decision))).allowed),
    authorizeMany: (credential, tenantId, checks) =>
      mapped(async () => {
        const answers: boolean[] = [];
        for (let start = 0; start < checks.length; start += authorizeManyLimit) {
          const chunk: Check[] = checks.slice(start, start + authorizeManyLimit);
          const { results } = await iam.authorizeMany({
            ...credentialInput(credential),
            tenantId,
            checks: chunk.map((check) => ({
              action: check.action,
              resource: { type: check.resource.type, id: check.resource.id },
            })),
          });
          if (results.length !== chunk.length)
            throw new ComputeError(
              'INTERNAL_ERROR',
              `authorizeMany answered ${results.length} of ${chunk.length} checks`,
            );
          for (const result of results) answers.push(result.allowed === true);
        }
        return answers;
      }),
    requestConfirmation: async (credential, decision) => {
      const input = credentialInput(credential);
      const { validSeconds } = decision as { validSeconds?: unknown };
      try {
        // A retry before the person decided reuses the pending request instead of asking again.
        const pending = await iam.api.delegations
          .listConfirmations?.(input, { tenantId: decision.tenantId, status: 'pending' })
          .catch(() => []);
        const same = pending?.find(
          (item) =>
            item.status === 'pending' &&
            item.expired !== true &&
            item.action === decision.action &&
            item.resource.type === decision.resource.type &&
            item.resource.id === decision.resource.id,
        );
        if (same)
          return {
            confirmationId: same.id,
            ...(same.expiresAt === undefined ? {} : { expiresAt: same.expiresAt }),
          };
        const confirmation = await iam.api.delegations.requestConfirmation(input, {
          tenantId: decision.tenantId,
          action: decision.action,
          resource: { type: decision.resource.type, id: decision.resource.id },
          reason: decision.reason,
          // §3.4 step 7: approvals last 15 min unless the caller says otherwise.
          validSeconds: typeof validSeconds === 'number' ? validSeconds : confirmationValidSeconds,
        });
        return {
          confirmationId: confirmation.id,
          ...(confirmation.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
        };
      } catch (error) {
        const { code } = error as { code?: unknown };
        // §3.4 step 7: INVALID_INPUT (typically "does not hold that action back") ⇒ a plain denial.
        if (code === 'INVALID_INPUT') return 'not-held-back';
        throw fromIamError(error);
      }
    },
    billingCheck: (input: SpendCheckInput) =>
      mapped(async (): Promise<SpendCheck> => {
        const query: SpendCheckInput = { tenantId: input.tenantId };
        if (input.identityId !== undefined) query.identityId = input.identityId;
        if (input.meter !== undefined) query.meter = input.meter;
        const verdict = await iam.billing.check(query);
        const result: SpendCheck = {
          allowed: verdict.allowed,
          budgets: verdict.budgets.map(({ budgetId, name, spent, amount }) => ({
            budgetId,
            name,
            spent,
            amount,
          })),
        };
        if (verdict.blockedBy) {
          const { budgetId, name, spent, amount } = verdict.blockedBy;
          result.blockedBy = { budgetId, name, spent, amount };
        }
        return result;
      }),
    recordUsage: (events: UsageEvent[]): Promise<UsageResult[]> =>
      mapped(() =>
        recordUsageIsolated(iam.billing, events, {
          ...(options.usageBatchSize === undefined ? {} : { batchSize: options.usageBatchSize }),
          ...(options.successorOf ? { successorOf: options.successorOf } : {}),
        }),
      ),
    featureEnabled: (tenantId, key) => mapped(() => flags.get(tenantId, key)),
    capabilities: () => capabilities,
  };
  attachBillingMembers(port, iam, options);
  const { identities, policies } = iam.api;
  const reviewer = options.sessionReviewer;
  if (reviewer && identities && policies) {
    const credential = async () =>
      credentialInput(typeof reviewer === 'function' ? await reviewer() : reviewer);
    const decide = sessionAuthorization({
      now: () => clock.now(),
      listSessions: async (input) => identities.listSessions(await credential(), input),
      identityStatus: async (input) => (await identities.get(await credential(), input)).status,
      simulate: async (input) =>
        (await policies.simulate(await credential(), input)).allowed === true,
    });
    port.authorizeSession = (session, decision) => mapped(() => decide(session, decision));
  }
  return port;
}

/** The billing members (meters, prices, quotes, spend) on the root tenant, where the host and credential allow. */
function attachBillingMembers(
  port: EmbeddedIam,
  iam: EmbeddedIamHost,
  options: EmbeddedIamOptions,
): void {
  const { rootTenantId } = options;
  const source = options.serviceCredential ?? options.sessionReviewer;
  const api = iam.api.billing;
  if (rootTenantId === undefined) return;
  const credential = async (): Promise<CredentialInput> =>
    credentialInput(typeof source === 'function' ? await source() : source!);
  const unavailable = (name: string) => () =>
    Promise.reject(
      new ComputeError('INVALID_CONFIG', `The embedded port has no billing credential for ${name}`),
    );
  const withApi = api && source !== undefined;
  const calls: BillingCalls = {
    listMeters: withApi
      ? async (input) => api.listMeters(await credential(), input)
      : unavailable('listMeters'),
    createMeter: withApi
      ? async (input) => api.createMeter(await credential(), input)
      : unavailable('createMeter'),
    setPrice: withApi
      ? async (input) => api.setPrice(await credential(), input)
      : unavailable('setPrice'),
    listPrices: withApi
      ? async (input) => api.listPrices(await credential(), input)
      : unavailable('listPrices'),
    quote: withApi ? async (input) => api.quote(await credential(), input) : unavailable('quote'),
    // The trusted runtime needs no credential and writes no audit event.
    spend: iam.billing.spend
      ? (input) => iam.billing.spend!(input)
      : withApi
        ? async (input) => api.spend(await credential(), input)
        : unavailable('spend'),
  };
  const members = billingPort(rootTenantId, calls, mapped);
  if (withApi) Object.assign(port, members);
  else if (iam.billing.spend) port.spend = members.spend;
}
