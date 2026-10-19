import type { ComputeError } from '@better-compute/core';
import { mapGoogleError } from './http.js';

// Long-running operations (google.longrunning.Operation) are never awaited in a call: a caller
// stores the operation name, polls it on each reconciler run, and reads the outcome through
// settledOperation. There is deliberately no waitForOperation.

export interface LongRunningOperation<R = unknown> {
  name: string;
  done?: boolean;
  metadata?: unknown;
  response?: R;
  error?: { code: number; message?: string; details?: unknown[] };
}

const rpcCodes: readonly (readonly [number, string])[] = [
  [499, 'CANCELLED'], // 1
  [500, 'UNKNOWN'], // 2
  [400, 'INVALID_ARGUMENT'], // 3
  [504, 'DEADLINE_EXCEEDED'], // 4
  [404, 'NOT_FOUND'], // 5
  [409, 'ALREADY_EXISTS'], // 6
  [403, 'PERMISSION_DENIED'], // 7
  [429, 'RESOURCE_EXHAUSTED'], // 8
  [400, 'FAILED_PRECONDITION'], // 9
  [409, 'ABORTED'], // 10
  [400, 'OUT_OF_RANGE'], // 11
  [501, 'UNIMPLEMENTED'], // 12
  [500, 'INTERNAL'], // 13
  [503, 'UNAVAILABLE'], // 14
  [500, 'DATA_LOSS'], // 15
  [401, 'UNAUTHENTICATED'], // 16
];

/** google.rpc.Code → [HTTP status, canonical status name]. Unknown codes map to [500, 'UNKNOWN']. */
export function rpcCodeToHttp(code: number): [number, string] {
  const entry = rpcCodes[code - 1];
  return entry ? [entry[0], entry[1]] : [500, 'UNKNOWN'];
}

const noHeaders: Pick<Headers, 'get'> = { get: () => null };

/**
 * The response when the operation is done; undefined while it is still running (and for a done
 * operation whose response is empty, such as a delete: check `done` for that). A done operation
 * with an error throws the ComputeError that the same failure would map to over HTTP.
 */
export function settledOperation<R>(
  operation: LongRunningOperation<R>,
  what: string,
): R | undefined {
  if (!operation.done) return undefined;
  const failure = operation.error;
  if (failure) throw operationError(failure, what);
  return operation.response;
}

function operationError(
  failure: NonNullable<LongRunningOperation['error']>,
  what: string,
): ComputeError {
  const [status, name] = rpcCodeToHttp(failure.code);
  return mapGoogleError(
    status,
    {
      error: {
        code: status,
        status: name,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    },
    noHeaders,
    what,
  );
}
