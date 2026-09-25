import { ComputeError, type Credential, type Decision } from '@better-compute/core';
import type { AnyCompute } from '../config.js';

// The authorizer for `GET /watch` (@better-compute/events `handleWatch`, PLAN.md §9.3): the stream shows what
// `events.list` would, so it is decided exactly like `events.list`. The caller's bearer token goes through the
// server's own envelope (authentication, the tenant pre-check, one `compute:events:read @ compute-tenant/{t}`
// decision and its caches) by calling `events.list` for one event; a refusal ends the request before a stream
// opens. Authenticating alone is not enough: any member of a tenant would read all of its events.
//
// The grant names who asked (identity, session, agent, delegation), so a `WatchRegistry` shared with
// `host.iam.streams` closes the stream the moment IAM withdraws it, and re-decides the same action for the
// recorded session while the stream stays open (`IamPort.authorizeSession`, when the port has it).

export interface WatchAuthorizerOptions {
  /** Also accept the IAM session cookie (same-origin consoles); default: the Authorization header only. */
  cookie?: boolean;
  /** better-iam's resource type prefix (default `compute-`). */
  typePrefix?: string;
}

/** What `handleWatch`'s `authorize` returns (structurally @better-compute/events' `WatchGrant`). */
export interface WatchGrantLike {
  tenantId: string;
  subject: { identityId: string; sessionId?: string; agentId?: string; delegationId?: string };
  reauthorize?: () => Promise<boolean>;
}

/** `authorize` for `handleWatch`: `?tenantId=` (default the caller's tenant), decided as `events.list`. */
export function watchAuthorizer(
  compute: AnyCompute,
  options: WatchAuthorizerOptions = {},
): (request: Request) => Promise<WatchGrantLike> {
  const api = compute.api as unknown as {
    events: { list(credential: Credential, input: { tenantId: string; limit: number }): Promise<unknown> };
  };
  const iam = compute.context.iam;
  const prefix = options.typePrefix ?? 'compute-';
  return async (request) => {
    const headers: Record<string, string> = {};
    const authorization = request.headers.get('authorization');
    if (authorization) headers.authorization = authorization;
    const cookie = options.cookie ? request.headers.get('cookie') : null;
    if (cookie) headers.cookie = cookie;
    if (!Object.keys(headers).length)
      throw new ComputeError('UNAUTHENTICATED', 'Send Authorization: Bearer <token>');
    const credential: Credential = { headers };
    const caller = await iam.authenticate(credential);
    const tenantId = new URL(request.url).searchParams.get('tenantId') ?? caller.tenantId;
    // The decision itself: events.list as the caller, through the envelope.
    await api.events.list(credential, { tenantId, limit: 1 });
    const decision: Decision = {
      tenantId,
      action: 'compute:events:read',
      resource: { type: `${prefix}tenant`, id: tenantId },
    };
    const session = caller.sessionId ? { identityId: caller.identityId, sessionId: caller.sessionId } : undefined;
    const authorizeSession = iam.authorizeSession?.bind(iam);
    return {
      tenantId,
      subject: {
        identityId: caller.identityId,
        ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
        ...(caller.agentId ? { agentId: caller.agentId } : {}),
        ...(caller.delegationId ? { delegationId: caller.delegationId } : {}),
      },
      ...(authorizeSession && session ? { reauthorize: () => authorizeSession(session, decision) } : {}),
    };
  };
}
