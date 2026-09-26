import { clearedSessionCookie, seal, sealSession, sessionCookie, sessionFromRequest, sessionsAvailable, unseal } from '@/lib/session';
import { callerAllowed, callIam, upstreamConfig, type UpstreamConfig } from '@/lib/upstream';

// Operator sign-in against better-iam (the compute API's identity service), from this server:
//   POST { organization?, email, password }  → { ok } | { step: 'code', challenge, hint } | { error }
//   POST { challenge, code }                 → { ok } | { error }          (the second factor)
//   DELETE                                   → signs out at better-iam and clears the cookie
// The operator's own session token is sealed into an HttpOnly, SameSite=Strict cookie and forwarded as the
// bearer by /api/upstream; the browser never sees it. The MFA challenge travels sealed, with its tenant and a
// five-minute expiry, so the second step can't be replayed or pointed at another tenant.

export const dynamic = 'force-dynamic';

const MAX_SESSION_MS = 12 * 3_600_000;

const json = (status: number, body: unknown, cookie?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) },
  });

const secure = (request: Request) => new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

const guard = (request: Request) => callerAllowed(request) && request.headers.get('x-better-compute') === '1';

interface Challenge {
  tenantId: string;
  challenge: string;
  expiresAt: number;
}

async function resolveTenant(config: UpstreamConfig, organization: string | undefined): Promise<string | { error: string }> {
  if (!organization) return config.tenantId ?? { error: 'Enter your organization (no platform tenant is configured: ADMIN_COMPUTE_TENANT).' };
  if (/^ten_[A-Za-z0-9_-]{1,64}$/.test(organization)) return organization;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(organization)) return { error: 'That is not an organization name.' };
  const lookup = await callIam(config, 'tenants/lookup', { slug: organization });
  const tenantId = (lookup.data as { tenantId?: unknown } | undefined)?.tenantId;
  return typeof tenantId === 'string' ? tenantId : { error: 'No organization by that name.' };
}

/** A session token → the cookie: who it is (auth/getSession) and until when. */
async function finish(request: Request, config: UpstreamConfig, tenantId: string, token: string) {
  const current = await callIam(config, 'auth/getSession', {}, token);
  const data = current.data as
    | { identity?: { id?: string; name?: string; email?: string; tenantId?: string }; session?: { tenantId?: string }; limits?: { lifetimeMs?: number; idleExpiresAt?: number; now?: number } }
    | undefined;
  if (!data?.identity?.id) return json(502, { error: { message: 'Signed in, but the identity service did not describe the session.' } });
  const now = Date.now();
  const lifetime = typeof data.limits?.lifetimeMs === 'number' ? data.limits.lifetimeMs : MAX_SESSION_MS;
  const expiresAt = Math.min(now + Math.min(lifetime, MAX_SESSION_MS), typeof data.limits?.idleExpiresAt === 'number' ? data.limits.idleExpiresAt : Infinity);
  const sealed = sealSession({
    token,
    identityId: data.identity.id,
    tenantId: data.session?.tenantId ?? data.identity.tenantId ?? tenantId,
    ...(data.identity.name ? { name: data.identity.name } : {}),
    ...(data.identity.email ? { email: data.identity.email } : {}),
    expiresAt,
  });
  if (!sealed) return json(500, { error: { message: 'Sessions are not configured on this admin (ADMIN_SESSION_SECRET).' } });
  return json(200, { ok: true }, sessionCookie(sealed, Math.max(60, Math.floor((expiresAt - now) / 1000)), secure(request)));
}

type SignInData = { token?: string; mfaRequired?: boolean; challenge?: string; enrollmentRequired?: boolean; emailCodeAvailable?: boolean };

export async function POST(request: Request) {
  if (!guard(request)) return json(403, { error: { message: 'Only the admin panel itself may sign in here.' } });
  const config = upstreamConfig();
  if (!config) return json(503, { error: { message: 'No compute API is configured (ADMIN_COMPUTE_URL).' } });
  if (!sessionsAvailable()) return json(503, { error: { message: 'Sessions are not configured on this admin (ADMIN_SESSION_SECRET, 32+ characters).' } });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8 * 1024) return json(413, { error: { message: 'Too large.' } });
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json(400, { error: { message: 'The body must be JSON.' } });
  }

  // Second step: a code for a sealed challenge.
  if (typeof body.challenge === 'string') {
    const pending = unseal<Challenge>(body.challenge);
    if (!pending || typeof pending.expiresAt !== 'number' || pending.expiresAt < Date.now()) return json(400, { error: { message: 'That sign-in expired; start again.' } });
    if (typeof body.code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(body.code.trim())) return json(400, { error: { message: 'Enter the code.' } });
    const verified = await callIam(config, 'auth/verifyMfa', { tenantId: pending.tenantId, challenge: pending.challenge, code: body.code.trim() });
    const token = (verified.data as SignInData | undefined)?.token;
    if (typeof token !== 'string') return json(401, { error: { message: verified.error?.message ?? 'That code did not work.' } });
    return finish(request, config, pending.tenantId, token);
  }

  // First step: organization, email and password.
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password || email.length > 254 || password.length > 1024) return json(400, { error: { message: 'Enter your email and password.' } });
  const tenant = await resolveTenant(config, typeof body.organization === 'string' ? body.organization.trim().toLowerCase() || undefined : undefined);
  if (typeof tenant !== 'string') return json(400, { error: { message: tenant.error } });
  const signedIn = await callIam(config, 'auth/signIn', { tenantId: tenant, email, password });
  if (signedIn.error) {
    const unreachable = signedIn.error.code === 'UPSTREAM_UNREACHABLE' || signedIn.error.code === 'NOT_CONFIGURED';
    // One message for wrong email, wrong password or unknown account: no account probing through the admin.
    return json(unreachable ? 502 : 401, { error: { message: unreachable ? signedIn.error.message : 'Those credentials did not work.' } });
  }
  const data = signedIn.data as SignInData | undefined;
  if (data?.mfaRequired && typeof data.challenge === 'string') {
    if (data.enrollmentRequired) return json(403, { error: { message: 'Your account must enroll a second factor first; do that in the console, then sign in here.' } });
    const challenge = seal({ tenantId: tenant, challenge: data.challenge, expiresAt: Date.now() + 5 * 60_000 } satisfies Challenge);
    if (!challenge) return json(500, { error: { message: 'Sessions are not configured on this admin.' } });
    if (data.emailCodeAvailable) await callIam(config, 'auth/requestMfaCode', { tenantId: tenant, challenge: data.challenge });
    return json(200, { step: 'code', challenge, hint: data.emailCodeAvailable ? 'Enter the code from your authenticator, or the one just emailed to you.' : 'Enter the code from your authenticator.' });
  }
  if (typeof data?.token !== 'string') return json(502, { error: { message: 'The identity service did not return a session.' } });
  return finish(request, config, tenant, data.token);
}

export async function DELETE(request: Request) {
  if (!guard(request)) return json(403, { error: { message: 'Only the admin panel itself may sign out here.' } });
  const session = sessionFromRequest(request);
  const config = upstreamConfig();
  // End the session at better-iam too, so a copied cookie is worthless afterwards.
  if (session && config) await callIam(config, 'auth/signOut', {}, session.token);
  return json(200, { ok: true }, clearedSessionCookie(secure(request)));
}
