import type { SqlExecutor, SqlTx } from '@better-compute/core';
import {
  gatewayControlClient,
  type ControlClientOptions,
  type GatewayControlClient,
} from '@better-compute/gateway';
import { applyBudgetPolicy, reassignReservations, withdrawAgentReservations } from '@better-compute/capacity';
import {
  agentStreamCloser,
  agentStreamFilter,
  budgetAlertHandler,
  combineStreamClosers,
  createIamWebhookHandler,
  gatewayStreamCloser,
  identityEndOf,
  localStreamCloser,
  sqlInbox,
  successorLookup,
  type AgentStreamFilter,
  type LocalStreamRegistry,
  type ComputeIamBridge,
  type GatewayTunnelCloser,
  type IamEventHandlers,
  type IamInboxEvent,
} from '@better-compute/iam';
import { revokeIdentitySshCertificates } from '@better-compute/server';
import type { AnyCompute } from '../config.js';
import type { HostRoute } from './http.js';

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
  /**
   * Remote IAM without access to its database (v0.4 fallback intake): better-iam delivers compute's events as
   * signed webhooks to `POST <path>` (default `/iam/events`), which writes them to this store's `iam_inbox`. The
   * IAM root subscribes with `webhooks.create({ scope: 'subtree', events: computeIamEventPatterns, outcomes:
   * ['allow'], url })`; `secret` is what that call returned.
   */
  webhook?: { secret: string; path?: string };
}

/** The host route of `host.iam.webhook`, if configured. */
export function iamWebhookRoutes(compute: AnyCompute, config: HostIamConfig | undefined): HostRoute[] {
  const webhook = config?.webhook;
  if (!webhook) return [];
  return [
    {
      path: webhook.path ?? '/iam/events',
      method: 'POST',
      handler: createIamWebhookHandler({ secret: webhook.secret, inbox: sqlInbox(compute.context.sql) }),
    },
  ];
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

/** Session revocations whose subject is the identity whose sessions ended. */
const identitySessionEnds = new Set([
  'auth:session:revoke',
  'auth:session:revoke-others',
  'identity:revoke-sessions',
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
   * better-iam audits session revocations and identity changes with the IDENTITY as the subject (its audit
   * helper sets `resourceId: identity.id`; the revoked session is not in the event). So:
   * - `end`: an identity that is gone. Its SSE streams here and its tunnels on every gateway close.
   * - `sessions`: some of its sessions ended. Its SSE streams here close (clients reconnect with Last-Event-ID
   *   and are re-authorized at once), and every gateway re-authorizes its tunnels now: the revoked sessions'
   *   shells close, the others keep running.
   * Never without an id: a bare filter would close too much.
   */
  const closeFor = (event: IamInboxEvent, mode: 'end' | 'sessions') => {
    const identityId = text(event.subjectId);
    if (!identityId) return;
    for (const registry of streams)
      try {
        registry.closeWhere({ identityId }, event.action);
      } catch (error) {
        report(error, { event });
      }
    void gateways
      .list()
      .then((clients) =>
        Promise.allSettled(
          clients.map((client) =>
            mode === 'end'
              ? client.closeTunnels({ subject: identityId }, event.action)
              : client.reauthorizeTunnels({ subject: identityId }),
          ),
        ),
      )
      .then((results) => {
        for (const result of results) if (result.status === 'rejected') report(result.reason, { event });
      })
      .catch((error: unknown) => report(error, { event }));
  };
  /** Every SSH certificate the identity holds, in any tenant. */
  const revokeSshFor = (tx: SqlTx, identityId: string, reason: string) =>
    revokeIdentitySshCertificates(tx, compute.context, { identityId, reason, by: 'iam' });
  const caches = compute.caches;
  const own = config.handlers ?? {};
  const handlers: IamEventHandlers = {
    ...own,
    agent:
      own.agent ??
      (async (tx, event) => {
        await closeStreams(tx, event);
        // The reservations the agent or delegation created that have not started are cancelled (§12.8).
        const filter = agentStreamFilter(event);
        if (filter) await withdrawAgentReservations(tx, compute.context, { ...filter, reason: event.action });
        // The agent's cached authentications and decisions, where the event names it.
        const agentId =
          event.action === 'delegation:revoke' ? text(event.metadata?.agentId) : text(event.subjectId);
        if (agentId) caches.dropIdentity(agentId);
        else if (event.action === 'agent:suspend-all') caches.clear();
      }),
    identity:
      own.identity ??
      (async (tx, event) => {
        const identityId = text(event.subjectId);
        if (identityId) caches.dropIdentity(identityId);
        else caches.clear();
        // An owner gone for good (offboarded, expired, deleted, or found so by IamReconcile): its reservations go
        // to the successor, else the unstarted ones are cancelled (§12.8).
        const end = await identityEndOf(event, successorLookup(compute.context.sql));
        if (end) await reassignReservations(tx, compute.context, { ...end, reason: event.action });
        // An identity that is gone keeps no streams and no break-glass SSH (an update, such as a rename, keeps
        // them): a certificate would otherwise open its node until it expires.
        if (end || identityEnds.has(event.action)) {
          if (identityId) await revokeSshFor(tx, identityId, event.action);
          closeFor(event, 'end');
        }
      }),
    // A role activation ended (the holder deactivated it, or an administrator revoked it): break-glass access
    // granted through it ends too (§12.8). better-iam names the binding as the subject and the holder as the actor
    // (or `metadata.identityId` when revoked). Its SSH certificates in the tenant are revoked, and every gateway
    // re-checks its tunnels. An activation only grants: certificates issued under it are already clamped to the
    // session at issuance, so `binding:activate` needs nothing here.
    binding:
      own.binding ??
      (async (tx, event) => {
        if (event.action !== 'binding:deactivate' || event.metadata?.cancelled === true) return;
        const holder = text(event.metadata?.identityId) ?? text(event.actorId);
        if (!holder) return;
        await revokeIdentitySshCertificates(tx, compute.context, {
          tenantId: event.tenantId,
          identityId: holder,
          reason: event.action,
          by: 'iam',
        });
        closeFor({ ...event, subjectId: holder }, 'sessions');
      }),
    // A budget spent: the offerings' onBudgetExceeded (stop-new, drain) for the alert's tenant.
    budget:
      own.budget ??
      budgetAlertHandler(async (tx, alert) => {
        await applyBudgetPolicy(tx as never, compute.context, alert);
      }),
    // Session revocations name an identity, a role or a tenant; dropping every cached authentication is exact
    // for all of them and costs one IAM call per caller. An identity's own revocations close or re-check its
    // streams at once; role- and tenant-wide ones are left to the streams' periodic re-authorization. Its SSH
    // certificates are revoked: the event does not say which session ended, and a certificate outlives any check
    // (break-glass is re-issued in a minute from a live session).
    sessions:
      own.sessions ??
      (async (tx, event) => {
        caches.clear();
        if (!identitySessionEnds.has(event.action)) return;
        const identityId = text(event.subjectId);
        if (identityId) await revokeSshFor(tx, identityId, event.action);
        closeFor(event, 'sessions');
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
