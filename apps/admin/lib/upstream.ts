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
}

export function upstreamConfig(): UpstreamConfig | null {
  let url = process.env.ADMIN_COMPUTE_URL;
  let token = process.env.ADMIN_COMPUTE_TOKEN;
  let tenantId = process.env.ADMIN_COMPUTE_TENANT;
  if (!url) {
    try {
      const file = JSON.parse(readFileSync(join(process.cwd(), '.upstream.json'), 'utf8')) as Partial<UpstreamConfig>;
      url = file.url;
      token ??= file.token;
      tenantId ??= file.tenantId;
    } catch {
      return null;
    }
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { url: url.replace(/\/+$/, ''), ...(token ? { token } : {}), ...(tenantId ? { tenantId } : {}) };
}

/** A method path as the compute API names them: `capacity/summary`, `nodes/list`, `system/version`. */
export const METHOD_PATH = /^[a-z][A-Za-z0-9]*(\/[a-z][A-Za-z0-9]*){1,3}$/;

/** POST a method to the upstream API; returns the raw status and JSON envelope. */
export async function callUpstream(config: UpstreamConfig, path: string, input: unknown, signal?: AbortSignal) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-better-compute': '1' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  const response = await fetch(`${config.url}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input ?? {}),
    redirect: 'error',
    cache: 'no-store',
    signal,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: { code: 'INVALID_RESPONSE', message: `The compute server answered ${response.status} without JSON` } };
  }
  return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
}
