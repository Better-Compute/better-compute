// The connect flow's browser-side state (P9): the anti-forgery state and the account to create, kept in this tab's
// session storage between leaving for DigitalOcean and the redirect back. Never a token: the code the redirect
// carries is traded by the compute server, which holds the OAuth app's secret.

export const pendingKey = 'bc.providerAccounts.connect';

export interface PendingConnect {
  state: string;
  /** The tenant the flow was started for: the account is connected to it, whatever tenant is selected on return. */
  tenantId: string;
  provider: 'digitalocean';
  name: string;
  regions: string[];
  redirectUri: string;
  /** Epoch ms; a pending connect older than 15 minutes is dropped. */
  startedAt: number;
}

export const pendingTtlMs = 15 * 60_000;

/** `providerAccounts.connect`'s input for a redirect back. */
export interface ConnectRequest {
  tenantId: string;
  provider: 'digitalocean';
  name: string;
  code: string;
  redirectUri: string;
  config: { regions: string[] };
  idempotencyKey: string;
}

/**
 * The connect request of the redirect back (its query `params`) for the flow this tab started (`pending`), or why
 * there is none: the state must be the one this tab sent, the flow at most 15 minutes old, and the account goes to
 * the tenant the flow was started for (another tab may have switched the console's tenant since).
 */
export function connectRequestOf(
  pending: PendingConnect | undefined,
  params: URLSearchParams,
  now: number,
): { request: ConnectRequest } | { error: string } {
  if (params.get('error')) return { error: `DigitalOcean answered ${params.get('error')}` };
  const code = params.get('code');
  const state = params.get('state');
  if (!pending || !state || state !== pending.state)
    return { error: 'This sign-in was not started from this tab: start again' };
  if (typeof pending.tenantId !== 'string' || !pending.tenantId)
    return { error: 'This sign-in does not say which tenant it was for: start again' };
  if (now - pending.startedAt > pendingTtlMs) return { error: 'The sign-in expired: start again' };
  if (!code) return { error: 'DigitalOcean sent no authorization code' };
  return {
    request: {
      tenantId: pending.tenantId,
      provider: pending.provider,
      name: pending.name,
      code,
      redirectUri: pending.redirectUri,
      config: { regions: pending.regions },
      idempotencyKey: `connect:${state.slice(0, 120)}`,
    },
  };
}

/** 32 random bytes, base64url (43 characters): the state DigitalOcean echoes back. */
export function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The redirect URI the platform registers for its DigitalOcean OAuth app (the host's `oauth.redirectUris`). */
export function callbackUri(origin: string): string {
  return `${origin}/provider-accounts/connect/callback`;
}
