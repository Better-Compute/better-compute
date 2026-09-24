// `ComputeSpan`, shaped like better-iam's `IamSpan` (PLAN.md §14): one timed unit of work. An observer times
// work, fans each finished span out to `onSpan` hooks (which can never affect the work), and feeds the registry's
// `better_compute_spans_total{kind,name,outcome,code}` and `better_compute_span_duration_seconds{kind}`.

import type { MetricsRegistry } from './registry.js';

export type ComputeSpanKind =
  | 'operation'
  | 'decision'
  | 'http'
  | 'command'
  | 'reconcile'
  | 'placement'
  | 'iam'
  | 'sink';

export interface ComputeSpan {
  kind: ComputeSpanKind;
  /** The method (`reservations.create`), route, command kind or reconciler. */
  name: string;
  /** For hooks only: never a metric label. */
  tenantId?: string;
  outcome: 'ok' | 'denied' | 'error';
  /** The ComputeError code for denied and error outcomes. */
  code?: string;
  status?: number;
  requestId?: string;
  durationMs: number;
}

/** Refusals (401, 403, 429) are `denied`; anything else that throws is an `error`. */
export const deniedStatuses: ReadonlySet<number> = new Set([401, 403, 429]);
const deniedCodes: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'ACCESS_DENIED',
  'CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'CSRF_REJECTED',
  'UNTRUSTED_ORIGIN',
]);
/** Codes whose span name came from the caller (an unknown route or method), so it never names a series. */
const callerNamedErrors: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'INVALID_INPUT',
  'METHOD_NOT_ALLOWED',
]);

export interface ObserverOptions {
  /** Receives every finished span; failures are swallowed so they can never affect the work. */
  onSpan?: ((span: ComputeSpan) => void) | readonly ((span: ComputeSpan) => void)[];
  /** Feeds the span metrics into this registry. */
  metrics?: MetricsRegistry;
  /** Milliseconds source (tests). */
  now?: () => number;
}

export interface Observer {
  /** Times `fn` and reports its span; `outcomeOf` classifies a successful result (advisory denials). */
  span<T>(
    kind: ComputeSpanKind,
    name: string,
    fn: () => Promise<T>,
    extra?: Pick<ComputeSpan, 'tenantId' | 'requestId'> & {
      outcomeOf?: (value: T) => Partial<Pick<ComputeSpan, 'outcome' | 'status' | 'code'>>;
    },
  ): Promise<T>;
  /** Reports a span timed elsewhere. */
  report(span: ComputeSpan): void;
}

export function createObserver(options: ObserverOptions = {}): Observer {
  const hooks =
    options.onSpan === undefined
      ? []
      : Array.isArray(options.onSpan)
        ? options.onSpan
        : [options.onSpan];
  const now = options.now ?? (() => performance.now());
  const counter = options.metrics?.counter(
    'spans_total',
    'Units of work by kind, name, outcome and code',
    ['kind', 'name', 'outcome', 'code'],
  );
  const histogram = options.metrics?.histogram(
    'span_duration_seconds',
    'Latency of units of work by kind',
    ['kind'],
  );

  const report = (span: ComputeSpan) => {
    const name =
      span.outcome !== 'ok' && span.code && callerNamedErrors.has(span.code)
        ? '(invalid)'
        : span.kind === 'http' && span.status === 404
          ? '(unknown)'
          : span.name;
    try {
      counter?.inc({ kind: span.kind, name, outcome: span.outcome, code: span.code ?? 'none' });
      histogram?.observe({ kind: span.kind }, Math.max(0, span.durationMs) / 1000);
    } catch {
      // Metrics must never affect the work.
    }
    for (const hook of hooks)
      try {
        hook(span);
      } catch {
        // Hooks must never affect the work.
      }
  };

  return {
    report,
    async span(kind, name, fn, extra = {}) {
      const started = now();
      const base = {
        kind,
        name,
        ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }),
        ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
      };
      try {
        const value = await fn();
        report({
          ...base,
          outcome: 'ok',
          ...extra.outcomeOf?.(value),
          durationMs: now() - started,
        });
        return value;
      } catch (error) {
        const { code, status } = error as { code?: unknown; status?: unknown };
        const known = typeof code === 'string' ? code : undefined;
        const httpStatus = typeof status === 'number' ? status : undefined;
        const denied =
          (known !== undefined && deniedCodes.has(known)) ||
          (httpStatus !== undefined && deniedStatuses.has(httpStatus));
        report({
          ...base,
          outcome: denied ? 'denied' : 'error',
          ...(known === undefined ? {} : { code: known }),
          ...(httpStatus === undefined ? {} : { status: httpStatus }),
          durationMs: now() - started,
        });
        throw error;
      }
    },
  };
}
