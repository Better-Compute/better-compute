// Server-side only (route handlers import it; it reads the filesystem and the token).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the admin's live mode talks to: a better-compute API base URL (…/api/compute) and a bearer token.
// Configured on the server only, never by the browser, so the proxy can't be pointed somewhere else:
//   ADMIN_COMPUTE_URL=http://127.0.0.1:3300/api/compute
//   ADMIN_COMPUTE_TOKEN=biam_ses_…          (optional; public methods work without)
//   ADMIN_COMPUTE_TENANT=ten_…              (optional; the tenant views default to)
// or the same keys in apps/admin/.upstream.json ({ "url", "token", "tenantId" }) for local development.

export interface UpstreamConfig {
  url: string;
  token?: string;
  tenantId?: string;
  /** better-iam's API base (…/api/iam) for operator sign-in; defaults to the compute URL's origin + /api/iam. */
  iamUrl?: string;
}

export function upstreamConfig(): UpstreamConfig | null {
  let url = process.env.ADMIN_COMPUTE_URL;
  let token = process.env.ADMIN_COMPUTE_TOKEN;
  let tenantId = process.env.ADMIN_COMPUTE_TENANT;
  let iamUrl = process.env.ADMIN_IAM_URL;
  if (!url) {
    try {
      const file = JSON.parse(readFileSync(join(process.cwd(), '.upstream.json'), 'utf8')) as Partial<UpstreamConfig>;
      url = typeof file.url === 'string' ? file.url : undefined;
      token ??= typeof file.token === 'string' ? file.token : undefined;
      tenantId ??= typeof file.tenantId === 'string' ? file.tenantId : undefined;
      iamUrl ??= typeof file.iamUrl === 'string' ? file.iamUrl : undefined;
    } catch {
      return null;
    }
  }
  if (!url) return null;
  const base = cleanBase(url);
  if (!base) return null;
  const iam = iamUrl ? cleanBase(iamUrl) : `${new URL(base).origin}/api/iam`;
  return { url: base, ...(token ? { token } : {}), ...(tenantId ? { tenantId } : {}), ...(iam ? { iamUrl: iam } : {}) };
}

/** http(s) origin + path, with no credentials, query or fragment (those never belong in a base URL). */
function cleanBase(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Credentials belong in ADMIN_COMPUTE_TOKEN, never in the URL (it is shown in Settings and in errors).
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * POST a better-iam method (…/api/iam/<group>/<method>) from this server: JSON, the x-better-iam CSRF header,
 * no Origin (server to server), an optional bearer, a timeout. Returns { data } or { error }.
 */
export async function callIam(
  config: UpstreamConfig,
  path: string,
  input: unknown,
  bearer?: string,
): Promise<{ data?: unknown; error?: { code: string; message: string } }> {
  if (!config.iamUrl) return { error: { code: 'NOT_CONFIGURED', message: 'No identity service is configured (ADMIN_IAM_URL)' } };
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-better-iam': '1' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  try {
    const response = await fetch(`${config.iamUrl}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input ?? {}),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } | null;
    if (!body || (!('data' in body) && !body.error)) return { error: { code: 'INVALID_RESPONSE', message: `The identity service answered ${response.status}` } };
    return body;
  } catch (error) {
    return { error: { code: 'UPSTREAM_UNREACHABLE', message: safeMessage(error) } };
  }
}

/**
 * The proxy acts with the operator's (or the server's) credential, so only this admin's own page may call it. The custom
 * x-better-compute header stops cross-site forms; this check stops other hosts on the network and DNS
 * rebinding (a hostile page resolving its name to this machine): the Host header must be an allowed name,
 * and a present Origin must be that same host. ADMIN_ALLOWED_HOSTS (comma-separated host[:port]) adds names
 * for a deployment behind a proxy; loopback names are always allowed.
 */
const hostOf = (request: Request) => (request.headers.get('host') ?? '').toLowerCase();

/** True when the request was addressed to a loopback name (localhost, 127.0.0.1, [::1], *.localhost). */
export function isLoopbackHost(request: Request): boolean {
  const name = hostOf(request).replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.localhost');
}

export function callerAllowed(request: Request): boolean {
  const host = hostOf(request);
  const name = host.replace(/:\d+$/, '');
  const extra = (process.env.ADMIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!isLoopbackHost(request) && !extra.includes(host) && !extra.includes(name)) return false;
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Messages from fetch can quote the URL; keep only the first line and drop anything URL-shaped. */
export function safeMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return text.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200) || 'The compute API did not answer';
}

const MAX_BODY = 8 * 1024 * 1024;

/** A method path as the compute API names them: `capacity/summary`, `nodes/list`, `system/version`. */
export const METHOD_PATH = /^[a-z][A-Za-z0-9]*(\/[a-z][A-Za-z0-9]*){1,3}$/;

/**
 * Read methods: the last segment is a getter or a listing (get, list, summary, version, status, timeline,
 * preview, history, diff, show, describe, catalog, search, find, estimate, optionally followed by more words:
 * `listSshCerts`, `getPolicy`). Signed out, the proxy forwards only these (with the shared connection, if
 * any); mutations need an operator's own session. A name that reads *and* writes (`getOrCreate`,
 * `listAndPrune`, `findAndLock`) is not a read. This is a name check, so give ADMIN_COMPUTE_TOKEN a read-only
 * role too: the API's own authorization is the real boundary.
 */
const READ_METHOD = /^(get|list|summary|version|status|timeline|preview|history|diff|show|describe|catalog|search|find|estimate)([A-Z][A-Za-z0-9]*)?$/;
const WRITE_WORD =
  /(?:Or|And|Then|Create|Delete|Update|Set|Put|Upsert|Insert|Remove|Prune|Purge|Revoke|Rotate|Write|Apply|Cancel|Release|Drain|Cordon|Reset|Ensure|Sync|Claim|Acquire|Lock|Mark|Ack|Refresh|Issue|Grant|Start|Stop|Run|Exec|Send|Save|Commit|Assign|Allocate|Reserve|Book)(?=[A-Z]|$)/;

export function isReadMethod(path: string): boolean {
  if (!METHOD_PATH.test(path)) return false;
  const method = path.split('/').at(-1)!;
  const match = READ_METHOD.exec(method);
  return Boolean(match) && !WRITE_WORD.test(match![2] ?? '');
}

/** POST a method to the upstream API; returns the raw status and JSON envelope. */
export async function callUpstream(config: UpstreamConfig, path: string, input: unknown, signal?: AbortSignal) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-better-compute': '1' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  // A hung upstream never holds a request forever.
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${config.url}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input ?? {}),
    redirect: 'error',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY)
    return { status: 502, body: { error: { code: 'INVALID_RESPONSE', message: 'The compute API answer is too large' } }, retryAfter: null };
  const text = await response.text();
  if (text.length > MAX_BODY)
    return { status: 502, body: { error: { code: 'INVALID_RESPONSE', message: 'The compute API answer is too large' } }, retryAfter: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: { code: 'INVALID_RESPONSE', message: `The compute server answered ${response.status} without JSON` } };
  }
  // Statuses that can't carry a body (204/205/304) or aren't valid Response statuses become a 502.
  const status = response.status >= 200 && response.status <= 599 && ![204, 205, 304].includes(response.status) ? response.status : 502;
  return { status, body, retryAfter: response.headers.get('retry-after') };
}
