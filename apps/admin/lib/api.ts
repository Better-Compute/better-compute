'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// The browser side of live mode: `api.$request('capacity/summary', { tenantId })` goes through this app's
// /api/upstream proxy to the configured compute API. It has console-kit's ComputeRequester shape, so every
// console-kit store and view model (createConsoleResources, createQuotaView, createUsageView…) runs on it.

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<Output = unknown>(path: string, input: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<Output> {
  const response = await fetch(`/api/upstream/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-better-compute': '1' },
    body: JSON.stringify(input ?? {}),
    cache: 'no-store',
    signal: options.signal,
  });
  let envelope: { data?: Output; error?: { code: string; message: string; details?: Record<string, unknown> } };
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError('INVALID_RESPONSE', `The admin proxy answered ${response.status} without JSON`, response.status);
  }
  if (envelope.error) throw new ApiError(envelope.error.code, envelope.error.message, response.status, envelope.error.details);
  if (!('data' in envelope)) throw new ApiError('INVALID_RESPONSE', 'The compute API returned no data', response.status);
  return envelope.data as Output;
}

/** A console-kit ComputeRequester over the admin's proxy. */
export const api = { $request: request };

export interface ConnectionStatus {
  configured: boolean;
  ok?: boolean;
  url?: string;
  latencyMs?: number;
  authenticated?: boolean;
  tenantId?: string | null;
  /** True once a signed-in operator's own credential is forwarded; mutations are refused otherwise. */
  writable?: boolean;
  /** The signed-in operator, or null (the shared read-only connection). */
  operator?: { identityId: string; name: string | null; email: string | null; expiresAt: number } | null;
  server?: { name: string; version: string; basePath: string; protocol: { min: number; max: number } };
  error?: { code: string; message: string };
  checkedAt?: number;
}

/**
 * Call one method and keep the result: `const { data, error, loading, refresh } = useApi('nodes/list', { tenantId })`.
 * `enabled: false` skips the call (e.g. while the panel is simulated); `refreshMs` polls.
 */
export function useApi<Output>(
  path: string,
  input: unknown,
  options: { enabled?: boolean; refreshMs?: number } = {},
): { data?: Output; error?: ApiError; loading: boolean; refresh(): void } {
  const [state, setState] = useState<{ data?: Output; error?: ApiError; loading: boolean }>({ loading: false });
  const key = `${path}:${JSON.stringify(input ?? {})}`;
  const enabled = options.enabled ?? true;
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    if (!enabled) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState((s) => ({ ...s, loading: true }));
    request<Output>(path, input, { signal: abort.signal })
      .then((data) => !abort.signal.aborted && setState({ data, loading: false }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: error instanceof ApiError ? error : new ApiError('NETWORK', String(error), 0) }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(() => {
    run();
    if (!enabled || !options.refreshMs) return () => controller.current?.abort();
    const timer = window.setInterval(run, options.refreshMs);
    return () => {
      window.clearInterval(timer);
      controller.current?.abort();
    };
  }, [run, enabled, options.refreshMs]);

  return { ...state, refresh: run };
}
