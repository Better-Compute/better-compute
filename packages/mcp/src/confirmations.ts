import type { McpCallerLike } from './server.js';
import type { ConfirmationPolling } from './tools.js';

/**
 * The part of better-iam's API a tool polls (`iam.api.delegations` satisfies it structurally): one
 * confirmation request, readable by the agent that asked for it with the same delegated credential.
 */
export interface ConfirmationReader {
  getConfirmation(
    credential: { token: string },
    input: { tenantId: string; confirmationId: string },
  ): Promise<{ status: string; expiresAt: number }>;
}

export interface IamConfirmationsOptions {
  /** How long a tool call waits for the person (default 25 s; see `ConfirmationPolling`). */
  timeoutMs?: number;
  /** Poll interval (default 2 s). */
  intervalMs?: number;
  /** better-iam's clock for `expiresAt` (default `Date.now`). */
  now?: () => number;
}

/**
 * Per-request confirmation polling against better-iam (§3.4 step 7, §9.3): the tool asks with the
 * caller's own bearer token, in the caller's tenant, so an agent only ever sees its own requests.
 * better-iam's states map onto the tools': `rejected` → `denied`, a `pending` request past its
 * `expiresAt` → `expired`. Without a bearer token or a tenant, tools answer `confirmation-required`
 * and the model retries later with the same idempotency key.
 *
 * `createComputeMcp({ confirmations: iamConfirmations(iam.api.delegations) })`
 */
export function iamConfirmations(
  delegations: ConfirmationReader,
  options: IamConfirmationsOptions = {},
): (request: Request, caller?: McpCallerLike) => ConfirmationPolling | undefined {
  const now = options.now ?? Date.now;
  return (request, caller) => {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const tenantId = caller?.tenantId;
    if (!token || !tenantId) return undefined;
    return {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      async status(confirmationId) {
        const found = await delegations.getConfirmation({ token }, { tenantId, confirmationId });
        if (found.status === 'approved') return 'approved';
        if (found.status === 'rejected') return 'denied';
        return found.expiresAt <= now() ? 'expired' : 'pending';
      },
    };
  };
}
