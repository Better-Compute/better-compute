import { callUpstream, METHOD_PATH, upstreamConfig } from '@/lib/upstream';

// The browser's way to the compute API: POST /api/upstream/<group>/<method> with a JSON body. The upstream
// URL and token live on this server (lib/upstream.ts). The custom header makes cross-site forms and simple
// requests unable to reach it (CSRF), the same boundary the compute API itself uses.

export const dynamic = 'force-dynamic';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (request.headers.get('x-better-compute') !== '1')
    return json(403, { error: { code: 'ACCESS_DENIED', message: 'Missing the x-better-compute header' } });
  const config = upstreamConfig();
  if (!config) return json(503, { error: { code: 'NOT_CONFIGURED', message: 'No compute API is configured (ADMIN_COMPUTE_URL)' } });
  const { path: segments } = await context.params;
  const path = segments.join('/');
  if (!METHOD_PATH.test(path)) return json(400, { error: { code: 'INVALID_INPUT', message: 'Not a method path' } });
  let input: unknown = {};
  try {
    const text = await request.text();
    input = text ? JSON.parse(text) : {};
  } catch {
    return json(400, { error: { code: 'INVALID_INPUT', message: 'The body must be JSON' } });
  }
  try {
    const { status, body, retryAfter } = await callUpstream(config, path, input, request.signal);
    return json(status, body, retryAfter ? { 'retry-after': retryAfter } : {});
  } catch (error) {
    return json(502, { error: { code: 'UPSTREAM_UNREACHABLE', message: (error as Error).message || 'The compute API did not answer' } });
  }
}
