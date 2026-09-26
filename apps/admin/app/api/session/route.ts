import { createHash } from 'node:crypto';
import {
  clearedSessionCookies,
  requestKeyHash,
  revokeSession,
  sameHash,
  seal,
  sealSession,
  sessionCookie,
  sessionsAvailable,
  sessionsInRequest,
  unseal,
} from '@/lib/session';
import { challengeThrottle, signInThrottle, usedChallenges } from '@/lib/throttle';
import { callerAllowed, callIam, isLoopbackHost, upstreamConfig, type UpstreamConfig } from '@/lib/upstream';

// Operator sign-in against better-iam (the compute API's identity service), from this server:
//   POST { organization?, email, password }  → { ok } | { step: 'code', challenge, hint } | { error }
//   POST { challenge, code }                 → { ok } | { error }          (the second factor)
//   DELETE                                   → signs out at better-iam and clears the cookie
// Every call carries the browser's session key (x-bc-session-key, lib/session-key.ts); the session and the
// challenge are bound to its hash. The operator's own session token is sealed into an HttpOnly, SameSite=Strict
// cookie and forwarded as the bearer by /api/upstream; the browser never sees it. The MFA challenge travels
// sealed with its tenant, the key hash and a five-minute expiry; it takes five codes at most and signs in once.

export const dynamic = 'force-dynamic';

const MAX_SESSION_MS = 12 * 3_600_000;
const FAILED = 'Those credentials did not work.';

const json = (status: number, body: unknown, cookies: string[] = []) => {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

const secure = (request: Request) => new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

const guard = (request: Request) => callerAllowed(request) && request.headers.get('x-better-compute') === '1';

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

interface Challenge {
  tenantId: string;
  challenge: string;
  keyHash: string;
  expiresAt: number;
}

async function resolveTenant(config: UpstreamConfig, organization: string | undefined): Promise<string | { error: string; status: number }> {
  if (!organization) return config.tenantId ?? { status: 400, error: 'Enter your organization (no platform tenant is configured: ADMIN_COMPUTE_TENANT).' };
  if (/^ten_[A-Za-z0-9_-]{1,64}$/.test(organization)) return organization;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(organization)) return { status: 400, error: 'That is not an organization name.' };
  const lookup = await callIam(config, 'tenants/lookup', { slug: organization });
  const tenantId = (lookup.data as { tenantId?: unknown } | undefined)?.tenantId;
  // An unknown organization answers like wrong credentials: no probing which organizations exist.
  return typeof tenantId === 'string' ? tenantId : { status: 401, error: FAILED };
}

/** A session token → the cookie: who it is (auth/getSession) and until when, bound to the browser's key. */
async function finish(request: Request, config: UpstreamConfig, tenantId: string, token: string, keyHash: string) {
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
    keyHash,
  });
  if (!sealed) return json(500, { error: { message: 'Sessions are not configured on this admin (ADMIN_SESSION_SECRET).' } });
  return json(200, { ok: true }, [sessionCookie(sealed, Math.max(60, Math.floor((expiresAt - now) / 1000)), secure(request))]);
}

type SignInData = { token?: string; mfaRequired?: boolean; challenge?: string; enrollmentRequired?: boolean; emailCodeAvailable?: boolean };

const unreachable = (error: { code: string } | undefined) => error?.code === 'UPSTREAM_UNREACHABLE' || error?.code === 'NOT_CONFIGURED';

export async function POST(request: Request) {
  if (!guard(request)) return json(403, { error: { message: 'Only the admin panel itself may sign in here.' } });
  // Passwords and session cookies travel in the clear over http: beyond loopback, sign in over https only.
  if (!isLoopbackHost(request) && !secure(request)) return json(403, { error: { message: 'Serve the admin over https to sign in from another machine.' } });
  const keyHash = requestKeyHash(request);
  if (!keyHash) return json(400, { error: { message: 'Reload the page and sign in again.' } });
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
  const now = Date.now();

  // Second step: a code for a sealed challenge, from the browser that started the sign-in.
  if (typeof body.challenge === 'string') {
    const pending = unseal<Challenge>(body.challenge, 'mfa');
    const id = hash(body.challenge);
    for (const [used, until] of usedChallenges) if (until <= now) usedChallenges.delete(used);
    if (
      !pending ||
      typeof pending.expiresAt !== 'number' ||
      pending.expiresAt < now ||
      !sameHash(pending.keyHash, keyHash) ||
      usedChallenges.has(id) ||
      challengeThrottle.blocked(id, now)
    )
      return json(400, { error: { message: 'That sign-in expired; start again.' } });
    if (typeof body.code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(body.code.trim())) return json(400, { error: { message: 'Enter the code.' } });
    const verified = await callIam(config, 'auth/verifyMfa', { tenantId: pending.tenantId, challenge: pending.challenge, code: body.code.trim() });
    const token = (verified.data as SignInData | undefined)?.token;
    if (typeof token !== 'string') {
      if (unreachable(verified.error)) return json(502, { error: { message: 'The identity service did not answer; try again.' } });
      challengeThrottle.fail(id, now);
      return json(401, { error: { message: challengeThrottle.blocked(id, now) ? 'Too many wrong codes; start again.' : 'That code did not work.' } });
    }
    usedChallenges.set(id, pending.expiresAt);
    challengeThrottle.clear(id);
    return finish(request, config, pending.tenantId, token, keyHash);
  }

  // First step: organization, email and password.
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password || email.length > 254 || password.length > 1024) return json(400, { error: { message: 'Enter your email and password.' } });
  const organization = typeof body.organization === 'string' ? body.organization.trim().toLowerCase() || undefined : undefined;
  const who = `${organization ?? ''}\n${email.toLowerCase()}`;
  if (signInThrottle.blocked(who, now)) return json(429, { error: { message: 'Too many attempts for this account; wait a few minutes.' } });
  const tenant = await resolveTenant(config, organization);
  if (typeof tenant !== 'string') {
    if (tenant.status === 401) signInThrottle.fail(who, now);
    return json(tenant.status, { error: { message: tenant.error } });
  }
  const signedIn = await callIam(config, 'auth/signIn', { tenantId: tenant, email, password });
  if (signedIn.error) {
    if (unreachable(signedIn.error)) return json(502, { error: { message: 'The identity service did not answer; try again.' } });
    signInThrottle.fail(who, now);
    // One message for wrong email, wrong password or unknown account: no account probing through the admin.
    return json(401, { error: { message: FAILED } });
  }
  signInThrottle.clear(who);
  const data = signedIn.data as SignInData | undefined;
  if (data?.mfaRequired && typeof data.challenge === 'string') {
    if (data.enrollmentRequired) return json(403, { error: { message: 'Your account must enroll a second factor first; do that in the console, then sign in here.' } });
    const challenge = seal({ tenantId: tenant, challenge: data.challenge, keyHash, expiresAt: now + 5 * 60_000 } satisfies Challenge, 'mfa');
    if (!challenge) return json(500, { error: { message: 'Sessions are not configured on this admin.' } });
    if (data.emailCodeAvailable) await callIam(config, 'auth/requestMfaCode', { tenantId: tenant, challenge: data.challenge });
    return json(200, { step: 'code', challenge, hint: data.emailCodeAvailable ? 'Enter the code from your authenticator, or the one just emailed to you.' : 'Enter the code from your authenticator.' });
  }
  if (typeof data?.token !== 'string') return json(502, { error: { message: 'The identity service did not return a session.' } });
  return finish(request, config, tenant, data.token, keyHash);
}

/**
 * Sign out: every session cookie in the request that opens (with or without this browser's key: ending a
 * session is always safe) is revoked here until it expires, and ended at better-iam.
 */
export async function DELETE(request: Request) {
  if (!guard(request)) return json(403, { error: { message: 'Only the admin panel itself may sign out here.' } });
  const config = upstreamConfig();
  let endedAtIdentity = true;
  for (const session of sessionsInRequest(request)) {
    revokeSession(session);
    if (!config) continue;
    const out = await callIam(config, 'auth/signOut', {}, session.token);
    if (out.error) endedAtIdentity = false;
  }
  return json(
    200,
    endedAtIdentity
      ? { ok: true }
      : { ok: true, warning: 'Signed out of the admin, but the identity service could not be reached to end the session there; it ends when it expires.' },
    clearedSessionCookies(secure(request)),
  );
}
