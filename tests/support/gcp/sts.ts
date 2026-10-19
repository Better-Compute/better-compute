import { systemClock, type Clock } from '@better-compute/core';
import { staticJwks, verifyJwt } from '@better-compute/pki';

// An in-memory Google Security Token Service for workload identity federation: it answers
// `https://sts.googleapis.com/v1/token` only (anything else is a 404), verifies the third-party
// subject token the way a workload identity pool provider does (signature against the issuer's
// JWKS, `iss`, the provider audience, `exp`), applies the provider's attribute condition, and hands
// out an access token. A refusal is the OAuth-style body STS really sends, not a google.rpc.Status.

export interface FakeStsOptions {
  /** The issuer's published JWKS (fetched per exchange, so a rollover is visible). */
  jwks: () => Promise<unknown>;
  /** The `iss` a subject token must carry. */
  issuer: string;
  /** The provider's resource name, `//iam.googleapis.com/projects/.../providers/<id>`. */
  audience: string;
  /** The provider's attribute condition, over the subject. */
  condition: (sub: string) => boolean;
  /** The access token to hand out for an accepted subject. */
  grant: (sub: string) => string;
  /** The clock `exp` is checked on (default: the system clock). */
  clock?: Clock;
}

const tokenExchange = 'urn:ietf:params:oauth:grant-type:token-exchange';
const jwtType = 'urn:ietf:params:oauth:token-type:jwt';
const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token';
const skewMs = 60_000;
const maxLifetimeSeconds = 86_400;
const resourcePrefix = '//iam.googleapis.com/';

export class FakeSts {
  /** One entry per exchange that reached the token endpoint; `sub` is set once the token verified. */
  readonly exchanges: { sub?: string; accepted: boolean }[] = [];
  /** True: every request is answered 503. */
  down = false;
  /**
   * Scripted replies, one per POST to the token endpoint, in order: an entry is answered as given
   * (and is not recorded in `exchanges`); `undefined` lets that exchange run normally.
   */
  scripted: ({ status: number; body: unknown } | undefined)[] = [];
  readonly fetch: typeof fetch;

  readonly #options: FakeStsOptions;

  constructor(options: FakeStsOptions) {
    this.#options = options;
    this.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== 'https://sts.googleapis.com' || url.pathname !== '/v1/token')
        return json(404, { error: 'not_found', error_description: `No route for ${url.origin}` });
      if (this.down)
        return json(503, {
          error: 'unavailable',
          error_description: 'The service is unavailable.',
        });
      if ((init?.method ?? 'GET') !== 'POST')
        return json(405, { error: 'invalid_request', error_description: 'POST only.' });
      if (this.scripted.length > 0) {
        const reply = this.scripted.shift();
        if (reply) return json(reply.status, reply.body);
      }
      return this.#exchange(new URLSearchParams(String(init?.body ?? '')));
    };
  }

  async #exchange(form: URLSearchParams): Promise<Response> {
    const refuse = (sub: string | undefined, error: string, description: string): Response => {
      this.exchanges.push(sub === undefined ? { accepted: false } : { sub, accepted: false });
      return json(400, { error, error_description: description });
    };
    if (form.get('grant_type') !== tokenExchange)
      return refuse(undefined, 'unsupported_grant_type', 'Unsupported grant type.');
    if (form.get('subject_token_type') !== jwtType)
      return refuse(undefined, 'invalid_request', 'Unsupported subject token type.');
    if (form.get('audience') !== this.#options.audience)
      return refuse(undefined, 'invalid_target', 'The audience is not this provider.');
    if (!form.get('scope')) return refuse(undefined, 'invalid_request', 'The scope is required.');
    if (form.get('requested_token_type') !== accessTokenType)
      return refuse(undefined, 'invalid_request', 'Unsupported requested token type.');
    const rejected = 'The given credential is rejected by the attribute condition.';
    let claims: Record<string, unknown>;
    try {
      claims = await verifyJwt(
        form.get('subject_token') ?? '',
        staticJwks(await this.#options.jwks()),
      );
    } catch {
      return refuse(undefined, 'invalid_grant', 'The subject token could not be verified.');
    }
    const expected = `https://iam.googleapis.com/${this.#options.audience.slice(resourcePrefix.length)}`;
    const now = (this.#options.clock ?? systemClock).now();
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    if (claims.iss !== this.#options.issuer)
      return refuse(undefined, 'invalid_grant', 'The token issuer is not trusted.');
    if (claims.aud !== expected)
      return refuse(undefined, 'invalid_grant', 'The token audience does not match.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now)
      return refuse(undefined, 'invalid_grant', 'The token has expired.');
    // Google refuses a token issued in the future (a minute of skew allowed), one not yet valid, and
    // one that lives longer than a day.
    if (typeof claims.iat !== 'number' || claims.iat * 1000 > now + skewMs)
      return refuse(
        undefined,
        'invalid_grant',
        'The token was issued in the future or has no iat.',
      );
    if (
      claims.nbf !== undefined &&
      (typeof claims.nbf !== 'number' || claims.nbf * 1000 > now + skewMs)
    )
      return refuse(undefined, 'invalid_grant', 'The token is not valid yet.');
    if (claims.exp - claims.iat > maxLifetimeSeconds)
      return refuse(undefined, 'invalid_grant', 'The token lives longer than 24 hours.');
    if (sub === undefined || !this.#options.condition(sub))
      return refuse(sub, 'invalid_grant', rejected);
    this.exchanges.push({ sub, accepted: true });
    return json(200, {
      access_token: this.#options.grant(sub),
      issued_token_type: accessTokenType,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
