import { ComputeError, type ErrorCode } from '@better-compute/core';

// DigitalOcean answers every failure with `{ id, message, request_id? }`. The status picks the
// code; for 422, which DO uses for everything it validates, the message does. Every error carries
// `details: { provider: 'digitalocean', status, id?, requestId?, reason? }`.

interface DoErrorBody {
  id?: unknown;
  message?: unknown;
  request_id?: unknown;
}

/** How long a 429 without a usable `retry-after` or `ratelimit-reset` waits. */
const defaultRetryAfterMs = 60_000;
/** The shortest wait a 429 answers: never zero, so a reset already past (clock skew) is not a hot loop. */
export const minRetryAfterMs = 1000;
/**
 * The longest wait a 429 answers: `ratelimit-reset` is when the oldest request leaves the hourly window, which can be
 * most of an hour away while the burst limit that refused the request clears within a minute.
 */
export const maxRetryAfterMs = 300_000;

/**
 * How long a 429 says to wait, in ms: `retry-after` first (this refusal's own wait: delay seconds or an HTTP date),
 * else the time until `ratelimit-reset` (epoch seconds), else a minute; kept between `minRetryAfterMs` and
 * `maxRetryAfterMs`.
 */
export function rateLimitWaitMs(headers: Pick<Headers, 'get'>, nowMs: number): number {
  let wait: number | undefined;
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - nowMs;
    if (Number.isFinite(ms)) wait = ms;
  }
  if (wait === undefined) {
    const reset = headers.get('ratelimit-reset')?.trim();
    const resetAt = Number(reset);
    if (reset && Number.isFinite(resetAt)) wait = resetAt * 1000 - nowMs;
  }
  return Math.min(
    maxRetryAfterMs,
    Math.max(minRetryAfterMs, Math.round(wait ?? defaultRetryAfterMs)),
  );
}

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
  // Block Storage (P2).
  {
    pattern: /attached to another droplet/i,
    code: 'CONFLICT',
    reason: 'attachedElsewhere',
  },
  {
    pattern: /maximum number of volumes/i,
    code: 'QUOTA_EXCEEDED',
    reason: 'volumesPerDroplet',
  },
  { pattern: /exceed your volume limit/i, code: 'QUOTA_EXCEEDED', reason: 'volumeLimit' },
  { pattern: /must be in the same region/i, code: 'INVALID_INPUT', reason: 'region' },
  { pattern: /must be larger than the current size/i, code: 'INVALID_INPUT', reason: 'shrink' },
  // Reserved IPs (P2). A pending event means an assign or unassign still runs: try again later.
  { pattern: /reserved ip limit/i, code: 'QUOTA_EXCEEDED', reason: 'reservedIpLimit' },
  { pattern: /has a pending event/i, code: 'CONFLICT', reason: 'actionPending' },
  // Load balancers (P4).
  { pattern: /load balancer limit/i, code: 'QUOTA_EXCEEDED', reason: 'loadBalancerLimit' },
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
    details.retryAfterMs = rateLimitWaitMs(headers, nowMs);
  } else if (status >= 500) code = 'UNAVAILABLE';
  else if (status === 400) code = 'INVALID_INPUT';
  else code = 'PROVIDER_ERROR';
  return new ComputeError(code, `${what}: ${text}`, undefined, details);
}
