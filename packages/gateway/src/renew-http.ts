import type { IncomingMessage, ServerResponse } from 'node:http';
import { systemClock, type Clock } from '@better-compute/core';
import { parseCertificate, parseNodeSpiffeId } from '@better-compute/pki';
import { decodeMessage, encodeMessage, RenewRequestSchema, RenewResponseSchema } from '@better-compute/protocol';
import type { Gateway } from './gateway.js';
import { GrpcCode, GrpcError, toGrpcError } from './grpc.js';

// Certificate renewal over plain HTTP (PLAN.md §7.1): WS-mode daemons sit behind proxies that strip
// client certificates, so the mTLS gRPC Renew is out of reach. `POST /v1/renew` takes the RenewRequest
// bytes and answers RenewResponse bytes. No TLS client identity is used or needed: JoinService verifies
// the presented chain (node CA, revocation, current generation), the proof of possession by the
// current key (±60 s, replay cache) and that the chain's node is the certificate's. The node id read
// from the leaf here only keys the rate limit and is checked against JoinService's record again.

export const RENEW_PATH = '/v1/renew';

export interface RenewHttpOptions {
  /** Largest request body (default 64 KiB). */
  maxBytes?: number;
  /** Renewals admitted per node id per hour (default 6; a daemon renews at ~60% of 24 h). */
  perNodePerHour?: number;
  clock?: Clock;
}

const httpStatusOf = (code: number): number =>
  code === GrpcCode.UNAUTHENTICATED
    ? 401
    : code === GrpcCode.PERMISSION_DENIED
      ? 403
      : code === GrpcCode.RESOURCE_EXHAUSTED
        ? 429
        : code === GrpcCode.INVALID_ARGUMENT
          ? 400
          : code === GrpcCode.NOT_FOUND
            ? 404
            : code === GrpcCode.FAILED_PRECONDITION
              ? 409
              : 503;

function answerError(res: ServerResponse, error: GrpcError): void {
  const headers: Record<string, string> = {
    'content-length': '0',
    'grpc-status': String(error.code),
    'x-bc-reason': encodeURIComponent(error.message),
  };
  if (error.retryAfterMs !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
    headers['grpc-retry-pushback-ms'] = String(Math.round(error.retryAfterMs));
  }
  res.writeHead(httpStatusOf(error.code), headers).end();
}

/** The node the leaf certificate names (its SPIFFE SAN), or undefined for anything else. */
function leafNodeId(der: Uint8Array | undefined): string | undefined {
  if (!der?.byteLength) return undefined;
  try {
    const leaf = parseCertificate(der);
    return leaf.uriSans.length === 1 ? parseNodeSpiffeId(leaf.uriSans[0]!)?.nodeId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `POST /v1/renew` handler for the WS listener (`serveGatewayWs` routes to it; a host that attaches
 * the WS fallback to its own server calls it first). Returns false for other paths.
 */
export function gatewayRenewHandler(
  gateway: Gateway,
  options: RenewHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const clock = options.clock ?? systemClock;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const perHour = options.perNodePerHour ?? 6;
  const recent = new Map<string, number[]>();

  const admit = (nodeId: string): number | undefined => {
    const now = clock.now();
    const window = (recent.get(nodeId) ?? []).filter((at) => at > now - 3_600_000);
    if (window.length >= perHour) {
      recent.set(nodeId, window);
      return window[0]! + 3_600_000 - now;
    }
    window.push(now);
    recent.set(nodeId, window);
    // Bounded by the active nodes: drop keys whose window emptied.
    if (recent.size > 100_000)
      for (const [key, times] of recent) if (!times.some((at) => at > now - 3_600_000)) recent.delete(key);
    return undefined;
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== RENEW_PATH) return false;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-length': '0' }).end();
      return true;
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/x-protobuf')) {
      answerError(res, new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the body is RenewRequest bytes (application/x-protobuf)'));
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        refused = true;
        answerError(res, new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, `the request exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (refused) return;
      void (async () => {
        let request;
        try {
          request = decodeMessage(RenewRequestSchema, new Uint8Array(Buffer.concat(chunks)));
        } catch {
          return answerError(res, new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the body is not a RenewRequest'));
        }
        const nodeId = leafNodeId(request.chain[0]);
        if (!nodeId)
          return answerError(res, new GrpcError(GrpcCode.UNAUTHENTICATED, 'the chain names no node certificate'));
        const waitMs = admit(nodeId);
        if (waitMs !== undefined)
          return answerError(
            res,
            new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, `node ${nodeId} renewed too often; retry later`, waitMs),
          );
        try {
          // The peer is the chain's own node: JoinService checks it against its certificate record.
          const response = await gateway.renew(request, { nodeId });
          const body = Buffer.from(encodeMessage(RenewResponseSchema, response));
          res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': String(body.byteLength) }).end(body);
        } catch (error) {
          answerError(res, toGrpcError(error));
        }
      })();
    });
    return true;
  };
}
