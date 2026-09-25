// Usage recording with poison isolation (PLAN.md §12.7). `billing.recordMany` records a batch in one
// transaction, so one bad event fails the batch on every retry. On an event-specific failure the batch is
// bisected down to the event, which is then re-attributed or dead-lettered on its own. Transient failures
// (IAM down, lock timeouts) are rethrown untouched: the whole flush retries later with the same keys.

import { ComputeError, type UsageEvent, type UsageResult } from '@better-compute/core';

/** better-iam's `UsageInput`, as far as compute sends it. */
export interface UsageInputLike {
  tenantId: string;
  meter: string;
  quantity?: number;
  identityId?: string;
  tags?: Record<string, string>;
  occurredAt?: number;
  idempotencyKey?: string;
}

/** The billing calls poison isolation needs; `iam.billing` satisfies it. */
export interface UsageBilling {
  recordMany(events: UsageInputLike[]): Promise<{ duplicate: boolean }[]>;
  record(event: UsageInputLike): Promise<{ duplicate: boolean }>;
}

export interface UsageIsolationOptions {
  /** Events per `recordMany` (bounds the IAM lock hold). Default 200, at most 1000. */
  batchSize?: number;
  /** The successor of an offboarded identity, remembered from `identity:offboard` events. */
  successorOf?(tenantId: string, identityId: string): Promise<string | undefined>;
}

/** Codes that mean "this event can never be recorded as sent"; anything else is transient. */
const poisonCodes: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'BILLING_PERIOD_CLOSED',
  'INVALID_INPUT',
  'INVALID_TRANSITION',
  'METER_ARCHIVED',
]);

interface IamErrorLike {
  code: string;
  message: string;
}

function iamError(error: unknown): IamErrorLike | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? { code, message: error.message } : undefined;
}

/**
 * Whether an error is specific to the events sent (bisect and isolate) rather than transient. better-iam's
 * "Endpoint not found" is also `NOT_FOUND`, but says the route is wrong (a misconfigured base path, a proxy): every
 * event would fail alike, and dead-lettering them all would lose the usage, so it stays transient.
 */
export function isPoisonError(error: unknown): boolean {
  const found = iamError(error);
  if (found === undefined || !poisonCodes.has(found.code)) return false;
  return !(found.code === 'NOT_FOUND' && /^Endpoint not found/.test(found.message));
}

const identityMissing = (error: IamErrorLike) =>
  error.code === 'NOT_FOUND' && error.message === 'Identity not found';

function toInput(event: UsageEvent): UsageInputLike {
  const input: UsageInputLike = {
    tenantId: event.tenantId,
    meter: event.meter,
    quantity: event.quantity,
    occurredAt: event.occurredAt,
    tags: { ...event.tags },
    idempotencyKey: event.idempotencyKey,
  };
  if (event.identityId !== undefined) input.identityId = event.identityId;
  return input;
}

/**
 * Records `events` and returns one result per event, in order:
 * - `recorded` or `duplicate` (the key was recorded before);
 * - `reattributed`: its identity no longer exists, so it was recorded under the offboarded identity's
 *   successor or, without one, tenant-attributed with tag `attribution=orphaned` (`identityId` absent);
 * - `dead-lettered`: it still fails on its own (a key reused on another meter, a closed period, an
 *   unknown meter, invalid input); `error` says why and the caller stores it in `usage_dead_letters`.
 *
 * A transient error rejects the whole call.
 */
export async function recordUsageIsolated(
  billing: UsageBilling,
  events: readonly UsageEvent[],
  options: UsageIsolationOptions = {},
): Promise<UsageResult[]> {
  const batchSize = options.batchSize ?? 200;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new ComputeError('INVALID_CONFIG', 'batchSize must be an integer from 1 to 1000');
  for (const event of events)
    if (typeof event.idempotencyKey !== 'string' || event.idempotencyKey === '')
      throw new ComputeError('INVALID_INPUT', 'Every usage event needs an idempotencyKey');

  const results: UsageResult[] = new Array(events.length);

  const single = async (index: number, failure: IamErrorLike): Promise<void> => {
    const event = events[index]!;
    const key = event.idempotencyKey;
    const deadLetter = (error: IamErrorLike) => {
      results[index] = {
        idempotencyKey: key,
        status: 'dead-lettered',
        error: { code: error.code, message: error.message },
      };
    };
    if (!identityMissing(failure) || event.identityId === undefined) return deadLetter(failure);

    const attempt = async (identityId: string | undefined, orphaned: boolean) => {
      const input = toInput(event);
      delete input.identityId;
      if (identityId !== undefined) input.identityId = identityId;
      if (orphaned) input.tags = { ...input.tags, attribution: 'orphaned' };
      await billing.record(input);
      const result: UsageResult = { idempotencyKey: key, status: 'reattributed' };
      if (identityId !== undefined) result.identityId = identityId;
      results[index] = result;
    };
    const successor = await options.successorOf?.(event.tenantId, event.identityId);
    if (successor !== undefined && successor !== event.identityId) {
      try {
        return await attempt(successor, false);
      } catch (error) {
        const found = iamError(error);
        if (!found || !poisonCodes.has(found.code)) throw error;
        if (!identityMissing(found)) return deadLetter(found);
      }
    }
    try {
      await attempt(undefined, true);
    } catch (error) {
      const found = iamError(error);
      if (!found || !poisonCodes.has(found.code)) throw error;
      deadLetter(found);
    }
  };

  const chunk = async (start: number, end: number): Promise<void> => {
    try {
      const receipts = await billing.recordMany(events.slice(start, end).map(toInput));
      for (let offset = 0; offset < end - start; offset++)
        results[start + offset] = {
          idempotencyKey: events[start + offset]!.idempotencyKey,
          status: receipts[offset]?.duplicate ? 'duplicate' : 'recorded',
        };
    } catch (error) {
      const found = iamError(error);
      if (!found || !poisonCodes.has(found.code)) throw error;
      if (end - start === 1) return single(start, found);
      const middle = start + Math.ceil((end - start) / 2);
      await chunk(start, middle);
      await chunk(middle, end);
    }
  };

  for (let start = 0; start < events.length; start += batchSize)
    await chunk(start, Math.min(start + batchSize, events.length));
  return results;
}
