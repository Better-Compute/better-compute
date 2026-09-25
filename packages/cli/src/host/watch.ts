import { ComputeError, type Credential } from '@better-compute/core';
import type { AnyCompute } from '../config.js';

// The authorizer for `GET /watch` (@better-compute/events `handleWatch`, PLAN.md §9.3): the stream shows what
// `events.list` would, so it is decided exactly like `events.list`. The caller's bearer token goes through the
// server's own envelope (authentication, the tenant pre-check, one `compute:events:read @ compute-tenant/{t}`
// decision and its caches) by calling `events.list` for one event; a refusal ends the request before a stream
// opens. Authenticating alone is not enough: any member of a tenant would read all of its events.

export interface WatchAuthorizerOptions {
  /** Also accept the IAM session cookie (same-origin consoles); default: the Authorization header only. */
  cookie?: boolean;
}

/** `authorize` for `handleWatch`: `?tenantId=` (default the caller's tenant), decided as `events.list`. */
export function watchAuthorizer(
  compute: AnyCompute,
  options: WatchAuthorizerOptions = {},
): (request: Request) => Promise<{ tenantId: string }> {
  const api = compute.api as unknown as {
    system: { whoami(credential: Credential, input: object): Promise<{ tenantId?: string }> };
    events: { list(credential: Credential, input: { tenantId: string; limit: number }): Promise<unknown> };
  };
  return async (request) => {
    const headers: Record<string, string> = {};
    const authorization = request.headers.get('authorization');
    if (authorization) headers.authorization = authorization;
    const cookie = options.cookie ? request.headers.get('cookie') : null;
    if (cookie) headers.cookie = cookie;
    if (!Object.keys(headers).length)
      throw new ComputeError('UNAUTHENTICATED', 'Send Authorization: Bearer <token>');
    const credential: Credential = { headers };
    const requested = new URL(request.url).searchParams.get('tenantId');
    const tenantId = requested ?? (await api.system.whoami(credential, {})).tenantId;
    if (!tenantId) throw new ComputeError('UNAUTHENTICATED', 'A signed-in caller is required');
    await api.events.list(credential, { tenantId, limit: 1 });
    return { tenantId };
  };
}
