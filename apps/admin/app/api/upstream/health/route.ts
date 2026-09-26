import { upstreamConfig } from '@/lib/upstream';

// The compute API's public GET /health ({ status, database, latencyMs, time }), with the round trip measured
// from this server. Used by the Control plane page's live vitals.

export const dynamic = 'force-dynamic';

export async function GET() {
  const config = upstreamConfig();
  if (!config) return Response.json({ configured: false }, { status: 503 });
  const started = performance.now();
  try {
    const response = await fetch(`${config.url}/health`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000) });
    const roundTripMs = Math.round((performance.now() - started) * 10) / 10;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({ configured: true, ok: response.ok, httpStatus: response.status, roundTripMs, ...body }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ configured: true, ok: false, error: (error as Error).message, roundTripMs: Math.round(performance.now() - started) });
  }
}
