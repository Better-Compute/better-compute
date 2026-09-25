// Closing an agent's live streams when IAM withdraws it (PLAN.md §16 v0.3 exit: "delegation:revoke closes the
// agent's stream within 5 s"). The inbox routes `delegation:revoke`, `agent:suspend` and `agent:suspend-all` to the
// `agent` handler; `agentStreamCloser` turns each into one close request that the host fans out to its gateways
// (their control API closes the tunnels a ticket opened for that agent or delegation). The periodic tunnel
// re-authorization stays the backstop.

import type { IamInboxEvent } from './worker.js';

/** Which streams to close: the agent's, the delegation's, or every agent's in a tenant. */
export interface AgentStreamFilter {
  tenantId: string;
  agentId?: string;
  delegationId?: string;
  /** `agent:suspend-all`: every agent of the tenant. */
  allAgents?: boolean;
  /**
   * The revoked delegation had live hand-offs, which IAM revoked with it without naming them (the event carries
   * only `handoffsRevoked`). Their tunnels carry the hand-off's id, so the tenant's agent tunnels are re-authorized
   * at once instead of at the next 60 s check.
   */
  recheckAgents?: boolean;
  reason: string;
}

export interface AgentStreamCloserOptions {
  /** Called with close failures (never thrown: the inbox drain must not fail on a gateway being away). */
  onError?(error: unknown, filter: AgentStreamFilter): void;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The streams an inbox event withdraws, or undefined for events that withdraw none. */
export function agentStreamFilter(
  event: Pick<IamInboxEvent, 'tenantId' | 'action' | 'subjectId' | 'metadata'>,
): AgentStreamFilter | undefined {
  const subject = text(event.subjectId);
  const reason = text(event.metadata?.reason) ?? event.action;
  switch (event.action) {
    case 'delegation:revoke': {
      const agentId = text(event.metadata?.agentId);
      const handoffs = event.metadata?.handoffsRevoked;
      return subject
        ? {
            tenantId: event.tenantId,
            delegationId: subject,
            ...(agentId ? { agentId } : {}),
            ...(typeof handoffs === 'number' && handoffs > 0 ? { recheckAgents: true } : {}),
            reason,
          }
        : undefined;
    }
    case 'agent:suspend':
      return subject ? { tenantId: event.tenantId, agentId: subject, reason } : undefined;
    case 'agent:suspend-all':
      return { tenantId: event.tenantId, allAgents: true, reason };
    default:
      return undefined;
  }
}
/**
 * An `agent` inbox handler: `bridge.setHandlers({ agent: agentStreamCloser(close) })`, where `close` asks every
 * gateway to end the matching tunnels (for example `gatewayControlClient.closeTunnels`). The request goes out at
 * once, without waiting for the inbox transaction: closing a stream that a rolled-back drain would have closed
 * anyway is harmless, and waiting would put a network call inside the transaction.
 */
export function agentStreamCloser(
  close: (filter: AgentStreamFilter) => Promise<unknown>,
  options: AgentStreamCloserOptions = {},
): (tx: unknown, event: IamInboxEvent) => Promise<void> {
  return async (_tx, event) => {
    const filter = agentStreamFilter(event);
    if (!filter) return;
    void Promise.resolve()
      .then(() => close(filter))
      .catch((error: unknown) => {
        try {
          options.onError?.(error, filter);
        } catch {
          // A broken reporter changes nothing.
        }
      });
  };
}

/** The gateway's tunnel filter (structural copy of `@better-compute/gateway`'s `TunnelFilter`; iam never imports it). */
export interface GatewayTunnelFilter {
  agentId?: string;
  delegationId?: string;
  tenantId?: string;
  /** With `tenantId`: every tunnel an agent opened in that tenant. */
  anyAgent?: true;
}

/** One gateway's control API, e.g. `gatewayControlClient(...)`: closes matching tunnels and returns how many. */
export interface GatewayTunnelCloser {
  closeTunnels(filter: GatewayTunnelFilter, reason: string): Promise<number>;
  /** Runs the matching tunnels' re-authorization now (closing those IAM refuses); returns how many it checked. */
  reauthorizeTunnels?(filter: GatewayTunnelFilter): Promise<number>;
}

/** The gateway filter for a stream filter. It always narrows to an agent or delegation, never to a whole tenant. */
export function gatewayTunnelFilter(filter: AgentStreamFilter): GatewayTunnelFilter {
  if (filter.delegationId !== undefined)
    return {
      delegationId: filter.delegationId,
      ...(filter.agentId !== undefined ? { agentId: filter.agentId } : {}),
    };
  if (filter.agentId !== undefined) return { agentId: filter.agentId };
  return { tenantId: filter.tenantId, anyAgent: true };
}

/** A process-local registry of open streams, e.g. `createWatchRegistry()` from `@better-compute/events` (SSE). */
export interface LocalStreamRegistry {
  closeWhere(filter: GatewayTunnelFilter, reason: string): number;
}

/** The `close` for a process-local registry (the same filters as the gateways'). */
export function localStreamCloser(
  registry: LocalStreamRegistry,
): (filter: AgentStreamFilter) => Promise<number> {
  return async (filter) => registry.closeWhere(gatewayTunnelFilter(filter), filter.reason);
}

/**
 * Runs several closers for one filter (tunnels on every gateway, this process's SSE streams, …) and returns the
 * total closed. All run; failures are thrown together afterwards.
 *
 * ```ts
 * bridge.setHandlers({
 *   agent: agentStreamCloser(combineStreamClosers(gatewayStreamCloser(gateways), localStreamCloser(watches))),
 * });
 * ```
 */
export function combineStreamClosers(
  ...closers: ((filter: AgentStreamFilter) => Promise<number>)[]
): (filter: AgentStreamFilter) => Promise<number> {
  return async (filter) => {
    const results = await Promise.allSettled(
      closers.map((close) => Promise.resolve().then(() => close(filter))),
    );
    let closed = 0;
    const errors: unknown[] = [];
    for (const result of results)
      if (result.status === 'fulfilled') closed += result.value;
      else errors.push(result.reason);
    if (errors.length > 0)
      throw new AggregateError(errors, `${errors.length} stream closers failed`);
    return closed;
  };
}

/**
 * The `close` for `agentStreamCloser`: asks every gateway at once and returns the total closed. Every gateway is
 * tried; if any failed, it throws an AggregateError after the others finished (a gateway being away must not keep
 * the rest from closing their share).
 */
export function gatewayStreamCloser(
  gateways: () => Iterable<GatewayTunnelCloser> | Promise<Iterable<GatewayTunnelCloser>>,
): (filter: AgentStreamFilter) => Promise<number> {
  return async (filter) => {
    const tunnelFilter = gatewayTunnelFilter(filter);
    const recheck: GatewayTunnelFilter | undefined = filter.recheckAgents
      ? { tenantId: filter.tenantId, anyAgent: true }
      : undefined;
    const results = await Promise.allSettled(
      [...(await gateways())].map((gateway) =>
        Promise.resolve().then(async () => {
          const closed = await gateway.closeTunnels(tunnelFilter, filter.reason);
          if (recheck && gateway.reauthorizeTunnels) await gateway.reauthorizeTunnels(recheck);
          return closed;
        }),
      ),
    );
    let closed = 0;
    const errors: unknown[] = [];
    for (const result of results)
      if (result.status === 'fulfilled') closed += result.value;
      else errors.push(result.reason);
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        `${errors.length} of ${results.length} gateways failed to close tunnels`,
      );
    return closed;
  };
}
