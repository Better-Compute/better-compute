import {
  connectivityTable,
  newId,
  parseDuration,
  transition,
  type Connectivity,
  type ModuleContext,
  type PoolPolicy,
  type SqlTx,
} from '@better-compute/core';
import { mergeReasons, sameReasons, setCondition, toMs } from './node-state.js';

// Liveness (PLAN.md §7.5, P6). Gateways keep heartbeats in memory, flush ages into
// `node_sessions.last_seen` and mark a closed session `disconnected` themselves. This controller
// applies the transitions nobody reports:
//   connected → disconnected   when the session's gateway lease expired (gateway crash, partition);
//   disconnected → unreachable after the 40 s lease TTL + grace: adds the `unreachable` NoSchedule
//                              reason and raises `NodeUnreachable`;
//   unreachable → lost         after the pool's `lostAfter`, and never for metal;
// and clears the reason and condition once the node is connected again. It releases nothing:
// allocations, bookings and commands are untouched (P6).
//
// Grace (Nomad's failover heartbeat TTL): 120 s after a gateway loss, so sessions can move to
// another gateway; 5 min after this controller or the database was down for more than 20 s, so
// ages the gateways could not flush meanwhile do not read as dead nodes.

export const unreachableReason = 'unreachable';
export const unreachableCondition = 'NodeUnreachable';

export interface LivenessOptions {
  /** Daemon liveness lease TTL (default 40 000 ms, `Welcome.lease_ttl`). */
  leaseTtlMs?: number;
  /** Extra time after a gateway loss (default 120 000 ms). */
  gatewayLossGraceMs?: number;
  /** Extra time after an outage of the database or this controller (default 300 000 ms). */
  outageGraceMs?: number;
  /** A gap between sweeps longer than this is an outage (default 20 000 ms). */
  outageThresholdMs?: number;
  /** Nodes one sweep examines at most (default 500). */
  batchSize?: number;
}

const defaults = {
  leaseTtlMs: 40_000,
  gatewayLossGraceMs: 120_000,
  outageGraceMs: 300_000,
  outageThresholdMs: 20_000,
  batchSize: 500,
} satisfies Required<LivenessOptions>;

/** Pool classes whose machines may be declared lost automatically: never metal (P6). */
const losablePoolClasses: ReadonlySet<string> = new Set(['provider']);

interface LivenessRow {
  connectivity: Connectivity;
  no_schedule_reasons: string[];
  owner_tenant_id: string;
  pool_class: string | null;
  pool_policy: PoolPolicy | null;
  gateway_id: string | null;
  last_seen: Date | null;
  disconnected_at: Date | null;
  connected_at: Date | null;
  gateway_expires_at: Date | null;
  unreachable_status: string | null;
  unreachable_since: Date | null;
}

export interface LivenessOutcome {
  connectivity: Connectivity;
  /** The transitions applied, in order (`disconnect`, `timeout`, `lose`, `clear`). */
  applied: string[];
  /** When a timed transition becomes due (the sweep re-examines the node then). */
  nextCheckAt?: number;
}

function lostAfterMs(policy: PoolPolicy | null): number | undefined {
  if (!policy?.lostAfter) return undefined;
  try {
    return parseDuration(policy.lostAfter);
  } catch {
    return undefined;
  }
}

/**
 * Evaluates one node in one transaction with its row locked. `timeouts: false` (the event-driven
 * node reconciler) applies only what an event proves: a dead gateway's disconnect and the clean-up
 * after a reconnect; the timed transitions belong to the sweep, which knows about outages.
 */
export async function reconcileLiveness(
  context: Pick<ModuleContext, 'sql' | 'clock' | 'events'>,
  nodeId: string,
  options: LivenessOptions & { timeouts?: boolean; graceUntil?: number } = {},
): Promise<LivenessOutcome | undefined> {
  const leaseTtlMs = options.leaseTtlMs ?? defaults.leaseTtlMs;
  const gatewayLossGraceMs = options.gatewayLossGraceMs ?? defaults.gatewayLossGraceMs;
  return context.sql.transaction(async (tx) => {
    const { rows } = await tx.query<LivenessRow>(
      `SELECT n.connectivity, n.no_schedule_reasons, n.owner_tenant_id,
              p.class AS pool_class, p.policy AS pool_policy,
              s.gateway_id, s.last_seen, s.disconnected_at, s.connected_at,
              l.expires_at AS gateway_expires_at,
              c.status AS unreachable_status, c.since AS unreachable_since
         FROM nodes n
         LEFT JOIN pools p ON p.id = n.pool_id
         LEFT JOIN node_sessions s ON s.node_id = n.id
         LEFT JOIN leases l ON l.name = 'gateway:' || s.gateway_id
         LEFT JOIN node_conditions c ON c.node_id = n.id AND c.type = $2
        WHERE n.id = $1 FOR UPDATE OF n`,
      [nodeId, unreachableCondition],
    );
    const row = rows[0];
    if (!row) return undefined;
    const now = context.clock.now();
    const initial = row.connectivity;
    let state = initial;
    let reasons = [...row.no_schedule_reasons];
    const applied: string[] = [];
    let nextCheckAt: number | undefined;
    const events: { type: string; data: Record<string, string | number | null> }[] = [];
    let condition: { status: 'true' | 'false'; reason: string } | undefined;

    const gatewayExpires = toMs(row.gateway_expires_at);
    const gatewayLive =
      row.gateway_id !== null && gatewayExpires !== undefined && gatewayExpires > now;
    const gatewayLost = row.gateway_id !== null && !gatewayLive;

    if (state === 'connected') {
      if (gatewayLive) {
        if (reasons.includes(unreachableReason) || row.unreachable_status === 'true') {
          reasons = mergeReasons(reasons, [], [unreachableReason]);
          condition = { status: 'false', reason: 'Connected' };
          applied.push('clear');
        }
      } else {
        state = transition(connectivityTable, state, 'disconnect');
        applied.push('disconnect');
        events.push({
          type: 'node.disconnected',
          data: {
            nodeId,
            gatewayId: row.gateway_id,
            reason: row.gateway_id ? 'gateway-lost' : 'no-session',
          },
        });
      }
    }

    let unreachableSince = toMs(row.unreachable_since);
    if (state === 'disconnected' && options.timeouts !== false) {
      const seen = [toMs(row.last_seen), toMs(row.disconnected_at)].filter(
        (value): value is number => value !== undefined,
      );
      const lastAlive = seen.length ? Math.max(...seen) : toMs(row.connected_at);
      let deadline =
        lastAlive === undefined
          ? Number.NEGATIVE_INFINITY
          : lastAlive + leaseTtlMs + (gatewayLost ? gatewayLossGraceMs : 0);
      if (options.graceUntil !== undefined) deadline = Math.max(deadline, options.graceUntil);
      if (now >= deadline) {
        state = transition(connectivityTable, state, 'timeout');
        applied.push('timeout');
        unreachableSince = now;
        condition = { status: 'true', reason: gatewayLost ? 'GatewayLost' : 'HeartbeatTimeout' };
        events.push({
          type: 'node.unreachable',
          data: { nodeId, lastSeen: lastAlive ?? null, reason: condition.reason },
        });
      } else nextCheckAt = deadline;
    }

    if (state === 'unreachable' || state === 'lost') {
      // Idempotent: a node found unreachable without its reason or condition gets them back.
      if (!reasons.includes(unreachableReason))
        reasons = mergeReasons(reasons, [unreachableReason], []);
      if (!condition && row.unreachable_status !== 'true') {
        condition = { status: 'true', reason: 'HeartbeatTimeout' };
        unreachableSince = now;
      }
    }

    if (state === 'unreachable' && options.timeouts !== false) {
      const lostAfter = lostAfterMs(row.pool_policy);
      if (lostAfter !== undefined && row.pool_class && losablePoolClasses.has(row.pool_class)) {
        const lostAt = (unreachableSince ?? now) + lostAfter;
        if (now >= lostAt) {
          state = transition(connectivityTable, state, 'lose');
          applied.push('lose');
          events.push({
            type: 'node.lost',
            data: { nodeId, unreachableSince: unreachableSince ?? now },
          });
        } else nextCheckAt = lostAt;
      }
    }

    if (state !== initial || !sameReasons(reasons, row.no_schedule_reasons))
      await tx.query(
        `UPDATE nodes SET connectivity = $2, no_schedule_reasons = $3, version = version + 1
          WHERE id = $1`,
        [nodeId, state, reasons],
      );
    if (condition) await setCondition(tx, nodeId, { type: unreachableCondition, ...condition });
    for (const event of events)
      await context.events.publish(tx, {
        type: event.type,
        tenantId: row.owner_tenant_id,
        subject: `node/${nodeId}`,
        data: event.data,
      });
    return { connectivity: state, applied, ...(nextCheckAt !== undefined ? { nextCheckAt } : {}) };
  });
}

/** The heartbeat row that detects outages of this controller (or of the database under it). */
export const livenessHeartbeat = 'heartbeat:liveness';

/**
 * Records this sweep in `leases` and reports whether the previous one is older than the outage
 * threshold. The first sweep of a fresh database is not an outage.
 */
async function heartbeat(tx: SqlTx, owner: string, now: number, thresholdMs: number) {
  const { rows } = await tx.query<{ expires_at: Date }>(
    'SELECT expires_at FROM leases WHERE name = $1 FOR UPDATE',
    [livenessHeartbeat],
  );
  const previous = toMs(rows[0]?.expires_at);
  await tx.query(
    `INSERT INTO leases (name, owner, epoch, expires_at) VALUES ($1, $2, 0, $3)
     ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at`,
    [livenessHeartbeat, owner, new Date(now + thresholdMs)],
  );
  return previous !== undefined && previous < now;
}

export interface LivenessSweep {
  /** One sweep: examines the nodes a timed transition may be due for; returns how many. */
  tick(): Promise<number>;
  /** Until when timeouts are held back after an outage (undefined when none is). */
  readonly graceUntil: number | undefined;
}

/** What a sweeping process remembers between ticks. */
export interface LivenessState {
  /** Owner of the heartbeat row. */
  readonly owner: string;
  /** Until when timeouts are held back after an outage. */
  graceUntil?: number | undefined;
}

export const createLivenessState = (): LivenessState => ({ owner: newId('wkr') });

/**
 * One tick of the Liveness controller's periodic side (every ~5 s, as a singleton). It records a
 * heartbeat, then re-evaluates connected nodes whose gateway lease expired, disconnected nodes past
 * the lease TTL (and the gateway-loss grace), and unreachable nodes of pools that may lose them.
 * Returns how many nodes it examined.
 */
export async function sweepLiveness(
  context: Pick<ModuleContext, 'sql' | 'clock' | 'events'>,
  state: LivenessState,
  options: LivenessOptions = {},
): Promise<number> {
  const settings = { ...defaults, ...options };
  const now = context.clock.now();
  const outage = await context.sql.transaction((tx) =>
    heartbeat(tx, state.owner, now, settings.outageThresholdMs),
  );
  if (outage) state.graceUntil = Math.max(state.graceUntil ?? 0, now + settings.outageGraceMs);
  if (state.graceUntil !== undefined && state.graceUntil <= now) state.graceUntil = undefined;
  const graceUntil = state.graceUntil;
  // Timed transitions are held back during an outage grace, so only gateway losses qualify then.
  // The disconnected deadline mirrors reconcileLiveness, so nodes still in grace are not
  // re-examined on every tick (nor starve the batch).
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT n.id
       FROM nodes n
       LEFT JOIN pools p ON p.id = n.pool_id
       LEFT JOIN node_sessions s ON s.node_id = n.id
       LEFT JOIN leases l ON l.name = 'gateway:' || s.gateway_id
      WHERE (n.connectivity = 'connected'
             AND (s.gateway_id IS NULL OR l.expires_at IS NULL OR l.expires_at <= compute_now()))
         OR (NOT $4::bool AND n.connectivity = 'disconnected'
             AND COALESCE(GREATEST(s.last_seen, s.disconnected_at), s.connected_at, '-infinity')
                 + make_interval(secs => $1::float8
                     + CASE WHEN s.gateway_id IS NOT NULL
                             AND (l.expires_at IS NULL OR l.expires_at <= compute_now())
                            THEN $5::float8 ELSE 0 END)
                 <= compute_now())
         OR (NOT $4::bool AND n.connectivity = 'unreachable'
             AND p.class = ANY($2::text[]) AND p.policy ? 'lostAfter')
      ORDER BY n.id
      LIMIT $3`,
    [
      settings.leaseTtlMs / 1000,
      [...losablePoolClasses],
      settings.batchSize,
      graceUntil !== undefined,
      settings.gatewayLossGraceMs / 1000,
    ],
  );
  for (const { id } of rows)
    await reconcileLiveness(context, id, {
      ...settings,
      ...(graceUntil !== undefined ? { graceUntil } : {}),
    });
  return rows.length;
}

/** A standalone sweep over one context (hosts that schedule it themselves, tests). */
export function createLivenessSweep(
  context: Pick<ModuleContext, 'sql' | 'clock' | 'events'>,
  options: LivenessOptions = {},
): LivenessSweep {
  const state = createLivenessState();
  return {
    get graceUntil() {
      return state.graceUntil;
    },
    tick: () => sweepLiveness(context, state, options),
  };
}
