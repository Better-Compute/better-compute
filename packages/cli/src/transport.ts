import { apiMethod } from '@better-compute/core';
import { createComputeClient } from '@better-compute/client';
import type { AnyCompute } from './config.js';
import { usageError } from './errors.js';

/**
 * Calls API routes (`system/version`, `plugins/acme/widgets/poke`): in process against a configured
 * deployment, or over HTTPS against a running server. Both go through the HTTP handler's route
 * table, envelope and credential rules, so a command behaves the same locally and remotely.
 */
export interface ApiTransport {
  readonly mode: 'local' | 'remote';
  /** The configuration file or endpoint URL the calls go to, for messages. */
  readonly target: string;
  call<Output = unknown>(path: string, input?: Record<string, unknown>): Promise<Output>;
}

const segment = /^[A-Za-z][A-Za-z0-9_-]*$/;
const basePathPattern = /^(?:\/[A-Za-z0-9_-]+)+$/;

/**
 * Turns `system.version`, `system/version`, `plugins.acme.widgets.poke` or
 * `plugins/acme/widgets/poke` into a route path; refuses anything else.
 */
export function routePath(route: string): string {
  const parts = (route.includes('/') ? route : route.replaceAll('.', '/')).split('/');
  if (!parts.every((part) => segment.test(part)))
    throw usageError(`${route} is not an API route like system.version`);
  if (parts[0] === 'plugins' ? parts.length !== 4 : parts.length !== 2)
    throw usageError(
      parts.length === 1
        ? `${route} names no method; use group.method (for example system.version), or api --list ${route}`
        : `${route} is not an API route: use group.method, or plugins.ID.group.method for plugins`,
    );
  return parts.join('/');
}

/** Whether this release's §9.2 table marks a core or built-in route public (needs no credential). */
export function isPublicRoute(path: string): boolean {
  const [group, method, ...rest] = path.split('/');
  return (
    !rest.length && group !== 'plugins' && apiMethod(group ?? '', method ?? '')?.kind === 'public'
  );
}

/**
 * Calls a deployment in process through `compute.handler`: the same route table, envelope, CSRF
 * rules, 64 KiB body limit and JSON round trip as HTTP, as `token` (or with no credential).
 */
export function localTransport(compute: AnyCompute, target: string, token?: string): ApiTransport {
  const client = createComputeClient<{ api: unknown }>({
    baseURL: compute.endpoint.origin,
    basePath: compute.endpoint.basePath,
    ...(token ? { token } : {}),
    requestId: true,
    fetch: async (input, init) => compute.handler(new Request(input, init)),
  });
  return {
    mode: 'local',
    target,
    call: <Output>(path: string, input: Record<string, unknown> = {}) =>
      client.$request<Output>(path, input),
  };
}

/** `https://compute.example.com` (default base path `/api/compute`) or the full endpoint `https://host/custom/compute`. */
export function parseEndpoint(url: string): { origin: string; basePath: string; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError(`--url ${url} is not an absolute http(s) URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw usageError('--url must be an http(s) URL without credentials, query, or fragment');
  // Bearer tokens never travel in clear text, except to this machine.
  if (
    parsed.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
    !parsed.hostname.endsWith('.localhost')
  )
    throw usageError(
      `--url ${parsed.origin} must use https (plain http is allowed for localhost only)`,
    );
  const basePath = parsed.pathname.replace(/\/+$/, '') || '/api/compute';
  if (!basePathPattern.test(basePath))
    throw usageError(`--url path ${basePath} is not a base path like /api/compute`);
  return { origin: parsed.origin, basePath, url: `${parsed.origin}${basePath}` };
}

/**
 * Calls a running compute server over HTTP(S) with a bearer token through the typed client
 * (request IDs, one retry after a short rate limit).
 */
export function remoteTransport(
  url: string,
  token: string | undefined,
  fetcher?: typeof globalThis.fetch,
): ApiTransport {
  const endpoint = parseEndpoint(url);
  const client = createComputeClient<{ api: unknown }>({
    baseURL: endpoint.origin,
    basePath: endpoint.basePath,
    ...(token ? { token } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
    requestId: true,
    retryRateLimited: true,
  });
  return {
    mode: 'remote',
    target: endpoint.url,
    call: <Output>(path: string, input: Record<string, unknown> = {}) =>
      client.$request<Output>(path, input),
  };
}

/** One route a deployment serves. */
export interface RouteEntry {
  /** `system/version`, `plugins/acme/widgets/poke`. */
  route: string;
  access: 'public' | 'token';
  /** The IAM action decided before the handler; `null` for public methods. */
  action: string | null;
}

/** Every route a deployment's HTTP API serves, with whether it needs a credential. */
export function listRoutes(compute: AnyCompute): RouteEntry[] {
  return compute.registry.methods
    .map((method) => ({
      route: method.path,
      access: method.kind === 'public' ? ('public' as const) : ('token' as const),
      action: method.action,
    }))
    .sort((a, b) => a.route.localeCompare(b.route));
}
