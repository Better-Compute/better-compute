import { ComputeError } from '@better-compute/core';
import { chunkBy } from '../common.js';

/** One entry the service refused in a batch call. */
export interface FailedEntry {
  index: number;
  code?: string;
}

const throttleCodes = /^(ThrottlingException|Throttling|ThrottledException|ProvisionedThroughputExceededException|KMSThrottlingException|RequestThrottled|TooManyRequestsException)$/;

/**
 * At-least-once batch delivery shared by every sink here. An item over `maxBytes` fails the whole
 * call with PAYLOAD_TOO_LARGE before anything is sent (the dispatcher's bisection isolates it and
 * dead-letters it). Every chunk is attempted; then any failed entry or failed call throws, so the
 * dispatcher retries the batch (consumers dedupe by event id). Never returns with an item dropped.
 */
export async function deliverInChunks<T extends { id: string }>(
  service: string,
  items: readonly T[],
  limits: { maxCount: number; maxBytes: number; maxItemBytes?: number; size: (item: T) => number },
  send: (chunk: T[]) => Promise<FailedEntry[]>,
): Promise<void> {
  if (items.length === 0) return;
  const maxItemBytes = limits.maxItemBytes ?? limits.maxBytes;
  for (const item of items) {
    const size = limits.size(item);
    if (size > maxItemBytes)
      throw new ComputeError(
        'PAYLOAD_TOO_LARGE',
        `${service}: event ${item.id} is ${size} bytes, over the ${maxItemBytes}-byte limit`,
        undefined,
        { eventId: item.id, bytes: size, limit: maxItemBytes },
      );
  }
  const failed: string[] = [];
  const codes = new Set<string>();
  let callError: unknown;
  for (const chunk of chunkBy(items, limits)) {
    try {
      for (const entry of await send(chunk)) {
        const item = chunk[entry.index];
        failed.push(item?.id ?? `#${entry.index}`);
        codes.add(entry.code ?? 'unknown');
      }
    } catch (error) {
      callError ??= error;
      for (const item of chunk) failed.push(item.id);
    }
  }
  if (callError !== undefined) {
    if (callError instanceof ComputeError)
      throw new ComputeError(callError.code, callError.message, callError.status, { ...callError.details, failed });
    throw callError;
  }
  if (failed.length === 0) return;
  const throttled = [...codes].every((code) => throttleCodes.test(code));
  throw new ComputeError(
    throttled ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
    `${service} refused ${failed.length} of ${items.length} events (${[...codes].sort().join(', ')})`,
    undefined,
    { provider: 'aws', service, failed, codes: [...codes].sort(), ...(throttled ? { retryAfterMs: 2000 } : {}) },
  );
}
