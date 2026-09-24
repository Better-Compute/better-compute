import type { Phase } from './domain.js';

/** Every stable error code the API, SDK and CLI can surface (PLAN.md §9.1). */
export const errorCodes = [
  'UNAUTHENTICATED',
  'ACCESS_DENIED',
  'CONFIRMATION_REQUIRED',
  'NOT_FOUND',
  'INVALID_INPUT',
  'INVALID_STATE',
  'CONFLICT',
  'CAPACITY_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'SPEND_LIMIT_REACHED',
  'UNSUPPORTED',
  'UPGRADE_REQUIRED',
  'RATE_LIMITED',
  'DRIVER_ERROR',
  'PROVIDER_ERROR',
  'INVALID_CONFIG',
  'NOT_IMPLEMENTED',
  'CSRF_REJECTED',
  'UNTRUSTED_ORIGIN',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'MISSING_DEPENDENCY',
  /** Configuration as code: live state differs from the plan (`fleet.apply`, `--fail-on-drift`). */
  'CONFIG_DRIFT',
] as const;
export type ErrorCode = (typeof errorCodes)[number];

/**
 * The HTTP status each code maps to unless a caller overrides it. `INVALID_CONFIG` and
 * `MISSING_DEPENDENCY` describe the deployment rather than the request, so they are server errors.
 */
export const defaultStatus: Readonly<Record<ErrorCode, number>> = {
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
};

/** The `error` member of a failed response: `{ error: { code, message, retryAfterMs?, details? } }`. */
export interface ComputeErrorBody {
  code: ErrorCode;
  message: string;
  /** `RATE_LIMITED` and retryable conflicts: how long to wait before retrying. */
  retryAfterMs?: number;
  /** Machine-readable context, such as `confirmationId` for `CONFIRMATION_REQUIRED`. */
  details?: Record<string, unknown>;
}

/**
 * The one error type compute code throws. The code is stable and safe to show; the message is for
 * people; `details` carries structured context. A `retryAfterMs` number in `details` becomes the
 * body's top-level `retryAfterMs`.
 */
export class ComputeError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    status?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ComputeError';
    this.status = status ?? defaultStatus[code] ?? 500;
  }

  /** How long to wait before retrying, when the error says. */
  get retryAfterMs(): number | undefined {
    const value = this.details?.retryAfterMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  /** The response body form of this error. */
  toBody(): ComputeErrorBody {
    const body: ComputeErrorBody = { code: this.code, message: this.message };
    const retryAfterMs = this.retryAfterMs;
    if (retryAfterMs !== undefined) body.retryAfterMs = retryAfterMs;
    if (this.details) {
      const { retryAfterMs: _lifted, ...rest } = this.details;
      if (Object.keys(rest).length) body.details = rest;
    }
    return body;
  }

  toJSON(): ComputeErrorBody {
    return this.toBody();
  }
}

const knownCodes: ReadonlySet<string> = new Set(errorCodes);

/** Whether `value` is a known error code. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && knownCodes.has(value);
}

/**
 * Whether `value` is a `ComputeError`, including one thrown by a second copy of this package (two
 * installed versions, or source and build output side by side), which `instanceof` would miss.
 */
export function isComputeError(value: unknown, code?: ErrorCode): value is ComputeError {
  if (!(value instanceof Error)) return false;
  const candidate = value as Partial<ComputeError>;
  const shaped =
    value instanceof ComputeError ||
    (value.name === 'ComputeError' &&
      isErrorCode(candidate.code) &&
      typeof candidate.status === 'number');
  return shaped && (code === undefined || candidate.code === code);
}

/** The error an unimplemented stub throws: `NOT_IMPLEMENTED`, naming the phase that delivers it. */
export function notImplemented(feature: string, phase: Phase): ComputeError {
  return new ComputeError('NOT_IMPLEMENTED', `${feature} arrives in ${phase}`, undefined, {
    feature,
    phase,
  });
}
