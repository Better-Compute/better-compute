// When an identity's reservations should change hands (PLAN.md §12.8 "reassign reservations to successorId or
// apply tenant policy"): an offboarding, expiry or deletion from the inbox, or IamReconcile finding an owner no
// longer active (its synthetic `compute:iam:reconcile` event). A merely disabled identity keeps its reservations
// unless an offboarding named a successor: it may be enabled again.

import type { IamInboxEvent } from './worker.js';

/** An identity that is gone for good, and who takes over (when anyone does). */
export interface IdentityEnd {
  tenantId: string;
  identityId: string;
  successorId?: string;
}

const ends = new Set([
  'identity:offboard',
  'identity:expire',
  'identity:delete',
  'iam:identities:delete',
]);

/**
 * The end an inbox event reports, or undefined. `successorOf` is the iam module's `successorLookup(sql)` (the
 * `iam_successors` the inbox remembered from offboarding events).
 */
export async function identityEndOf(
  event: Pick<IamInboxEvent, 'tenantId' | 'action' | 'subjectId' | 'metadata'>,
  successorOf?: (tenantId: string, identityId: string) => Promise<string | undefined>,
): Promise<IdentityEnd | undefined> {
  const identityId =
    typeof event.subjectId === 'string' && event.subjectId ? event.subjectId : undefined;
  if (!identityId) return undefined;
  const named =
    typeof event.metadata?.successorId === 'string' && event.metadata.successorId
      ? event.metadata.successorId
      : undefined;
  const successor = async () => named ?? (await successorOf?.(event.tenantId, identityId));
  const end = (successorId: string | undefined): IdentityEnd => ({
    tenantId: event.tenantId,
    identityId,
    ...(successorId && successorId !== identityId ? { successorId } : {}),
  });
  if (ends.has(event.action)) return end(await successor());
  if (event.action === 'compute:iam:reconcile') {
    const status = event.metadata?.status;
    if (status === 'deleted' || status === 'missing') return end(await successor());
    // Disabled: only an offboarding (a remembered successor) makes it final.
    if (status === 'disabled') {
      const successorId = await successor();
      return successorId ? end(successorId) : undefined;
    }
  }
  return undefined;
}
