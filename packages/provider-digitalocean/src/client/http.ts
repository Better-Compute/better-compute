import { ComputeError, type Clock, type Logger } from '@better-compute/core';
import type { DoAction } from '../compute/types.js';
import type { BudgetClass, RateBudget } from './budget.js';
import { mapDoError } from './errors.js';

// A DigitalOcean API v2 client over plain fetch. Paths are relative to the endpoint
// (`/droplets/1`). Every request spends from the token's budget first and reports the response's
// rate-limit headers back to it. The token lives only in this closure: it is resolved on first
// use and never reaches a log line, an error message or an error's details.

export type { BudgetClass } from './budget.js';

export interface DoClient {
  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string>;
      signal: AbortSignal;
      budget: BudgetClass;
    },
  ): Promise<T>;
  /** Every element of a list response's `field` array, with `per_page=200`, following `links.pages.next`. */
  pages<T>(
    path: string,
    field: string,
    options: { query?: Record<string, string>; signal: AbortSignal; budget: BudgetClass },
  ): AsyncIterable<T>;
  /** `GET /actions/{id}` (budget `observe`). */
  action(id: number, signal: AbortSignal): Promise<DoAction>;
}

export interface DoClientOptions {
  fetch: typeof fetch;
  endpoint: string;
  /** Resolves the API token; called once, on first use. */
  token: () => Promise<string>;
  budget: RateBudget;
  clock: Clock;
  log: Logger;
}

const perPage = '200';

function providerError(message: string, reason: string, status?: number): ComputeError {
  return new ComputeError('PROVIDER_ERROR', message, undefined, {
    provider: 'digitalocean',
    ...(status !== undefined ? { status } : {}),
    reason,
  });
}

export function doClient(options: DoClientOptions): DoClient {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const { origin, pathname: basePath } = new URL(endpoint);

  // One shared in-flight promise; a failed resolution is not remembered, so a later call retries.
  let pending: Promise<string> | undefined;
  function token(): Promise<string> {
    pending ??= options.token().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  }

  async function send<T>(
    method: string,
    url: URL,
    opts: { body?: unknown; signal: AbortSignal; budget: BudgetClass },
  ): Promise<T> {
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || '/'
      : url.pathname;
    const what = `${method} ${path}`;
    options.budget.take(opts.budget);
    const bearer = await token();
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: opts.signal,
      });
    } catch (error) {
      if (opts.signal.aborted) throw error;
      options.log.warn('digitalocean.unreachable', { method, path });
      throw new ComputeError('UNAVAILABLE', `DigitalOcean unreachable: ${what}`, undefined, {
        provider: 'digitalocean',
        status: 0,
        reason: 'network',
      });
    }
    options.budget.observe(response.headers);
    options.log.debug('digitalocean.request', { method, path, status: response.status });
    const text = await response.text();
    let payload: unknown;
    let parsed = true;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = undefined;
      parsed = false;
    }
    if (response.ok) {
      // Only an empty body (a 202 or 204) means "nothing": a page of HTML must not read as an empty list.
      if (!parsed)
        throw providerError(
          `DigitalOcean answered ${what} with a body that is not JSON`,
          'badBody',
          response.status,
        );
      return (payload ?? {}) as T;
    }
    throw mapDoError(response.status, payload, response.headers, options.clock.now(), what);
  }

  function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string>;
      signal: AbortSignal;
      budget: BudgetClass;
    },
  ): Promise<T> {
    const url = new URL(`${endpoint}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    return send<T>(method, url, opts);
  }

  async function* pages<T>(
    path: string,
    field: string,
    opts: { query?: Record<string, string>; signal: AbortSignal; budget: BudgetClass },
  ): AsyncIterable<T> {
    let url: URL | undefined = new URL(`${endpoint}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('per_page', perPage);
    const seen = new Set<string>();
    while (url) {
      seen.add(url.toString());
      const page: { links?: { pages?: { next?: unknown } } } & Record<string, unknown> = await send(
        'GET',
        url,
        opts,
      );
      for (const item of (page[field] as T[] | undefined) ?? []) yield item;
      const next = page.links?.pages?.next;
      if (typeof next !== 'string' || !next) return;
      let target: URL;
      try {
        target = new URL(next);
      } catch {
        throw providerError('DigitalOcean returned an invalid page link', 'foreignLink');
      }
      // A link the API hands out is followed only on the endpoint's own origin: the bearer token
      // goes with the request.
      if (target.origin !== origin)
        throw providerError('DigitalOcean returned a page link to another origin', 'foreignLink');
      if (!target.searchParams.has('per_page')) target.searchParams.set('per_page', perPage);
      if (seen.has(target.toString()))
        throw providerError('DigitalOcean returned a page link that loops', 'pageLoop');
      url = target;
    }
  }

  async function action(id: number, signal: AbortSignal): Promise<DoAction> {
    const reply = await request<{ action: DoAction }>('GET', `/actions/${id}`, {
      signal,
      budget: 'observe',
    });
    return reply.action;
  }

  return { request, pages, action };
}
