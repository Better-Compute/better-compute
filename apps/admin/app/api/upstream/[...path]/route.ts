import { callerAllowed, callUpstream, isReadMethod, METHOD_PATH, safeMessage, upstreamConfig } from '@/lib/upstream';

// The browser's way to the compute API: POST /api/upstream/<group>/<method> with a JSON body. The upstream
// URL and token live on this server (lib/upstream.ts). Only this admin's own page may call it: the Host (and
// any Origin) must be an allowed name, which stops other hosts on the network and DNS rebinding, and the
// custom header stops cross-site forms and simple requests (CSRF), the same boundary the compute API uses.
// This is not operator authentication: put real auth in front before exposing the admin beyond loopback.

export const dynamic = 'force-dynamic';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!callerAllowed(request) || request.headers.get('x-better-compute') !== '1')
    return json(403, { error: { code: 'ACCESS_DENIED', message: 'Only the admin panel itself may use this proxy' } });
  const config = upstreamConfig();
  if (!config) return json(503, { error: { code: 'NOT_CONFIGURED', message: 'No compute API is configured (ADMIN_COMPUTE_URL)' } });
  const { path: segments } = await context.params;
  const path = segments.join('/');
  if (!METHOD_PATH.test(path)) return json(400, { error: { code: 'INVALID_INPUT', message: 'Not a method path' } });
  // No operator login yet: the shared server credential may only read. Mutations wait for per-operator auth.
  if (!isReadMethod(path))
    return json(403, {
      error: {
        code: 'READ_ONLY',
        message: `The admin's live connection is read-only until operator sign-in exists; ${path} changes state. Use the CLI or the console.`,
      },
    });
  let input: unknown = {};
  try {
    const text = await request.text();
    if (text.length > 1024 * 1024) return json(413, { error: { code: 'INVALID_INPUT', message: 'The body is too large' } });
    input = text ? JSON.parse(text) : {};
  } catch {
    return json(400, { error: { code: 'INVALID_INPUT', message: 'The body must be JSON' } });
  }
  try {
    const { status, body, retryAfter } = await callUpstream(config, path, input, request.signal);
    return json(status, body, retryAfter ? { 'retry-after': retryAfter } : {});
  } catch (error) {
    return json(502, { error: { code: 'UPSTREAM_UNREACHABLE', message: safeMessage(error) } });
  }
}
