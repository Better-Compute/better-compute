// `remoteIam(...)`: the IamPort over a better-iam deployment reached by HTTP (PLAN.md §12.1 remote column,
// v0.4). Callers' own credentials are forwarded per call to a bearer-less client, so every decision is made
// as the caller; billing and flags use compute's root service-account credential.
//
// Differences from embedded mode, all from better-iam 0.1.0's HTTP surface:
// - authenticate is `sts.getCallerIdentity` (2 lock acquisitions); callers cache it 30 s by token.
// - require is `authorize` + a thrown ACCESS_DENIED (the same decision, audited the same way).
// - usage goes through HTTP `billing.recordMany`, at most 100 events per call, as the root tenant.
// - billingCheck runs as the caller when the envelope passes its credential (HTTP `billing.check` checks the
//   credential's own spend in its own tenant); without one it uses the service credential.

import {
  ComputeError,
  systemClock,
  type Clock,
  type Credential,
  type IamPort,
  type SqlExecutor,
} from '@better-compute/core';
import { signRefresh } from './host.js';
import { confirmationValidSeconds } from './confirmation.js';
import { sessionAuthorization, type ListedSession } from './sessions.js';
import { authorizeManyLimit, fromIamError } from './embedded.js';
import { createFlagCache, type FlagCache } from './flags.js';
import { recordUsageIsolated, type UsageBilling, type UsageInputLike } from './usage.js';

interface CallOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/**
 * The part of `createIamClient<BetterIam>()` the remote port uses; tests may pass their own. Methods take
 * `(input, options)` with the caller's headers in `options`.
 */
export interface RemoteIamClient {
  authorize(
    input: { tenantId: string; action: string; resource: { type: string; id: string } },
    options?: CallOptions,
  ): Promise<{ allowed: boolean }>;
  authorizeMany(
    input: {
      tenantId: string;
      checks: { action: string; resource: { type: string; id: string } }[];
    },
    options?: CallOptions,
  ): Promise<{ results: { allowed: boolean }[] }>;
  sts: {
    getCallerIdentity(options?: CallOptions): Promise<{
      identityId: string;
      identityKind: string;
      tenantId: string;
      sessionId: string;
      sessionKind: string;
      mfa: boolean;
      /** When the session expires (epoch ms). */
      expiresAt?: number;
      agentId?: string;
      delegationId?: string;
    }>;
  };
  delegations: {
    requestConfirmation(
      input: {
        tenantId: string;
        action: string;
        resource: { type: string; id: string };
        reason: string;
        validSeconds?: number;
      },
      options?: CallOptions,
    ): Promise<{ id: string; expiresAt?: number }>;
    listConfirmations(
      input: { tenantId: string; status?: 'pending' },
      options?: CallOptions,
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
  billing: {
    check(
      input: { tenantId: string; meter?: string },
      options?: CallOptions,
    ): Promise<{
      allowed: boolean;
      budgets: { budgetId: string; name: string; spent: number; amount: number }[];
      blockedBy?: { budgetId: string; name: string; spent: number; amount: number };
    }>;
    recordMany(
      input: { tenantId: string; events: Omit<UsageInputLike, 'tenantId'>[] | UsageInputLike[] },
      options?: CallOptions,
    ): Promise<{ receipts: { duplicate: boolean }[] }>;
  };
  /** Administrator reads for `authorizeSession` (with `authorizeSessions`). */
  identities?: {
    listSessions(
      input: { tenantId: string; identityId: string },
      options?: CallOptions,
    ): Promise<ListedSession[]>;
    get(
      input: { tenantId: string; identityId: string },
      options?: CallOptions,
    ): Promise<{ status?: string }>;
  };
  policies?: {
    simulate(
      input: {
        tenantId: string;
        identityId: string;
        action: string;
        resource: { type: string; id: string };
        assumeMfa?: boolean;
      },
      options?: CallOptions,
    ): Promise<{ allowed: boolean }>;
  };
  features: {
    evaluate(
      input: { tenantId: string; keys?: string[] },
      options?: CallOptions,
    ): Promise<{ flags: Record<string, boolean> }>;
  };
}

export interface RemoteIamOptions {
  /** The IAM deployment's origin, e.g. `https://iam.example.com`. */
  baseURL: string;
  /** Default better-iam's `/api/iam`. */
  basePath?: string;
  fetch?: typeof globalThis.fetch;
  /** A prebuilt client (tests); otherwise `createIamClient` from `@better-iam/client` is loaded on first use. */
  client?: RemoteIamClient;
  /**
   * The root service account's credential (hourly `sts.getSessionToken`, or a key), used for usage and flags.
   * It needs `iam:billing:record` and the flag reads (§12.2).
   */
  serviceToken: string | (() => string | Promise<string>);
  rootTenantId: string;
  clock?: Clock;
  flagTtlMs?: number;
  flags?: FlagCache;
  /** Events per HTTP `recordMany`; default and maximum 100. */
  usageBatchSize?: number;
  successorOf?(tenantId: string, identityId: string): Promise<string | undefined>;
  /**
   * Offer `authorizeSession` (§7.6 tunnel re-authorization) through HTTP `identities.listSessions`,
   * `identities.get` and `policies.simulate` with the service credential, which then also needs
   * `iam:identities:read` and `iam:policies:simulate`. Default false: the port has no `authorizeSession`.
   */
  authorizeSessions?: boolean;
  /**
   * Admission refresh (§12.4): before an admission's `require`, post a signed refresh to the IAM host's
   * `createRefreshHandler` so it decides on the row transaction 1 committed, not its replica's older copy.
   * `sql` (compute's primary) supplies the WAL position the replica must reach. Without this option the port has
   * no `refreshResource` and remote admissions can decide on a row up to the replica lag plus 1 s old.
   */
  refresh?: {
    url: string;
    secret: string;
    sql?: Pick<SqlExecutor, 'query'>;
    /** Default `compute-`. */
    typePrefix?: string;
    fetch?: typeof globalThis.fetch;
  };
}

export interface RemoteIam extends IamPort {
  readonly rootTenantId: string;
  readonly flags: FlagCache;
}

const identityKinds: ReadonlySet<string> = new Set(['user', 'service', 'agent']);
const sessionKinds: ReadonlySet<string> = new Set([
  'user',
  'role',
  'api-key',
  'session-token',
  'delegated',
]);

/**
 * Headers forwarded to IAM with a caller's credential. Credentials often carry the whole incoming request's
 * headers; forwarding `content-length`, `host` or `content-type` onto a different request would corrupt it,
 * so only identity and client-context headers pass.
 */
export const forwardedCredentialHeaders: readonly string[] = [
  'authorization',
  'cookie',
  'origin',
  'user-agent',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-request-id',
];

/** A caller's credential as request headers (a token becomes `Authorization: Bearer`). */
export function credentialHeaders(credential: Credential): HeadersInit {
  const given = new Headers(credential.headers);
  const headers = new Headers();
  for (const name of forwardedCredentialHeaders) {
    const value = given.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (credential.token !== undefined) headers.set('authorization', `Bearer ${credential.token}`);
  if (!headers.has('authorization') && !headers.has('cookie'))
    throw new ComputeError('UNAUTHENTICATED', 'No credential was presented');
  return headers;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw fromIamError(error);
  }
}

export function remoteIam(options: RemoteIamOptions): RemoteIam {
  if (!options.rootTenantId)
    throw new ComputeError('INVALID_CONFIG', 'remoteIam needs the IAM root tenant id');
  const batchSize = options.usageBatchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new ComputeError('INVALID_CONFIG', 'usageBatchSize must be an integer from 1 to 100');
  let loading: Promise<RemoteIamClient> | undefined;
  const client = (): Promise<RemoteIamClient> => {
    if (options.client) return Promise.resolve(options.client);
    loading ??= (async () => {
      const specifier = '@better-iam/client';
      let module: { createIamClient(o: Record<string, unknown>): unknown };
      try {
        module = await import(/* @vite-ignore */ specifier);
      } catch {
        throw new ComputeError(
          'MISSING_DEPENDENCY',
          'remoteIam() needs the optional peer dependency @better-iam/client',
        );
      }
      return module.createIamClient({
        baseURL: options.baseURL,
        ...(options.basePath ? { basePath: options.basePath } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }) as RemoteIamClient;
    })();
    return loading;
  };
  const service = async (): Promise<CallOptions> => {
    const token =
      typeof options.serviceToken === 'function'
        ? await options.serviceToken()
        : options.serviceToken;
    return { headers: { authorization: `Bearer ${token}` } };
  };
  const as = (credential: Credential): CallOptions => ({ headers: credentialHeaders(credential) });
  const flags =
    options.flags ??
    createFlagCache({
      isEnabled: async (tenantId, key) => {
        const { flags: values } = await (
          await client()
        ).features.evaluate({ tenantId, keys: [key] }, await service());
        return values[key] === true;
      },
      clock: options.clock ?? systemClock,
      ...(options.flagTtlMs === undefined ? {} : { ttlMs: options.flagTtlMs }),
    });

  // Poison isolation over HTTP: every event goes in under the root tenant (events may name any tenant below).
  const billing: UsageBilling = {
    async recordMany(events) {
      const { receipts } = await (
        await client()
      ).billing.recordMany({ tenantId: options.rootTenantId, events }, await service());
      return receipts;
    },
    async record(event) {
      const [receipt] = await billing.recordMany([event]);
      if (!receipt)
        throw new ComputeError('INTERNAL_ERROR', 'billing.recordMany returned no receipt');
      return receipt;
    },
  };

  const decisionInput = (decision: {
    tenantId: string;
    action: string;
    resource: { type: string; id: string };
  }) => ({
    tenantId: decision.tenantId,
    action: decision.action,
    resource: { type: decision.resource.type, id: decision.resource.id },
  });

  const port: RemoteIam = {
    rootTenantId: options.rootTenantId,
    flags,
    authenticate: (credential) =>
      mapped(async () => {
        const identity = await (await client()).sts.getCallerIdentity(as(credential));
        if (!identityKinds.has(identity.identityKind) || !sessionKinds.has(identity.sessionKind))
          throw new ComputeError(
            'UNAUTHENTICATED',
            `Unsupported identity or session kind ${identity.identityKind}/${identity.sessionKind}`,
          );
        const agentId =
          identity.agentId ?? (identity.identityKind === 'agent' ? identity.identityId : undefined);
        return {
          identityId: identity.identityId,
          identityKind: identity.identityKind as 'user' | 'service' | 'agent',
          tenantId: identity.tenantId,
          sessionId: identity.sessionId,
          sessionKind: identity.sessionKind as
            | 'user'
            | 'role'
            | 'api-key'
            | 'session-token'
            | 'delegated',
          mfa: identity.mfa === true,
          // When the session ends: credentials compute issues for the caller never outlive it.
          ...(typeof identity.expiresAt === 'number'
            ? { sessionExpiresAt: identity.expiresAt }
            : {}),
          ...(agentId === undefined ? {} : { agentId }),
          ...(identity.delegationId === undefined ? {} : { delegationId: identity.delegationId }),
        };
      }),
    require: (credential, decision) =>
      mapped(async () => {
        const { allowed } = await (
          await client()
        ).authorize(decisionInput(decision), as(credential));
        if (!allowed) throw new ComputeError('ACCESS_DENIED', 'Access denied');
      }),
    authorize: (credential, decision) =>
      mapped(
        async () =>
          (await (await client()).authorize(decisionInput(decision), as(credential))).allowed ===
          true,
      ),
    authorizeMany: (credential, tenantId, checks) =>
      mapped(async () => {
        const answers: boolean[] = [];
        for (let start = 0; start < checks.length; start += authorizeManyLimit) {
          const chunk = checks.slice(start, start + authorizeManyLimit);
          const { results } = await (
            await client()
          ).authorizeMany(
            {
              tenantId,
              checks: chunk.map((check) => ({
                action: check.action,
                resource: { type: check.resource.type, id: check.resource.id },
              })),
            },
            as(credential),
          );
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
      const call = as(credential);
      const { validSeconds } = decision as { validSeconds?: unknown };
      try {
        const remote = await client();
        const pending = await remote.delegations
          .listConfirmations({ tenantId: decision.tenantId, status: 'pending' }, call)
          .catch(() => []);
        const same = pending.find(
          (item) =>
            item.status === 'pending' &&
            item.expired !== true &&
            item.action === decision.action &&
            item.resource.type === decision.resource.type &&
            item.resource.id === decision.resource.id,
        );
        const confirmation =
          same ??
          (await remote.delegations.requestConfirmation(
            {
              ...decisionInput(decision),
              reason: decision.reason,
              validSeconds:
                typeof validSeconds === 'number' ? validSeconds : confirmationValidSeconds,
            },
            call,
          ));
        return {
          confirmationId: confirmation.id,
          ...(confirmation.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
        };
      } catch (error) {
        if ((error as { code?: unknown }).code === 'INVALID_INPUT') return 'not-held-back';
        throw fromIamError(error);
      }
    },
    billingCheck: (input, credential?: Credential) =>
      mapped(async () => {
        // HTTP billing.check checks the credential's own spend in its own tenant: the caller's when given.
        const verdict = await (
          await client()
        ).billing.check(
          { tenantId: input.tenantId, ...(input.meter ? { meter: input.meter } : {}) },
          credential ? as(credential) : await service(),
        );
        return {
          allowed: verdict.allowed,
          budgets: verdict.budgets.map(({ budgetId, name, spent, amount }) => ({
            budgetId,
            name,
            spent,
            amount,
          })),
          ...(verdict.blockedBy
            ? {
                blockedBy: {
                  budgetId: verdict.blockedBy.budgetId,
                  name: verdict.blockedBy.name,
                  spent: verdict.blockedBy.spent,
                  amount: verdict.blockedBy.amount,
                },
              }
            : {}),
        };
      }),
    recordUsage: (events) =>
      mapped(() =>
        recordUsageIsolated(billing, events, {
          batchSize,
          ...(options.successorOf ? { successorOf: options.successorOf } : {}),
        }),
      ),
    featureEnabled: (tenantId, key) => mapped(() => flags.get(tenantId, key)),
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  };
  if (options.authorizeSessions) {
    // better-iam's HTTP API exposes the same administrator reads as embedded mode: with the service credential.
    const reads = async () => {
      const iam = await client();
      if (!iam.identities || !iam.policies)
        throw new ComputeError(
          'INVALID_CONFIG',
          'This better-iam client has no identities.listSessions or policies.simulate',
        );
      return { identities: iam.identities, policies: iam.policies };
    };
    const decide = sessionAuthorization({
      now: () => (options.clock ?? systemClock).now(),
      listSessions: async (input) =>
        (await reads()).identities.listSessions(input, await service()),
      identityStatus: async (input) =>
        (await (await reads()).identities.get(input, await service())).status,
      simulate: async (input) =>
        (await (await reads()).policies.simulate(input, await service())).allowed === true,
    });
    port.authorizeSession = (session, decision) => mapped(() => decide(session, decision));
  }
  if (options.refresh) port.refreshResource = remoteRefresher(options.refresh, options.clock);
  return port;
}

/** `refreshResource` over the IAM host's refresh endpoint; any failure throws, so the admission fails closed. */
export function remoteRefresher(
  refresh: NonNullable<RemoteIamOptions['refresh']>,
  clock: Clock = systemClock,
): NonNullable<IamPort['refreshResource']> {
  const prefix = refresh.typePrefix ?? 'compute-';
  const send = refresh.fetch ?? globalThis.fetch;
  return async (tenantId, resource) => {
    // Other types are the IAM host's own, resolved without compute's projection.
    if (!resource.type.startsWith(prefix)) return;
    let lsn: string | undefined;
    if (refresh.sql) {
      const { rows } = await refresh.sql.query<{ lsn: string }>(
        'SELECT pg_current_wal_lsn()::text AS lsn',
      );
      lsn = rows[0]?.lsn;
    }
    const { body, signature } = signRefresh(
      refresh.secret,
      {
        purpose: 'refresh',
        tenantId,
        type: resource.type.slice(prefix.length),
        id: resource.id,
        ...(lsn ? { lsn } : {}),
      },
      clock.now(),
    );
    let response: Response;
    try {
      response = await send(refresh.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-better-compute-signature': signature },
        body,
      });
    } catch (error) {
      throw new ComputeError(
        'UNAVAILABLE',
        'The IAM host refresh endpoint is unreachable',
        undefined,
        { cause: String(error) },
      );
    }
    if (!response.ok)
      throw new ComputeError(
        'UNAVAILABLE',
        `The IAM host could not refresh ${resource.type}/${resource.id} (${response.status})`,
      );
  };
}
