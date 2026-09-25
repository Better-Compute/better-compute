// `IamPort.authorizeSession` (core f3bfa70): re-deciding for a session recorded earlier when the caller presents no
// credential again, as long-lived streams need (tunnels re-authorize every 60 s by the ticket's `sub` and `ses`,
// PLAN.md §7.6). better-iam decides from credentials, so this goes through its public administrator API with
// compute's service account: the session must still be listed for the identity (revoked and expired sessions are
// not), the identity must be active, and `policies.simulate` must allow the action for that identity. Simulation
// is identity-level: it cannot see what a delegation or an assumed role narrows, so those sessions answer false
// (the tunnel closes and the caller reopens it with a fresh credential).

import { ComputeError, type Credential, type Decision, type IamPort } from '@better-compute/core';

/** One session as better-iam's `identities.listSessions` returns it (token hashes are never included). */
export interface ListedSession {
  id: string;
  kind: string;
  expiresAt: number;
  mfa?: boolean;
  agentId?: string;
  delegationId?: string;
}

/** The three administrator reads `authorizeSession` makes; embedded and remote mode each supply them. */
export interface SessionReader {
  listSessions(input: { tenantId: string; identityId: string }): Promise<readonly ListedSession[]>;
  identityStatus(input: { tenantId: string; identityId: string }): Promise<string | undefined>;
  simulate(input: {
    tenantId: string;
    identityId: string;
    action: string;
    resource: { type: string; id: string };
    assumeMfa: boolean;
  }): Promise<boolean>;
  now(): number;
}

/** Session kinds whose rights `policies.simulate` reproduces exactly (identity-level). */
const simulatable: ReadonlySet<string> = new Set(['user', 'api-key', 'session-token']);

const notFound = (error: unknown): boolean => {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return code === 'NOT_FOUND' || status === 404;
};

/** `authorizeSession` over a reader; answers false for anything it cannot confirm is live and allowed. */
export function sessionAuthorization(
  reader: SessionReader,
): NonNullable<IamPort['authorizeSession']> {
  return async (session, decision) => {
    const scope = { tenantId: decision.tenantId, identityId: session.identityId };
    let sessions: readonly ListedSession[];
    try {
      sessions = await reader.listSessions(scope);
    } catch (error) {
      // An identity that no longer exists in the tenant has no live session there.
      if (notFound(error)) return false;
      throw error;
    }
    const current = sessions.find((item) => item.id === session.sessionId);
    if (!current || current.expiresAt <= reader.now()) return false;
    if (
      !simulatable.has(current.kind) ||
      current.agentId !== undefined ||
      current.delegationId !== undefined
    )
      return false;
    const status = await reader.identityStatus(scope).catch((error: unknown) => {
      if (notFound(error)) return undefined;
      throw error;
    });
    if (status !== 'active') return false;
    return reader.simulate({
      ...scope,
      action: decision.action,
      resource: { type: decision.resource.type, id: decision.resource.id },
      assumeMfa: current.mfa === true,
    });
  };
}

/** The actions a tunnel ticket may be re-decided for: exec into an instance, the console of a node. */
const tunnelActions: ReadonlySet<string> = new Set([
  'compute:instances:exec',
  'compute:nodes:console',
]);

/** What `tunnels.authorize` receives (`@better-compute/server`'s `TunnelReauthorization`, structurally). */
export interface TunnelReauthorizationLike {
  claims: {
    sub: string;
    ses?: string;
    tnt?: string;
    inst?: string;
    aud: string;
    op: string;
    act?: string;
  };
  credential?: Credential;
}

export interface TunnelAuthorizerOptions {
  /** The IAM resource type prefix, the same as `betterCompute({ typePrefix })` (default `compute-`). */
  typePrefix?: string;
  /**
   * The decision re-checked for a ticket. Default: the action the ticket was issued for, from its `act` claim or
   * else by target: `compute:instances:exec` on the instance (`inst`), `compute:nodes:console` on the node
   * (`aud` = `node:<id>`), in the ticket's tenant (`tnt`). An unknown or mismatched action fails closed.
   */
  decisionFor?(claims: TunnelReauthorizationLike['claims']): Decision | undefined;
}

/**
 * `tunnels.authorize` for `@better-compute/server`: with the upgrade request's credential, the ordinary decision;
 * without one (WebSocket clients cannot send headers), `authorizeSession` for the ticket's identity and session.
 * A ticket without a tenant or a session answers false. A port without `authorizeSession` is a configuration
 * error (`INVALID_CONFIG`), which the tunnel treats as IAM unreachable.
 */
export function tunnelAuthorizer(
  iam: Pick<IamPort, 'authorize' | 'authorizeSession'>,
  options: TunnelAuthorizerOptions = {},
): (input: TunnelReauthorizationLike) => Promise<boolean> {
  const prefix = options.typePrefix ?? 'compute-';
  const decisionFor =
    options.decisionFor ??
    ((claims: TunnelReauthorizationLike['claims']): Decision | undefined => {
      if (!claims.tnt) return undefined;
      const node = claims.aud.startsWith('node:') ? claims.aud.slice('node:'.length) : undefined;
      const resource = claims.inst
        ? { type: `${prefix}instance`, id: claims.inst }
        : node
          ? { type: `${prefix}node`, id: node }
          : undefined;
      if (!resource) return undefined;
      // The action the ticket was issued for: its `act` claim when stamped, else what tunnels.open decides for
      // the target. Anything else fails closed.
      const action =
        claims.act ?? (claims.inst ? 'compute:instances:exec' : 'compute:nodes:console');
      const expected = claims.inst ? 'compute:instances:exec' : 'compute:nodes:console';
      if (!tunnelActions.has(action) || action !== expected) return undefined;
      return { tenantId: claims.tnt, action, resource };
    });
  return async ({ claims, credential }) => {
    const decision = decisionFor(claims);
    if (!decision) return false;
    if (credential) return iam.authorize(credential, decision);
    if (!claims.ses) return false;
    if (!iam.authorizeSession)
      throw new ComputeError(
        'INVALID_CONFIG',
        'The IamPort cannot re-authorize a session without a credential: configure sessionReviewer (embedded) or authorizeSessions (remote)',
      );
    return iam.authorizeSession({ identityId: claims.sub, sessionId: claims.ses }, decision);
  };
}
