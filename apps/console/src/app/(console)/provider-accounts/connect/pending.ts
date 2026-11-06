// The connect flow's browser-side state (P9): the anti-forgery state and the account to create, kept in this tab's
// session storage between leaving for DigitalOcean and the redirect back. Never a token: the code the redirect
// carries is traded by the compute server, which holds the OAuth app's secret.

export const pendingKey = 'bc.providerAccounts.connect';

export interface PendingConnect {
  state: string;
  provider: 'digitalocean';
  name: string;
  regions: string[];
  redirectUri: string;
  /** Epoch ms; a pending connect older than 15 minutes is dropped. */
  startedAt: number;
}

export const pendingTtlMs = 15 * 60_000;

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
