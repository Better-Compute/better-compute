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
// imports the gateway. The gateway and the daemon verify the ticket again (P14).
// While the tunnel is open the caller is re-authorized every 60 s by identity (the ticket's `sub`,
// `ses`, `tnt`, `inst`: browsers cannot send headers on a WebSocket); a refusal, IAM unreachable
// for 2 min or 12 h end it. `handleTunnel` never rejects: every failure is answered on the socket.

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

export interface TunnelReauthorization {
  /** The verified ticket: `sub` (identity), `ses` (IAM session), `tnt`, `inst`, `op`, `aud`. */
  claims: ExecTicketClaims;
  /** The upgrade request's Authorization/cookie, when the client could send them. */
  credential?: Credential;
}

export interface HandleTunnelOptions {
  /** The deployment's store (`node_sessions` lookup). */
  sql: SqlExecutor;
  /** The same issuer `tunnels.open` uses: its JWKS verifies the ticket. */
  issuer: ExecTicketIssuer;
  relay: TunnelRelay;
  /**
   * Re-checks the caller every `reauthorizeMs` (§7.6): the identity and session in the ticket are
   * still live and still allowed `compute:instances:exec` (or `nodes:console`) on the target. False
   * ends the tunnel; a throw or a hang past `authorizeTimeoutMs` counts as IAM unreachable.
   */
  authorize(input: TunnelReauthorization): Promise<boolean>;
  /** The API base path (default `/api/compute`). */
  basePath?: string;
  /** When set, the ticket's `iss` must equal it. */
  issuerName?: string;
  /** This api's own jti set (default: one per issuer in this process). */
  jtiCache?: ReplayCache;
  now?: () => number;
  reauthorizeMs?: number;
  /** One re-authorization may take this long (default 10 s). */
  authorizeTimeoutMs?: number;
  iamOutageMs?: number;
  maxDurationMs?: number;
  /** Largest caller message (default 1 MiB). */
  maxMessageBytes?: number;
  /** WebSocket keepalive: a ping this often, closed when nothing arrives for two periods (default 30 s). */
  pingIntervalMs?: number;
  /** Called when a tunnel ends, for audit. */
  onClose?(event: { tunnelId: string; nodeId: string; subject: string; reason: string }): void;
}

// One jti set per issuer in this process, whatever options object a host passes per request.
const jtiCaches = new WeakMap<ExecTicketIssuer, ReplayCache>();
function defaultJtiCache(issuer: ExecTicketIssuer): ReplayCache {
  let cache = jtiCaches.get(issuer);
  // Single-use tickets fail closed when the set is full, never evicting a live jti.
  if (!cache) jtiCaches.set(issuer, (cache = createReplayCache({ whenFull: 'refuse' })));
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

function pathOf(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://tunnel.local').pathname;
  } catch {
    return undefined;
  }
}

/**
 * Handles one `upgrade` request. Returns false when the path is not a tunnel path (the host passes
 * the request on), true when it answered it (tunnel opened or refused). Never rejects.
 */
export async function handleTunnel(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: HandleTunnelOptions,
): Promise<boolean> {
  const basePath = (options.basePath ?? '/api/compute').replace(/\/+$/, '');
  const prefix = `${basePath}/tunnels/`;
  const path = pathOf(req);
  if (path === undefined || !path.startsWith(prefix)) return false;
  // Node drops the server's socket error listener before 'upgrade': a client reset must not crash.
  socket.on('error', () => undefined);
  let tunnel: RelayedTunnel | undefined;
  try {
    return await open(req, socket, head, options, path.slice(prefix.length), (relayed) => {
      tunnel = relayed;
    });
  } catch {
    tunnel?.close();
    if (!socket.destroyed)
      rejectUpgrade(socket, 500, { error: { code: 'INTERNAL_ERROR', message: 'Tunnel failed' } });
    return true;
  }
}

async function open(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: HandleTunnelOptions,
  encoded: string,
  opened: (tunnel: RelayedTunnel) => void,
): Promise<boolean> {
  const refuse = (status: number, code: string, message: string) => {
    if (!socket.destroyed) rejectUpgrade(socket, status, { error: { code, message } });
    return true;
  };
  if (!isWebSocketUpgrade(req))
    return refuse(426, 'METHOD_NOT_ALLOWED', 'Open tunnels with a WebSocket upgrade (version 13)');
  let ticket: string;
  try {
    ticket = decodeURIComponent(encoded);
  } catch {
    return refuse(400, 'INVALID_INPUT', 'Malformed ticket');
  }
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
  if (socket.destroyed) return true;
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
  opened(tunnel);
  // The caller may have gone while the gateway opened the tunnel: nothing to relay to.
  if (socket.destroyed || !socket.readable || !socket.writable) {
    tunnel.close();
    return true;
  }

  const ws = acceptWebSocket(req, socket, head, {
    ...(options.maxMessageBytes ? { maxMessageBytes: options.maxMessageBytes } : {}),
    ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
  });
  const headers = Object.fromEntries(
    (['authorization', 'cookie'] as const)
      .filter((name) => typeof req.headers[name] === 'string')
      .map((name) => [name, req.headers[name] as string]),
  );
  const reauthorization: TunnelReauthorization = {
    claims,
    ...(Object.keys(headers).length ? { credential: { headers } } : {}),
  };
  let ended = false;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let nextCheck: ReturnType<typeof setTimeout> | undefined;
  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(lifetime);
    clearTimeout(nextCheck);
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
  ws.onClose((_code, reason) => end(1000, reason || 'caller-closed'));

  // Lifetime and re-authorization (§7.6).
  lifetime = setTimeout(() => end(1008, 'max-duration'), options.maxDurationMs ?? 12 * 3_600_000);
  const every = options.reauthorizeMs ?? 60_000;
  const outage = options.iamOutageMs ?? 120_000;
  const timeout = options.authorizeTimeoutMs ?? 10_000;
  let lastOk = now();
  let checking = false;
  const tick = () => {
    if (ended) return;
    // The outage rule holds even while a check hangs.
    if (now() - lastOk >= outage) return end(1011, 'iam-unreachable');
    if (!checking) {
      checking = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('authorize timed out')), timeout);
      });
      Promise.race([options.authorize(reauthorization), deadline])
        .then((allowed) => {
          if (allowed === true) lastOk = now();
          else end(1008, 'revoked');
        })
        .catch(() => {
          if (now() - lastOk >= outage) end(1011, 'iam-unreachable');
        })
        .finally(() => {
          clearTimeout(timer);
          checking = false;
        });
    }
    nextCheck = setTimeout(tick, every);
  };
  nextCheck = setTimeout(tick, every);
  return true;
}
