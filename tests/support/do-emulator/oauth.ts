import type { DoEmulator } from './index.js';

// DigitalOcean's OAuth token endpoint (`POST https://cloud.digitalocean.com/v1/oauth/token`, DigitalOcean P9): the
// authorization-code and refresh-token grants, with parameters in the query (as DO documents them). A refresh token
// is single use: every exchange answers a new one (rotation) and a new access token, which the paired API emulator
// then accepts. Invalid grants answer 401 `invalid_grant`. Requests are recorded without being parsed further.

export const oauthOrigin = 'https://cloud.digitalocean.com';

export class OAuthEmulator {
  /** Live refresh tokens. */
  readonly refreshTokens = new Set<string>(['refresh-0']);
  /** Authorization codes, single use, with the redirect URI they were issued for. */
  readonly codes = new Map<string, string>();
  requests: { url: URL; method: string }[] = [];
  /** Seconds an access token lives (DO: 30 days). */
  expiresIn = 2_592_000;
  clientId = 'client-1';
  clientSecret = 'client-secret-1';
  #n = 0;

  constructor(readonly api: DoEmulator) {}

  /** A fetch that sends the token endpoint here and everything else to the API emulator. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (url.origin !== oauthOrigin) return this.api.fetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ url, method });
    if (url.pathname !== '/v1/oauth/token' || method !== 'POST')
      return json(404, { error: 'not_found' });
    const q = url.searchParams;
    if (q.get('client_id') !== this.clientId || q.get('client_secret') !== this.clientSecret)
      return json(401, { error: 'invalid_client', error_description: 'bad client' });
    if (q.get('grant_type') === 'refresh_token') {
      const refresh = q.get('refresh_token') ?? '';
      if (!this.refreshTokens.delete(refresh))
        return json(401, {
          error: 'invalid_grant',
          error_description: 'The refresh token is invalid',
        });
      return this.#issue();
    }
    if (q.get('grant_type') === 'authorization_code') {
      const code = q.get('code') ?? '';
      const redirect = this.codes.get(code);
      if (redirect === undefined || redirect !== q.get('redirect_uri'))
        return json(401, { error: 'invalid_grant', error_description: 'bad code' });
      this.codes.delete(code);
      return this.#issue();
    }
    return json(400, { error: 'unsupported_grant_type' });
  };

  #issue(): Response {
    const n = ++this.#n;
    const access = `access-${n}`;
    const refresh = `refresh-${n}`;
    this.refreshTokens.add(refresh);
    this.api.validTokens.add(access);
    return json(200, {
      access_token: access,
      token_type: 'bearer',
      expires_in: this.expiresIn,
      refresh_token: refresh,
      scope: 'read write',
      info: { name: 'Sammy', email: 'sammy@example.com', uuid: 'acct-uuid-1' },
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
