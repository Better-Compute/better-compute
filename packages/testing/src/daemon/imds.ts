import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { imdsSessionHeader, imdsSessionTtlHeader } from '@better-compute/pki';

// The metadata service a VPS host serves each instance (PLAN.md §12.2, §13; v0.5), IMDSv2-style:
//   PUT /latest/api/token   (x-bc-metadata-token-ttl-seconds: 1..21600) → a session token bound to
//                            the instance the request came from by an HMAC;
//   GET /latest/identity-token?audience=… (x-bc-metadata-token) → a workload-identity token, minted
//                            by the control plane for THAT instance only.
// The instance is known from where the request arrived (the instance's tap and link-local
// address), never from a request field; forwarded requests are refused, which blocks the usual SSRF
// relays. The host holds no signing key: `mint` asks the control plane (a WorkloadTokenRequest on
// the node's session), which checks the instance is placed on this node.

/** What the host asks the control plane for, and what comes back. */
export type ImdsMint = (request: {
  instanceId: string;
  audience?: string;
}) => Promise<{ token: string } | { error: string }>;

export interface FakeImdsOptions {
  mint: ImdsMint;
  now(): number;
  /** HMAC key for session tokens (default: random per host, so they die with it). */
  sessionKey?: Uint8Array;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/** One host's metadata service; `handle(request, instanceId)` answers a request from that instance. */
export class FakeImds {
  readonly #options: FakeImdsOptions;
  readonly #key: Buffer;

  constructor(options: FakeImdsOptions) {
    this.#options = options;
    this.#key = Buffer.from(options.sessionKey ?? randomBytes(32));
  }

  #mac(instanceId: string, expires: number): Buffer {
    return createHmac('sha256', this.#key).update(`bc-imds/v1\0${instanceId}\0${expires}`).digest();
  }

  /** Answers `request`, which arrived from `instanceId`'s own interface. */
  async handle(request: Request, instanceId: string): Promise<Response> {
    if (request.headers.has('x-forwarded-for') || request.headers.has('forwarded'))
      return text(403, 'Forwarded requests are refused');
    const url = new URL(request.url);
    if (url.pathname === '/latest/api/token') {
      if (request.method !== 'PUT') return text(405, 'Use PUT');
      const ttl = Number(request.headers.get(imdsSessionTtlHeader));
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 21_600)
        return text(400, `${imdsSessionTtlHeader} must be 1 to 21600`);
      const expires = Math.floor(this.#options.now() / 1000) + ttl;
      return text(200, `${expires}.${this.#mac(instanceId, expires).toString('base64url')}`);
    }
    if (url.pathname === '/latest/identity-token') {
      if (request.method !== 'GET') return text(405, 'Use GET');
      const [expiresText, tag] = (request.headers.get(imdsSessionHeader) ?? '').split('.');
      const expires = Number(expiresText);
      const expected = Number.isInteger(expires) ? this.#mac(instanceId, expires) : undefined;
      const given = Buffer.from(tag ?? '', 'base64url');
      const valid =
        expected !== undefined &&
        expires * 1000 > this.#options.now() &&
        given.length === expected.length &&
        timingSafeEqual(given, expected);
      if (!valid) return text(401, 'A valid metadata session token is required');
      const audience = url.searchParams.get('audience') ?? undefined;
      const minted = await this.#options.mint({
        instanceId,
        ...(audience !== undefined ? { audience } : {}),
      });
      if ('error' in minted)
        return text(minted.error === 'audience' ? 400 : 403, `Refused: ${minted.error}`);
      return text(200, minted.token);
    }
    return text(404, 'Not found');
  }
}
