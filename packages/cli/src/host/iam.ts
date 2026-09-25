import type { SqlExecutor } from '@better-compute/core';
import {
  gatewayControlClient,
  type ControlClientOptions,
  type GatewayControlClient,
} from '@better-compute/gateway';
import {
  agentStreamCloser,
  combineStreamClosers,
  gatewayStreamCloser,
  localStreamCloser,
  type AgentStreamFilter,
  type LocalStreamRegistry,
  type ComputeIamBridge,
  type GatewayTunnelCloser,
  type IamEventHandlers,
  type IamInboxEvent,
} from '@better-compute/iam';
import type { AnyCompute } from '../config.js';

// Compute's reactions to IAM events (PLAN.md §12.8), installed by the host because it is the one place that
// holds the bridge, the control plane and the way to the gateways. The iam module's inbox drain calls them in
// whichever process runs it (a worker role): `agent` ends the tunnels an agent or delegation opened on every
// live gateway (§16 v0.3 exit: "delegation:revoke closes the agent's stream within 5 s"), and the others drop
// this process's authentication and decision caches. The periodic tunnel re-authorization stays the backstop.

/**
 * A process-local stream registry that also closes by session or identity (@better-compute/events'
 * `WatchRegistry` is one).
 */
export interface HostStreamRegistry extends LocalStreamRegistry {
  closeWhere(
    filter: Parameters<LocalStreamRegistry['closeWhere']>[0] & { sessionId?: string; identityId?: string },
    reason: string,
  ): number;
}

/** `host.iam`: the IAM bridge whose inbox this deployment drains. */
export interface HostIamConfig {
  /** The bridge from `createComputeIamBridge()` (the one whose `modules` and port the configuration uses). */
  bridge: Pick<ComputeIamBridge, 'setHandlers'>;
  /**
   * Your own reactions, each replacing the default of the same name: `agent` (default: close the agent's
   * tunnels on every gateway), `identity`/`sessions`/`authz` (default: drop this process's IAM caches).
   * Handlers without a default (`binding`, `tenant`, `budget`) are only yours.
   */
  handlers?: IamEventHandlers;
  /** Gateways whose heartbeat is older than this are not asked (default 120 000 ms: they hold no streams). */
  gatewayStaleMs?: number;
  /**
   * This process's own streams, e.g. the `createWatchRegistry()` (@better-compute/events) that your `GET /watch`
   * mount passes to `handleWatch({ registry })`: revocations close them at once, like the gateways' tunnels.
   */
  streams?: readonly HostStreamRegistry[];
  /** Close failures of the default `agent` handler and handler errors (never thrown). */
  onError?(error: unknown, context: { filter?: AgentStreamFilter; event?: IamInboxEvent }): void;
}

export interface LiveGatewaysOptions {
  sql: Pick<SqlExecutor, 'query'>;
  /** Client TLS for the control APIs (the internal CA); without it only `http://` (h2c) gateways are asked. */
  tls?: ControlClientOptions['tls'];
  timeoutMs?: number;
  /** Default 120 000 ms. */
  staleMs?: number;
}

/** The control clients of every gateway that heartbeated recently, one cached client per URL. */
export interface LiveGateways {
  list(): Promise<GatewayControlClient[]>;
  close(): void;
}

export function liveGateways(options: LiveGatewaysOptions): LiveGateways {
  const staleMs = options.staleMs ?? 120_000;
  const clients = new Map<string, GatewayControlClient>();
  return {
    async list() {
      const { rows } = await options.sql.query<{ internal_url: string }>(
        `SELECT internal_url FROM gateways
          WHERE heartbeat_at > compute_now() - make_interval(secs => $1::double precision / 1000)
          ORDER BY id`,
        [staleMs],
      );
      // With internal-CA TLS configured, a gateway registered as http:// never gets a request in the clear;
      // without it, https:// gateways would refuse a client with no certificate.
      const tls = options.tls !== undefined;
      const urls = rows
        .map((row) => row.internal_url)
        .filter((url) => (tls ? url.startsWith('https://') : url.startsWith('http://')));
      for (const [url, client] of clients)
        if (!urls.includes(url)) {
          client.close();
          clients.delete(url);
        }
      return urls.map((url) => {
        let client = clients.get(url);
        if (!client) {
          client = gatewayControlClient({
            baseUrl: url,
            ...(options.tls ? { tls: options.tls } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          });
          clients.set(url, client);
        }
        return client;
      });
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Events after which an identity has no business holding a stream. */
const identityEnds = new Set([
  'identity:offboard',
  'identity:expire',
  'identity:delete',
  'iam:identities:delete',
]);

/**
 * Installs compute's IAM event handlers on `config.bridge` (see `HostIamConfig.handlers` for the defaults).
 * Returns `close()` for the gateway clients the `agent` handler opened.
 */
export function installIamHandlers(
  compute: AnyCompute,
  config: HostIamConfig,
  control: Pick<LiveGatewaysOptions, 'tls' | 'timeoutMs'> = {},
): { close(): void } {
  const gateways = liveGateways({
    sql: compute.context.sql,
    ...control,
    ...(config.gatewayStaleMs === undefined ? {} : { staleMs: config.gatewayStaleMs }),
  });
  const report = (error: unknown, context: { filter?: AgentStreamFilter; event?: IamInboxEvent }) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken reporter changes nothing.
    }
  };
  const streams = config.streams ?? [];
  const closeStreams = agentStreamCloser(
    combineStreamClosers(gatewayStreamCloser(() => gateways.list()), ...streams.map(localStreamCloser)),
    { onError: (error, filter) => report(error, { filter }) },
  );
  /**
   * A revoked session or offboarded identity: its SSE streams in this process at once, and (for an identity) the
   * tunnels its tickets opened on every gateway. Never without an id: a bare filter would close too much.
   */
  const closeFor = (event: IamInboxEvent, by: 'session' | 'identity') => {
    const id = text(event.subjectId);
    if (!id) return;
    for (const registry of streams)
      try {
        registry.closeWhere(by === 'session' ? { sessionId: id } : { identityId: id }, event.action);
      } catch (error) {
        report(error, { event });
      }
    if (by === 'identity')
      void gateways
        .list()
        .then((clients) =>
          Promise.allSettled(clients.map((client) => client.closeTunnels({ subject: id }, event.action))),
        )
        .then((results) => {
          for (const result of results) if (result.status === 'rejected') report(result.reason, { event });
        })
        .catch((error: unknown) => report(error, { event }));
  };
  const caches = compute.caches;
  const own = config.handlers ?? {};
  const handlers: IamEventHandlers = {
    ...own,
    agent:
      own.agent ??
      (async (tx, event) => {
        await closeStreams(tx, event);
        // The agent's cached authentications and decisions, where the event names it.
        const agentId =
          event.action === 'delegation:revoke' ? text(event.metadata?.agentId) : text(event.subjectId);
        if (agentId) caches.dropIdentity(agentId);
        else if (event.action === 'agent:suspend-all') caches.clear();
      }),
    identity:
      own.identity ??
      (async (_tx, event) => {
        const identityId = text(event.subjectId);
        if (identityId) caches.dropIdentity(identityId);
        else caches.clear();
        // An identity that is gone keeps no streams (an update, such as a rename, keeps them).
        if (identityEnds.has(event.action)) closeFor(event, 'identity');
      }),
    // Session revocations name a session, an identity, a role or a tenant; dropping every cached
    // authentication is exact for all of them and costs one IAM call per caller. Streams close where the event
    // names the session or identity exactly; the others (revoke-others, role- and tenant-wide) are left to the
    // streams' periodic re-authorization.
    sessions:
      own.sessions ??
      (async (_tx, event) => {
        caches.clear();
        if (event.action === 'auth:session:revoke') closeFor(event, 'session');
        else if (event.action === 'identity:revoke-sessions') closeFor(event, 'identity');
      }),
    authz: own.authz ?? (async () => caches.dropDecisions()),
    onError(error, event, reaction) {
      if (own.onError) own.onError(error, event, reaction);
      else report(error, { event });
    },
  };
  config.bridge.setHandlers(handlers);
  return { close: () => gateways.close() };
}
