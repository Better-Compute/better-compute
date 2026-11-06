import { manualClock, type ManualClock } from '@better-compute/core';
import type { CredentialSource } from '@better-compute/aws-core';
import { StsEmulator } from './sts.js';
import { ec2Error, jsonError, queryError } from './xml.js';

/** The platform (control plane) AWS account and its ambient keys. */
export const platformAccount = '111111111111';
export const platformKeys = {
  accessKeyId: 'AKIATESTKEY0000000001',
  secretAccessKey: 'testsecret-platform',
} as const;

// An in-process AWS emulator injected through `fetch` (AD17). Each service registers a handler
// for its hosts; the router checks the SigV4 shape and clock of every signed request, records it,
// and answers queued failures (`failNext`) before the handler runs.

export type Protocol = 'ec2' | 'query' | 'json' | 'rest' | 'plain';

export interface EmulatorRequest {
  service: string;
  operation: string;
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  /** Form parameters (ec2/query protocols). */
  params: URLSearchParams;
  /** The access key id the request was signed with, when signed. */
  accessKeyId?: string;
}

export interface ServiceHandler {
  service: string;
  protocol: Protocol;
  /** Operations that are sent unsigned (AssumeRoleWithWebIdentity, IMDS). */
  unsigned?: (operation: string, request: EmulatorRequest) => boolean;
  handle(request: EmulatorRequest): Response | Promise<Response>;
}

interface Failure {
  operation: string;
  code: string;
  status: number;
  times: number;
}

const authPattern =
  /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

function parseAmzDate(value: string | null): number | undefined {
  const match = value ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value) : null;
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

export class AwsEmulator {
  readonly clock: ManualClock;
  /** Every request that reached a handler (or a queued failure). */
  readonly requests: EmulatorRequest[] = [];
  /** Moves the emulator's own clock against the caller's (clock-skew tests). */
  skewMs = 0;
  /** Requests with no handler; tests assert this stays empty. */
  readonly unrouted: string[] = [];
  #routes: { host: RegExp; handler: ServiceHandler }[] = [];
  #failures: Failure[] = [];
  #before = new Map<string, (request: EmulatorRequest) => void | Promise<void>>();
  /** STS, with the platform identity registered. */
  readonly sts: StsEmulator;
  /** The control plane's ambient identity (account 111111111111). */
  readonly ambient: CredentialSource = {
    kind: 'ambient:test',
    credentials: async () => ({ ...platformKeys }),
  };

  constructor(options: { clock?: ManualClock } = {}) {
    this.clock = options.clock ?? manualClock(Date.UTC(2026, 9, 1));
    this.sts = new StsEmulator(this);
    this.sts.identities.set(platformKeys.accessKeyId, {
      secret: platformKeys.secretAccessKey,
      account: platformAccount,
      arn: `arn:aws:iam::${platformAccount}:role/bc-control-plane`,
    });
  }

  register(host: RegExp, handler: ServiceHandler): void {
    // A later registration wins, so a test can override a default service.
    this.#routes.unshift({ host, handler });
  }

  /** The next `times` calls of `operation` fail with `code`. */
  failNext(operation: string, code: string, status = 400, times = 1): void {
    this.#failures.push({ operation, code, status, times });
  }

  /** Runs `hook` before the handler of each `operation` call (race tests). */
  beforeAction(operation: string, hook: (request: EmulatorRequest) => void | Promise<void>): void {
    this.#before.set(operation, hook);
  }

  /** The emulator's view of now. */
  now(): number {
    return this.clock.now() + this.skewMs;
  }

  /** Requests for one operation. */
  calls(operation: string): EmulatorRequest[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const route = this.#routes.find(({ host }) => host.test(url.host));
    if (!route) {
      this.unrouted.push(`${request.method} ${url.host}${url.pathname}`);
      throw new TypeError(`fetch failed: no emulated host ${url.host}`);
    }
    const { handler } = route;
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const params = new URLSearchParams(
      handler.protocol === 'ec2' || handler.protocol === 'query'
        ? body || url.search.slice(1)
        : url.search.slice(1),
    );
    const operation =
      handler.protocol === 'ec2' || handler.protocol === 'query'
        ? (params.get('Action') ?? '')
        : handler.protocol === 'json'
          ? (request.headers.get('x-amz-target')?.split('.').pop() ?? '')
          : `${request.method} ${url.pathname}`;
    const emulated: EmulatorRequest = {
      service: handler.service,
      operation,
      method: request.method,
      url,
      headers: request.headers,
      body,
      params,
    };
    const error = (code: string, message: string, status: number) =>
      handler.protocol === 'json'
        ? jsonError(code, message, status)
        : handler.protocol === 'query'
          ? queryError(code, message, 'Sender', status)
          : ec2Error(code, message, status);

    if (!handler.unsigned?.(operation, emulated)) {
      const match = authPattern.exec(request.headers.get('authorization') ?? '');
      if (!match) return error('IncompleteSignature', 'malformed authorization', 403);
      const [, keyId, date, , service] = match;
      const signedAt = parseAmzDate(request.headers.get('x-amz-date'));
      if (signedAt === undefined || date !== request.headers.get('x-amz-date')!.slice(0, 8))
        return error('IncompleteSignature', 'malformed x-amz-date', 403);
      if (service !== handler.service) return error('SignatureDoesNotMatch', 'wrong service', 403);
      emulated.accessKeyId = keyId;
      if (Math.abs(signedAt - this.now()) > 15 * 60_000) {
        this.requests.push(emulated);
        const response = error('RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.', 400);
        response.headers.set('date', new Date(this.now()).toUTCString());
        return response;
      }
    }
    this.requests.push(emulated);
    const failure = this.#failures.find((entry) => entry.operation === operation);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.#failures.splice(this.#failures.indexOf(failure), 1);
      const response = error(failure.code, `emulated ${failure.code}`, failure.status);
      response.headers.set('date', new Date(this.now()).toUTCString());
      return response;
    }
    await this.#before.get(operation)?.(emulated);
    const response = await handler.handle(emulated);
    response.headers.set('date', new Date(this.now()).toUTCString());
    return response;
  };
}
