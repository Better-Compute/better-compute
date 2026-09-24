// Delegated confirmation (PLAN.md §3.4 step 7, v0.3): an agent acting for a person under a delegation whose
// `confirm[]` holds an action back is denied until the person approves that exact (action, type, id). The
// envelope turns such a denial into `403 CONFIRMATION_REQUIRED { confirmationId }`; the agent polls
// better-iam's `getConfirmation` and retries with the same idempotency key, whose draft id is the approved one.

import {
  ComputeError,
  type Caller,
  type Credential,
  type Decision,
  type IamPort,
} from '@better-compute/core';

/** How long an approval stays valid, and the longest a draft waits for one (§3.4: ≤ 30 min). */
export const confirmationValidSeconds = 900;

export interface DelegatedDenialInput {
  caller: Caller;
  credential: Credential;
  decision: Decision;
  /** Shown to the person, e.g. "Reserve 4× H100 in pool-1 for 8h". */
  reason: string;
  validSeconds?: number;
}

/** `details` of a `CONFIRMATION_REQUIRED` error. */
export interface ConfirmationDetails {
  confirmationId: string;
  expiresAt?: number;
  action: string;
  resource: { type: string; id: string };
}

const denied = () => new ComputeError('ACCESS_DENIED', 'Access denied');

/**
 * What a denied decision becomes. For a delegated session whose delegation holds the action back, a
 * confirmation request is made (or a pending one reused) and `CONFIRMATION_REQUIRED` carries its id.
 * Everything else, including any failure while asking, is a plain `ACCESS_DENIED`: the caller never
 * learns more than a denial would tell them (P11). better-iam hides deny reasons, so a policy-denied,
 * confirm-listed action also produces a (futile) request until U8.
 */
export async function delegatedDenial(
  iam: Pick<IamPort, 'requestConfirmation'>,
  input: DelegatedDenialInput,
): Promise<ComputeError> {
  if (input.caller.sessionKind !== 'delegated') return denied();
  try {
    const outcome = await iam.requestConfirmation(input.credential, {
      ...input.decision,
      reason: input.reason.slice(0, 512),
      validSeconds: input.validSeconds ?? confirmationValidSeconds,
    } as Decision & { reason: string });
    if (outcome === 'not-held-back') return denied();
    const { expiresAt } = outcome as { expiresAt?: unknown };
    const details: ConfirmationDetails = {
      confirmationId: outcome.confirmationId,
      action: input.decision.action,
      resource: { type: input.decision.resource.type, id: input.decision.resource.id },
    };
    if (typeof expiresAt === 'number') details.expiresAt = expiresAt;
    return new ComputeError(
      'CONFIRMATION_REQUIRED',
      'The person this agent acts for must confirm this request; retry with the same idempotency key once they approve',
      403,
      { ...details },
    );
  } catch {
    return denied();
  }
}

/** The confirmation details of an error from `delegatedDenial`, if it asks for one. */
export function confirmationOf(error: unknown): ConfirmationDetails | undefined {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'CONFIRMATION_REQUIRED')
    return undefined;
  const details = (error as { details?: Record<string, unknown> }).details;
  if (!details || typeof details.confirmationId !== 'string') return undefined;
  return details as unknown as ConfirmationDetails;
}
