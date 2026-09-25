import { createPrivateKey, type KeyObject } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { systemClock, type Clock } from '@better-compute/core';
import { createReplayCache, type ReplayCache, type RevocationSet } from '@better-compute/pki';
import { decodeAgentFrame, encodeServerFrame, MAX_FRAME_BYTES } from '@better-compute/protocol';
import { closeReason } from './frames.js';
import type { Gateway, SessionHandle } from './gateway.js';
import { frameMessage, GrpcCode, GrpcError, MessageDecoder, toGrpcError } from './grpc.js';
import { WsConnection, wsAcceptKey } from './websocket.js';
import { signGatewayProof, verifyAgentProof } from './ws-auth.js';
import { swapSecureContext, type TlsMaterial } from './tls-reload.js';

// The WebSocket fallback (PLAN.md §7.1, D4, v0.4): `wss://gw…/v1/session`, subprotocol
// `bc.agent.v1`, the same length-prefixed AgentFrame/ServerFrame messages as the gRPC Session, for
// networks whose TLS-inspecting proxy strips client certificates. Identity is proven in-band (see
// ws-auth.ts), and a WS session only ever receives signed commands and specs: whatever the proxy
// sees or does, it can delay or drop frames but cannot forge intent (P14).

export const WS_PATH = '/v1/session';
export const WS_SUBPROTOCOL = 'bc.agent.v1';

export interface GatewayWsOptions {
  /** Node-CA trust anchors (DER) for the daemons' proof chains. */
  roots: readonly Uint8Array[];
  /** `aud` values this gateway accepts in proofs, e.g. `gw.eu-1.compute.example`. */
  audiences: readonly string[];
  /** The serving key and its chain (DER, leaf first), used to sign the gateway proof. */
  serving: { key: KeyObject; chain: readonly Uint8Array[] };
  revocations?: RevocationSet;
  trustDomain?: string;
  jtiCache?: ReplayCache;
  clock?: Clock;
  /** WS ping period (default 20 000 ms). */
  pingIntervalMs?: number;
}

const httpStatus = (code: number) =>
  code === GrpcCode.UNAUTHENTICATED
    ? 401
    : code === GrpcCode.PERMISSION_DENIED
      ? 403
      : code === GrpcCode.RESOURCE_EXHAUSTED
        ? 429
        : code === GrpcCode.INVALID_ARGUMENT
          ? 400
          : 503;

function refuse(socket: Duplex, status: number, error: GrpcError): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Refused'}\r\n` +
      `connection: close\r\ncontent-length: 0\r\ngrpc-status: ${error.code}\r\n` +
      `x-bc-reason: ${encodeURIComponent(error.message)}\r\n\r\n`,
  );
}

/**
 * Handles WS upgrades on `server` (the host's HTTP(S) server behind the proxy-facing listener):
 * verifies the daemon's proof, admits the session through `gateway.open` (token bucket,
 * `maxStreams`, draining) and answers `101` with the gateway proof. Other upgrade paths are left
 * to other listeners.
 */
export function attachGatewayWs(
  server: Server,
  gateway: Gateway,
  options: GatewayWsOptions,
): (() => void) & {
  /** Signs later gateway proofs with a renewed serving key and chain (certificate rotation). */
  setServing(serving: GatewayWsOptions['serving']): void;
} {
  const clock = options.clock ?? systemClock;
  let serving = options.serving;
  const jtiCache = options.jtiCache ?? createReplayCache({ whenFull: 'refuse' });
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;

  const onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== WS_PATH) return; // not ours
    socket.on('error', () => {});
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((value) => value.trim());
    const key = req.headers['sec-websocket-key'];
    if (
      req.method !== 'GET' ||
      String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      !protocols.includes(WS_SUBPROTOCOL)
    )
      return refuse(socket, 400, new GrpcError(GrpcCode.INVALID_ARGUMENT, `a ${WS_SUBPROTOCOL} WebSocket upgrade is required`));
    const nonce = req.headers['x-bc-nonce'];
    const proof = req.headers['x-bc-proof'];
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce) || typeof proof !== 'string')
      return refuse(socket, 401, new GrpcError(GrpcCode.UNAUTHENTICATED, 'x-bc-nonce and x-bc-proof are required'));

    let identity;
    try {
      identity = verifyAgentProof(proof, {
        roots: options.roots,
        audiences: options.audiences,
        nonce,
        now: clock.now(),
        jtiCache,
        ...(options.revocations ? { revocations: options.revocations } : {}),
        ...(options.trustDomain ? { trustDomain: options.trustDomain } : {}),
      });
    } catch (error) {
      return refuse(socket, 401, toGrpcError(error));
    }

    let connection: WsConnection | undefined;
    let handle: SessionHandle;
    try {
      handle = gateway.open(
        {
          nodeId: identity.nodeId,
          siteId: identity.siteId,
          role: identity.role,
          serial: identity.serial,
          notAfter: identity.notAfter,
          ...(identity.tenantControlled ? { tenantControlled: true } : {}),
          signedOnly: true,
        },
        {
          send: (frame) => void connection?.send(frameMessage(encodeServerFrame(frame))),
          close: (error) => connection?.close(!error || error.code === GrpcCode.OK ? 1000 : 1008, closeReason(error)),
        },
      );
    } catch (error) {
      const status = toGrpcError(error);
      return refuse(socket, httpStatus(status.code), status);
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
        `sec-websocket-accept: ${wsAcceptKey(key)}\r\nsec-websocket-protocol: ${WS_SUBPROTOCOL}\r\n` +
        `x-bc-gateway-proof: ${signGatewayProof({
          key: serving.key,
          chain: serving.chain,
          gatewayId: gateway.id,
          nodeId: identity.nodeId,
          nonce,
          now: clock.now(),
        })}\r\n\r\n`,
    );
    const decoder = new MessageDecoder(MAX_FRAME_BYTES);
    const ping = setInterval(() => connection?.ping(), pingIntervalMs);
    ping.unref?.();
    connection = new WsConnection(socket, {
      role: 'server',
      onMessage(message) {
        try {
          for (const bytes of decoder.push(message)) void handle.receive(decodeAgentFrame(bytes));
        } catch (error) {
          connection?.close(1008, closeReason(toGrpcError(error)));
        }
      },
      onClose(info) {
        clearInterval(ping);
        void handle.end(`ws-closed ${info.code}`);
      },
    });
  };

  server.on('upgrade', onUpgrade);
  return Object.assign(() => void server.off('upgrade', onUpgrade), {
    setServing(next: GatewayWsOptions['serving']) {
      serving = next;
    },
  });
}

/** The serving key and chain for gateway proofs, from PEM material (a reloaded key pair). */
export function servingFromPem(material: { key: string | Buffer; cert: string | Buffer }): GatewayWsOptions['serving'] {
  const chain = [...String(material.cert).matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (match) => new Uint8Array(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64')),
  );
  if (!chain.length) throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the certificate PEM holds no certificate');
  return { key: createPrivateKey(material.key), chain };
}

export interface ServedGatewayWs {
  server: Server;
  port: number;
  close(): Promise<void>;
  /**
   * Hot-reloads the serving certificate for new connections (see `ServedGateway.setTls`) and, from
   * the same key and chain, the key that signs later in-band gateway proofs.
   */
  setTls(material: TlsMaterial): void;
}

/**
 * A listener just for the WS fallback: HTTPS with the serving cert (what the proxy re-signs), or
 * plain HTTP for tests (`insecure`). Plain HTTP requests get 404.
 */
export async function serveGatewayWs(
  gateway: Gateway,
  options: GatewayWsOptions & { port?: number; host?: string; tls?: ServerOptions; insecure?: boolean },
): Promise<ServedGatewayWs> {
  if (!options.tls && !options.insecure)
    throw new GrpcError(GrpcCode.FAILED_PRECONDITION, 'serveGatewayWs needs tls, or insecure for tests');
  const notFound = (_req: IncomingMessage, res: import('node:http').ServerResponse) => res.writeHead(404).end();
  const server: Server = options.tls ? createHttpsServer(options.tls, notFound) : createHttpServer(notFound);
  const detach = attachGatewayWs(server, gateway, options);
  const sockets = new Set<Duplex>();
  server.on('connection', (socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    setTls: (material) => {
      // The in-band gateway proof is signed with the serving key too: rotate both, the proof key
      // only once the TLS context took the pair (so a bad pair changes neither).
      const serving = material.key && material.cert ? servingFromPem({ key: material.key as string, cert: material.cert as string }) : undefined;
      swapSecureContext(server as { setSecureContext?(options: object): void }, options.tls, material);
      if (serving) detach.setServing(serving);
    },
    close: () =>
      new Promise<void>((resolve) => {
        detach();
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
