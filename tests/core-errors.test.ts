import { describe, expect, it } from 'vitest';
import {
  ComputeError,
  defaultStatus,
  errorCodes,
  isComputeError,
  isErrorCode,
  notImplemented,
  type ErrorCode,
} from '@better-compute/core';

describe('error codes', () => {
  it('map to the statuses of PLAN.md §9.1', () => {
    const expected: Record<ErrorCode, number> = {
      UNAUTHENTICATED: 401,
      ACCESS_DENIED: 403,
      CONFIRMATION_REQUIRED: 403,
      NOT_FOUND: 404,
      INVALID_INPUT: 400,
      INVALID_STATE: 409,
      CONFLICT: 409,
      CAPACITY_UNAVAILABLE: 409,
      QUOTA_EXCEEDED: 409,
      SPEND_LIMIT_REACHED: 402,
      UNSUPPORTED: 422,
      UPGRADE_REQUIRED: 426,
      RATE_LIMITED: 429,
      DRIVER_ERROR: 502,
      PROVIDER_ERROR: 502,
      INVALID_CONFIG: 500,
      NOT_IMPLEMENTED: 501,
      CSRF_REJECTED: 403,
      UNTRUSTED_ORIGIN: 403,
      METHOD_NOT_ALLOWED: 405,
      PAYLOAD_TOO_LARGE: 413,
      INTERNAL_ERROR: 500,
      MISSING_DEPENDENCY: 500,
      CONFIG_DRIFT: 409,
      UNAVAILABLE: 503,
    };
    expect(defaultStatus).toEqual(expected);
    expect([...errorCodes].sort()).toEqual(Object.keys(expected).sort());
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
  });

  it('recognizes known codes only', () => {
    expect(isErrorCode('QUOTA_EXCEEDED')).toBe(true);
    expect(isErrorCode('quota_exceeded')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode(403)).toBe(false);
  });
});

describe('ComputeError', () => {
  it('takes its status from the code unless overridden', () => {
    const error = new ComputeError('CAPACITY_UNAVAILABLE', 'No GPUs free');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ComputeError');
    expect(error.code).toBe('CAPACITY_UNAVAILABLE');
    expect(error.status).toBe(409);
    expect(error.message).toBe('No GPUs free');
    expect(error.details).toBeUndefined();
    expect(new ComputeError('INVALID_INPUT', 'x', 422).status).toBe(422);
  });

  it('renders the response body, lifting retryAfterMs out of details', () => {
    const limited = new ComputeError('RATE_LIMITED', 'Slow down', undefined, {
      retryAfterMs: 1500,
      bucket: 'handshake',
    });
    expect(limited.retryAfterMs).toBe(1500);
    expect(limited.toBody()).toEqual({
      code: 'RATE_LIMITED',
      message: 'Slow down',
      retryAfterMs: 1500,
      details: { bucket: 'handshake' },
    });
    expect(JSON.parse(JSON.stringify(limited))).toEqual(limited.toBody());

    const confirmation = new ComputeError('CONFIRMATION_REQUIRED', 'Confirm', undefined, {
      confirmationId: 'cnf_1',
    });
    expect(confirmation.status).toBe(403);
    expect(confirmation.toBody()).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Confirm',
      details: { confirmationId: 'cnf_1' },
    });
    expect(new ComputeError('CONFLICT', 'x', undefined, { retryAfterMs: 5 }).toBody()).toEqual({
      code: 'CONFLICT',
      message: 'x',
      retryAfterMs: 5,
    });
    expect(new ComputeError('CONFLICT', 'x', undefined, { retryAfterMs: -1 }).retryAfterMs).toBe(
      undefined,
    );
  });

  it('is recognized across package copies but not by shape alone', () => {
    class ComputeErrorCopy extends Error {
      constructor(
        readonly code: string,
        message: string,
        readonly status = 400,
      ) {
        super(message);
        this.name = 'ComputeError';
      }
    }
    const error = new ComputeError('NOT_FOUND', 'missing');
    expect(isComputeError(error)).toBe(true);
    expect(isComputeError(error, 'NOT_FOUND')).toBe(true);
    expect(isComputeError(error, 'CONFLICT')).toBe(false);
    expect(isComputeError(new ComputeErrorCopy('NOT_FOUND', 'missing', 404))).toBe(true);
    expect(isComputeError(new ComputeErrorCopy('NOPE', 'missing', 404))).toBe(false);
    expect(isComputeError(new Error('plain'))).toBe(false);
    expect(isComputeError({ name: 'ComputeError', code: 'NOT_FOUND', status: 404 })).toBe(false);
    expect(isComputeError(undefined)).toBe(false);
  });

  it('names the phase that implements a stub', () => {
    const error = notImplemented('metal()', 'v0.2');
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.status).toBe(501);
    expect(error.message).toBe('metal() arrives in v0.2');
    expect(error.details).toEqual({ feature: 'metal()', phase: 'v0.2' });
  });
});
