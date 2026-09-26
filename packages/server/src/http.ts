import { X509Certificate } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ComputeError, isComputeError, newId, type ComputeErrorBody } from '@better-compute/core';
import { spkiPin } from '@better-compute/pki';
import { serveDownload } from './downloads.js';
import type { Operations } from './operations.js';
import { forwardingHeaders } from './proxy.js';
import type { ResolvedOptions } from './options.js';
import type { RegisteredMethod, Registry } from './registry.js';
import {
  serverInfo,
  wellKnownJoinKeys,
  type WellKnownGateway,
  type WellKnownJoinKeys,
} from './version.js';

/** JSON request bodies above this are refused with `PAYLOAD_TOO_LARGE` (PLAN.md §9.1). */
export const maxBodyBytes = 65_536;

/** Headers every answer carries: never cached, never sniffed, never leaking the URL as a referrer. */
const hardened = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const segmentPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const notFound = () => new ComputeError('NOT_FOUND', 'Endpoint not found');
const tooLarge = () => new ComputeError('PAYLOAD_TOO_LARGE', 'Request body too large');

/** The caller's `X-Request-Id` when it is short and plain; otherwise a fresh one. */
function requestIdOf(headers: Headers): string {
  const value = headers.get('x-request-id');
  return value && requestIdPattern.test(value) ? value : newId('req');
}

/** W3C trace context, version 00; the all-zero trace and parent ids are invalid. */
const traceparentPattern = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The caller's `traceparent` when it is a valid W3C trace context; otherwise none (dropped). */
function traceparentOf(headers: Headers): string | undefined {
  const value = headers.get('traceparent')?.trim();
  return value && traceparentPattern.test(value) ? value : undefined;
}

/** Reads at most `limit` bytes of the body; more is `PAYLOAD_TOO_LARGE`. */
async function limitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(item.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The request body as a JSON object; an empty body is `{}`. */
async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      await limitedBody(request, maxBodyBytes),
    );
  } catch (error) {
    if (isComputeError(error)) throw error;
    throw new ComputeError('INVALID_INPUT', 'The body is not valid UTF-8');
  }
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ComputeError('INVALID_INPUT', 'The body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new ComputeError('INVALID_INPUT', 'The body must be a JSON object');
  return body as Record<string, unknown>;
}

/** Whether an error's code and message are safe to show; anything else is `INTERNAL_ERROR`. */
function presentable(error: unknown): error is ComputeError {
  return isComputeError(error) && error.code !== 'INTERNAL_ERROR';
}

/** `{ error: { code, message, retryAfterMs?, details? } }` with the error's status. */
function errorResponse(error: unknown): Response {
  let status = 500;
  let body: ComputeErrorBody = { code: 'INTERNAL_ERROR', message: 'Internal server error' };
  if (presentable(error)) {
    status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    body =
      typeof error.toBody === 'function'
        ? error.toBody()
        : { code: error.code, message: error.message };
  }
  const headers: Record<string, string> = { ...hardened };
  // Rate-limited callers learn when to come back (RFC 9110 Retry-After, in seconds).
  if (body.retryAfterMs !== undefined)
    headers['retry-after'] = String(Math.max(1, Math.ceil(body.retryAfterMs / 1000)));
  if (status === 405) headers.allow = 'GET, POST';
  return Response.json({ error: body }, { status, headers });
}

/**
 * What the host knows about a request that the request itself cannot prove: the peer's address, from
 * the socket (or, behind a proxy the host is configured to trust, the hop that proxy reported). It
 * becomes `Credential.sourceIp`, which remote IAM sees for `request.sourceIp` conditions.
 */
export interface HandlerInfo {
  peer?: { address?: string };
}

export interface HttpHost {
  options: ResolvedOptions;
  registry: Registry;
  operations: Operations;
}

/** How long a failed `pki.join.publicKeys()` is not retried (the well-known document omits `join`). */
const joinKeysRetryMs = 60_000;

/**
 * The fetch and Node transports (PLAN.md §9.1). `POST {basePath}/{group}/{method}` and
 * `POST {basePath}/plugins/{id}/{group}/{method}` take JSON objects with `X-Better-Compute: 1`;
 * `GET` serves only `/health`, `/.well-known/better-compute` and `/downloads/{bcd|bcx-ipmi}/{version}/{os}-{arch}`.
 */
export function createHttp({ options, registry, operations }: HttpHost) {
  const { basePath, database, log } = options;

  // The well-known `join` section (PLAN.md §6 Install): JoinService's public keys, read once; the
  // keys live as long as the process. A failing port is logged and retried a minute later.
  let joinKeys: Promise<WellKnownJoinKeys | undefined> | undefined;
  let joinRetryAt = 0;
  function wellKnownJoin(): Promise<WellKnownJoinKeys | undefined> {
    const join = options.join;
    if (typeof join?.publicKeys !== 'function') return Promise.resolve(undefined);
    if (!joinKeys && Date.now() >= joinRetryAt)
      joinKeys = (async () => wellKnownJoinKeys(await join.publicKeys!()))().catch(
        (error: unknown) => {
          joinKeys = undefined;
          joinRetryAt = Date.now() + joinKeysRetryMs;
          log.error('Reading the join public keys failed; the well-known document omits them', {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        },
      );
    return joinKeys ?? Promise.resolve(undefined);
  }

  // The well-known `gateway` section: the configured URL, plus the serving CA's SPKI pin read once
  // from its certificate (a failing CA is logged, the pin omitted and retried a minute later).
  let servingPin: Promise<string | undefined> | undefined;
  let servingRetryAt = 0;
  async function wellKnownGateway(): Promise<WellKnownGateway | undefined> {
    const gateway = options.wellKnownGateway;
    if (!gateway) return undefined;
    const ca = gateway.servingCa;
    if (ca && !servingPin && Date.now() >= servingRetryAt)
      servingPin = (async () => {
        const [certificate] = await ca.certificates();
        if (!certificate) throw new Error('the serving CA has no certificate');
        return spkiPin(new X509Certificate(certificate).publicKey);
      })().catch((error: unknown) => {
        servingPin = undefined;
        servingRetryAt = Date.now() + joinKeysRetryMs;
        log.error('Reading the serving CA failed; the well-known document omits its pin', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
    const pin = await servingPin;
    return {
      url: gateway.url,
      ...(gateway.serverName ? { serverName: gateway.serverName } : {}),
      ...(pin ? { servingCaPin: pin } : {}),
    };
  }

  /** A route below the base path; the registry's Map never answers for inherited names. */
  function route(path: string): RegisteredMethod | undefined {
    const parts = path.split('/');
    if (!parts.every((part) => segmentPattern.test(part))) return undefined;
    if (parts.length === 2 || (parts.length === 4 && parts[0] === 'plugins'))
      return registry.method(path);
    return undefined;
  }

  /** Unauthenticated operator endpoints. `/health` pings the store and reveals only up or down. */
  async function operational(path: string): Promise<Response> {
    if (path === 'health') {
      const started = Date.now();
      try {
        await database.query('SELECT 1');
        return Response.json(
          { status: 'ok', database: 'ok', latencyMs: Date.now() - started, time: started },
          { headers: hardened },
        );
      } catch {
        return Response.json(
          { status: 'unavailable', database: 'error', time: started },
          { status: 503, headers: hardened },
        );
      }
    }
    if (path === '.well-known/better-compute') {
      const [join, gateway] = await Promise.all([wellKnownJoin(), wellKnownGateway()]);
      return Response.json(
        { ...serverInfo(basePath), ...(join ? { join } : {}), ...(gateway ? { gateway } : {}) },
        { headers: hardened },
      );
    }
    if (path.startsWith('downloads/')) {
      const download = await serveDownload(options.downloads, path, hardened);
      if (download) return download;
    }
    throw notFound();
  }

  async function handler(request: Request, info?: HandlerInfo): Promise<Response> {
    const requestId = requestIdOf(request.headers);
    const answer = (response: Response) => {
      response.headers.set('x-request-id', requestId);
      return response;
    };
    let path = '(unknown)';
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${basePath}/`)) throw notFound();
      path = url.pathname.slice(basePath.length + 1);
      if (request.method === 'GET') return answer(await operational(path));
      if (request.method !== 'POST')
        throw new ComputeError(
          'METHOD_NOT_ALLOWED',
          'Use POST, or GET for /health and /.well-known/better-compute',
        );
      if (
        !request.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
        request.headers.get('x-better-compute') !== '1'
      )
        throw new ComputeError(
          'CSRF_REJECTED',
          'JSON and the X-Better-Compute: 1 header are required',
        );
      // An accepted IAM cookie counts only from this deployment's own origin; an unaccepted one is
      // dropped from the credential by the envelope.
      if (options.acceptIamCookie && request.headers.has('cookie')) {
        const origin = request.headers.get('origin');
        if (!origin) throw new ComputeError('CSRF_REJECTED', 'Cookie requests require Origin');
        if (origin !== options.origin)
          throw new ComputeError('UNTRUSTED_ORIGIN', 'Origin is not trusted');
      }
      const method = route(path);
      if (!method) throw notFound();
      const body = await jsonObject(request);
      // IAM sees the request id the caller sees.
      const headers = new Headers(request.headers);
      headers.set('x-request-id', requestId);
      const traceparent = traceparentOf(request.headers);
      // The caller's address as the host verified it: the peer, or behind a trusted proxy the hop it
      // reported (`trustedProxies`); never a forwarding header an untrusted peer sent.
      const peer = options.sourceAddress(info?.peer?.address, request.headers);
      // Client-sent forwarding headers never reach IAM (an embedded IAM that reads X-Forwarded-For
      // would take the client's word): only the verified address, as X-Forwarded-For.
      for (const name of forwardingHeaders) headers.delete(name);
      if (peer) headers.set('x-forwarded-for', peer);
      const data = await operations.call(method, { headers, ...(peer ? { sourceIp: peer } : {}) }, body, {
        requestId,
        signal: request.signal,
        ...(traceparent ? { traceparent } : {}),
      });
      return answer(Response.json({ data: data ?? null }, { headers: hardened }));
    } catch (error) {
      if (!presentable(error))
        log.error('Unhandled error in a compute request', {
          requestId,
          route: route(path)?.path ?? '(unknown)',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      return answer(errorResponse(error));
    }
  }

  async function send(res: ServerResponse, response: Response): Promise<void> {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  async function nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (['TRACE', 'CONNECT', 'TRACK'].includes(req.method ?? ''))
        throw new ComputeError('METHOD_NOT_ALLOWED', 'Method is not supported');
      let url: URL;
      try {
        url = new URL(req.url ?? '/', options.baseURL);
      } catch {
        throw new ComputeError('INVALID_INPUT', 'Invalid request target');
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > maxBodyBytes) {
            const response = errorResponse(tooLarge());
            response.headers.set('x-request-id', requestIdOf(headers));
            return await send(res, response);
          }
          chunks.push(buffer);
        }
        body = new Uint8Array(Buffer.concat(chunks));
      }
      // The socket peer; the handler resolves trusted proxies (`trustedProxies`) from it.
      const address = req.socket?.remoteAddress;
      await send(
        res,
        await handler(
          new Request(url, { method: req.method, headers, body }),
          address ? { peer: { address } } : undefined,
        ),
      );
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      await send(res, errorResponse(error));
    }
  }

  return { handler, nodeHandler };
}
