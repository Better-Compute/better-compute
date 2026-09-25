import type { JsonWebKey } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { ComputeError, isComputeError, type Clock, type Logger } from '@better-compute/core';
import { createReplayCache, verifyExecTicket, type ExecTicketClaims, type ReplayCache } from '@better-compute/pki';
import { TunnelFrameSchema, type TunnelFrame } from '@better-compute/protocol';
import { GrpcCode, GrpcError } from './grpc.js';

// Tunnels (PLAN.md §7.6, §13 "Interactive access", v0.3). The api authorizes the caller and issues
// a 60 s single-use exec ticket for one node; the owning gateway verifies it (signature, audience,
// its own jti set), asks the node over its Session (`OpenTunnel`), and the daemon — after verifying
// the ticket again against its pinned JWKS and jti set — opens a `Tunnel` stream on the same
// connection. The gateway only relays frames: it cannot open a tunnel without a valid ticket, and
// the node would refuse one anyway.

/** One side of a tunnel as its transport presents it. */
export interface TunnelEndpoint {
  /** Queues a frame; false when the write buffer is full (resume after `onDrain`). */
  send(frame: TunnelFrame): boolean;
  /** Called once when the buffer has room again. */
  onDrain(callback: () => void): void;
  /** Stops and restarts reading from this side (backpressure towards the other side). */
  pause(): void;
  resume(): void;
  /** Ends this side; `error` is the status its transport reports. */
  close(error?: GrpcError): void;
}

/** What a caller learns about an open tunnel. */
export interface TunnelInfo {
  id: string;
  nodeId: string;
  /** The ticket's `sub`: the better-iam identity that asked. */
  subject: string;
  op: ExecTicketClaims['op'];
  tenantId?: string;
  instanceId?: string;
  /**
   * The ticket's `ses` and `act`: the caller's IAM session and the action `tunnels.open` decided, so
   * `reauthorize` can check the session is still live and re-decide the same action (§7.6). A
   * re-authorizer should refuse a tunnel without a session id (fail closed).
   */
  sessionId?: string;
  action?: string;
  /** The ticket's `agt`: the agent acting for `subject` in a delegated session. */
  agentId?: string;
  /** The ticket's `dlg`: that delegation, so revoking it closes exactly its tunnels. */
  delegationId?: string;
  openedAt: number;
}

/**
 * Which tunnels `closeWhere`/`reauthorizeWhere` act on: every given field must match. Remote callers
 * must narrow (see `narrowsTunnels`).
 */
export interface TunnelFilter {
  tunnelId?: string;
  nodeId?: string;
  subject?: string;
  agentId?: string;
  delegationId?: string;
  /** The ticket's tenant. Alone it does not narrow: pair it with `anyAgent` or another key. */
  tenantId?: string;
  /** Only tunnels an agent opened (the ticket has `agt`), e.g. `agent:suspend-all` with `tenantId`. */
  anyAgent?: true;
}

/**
 * Whether a filter names something narrower than "every tunnel" or "every tunnel of a tenant": one
 * of the id keys, or `tenantId` with `anyAgent`. The control API refuses filters that do not.
 */
export function narrowsTunnels(filter: TunnelFilter): boolean {
  return (
    filter.tunnelId !== undefined ||
    filter.nodeId !== undefined ||
    filter.subject !== undefined ||
    filter.agentId !== undefined ||
    filter.delegationId !== undefined ||
    (filter.tenantId !== undefined && filter.anyAgent === true)
  );
}

function matches(info: TunnelInfo, filter: TunnelFilter): boolean {
  return (
    (filter.tunnelId === undefined || info.id === filter.tunnelId) &&
    (filter.nodeId === undefined || info.nodeId === filter.nodeId) &&
    (filter.subject === undefined || info.subject === filter.subject) &&
    (filter.agentId === undefined || info.agentId === filter.agentId) &&
    (filter.delegationId === undefined || info.delegationId === filter.delegationId) &&
    (filter.tenantId === undefined || info.tenantId === filter.tenantId) &&
    (filter.anyAgent !== true || info.agentId !== undefined)
  );
}

export interface TunnelOptions {
  /** The JWKS the api signs tickets with (`ExecTicketIssuer.jwksJson()`); read on every open. */
  jwks: () => string | { keys: JsonWebKey[] };
  /** When set, the ticket's `iss` must equal it. */
  issuer?: string;
  /** Default: an in-memory cache that fails closed when full. A ticket opens one tunnel, ever. */
  jtiCache?: ReplayCache;
  /**
   * Re-checks the caller's authorization every `reauthorizeMs` (default 60 s): false closes the
   * tunnel; a throw counts as IAM unreachable, and after `iamOutageMs` (2 min) of that it closes.
   */
  reauthorize?: (tunnel: TunnelInfo) => Promise<boolean>;
  reauthorizeMs?: number;
  iamOutageMs?: number;
  /** Hard maximum lifetime (default 12 h). */
  maxDurationMs?: number;
  /** How long the node has to open its Tunnel stream (default 10 s). */
  openTimeoutMs?: number;
}

/** The caller half: frames from the caller go to the node through `receive`. */
export interface TunnelHandle {
  readonly info: TunnelInfo;
  receive(frame: TunnelFrame): void;
  end(reason?: string): void;
}

/** The node half, returned for a daemon's `Tunnel` stream. */
export interface TunnelStreamHandle {
  receive(frame: TunnelFrame): void;
  end(reason?: string): void;
}

interface Tunnel {
  info: TunnelInfo;
  caller: TunnelEndpoint;
  node?: TunnelEndpoint;
  state: 'opening' | 'open' | 'closed';
  lastAuthOkMs: number;
  nextAuthMs: number;
  authorizing: boolean;
  /** The caller sent `closed`; waiting for the node's exit status. */
  callerClosed?: boolean;
  opened?: (node: TunnelEndpoint) => void;
  failed?: (error: unknown) => void;
  reason?: string;
}

export interface TunnelRegistryDeps {
  clock: Clock;
  log: Logger;
  options: TunnelOptions | undefined;
  /** Sends `OpenTunnel` on the node's live session; false when the node has none here. */
  sendOpen(nodeId: string, tunnelId: string, ticket: string): boolean;
}

const closedFrame = (tunnelId: string, reason: string, exitCode = -1): TunnelFrame =>
  create(TunnelFrameSchema, { tunnelId, body: { case: 'closed', value: { exitCode, reason } } });

export function createTunnelRegistry(deps: TunnelRegistryDeps) {
  const { clock, log } = deps;
  const options = deps.options;
  const jti = options?.jtiCache ?? createReplayCache({ whenFull: 'refuse' });
  const reauthorizeMs = options?.reauthorizeMs ?? 60_000;
  const iamOutageMs = options?.iamOutageMs ?? 120_000;
  const maxDurationMs = options?.maxDurationMs ?? 12 * 3_600_000;
  const openTimeoutMs = options?.openTimeoutMs ?? 10_000;
  /** After the caller hangs up, how long the node has to report its exit status. */
  const closeGraceMs = 5_000;
  const tunnels = new Map<string, Tunnel>();

  function close(tunnel: Tunnel, reason: string, error?: GrpcError): void {
    if (tunnel.state === 'closed') return;
    const wasOpening = tunnel.state === 'opening';
    tunnel.state = 'closed';
    tunnel.reason = reason;
    tunnels.delete(tunnel.info.id);
    if (wasOpening) tunnel.failed?.(error ?? new GrpcError(GrpcCode.UNAVAILABLE, reason));
    for (const side of [tunnel.caller, tunnel.node])
      if (side) {
        try {
          side.send(closedFrame(tunnel.info.id, reason));
          side.close(error);
        } catch {
          // A side that is already gone.
        }
      }
    log.info('gateway: tunnel closed', { tunnelId: tunnel.info.id, nodeId: tunnel.info.nodeId, reason });
  }

  /**
   * One re-authorization of an open tunnel: false closes it; a throw counts as IAM unreachable and
   * closes it after `iamOutageMs` without a success. Returns whether it closed the tunnel.
   */
  async function authorize(tunnel: Tunnel, now: number): Promise<boolean> {
    tunnel.authorizing = true;
    tunnel.nextAuthMs = now + reauthorizeMs;
    try {
      if (await options!.reauthorize!(tunnel.info)) {
        tunnel.lastAuthOkMs = Math.max(tunnel.lastAuthOkMs, now);
        return false;
      }
      close(tunnel, 'unauthorized', new GrpcError(GrpcCode.PERMISSION_DENIED, 'access revoked'));
      return true;
    } catch (error) {
      log.warn('gateway: tunnel re-authorization failed', { tunnelId: tunnel.info.id, cause: String(error) });
      if (now - tunnel.lastAuthOkMs > iamOutageMs) {
        close(tunnel, 'iam-unreachable');
        return true;
      }
      return false;
    } finally {
      tunnel.authorizing = false;
    }
  }

  /** Forwards `frame` to `to`; pauses `from` while `to` is full. */
  function relay(tunnel: Tunnel, from: TunnelEndpoint, to: TunnelEndpoint | undefined, frame: TunnelFrame) {
    if (tunnel.state !== 'open' || !to) return;
    if (frame.body.case === 'closed') {
      to.send(create(TunnelFrameSchema, { ...frame, tunnelId: tunnel.info.id }));
      if (from === tunnel.caller) {
        // The caller hung up: the node gets to report the real exit status, within a grace period.
        tunnel.callerClosed = true;
        const timer = setTimeout(() => close(tunnel, 'caller-closed'), closeGraceMs);
        timer.unref?.();
        return;
      }
      // The node ended it (exit status included): done on both sides.
      tunnel.state = 'closed';
      tunnels.delete(tunnel.info.id);
      tunnel.reason = frame.body.value.reason || 'exited';
      to.close();
      from.close();
      return;
    }
    if (tunnel.callerClosed && from === tunnel.caller) return;
    if (frame.body.case === 'opened') return;
    const ok = to.send(create(TunnelFrameSchema, { ...frame, tunnelId: tunnel.info.id }));
    if (!ok) {
      from.pause();
      to.onDrain(() => from.resume());
    }
  }

  return {
    /**
     * Opens a tunnel for a caller holding a ticket (§7.6). Resolves once the node's Tunnel stream
     * is up; rejects `ACCESS_DENIED` (bad, foreign or replayed ticket), `NOT_FOUND` (the node has
     * no session on this gateway) or `UNAVAILABLE` (the node did not open in time).
     */
    open(request: { ticket: string; nodeId: string; caller: TunnelEndpoint }): Promise<TunnelHandle> {
      if (!options)
        return Promise.reject(new ComputeError('INVALID_CONFIG', 'This gateway has no tunnel configuration'));
      let claims: ExecTicketClaims;
      try {
        claims = verifyExecTicket(request.ticket, {
          jwks: options.jwks(),
          nodeId: request.nodeId,
          now: clock.now(),
          jtiCache: jti,
          ...(options.issuer ? { issuer: options.issuer } : {}),
        });
      } catch (error) {
        return Promise.reject(
          isComputeError(error) ? error : new ComputeError('ACCESS_DENIED', 'Exec ticket rejected'),
        );
      }
      if (tunnels.has(claims.sid))
        return Promise.reject(new ComputeError('CONFLICT', `Tunnel ${claims.sid} is already open`));
      const now = clock.now();
      const info: TunnelInfo = {
        id: claims.sid,
        nodeId: request.nodeId,
        subject: claims.sub,
        op: claims.op,
        openedAt: now,
        ...(claims.tnt ? { tenantId: claims.tnt } : {}),
        ...(claims.inst ? { instanceId: claims.inst } : {}),
        ...(claims.ses ? { sessionId: claims.ses } : {}),
        ...(claims.act ? { action: claims.act } : {}),
        ...(claims.agt ? { agentId: claims.agt } : {}),
        ...(claims.dlg ? { delegationId: claims.dlg } : {}),
      };
      const tunnel: Tunnel = {
        info,
        caller: request.caller,
        state: 'opening',
        lastAuthOkMs: now,
        nextAuthMs: now + reauthorizeMs,
        authorizing: false,
      };
      if (!deps.sendOpen(request.nodeId, info.id, request.ticket))
        return Promise.reject(
          new ComputeError('NOT_FOUND', `Node ${request.nodeId} has no session on this gateway`),
        );
      tunnels.set(info.id, tunnel);
      return new Promise<TunnelHandle>((resolve, reject) => {
        const timer = setTimeout(() => close(tunnel, 'open-timeout'), openTimeoutMs);
        timer.unref?.();
        tunnel.failed = (error) => {
          clearTimeout(timer);
          reject(
            error instanceof GrpcError
              ? new ComputeError('INVALID_STATE', `Tunnel did not open: ${error.message}`)
              : error,
          );
        };
        tunnel.opened = (node) => {
          clearTimeout(timer);
          tunnel.node = node;
          tunnel.state = 'open';
          resolve({
            info,
            receive: (frame) => relay(tunnel, tunnel.caller, tunnel.node, frame),
            end: (reason = 'caller-closed') => close(tunnel, reason),
          });
        };
      });
    },

    /**
     * A daemon's Tunnel stream (§7.7 `rpc Tunnel`). Its first frame must be `opened` for a tunnel
     * this gateway is opening for the same node; anything else is refused.
     */
    accept(peer: { nodeId: string }, node: TunnelEndpoint): TunnelStreamHandle {
      let tunnel: Tunnel | undefined;
      return {
        receive(frame) {
          if (!tunnel) {
            const candidate = tunnels.get(frame.tunnelId);
            if (frame.body.case !== 'opened' || !candidate || candidate.state !== 'opening') {
              node.close(new GrpcError(GrpcCode.NOT_FOUND, 'no such tunnel is being opened'));
              return;
            }
            if (candidate.info.nodeId !== peer.nodeId) {
              // A node answering for another node's tunnel: refused, and the real opener times out.
              node.close(new GrpcError(GrpcCode.PERMISSION_DENIED, 'this tunnel belongs to another node'));
              return;
            }
            tunnel = candidate;
            candidate.opened!(node);
            return;
          }
          relay(tunnel, node, tunnel.caller, frame);
        },
        end(reason = 'node-closed') {
          if (tunnel) close(tunnel, reason);
        },
      };
    },

    /** Closes matching tunnels (delegation revoked, node revoked, operator); returns how many. */
    closeWhere(filter: TunnelFilter, reason: string): number {
      let closed = 0;
      for (const tunnel of [...tunnels.values()])
        if (matches(tunnel.info, filter)) {
          close(tunnel, reason, new GrpcError(GrpcCode.PERMISSION_DENIED, reason));
          closed++;
        }
      return closed;
    },

    /**
     * Runs the re-authorization of matching open tunnels now instead of at their next 60 s check,
     * closing those IAM refuses (e.g. hand-offs revoked with their parent delegation, which the
     * revocation event does not name). Returns how many were checked; 0 without `reauthorize`.
     */
    async reauthorizeWhere(filter: TunnelFilter): Promise<number> {
      if (!options?.reauthorize) return 0;
      const now = clock.now();
      const due = [...tunnels.values()].filter((tunnel) => tunnel.state === 'open' && matches(tunnel.info, filter));
      // A check already in flight may have started before the revocation: run another one anyway.
      await Promise.all(due.map((tunnel) => authorize(tunnel, now)));
      return due.length;
    },

    /** Lifetime and re-authorization checks; run from the gateway's liveness loop. */
    async sweep(): Promise<number> {
      const now = clock.now();
      let handled = 0;
      for (const tunnel of [...tunnels.values()]) {
        if (tunnel.state !== 'open') continue;
        if (now - tunnel.info.openedAt >= maxDurationMs) {
          close(tunnel, 'max-duration');
          handled++;
          continue;
        }
        if (!options?.reauthorize || tunnel.authorizing || now < tunnel.nextAuthMs) continue;
        if (await authorize(tunnel, now)) handled++;
      }
      return handled;
    },

    list(): (TunnelInfo & { state: string })[] {
      return [...tunnels.values()].map((tunnel) => ({ ...tunnel.info, state: tunnel.state }));
    },
  };
}

export type TunnelRegistry = ReturnType<typeof createTunnelRegistry>;
