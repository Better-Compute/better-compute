import { ComputeError, type ErrorCode } from '@better-compute/core';

// DigitalOcean answers every failure with `{ id, message, request_id? }`. The status picks the
// code; for 422, which DO uses for everything it validates, the message does. Every error carries
// `details: { provider: 'digitalocean', status, id?, requestId?, reason? }`.

interface DoErrorBody {
  id?: unknown;
  message?: unknown;
  request_id?: unknown;
}

/** How long a 429 without a usable `ratelimit-reset` waits. */
const defaultRetryAfterMs = 60_000;

/**
 * The 422 messages that mean more than "bad input". DO's spec doesn't list them: they are what its
 * clients report in practice (each has a fixture in tests/fixtures/digitalocean/errors.json, marked
 * unverified until the live suite records the real text). Anything else stays `INVALID_INPUT` and
 * is never retried; an `INVALID_INPUT` entry only names the reason.
 */
export const unprocessablePatterns: readonly {
  pattern: RegExp;
  code: 'CAPACITY_UNAVAILABLE' | 'QUOTA_EXCEEDED' | 'CONFLICT' | 'INVALID_INPUT';
  reason: string;
}[] = [
  {
    pattern: /size is not available in this region/i,
    code: 'CAPACITY_UNAVAILABLE',
    reason: 'sizeUnavailable',
  },
  {
    pattern: /region is not available/i,
    code: 'CAPACITY_UNAVAILABLE',
    reason: 'regionUnavailable',
  },
  {
    pattern: /insufficient capacity/i,
    code: 'CAPACITY_UNAVAILABLE',
    reason: 'insufficientCapacity',
  },
  { pattern: /exceed your droplet limit/i, code: 'QUOTA_EXCEEDED', reason: 'dropletLimit' },
  { pattern: /ssh key is already in use/i, code: 'CONFLICT', reason: 'sshKeyInUse' },
  { pattern: /name is already in use/i, code: 'CONFLICT', reason: 'nameInUse' },
  { pattern: /already exists/i, code: 'CONFLICT', reason: 'alreadyExists' },
  // A resource that something still uses (a VPC with members): try again once it is free.
  { pattern: /\bis in use\b/i, code: 'CONFLICT', reason: 'inUse' },
  // Still bad input, but a caller can say why: the range collides with another VPC of the account.
  { pattern: /overlaps with another network/i, code: 'INVALID_INPUT', reason: 'cidrOverlap' },
];

/** The ComputeError for a failed DigitalOcean HTTP response. */
export function mapDoError(
  status: number,
  body: unknown,
  headers: Pick<Headers, 'get'>,
  nowMs: number,
  what = 'DigitalOcean request',
): ComputeError {
  const parsed: DoErrorBody = typeof body === 'object' && body !== null ? body : {};
  const id = typeof parsed.id === 'string' ? parsed.id : undefined;
  const text = typeof parsed.message === 'string' ? parsed.message : `HTTP ${status}`;
  const requestId =
    typeof parsed.request_id === 'string'
      ? parsed.request_id
      : (headers.get('x-request-id') ?? undefined);
  const details: Record<string, unknown> = { provider: 'digitalocean', status };
  if (id !== undefined) details.id = id;
  if (requestId !== undefined) details.requestId = requestId;

  let code: ErrorCode;
  if (status === 401) {
    code = 'INVALID_CONFIG';
    details.reason = 'token';
  } else if (status === 403) {
    code = 'ACCESS_DENIED';
    details.reason = 'scope';
  } else if (status === 404) code = 'NOT_FOUND';
  else if (status === 409) code = 'CONFLICT';
  else if (status === 422) {
    const known = unprocessablePatterns.find(({ pattern }) => pattern.test(text));
    code = known?.code ?? 'INVALID_INPUT';
    if (known) details.reason = known.reason;
  } else if (status === 429) {
    code = 'RATE_LIMITED';
    details.reason = 'rateLimit';
    // ratelimit-reset is when the oldest request leaves the window, in epoch seconds.
    const rawReset = headers.get('ratelimit-reset');
    const resetAt = Number(rawReset);
    details.retryAfterMs =
      rawReset !== null && rawReset.trim() !== '' && Number.isFinite(resetAt)
        ? Math.max(0, resetAt * 1000 - nowMs)
        : defaultRetryAfterMs;
  } else if (status >= 500) code = 'UNAVAILABLE';
  else if (status === 400) code = 'INVALID_INPUT';
  else code = 'PROVIDER_ERROR';
  return new ComputeError(code, `${what}: ${text}`, undefined, details);
}
