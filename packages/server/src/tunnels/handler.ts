import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isComputeError, type Credential, type SqlExecutor } from '@better-compute/core';
import {
  createReplayCache,
  verifyExecTicket,
  type ExecTicketClaims,
  type ExecTicketIssuer,
  type ReplayCache,
} from '@better-compute/pki';
import {
  decodeMessage,
  encodeMessage,
  TunnelFrameSchema,
  type TunnelFrame,
} from '@better-compute/protocol';
import { acceptWebSocket, isWebSocketUpgrade, rejectUpgrade } from './websocket.js';

// `GET {basePath}/tunnels/{ticket}` (PLAN.md §7.6, §9.1), mounted by the host on its HTTP server's
// `upgrade` event, like events' `handleWatch`. The caller speaks WebSocket; each binary message is
// one protobuf `TunnelFrame` (data on channel 0/1, resize, closed). The api checks the ticket
// (signature, audience, its own jti set), finds the node's gateway and relays through the
// host-supplied `TunnelRelay` (e.g. `gatewayControlClient(...).openTunnel`), so the server never
// imports the gateway. The gateway and the daemon verify the ticket again (P14). While the tunnel
// is open the caller's credential is re-checked every 60 s; IAM unreachable for 2 min, a refusal or
// 12 h end it.

/** A tunnel as the gateway relays it (`gatewayControlClient().openTunnel()` satisfies it). */
export interface RelayedTunnel {
  readonly frames: AsyncIterable<TunnelFrame>;
  /** False when the write buffer is full: wait for `drained()`. */
  send(frame: TunnelFrame): boolean;
  drained(): Promise<void>;
  close(): void;
}

export interface TunnelRelay {
  open(input: {
    ticket: string;
    nodeId: string;
    tunnelId: string;
    /** `node_sessions.gateway_id`: the gateway holding the node's session. */
    gatewayId: string;
  }): Promise<RelayedTunnel>;
}

export interface HandleTunnelOptions {
  /** The deployment's store (`node_sessions` lookup). */
  sql: SqlExecutor;
  /** The same issuer `tunnels.open` uses: its JWKS verifies the ticket. */
  issuer: ExecTicketIssuer;
  relay: TunnelRelay;
  /** The API base path (default `/api/compute`). */
  basePath?: string;
  /** When set, the ticket's `iss` must equal it. */
  issuerName?: string;
  /** This api's own jti set (default in-memory). */
  jtiCache?: ReplayCache;
  now?: () => number;
  /**
   * Re-checks the caller with the upgrade request's credential (its Authorization header or
   * cookie): false ends the tunnel, a throw counts as IAM unreachable.
   */
  authorize?(credential: Credential, claims: ExecTicketClaims): Promise<boolean>;
  reauthorizeMs?: number;
  iamOutageMs?: number;
  maxDurationMs?: number;
  /** Largest caller message (default 1 MiB). */
  maxMessageBytes?: number;
  /** Called when a tunnel ends, for audit. */
  onClose?(event: { tunnelId: string; nodeId: string; subject: string; reason: string }): void;
}

// One jti set per issuer in this process, whatever options object a host passes per request.
const jtiCaches = new WeakMap<ExecTicketIssuer, ReplayCache>();
function defaultJtiCache(issuer: ExecTicketIssuer): ReplayCache {
  let cache = jtiCaches.get(issuer);
  if (!cache) jtiCaches.set(issuer, (cache = createReplayCache()));
  return cache;
}

/** The unverified claims: enough to know which node the ticket is for. */
function peek(ticket: string): { aud?: unknown } | undefined {
  try {
    const body = ticket.split('.')[1];
    return body
      ? (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { aud?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handles one `upgrade` request. Returns false when the path is not a tunnel path (the host passes
 * the request on), true when it answered it (tunnel opened or refused).
 */
export async function handleTunnel(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: HandleTunnelOptions,
): Promise<boolean> {
  const basePath = (options.basePath ?? '/api/compute').replace(/\/+$/, '');
  const url = new URL(req.url ?? '/', 'http://tunnel.local');
  const prefix = `${basePath}/tunnels/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const ticket = decodeURIComponent(url.pathname.slice(prefix.length));
  const refuse = (status: number, code: string, message: string) => {
    rejectUpgrade(socket, status, { error: { code, message } });
    return true;
  };
  if (!isWebSocketUpgrade(req))
    return refuse(426, 'METHOD_NOT_ALLOWED', 'Open tunnels with a WebSocket upgrade');
  const now = options.now ?? Date.now;
  const aud = peek(ticket)?.aud;
  if (typeof aud !== 'string' || !aud.startsWith('node:'))
    return refuse(403, 'ACCESS_DENIED', 'Exec ticket rejected');
  const nodeId = aud.slice('node:'.length);
  let claims: ExecTicketClaims;
  try {
    claims = verifyExecTicket(ticket, {
      jwks: options.issuer.jwksJson(),
      nodeId,
      now: now(),
      jtiCache: options.jtiCache ?? defaultJtiCache(options.issuer),
      ...(options.issuerName ? { issuer: options.issuerName } : {}),
    });
  } catch {
    return refuse(403, 'ACCESS_DENIED', 'Exec ticket rejected');
  }
  const { rows } = await options.sql.query<{ gateway_id: string | null }>(
    'SELECT gateway_id FROM node_sessions WHERE node_id = $1',
    [nodeId],
  );
  const gatewayId = rows[0]?.gateway_id;
  if (!gatewayId) return refuse(409, 'INVALID_STATE', 'The node is not connected');
  let tunnel: RelayedTunnel;
  try {
    tunnel = await options.relay.open({ ticket, nodeId, tunnelId: claims.sid, gatewayId });
  } catch (error) {
    const code = isComputeError(error) ? error.code : 'INTERNAL_ERROR';
    return refuse(
      502,
      code,
      isComputeError(error) ? error.message : 'The gateway refused the tunnel',
    );
  }

  const ws = acceptWebSocket(req, socket, head, {
    ...(options.maxMessageBytes ? { maxMessageBytes: options.maxMessageBytes } : {}),
  });
  const credential: Credential = {
    headers: Object.fromEntries(
      (['authorization', 'cookie'] as const)
        .filter((name) => typeof req.headers[name] === 'string')
        .map((name) => [name, req.headers[name] as string]),
    ),
  };
  let ended = false;
  const timers: NodeJS.Timeout[] = [];
  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    for (const timer of timers) clearInterval(timer);
    tunnel.close();
    if (!ws.closed) ws.close(code, reason);
    options.onClose?.({ tunnelId: claims.sid, nodeId, subject: claims.sub, reason });
  };

  // Node → caller, with backpressure from the caller's socket.
  void (async () => {
    try {
      for await (const frame of tunnel.frames) {
        if (ended) break;
        if (!ws.sendBinary(encodeMessage(TunnelFrameSchema, frame)))
          await new Promise<void>((resolve) => ws.onDrain(resolve));
      }
      end(1000, 'closed');
    } catch {
      end(1011, 'relay-error');
    }
  })();

  // Caller → node: every binary message is one TunnelFrame of this tunnel.
  ws.onMessage((data, binary) => {
    if (ended) return;
    if (!binary) return end(1003, 'binary TunnelFrames only');
    let frame: TunnelFrame;
    try {
      frame = decodeMessage(TunnelFrameSchema, data);
    } catch {
      return end(1007, 'not a TunnelFrame');
    }
    frame.tunnelId = claims.sid;
    if (!tunnel.send(frame)) {
      ws.pause();
      void tunnel.drained().then(() => ws.resume());
    }
  });
  ws.onClose(() => end(1000, 'caller-closed'));

  // Lifetime and re-authorization (§7.6).
  const maxDuration = options.maxDurationMs ?? 12 * 3_600_000;
  timers.push(
    setTimeout(() => end(1008, 'max-duration'), maxDuration) as unknown as NodeJS.Timeout,
  );
  if (options.authorize) {
    const every = options.reauthorizeMs ?? 60_000;
    const outage = options.iamOutageMs ?? 120_000;
    let lastOk = now();
    let checking = false;
    timers.push(
      setInterval(() => {
        if (checking || ended) return;
        checking = true;
        options.authorize!(credential, claims)
          .then((allowed) => {
            if (allowed) lastOk = now();
            else end(1008, 'revoked');
          })
          .catch(() => {
            if (now() - lastOk >= outage) end(1011, 'iam-unreachable');
          })
          .finally(() => {
            checking = false;
          });
      }, every),
    );
  }
  return true;
}
