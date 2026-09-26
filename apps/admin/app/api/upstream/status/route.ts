import { callerAllowed, callUpstream, safeMessage, upstreamConfig } from '@/lib/upstream';

// Connection status for the status bar and Settings: is an API configured, does it answer, who are we to it.
// Never returns the token; the URL is origin + path only (upstreamConfig refuses credentials in it).

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!callerAllowed(request)) return Response.json({ configured: false }, { status: 403 });
  const config = upstreamConfig();
  if (!config) return Response.json({ configured: false }, { headers: { 'cache-control': 'no-store' } });
  const started = performance.now();
  const base = { configured: true, url: config.url, authenticated: Boolean(config.token), tenantId: config.tenantId ?? null };
  try {
    const signal = AbortSignal.timeout(4000);
    const version = await callUpstream(config, 'system/version', {}, signal);
    const latencyMs = Math.round(performance.now() - started);
    const data = (version.body as { data?: unknown; error?: { code: string; message: string } }) ?? {};
    if (!data.data) return Response.json({ ...base, ok: false, latencyMs, error: data.error ?? { code: 'HTTP_ERROR', message: `HTTP ${version.status}` } });
    return Response.json({ ...base, ok: true, latencyMs, server: data.data }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ...base, ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: safeMessage(error) } });
  }
}
