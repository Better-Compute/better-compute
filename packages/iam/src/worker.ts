// The IAM module's worker jobs (PLAN.md §12.7, §12.8): IamInbox drains `iam_inbox` per tenant in `sequence`
// order and reacts level-triggered; IamReconcile re-reads the identities that hold compute state, so a
// spilled or lost event only delays a reaction; the usage flush hands closed usage windows to the IamPort.

import {
  reservationStateTable,
  type IamPort,
  type Json,
  type Migration,
  type SqlExecutor,
  type SqlTx,
  type UsageEvent,
} from '@better-compute/core';
import type { FlagCache } from './flags.js';
import { inboxReactions, type InboxReaction } from './inbox.js';

/** The IAM module's own table: successors of offboarded identities, for usage re-attribution. */
export const successorsMigration: Migration = {
  name: 'iam/0001_successors',
  sql: `
CREATE TABLE iam_successors (
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  successor_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (tenant_id, identity_id)
);
`,
};

export async function rememberSuccessor(
  tx: SqlTx,
  tenantId: string,
  identityId: string,
  successorId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO iam_successors (tenant_id, identity_id, successor_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, identity_id)
       DO UPDATE SET successor_id = EXCLUDED.successor_id, recorded_at = compute_now()`,
    [tenantId, identityId, successorId],
  );
}

/** Follows successor links (an offboarded successor hands on again), at most 8 hops. */
export function successorLookup(
  sql: SqlTx,
): (tenantId: string, identityId: string) => Promise<string | undefined> {
  return async (tenantId, identityId) => {
    let current = identityId;
    const seen = new Set([identityId]);
    for (let hop = 0; hop < 8; hop++) {
      const { rows } = await sql.query<{ successor_id: string }>(
        'SELECT successor_id FROM iam_successors WHERE tenant_id = $1 AND identity_id = $2',
        [tenantId, current],
      );
      const next = rows[0]?.successor_id;
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current === identityId ? undefined : current;
  };
}

/** An inbox event as handlers see it. `subjectId` is the audit event's `resourceId`. */
export interface IamInboxEvent {
  eventId: string;
  tenantId: string;
  sequence: number;
  occurredAt: number;
  action: string;
  /** The identity, agent, delegation, tenant or role the event is about. */
  subjectId?: string;
  actorId?: string;
  metadata: Record<string, Json>;
  reactions: InboxReaction[];
}

/**
 * Compute's reactions. Each is level-triggered: re-read current IAM state instead of trusting event order,
 * so a reversed `binding:activate`/`binding:deactivate` pair still ends right. Errors are reported and the
 * event is marked processed anyway (IamReconcile retries the state, not the event).
 */
export interface IamEventHandlers {
  /** `identity:offboard|expire|delete`, `iam:identities:delete|update`: close streams, reassign work. */
  identity?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** Session revocations: recheck that identity's streams, drop cached authentications. */
  sessions?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** `agent:suspend(-all)`, `delegation:revoke`: close the agent's streams, cancel unplaced work. */
  agent?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** `binding:activate|deactivate`: cap or close break-glass sessions. */
  binding?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** `iam:tenants:update|delete`: suspend admissions, schedule teardown. */
  tenant?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** Policies, roles, bindings, relationships, flags: drop read-decision caches. */
  authz?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** `billing:budget-alert`: apply the offering's budget policy. */
  budget?(tx: SqlTx, event: IamInboxEvent): Promise<void>;
  /** Handler failures; must not throw. */
  onError?(error: unknown, event: IamInboxEvent, reaction: InboxReaction): void;
}

interface InboxDbRow {
  event_id: string;
  tenant_id: string;
  sequence: string | number;
  occurred_at: Date | string;
  action: string;
  body: unknown;
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function inboxEventOf(row: InboxDbRow): IamInboxEvent {
  const body = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Record<
    string,
    Json
  > | null;
  const metadata =
    body && typeof body.metadata === 'object' && body.metadata && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, Json>)
      : {};
  const event: IamInboxEvent = {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    sequence: Number(row.sequence),
    occurredAt: toMillis(row.occurred_at),
    action: row.action,
    metadata,
    reactions: inboxReactions(row.action),
  };
  if (typeof body?.resourceId === 'string') event.subjectId = body.resourceId;
  if (typeof body?.actorId === 'string') event.actorId = body.actorId;
  return event;
}

export interface DrainInboxOptions {
  handlers?: IamEventHandlers;
  /** Invalidated on `feature:*` and other authz changes. */
  flags?: FlagCache;
  /** Rows per pass. Default 500. */
  limit?: number;
  /** Processed rows older than this are deleted. Default 7 days; 0 keeps them. */
  retainMs?: number;
}

export interface DrainInboxResult {
  processed: number;
  /** A full page was processed: call again. */
  more: boolean;
  failures: number;
}

/**
 * One IamInbox pass: claims up to `limit` unprocessed rows (skipping rows another worker holds), processes
 * them per tenant in `sequence` order without waiting for gaps, and marks them processed, all in one
 * transaction. Built-in reactions: remembering `successorId` from `identity:offboard`, and invalidating the
 * flag cache on flag and authz changes.
 */
export async function drainIamInbox(
  sql: SqlExecutor,
  options: DrainInboxOptions = {},
): Promise<DrainInboxResult> {
  const limit = options.limit ?? 500;
  const handlers = options.handlers ?? {};
  const retainMs = options.retainMs ?? 7 * 86_400_000;
  const result = await sql.transaction(async (tx) => {
    const { rows } = await tx.query<InboxDbRow>(
      `SELECT event_id, tenant_id, sequence, occurred_at, action, body FROM iam_inbox
        WHERE processed_at IS NULL
        ORDER BY tenant_id, sequence, event_id
        LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let failures = 0;
    // A failing statement aborts a PostgreSQL transaction, so every step runs in its own savepoint: one
    // broken handler can neither poison the pass (and every event after it, forever) nor undo the
    // built-in reactions.
    const isolated = async (
      event: IamInboxEvent,
      reaction: InboxReaction,
      step: () => Promise<void>,
    ) => {
      await tx.query('SAVEPOINT iam_reaction');
      try {
        await step();
        await tx.query('RELEASE SAVEPOINT iam_reaction');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT iam_reaction');
        await tx.query('RELEASE SAVEPOINT iam_reaction');
        failures++;
        try {
          handlers.onError?.(error, event, reaction);
        } catch {
          // Reporting must not stop the pass.
        }
      }
    };
    for (const row of rows) {
      const event = inboxEventOf(row);
      for (const reaction of event.reactions) {
        const successorId = event.metadata.successorId;
        if (reaction === 'identity' && typeof successorId === 'string' && event.subjectId) {
          const subjectId = event.subjectId;
          await isolated(event, reaction, () =>
            rememberSuccessor(tx, event.tenantId, subjectId, successorId),
          );
        }
        if (reaction === 'features' || reaction === 'authz') options.flags?.invalidate();
        const handler = reaction === 'features' ? undefined : handlers[reaction];
        if (handler) await isolated(event, reaction, () => handler(tx, event));
      }
    }
    if (rows.length)
      await tx.query(
        'UPDATE iam_inbox SET processed_at = compute_now() WHERE event_id = ANY($1::text[])',
        [rows.map((row) => row.event_id)],
      );
    return { processed: rows.length, more: rows.length === limit, failures };
  });
  if (retainMs > 0)
    await sql.query(
      `DELETE FROM iam_inbox WHERE processed_at < compute_now() - make_interval(secs => $1::float8 / 1000)`,
      [retainMs],
    );
  return result;
}

/** What IamReconcile learns about one identity from IAM. */
export interface IdentityState {
  status: 'active' | 'disabled' | 'deleted' | 'missing';
  kind?: 'user' | 'service' | 'agent';
}

/**
 * Identities that hold something compute must take back when they end (§12.8), beyond reservation owners: another
 * module's owners, agents and delegations (vps sandboxes, for one). Returns at most `limit`.
 */
export type IdentityHolders = (
  sql: Pick<SqlExecutor, 'query'>,
  limit: number,
) => Promise<readonly { tenantId: string; identityId: string }[]>;

export interface ReconcileIdentitiesOptions {
  /** Reads the identity from IAM (embedded: the IAM store; remote: the root SA). */
  readIdentity(tenantId: string, identityId: string): Promise<IdentityState>;
  /** More holders to re-read besides reservation owners (a module's, which iam cannot import). */
  holders?: readonly IdentityHolders[];
  /**
   * Called for every identity that is no longer active with a synthetic `identity` event; an agent also gets a
   * synthetic `agent:suspend` for `agent` (what it holds as an agent, not as an owner: sandboxes it created,
   * reservations, tunnels).
   */
  handlers?: Pick<IamEventHandlers, 'identity' | 'agent' | 'onError'>;
  /** Identities per pass. Default 1000. */
  limit?: number;
}

export interface ReconcileIdentitiesResult {
  checked: number;
  inactive: { tenantId: string; identityId: string; status: IdentityState['status'] }[];
}

const liveStates = reservationStateTable.states.filter(
  (state) => !(reservationStateTable.terminal as readonly string[]).includes(state),
);

/**
 * One IamReconcile pass: every identity that owns a non-terminal reservation, or that one of `holders` names, is
 * re-read from IAM; each one that is no longer active is handed to `handlers.identity` as if its event had arrived,
 * and an agent to `handlers.agent` as if it had been suspended (§12.8).
 */
export async function reconcileIamIdentities(
  sql: SqlExecutor,
  options: ReconcileIdentitiesOptions,
): Promise<ReconcileIdentitiesResult> {
  const limit = options.limit ?? 1000;
  const { rows: owners } = await sql.query<{ tenant_id: string; identity_id: string }>(
    `SELECT DISTINCT tenant_id, owner_identity_id AS identity_id FROM reservations
      WHERE state = ANY($1::text[]) ORDER BY tenant_id, identity_id LIMIT $2`,
    [liveStates, limit],
  );
  const byKey = new Map<string, { tenant_id: string; identity_id: string }>();
  for (const row of owners) byKey.set(`${row.tenant_id}\u0000${row.identity_id}`, row);
  for (const holders of options.holders ?? [])
    for (const holder of await holders(sql, limit))
      byKey.set(`${holder.tenantId}\u0000${holder.identityId}`, {
        tenant_id: holder.tenantId,
        identity_id: holder.identityId,
      });
  const rows = [...byKey.values()].slice(0, limit);
  const inactive: ReconcileIdentitiesResult['inactive'] = [];
  for (const row of rows) {
    const state = await options.readIdentity(row.tenant_id, row.identity_id);
    if (state.status === 'active') continue;
    inactive.push({ tenantId: row.tenant_id, identityId: row.identity_id, status: state.status });
    const event: IamInboxEvent = {
      eventId: `reconcile:${row.tenant_id}:${row.identity_id}`,
      tenantId: row.tenant_id,
      sequence: 0,
      occurredAt: 0,
      action: 'compute:iam:reconcile',
      subjectId: row.identity_id,
      metadata: { status: state.status },
      reactions: ['identity'],
    };
    const dispatch = async (
      reaction: 'identity' | 'agent',
      synthetic: IamInboxEvent,
      handler: ((tx: SqlTx, event: IamInboxEvent) => Promise<void>) | undefined,
    ) => {
      if (!handler) return;
      try {
        await sql.transaction((tx) => handler(tx, synthetic));
      } catch (error) {
        try {
          options.handlers?.onError?.(error, synthetic, reaction);
        } catch {
          // Reporting must not stop the pass.
        }
      }
    };
    await dispatch('identity', event, options.handlers?.identity);
    // A suspended agent reads as disabled with no successor, which ends nothing for the identity reaction; what it
    // holds as an agent is withdrawn by the agent reaction, as `agent:suspend` would have.
    if (state.kind === 'agent')
      await dispatch(
        'agent',
        {
          ...event,
          eventId: `reconcile:${row.tenant_id}:${row.identity_id}:agent`,
          action: 'agent:suspend',
          metadata: { status: state.status, reason: 'compute:iam:reconcile' },
          reactions: ['agent'],
        },
        options.handlers?.agent,
      );
  }
  return { checked: rows.length, inactive };
}

export interface FlushUsageOptions {
  /** Windows per pass. Default 1000. */
  limit?: number;
}

export interface FlushUsageResult {
  sent: number;
  deadLettered: number;
  more: boolean;
}

interface WindowRow {
  idempotency_key: string;
  tenant_id: string;
  identity_id: string | null;
  meter: string;
  quantity: string | number;
  window_start: Date | string;
  tags: unknown;
  cost_micros: string | number | null;
  window_end: Date | string;
  claim: string;
}

/** How long a flush's claim on a window holds (core/0033); `usage.void` refuses a window claimed within it. */
const claimTtl = "interval '10 minutes'";

/**
 * One usage-sink pass (§12.7): sends closed, unrecorded `usage_windows` of every source (D2) through
 * `iam.recordUsage` (poison-isolating), stores each outcome, and upserts dead letters. Voided windows are
 * never sent; a window with `cost_micros` (pass-through) carries its cost in currency units. Retries are
 * safe: every window keeps its idempotency key, and a failed send leaves the windows unrecorded and claimed
 * until the claim's TTL, when a later pass takes them over and resends. A dead-lettered window (a closed period included) is marked sent with outcome `dead-lettered`, so
 * no later pass picks it up again; only `usage.retry` clears that. A dead letter whose event IAM accepts later
 * (after a retry) is resolved.
 */
export async function flushUsageWindows(
  sql: SqlExecutor,
  iam: Pick<IamPort, 'recordUsage'>,
  options: FlushUsageOptions = {},
): Promise<FlushUsageResult> {
  const limit = options.limit ?? 1000;
  // Claim the batch first, in a short committed statement: `usage.void` refuses a claimed window, so it can never
  // void one this pass is about to bill. A claim older than the TTL is a dead sender's and is taken over (IAM
  // knows the idempotency keys, so a resend is a duplicate). The claim is not `recorded_at`: retention prunes
  // recorded rows.
  const { rows: claimed } = await sql.query<WindowRow>(
    `UPDATE usage_windows u SET claimed_at = compute_now()
       FROM (SELECT idempotency_key, window_start FROM usage_windows
              WHERE recorded_at IS NULL AND voided_at IS NULL AND window_end <= compute_now()
                AND (claimed_at IS NULL OR claimed_at < compute_now() - ${claimTtl})
              ORDER BY window_end, idempotency_key LIMIT $1 FOR UPDATE SKIP LOCKED) c
      WHERE u.idempotency_key = c.idempotency_key AND u.window_start = c.window_start
      RETURNING u.idempotency_key, u.tenant_id, u.identity_id, u.meter, u.quantity, u.window_start, u.window_end,
                u.tags, u.cost_micros, u.claimed_at::text AS claim`,
    [limit],
  );
  if (claimed.length === 0) return { sent: 0, deadLettered: 0, more: false };
  // This pass's claim (one statement, one compute_now()), as text so it compares exactly: a pass only ever clears
  // its own claim, never a newer takeover's.
  const claim = claimed[0]!.claim;
  const rows = claimed.sort(
    (a, b) =>
      toMillis(a.window_end) - toMillis(b.window_end) ||
      (a.idempotency_key < b.idempotency_key ? -1 : 1),
  );
  const events: UsageEvent[] = rows.map((row) => {
    const parsed = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
    const event: UsageEvent = {
      tenantId: row.tenant_id,
      meter: row.meter,
      quantity: Number(row.quantity),
      occurredAt: toMillis(row.window_start),
      tags: { ...(parsed as Record<string, string>) },
      idempotencyKey: row.idempotency_key,
    };
    if (row.identity_id !== null) event.identityId = row.identity_id;
    if (row.cost_micros !== null) event.cost = Number(row.cost_micros) / 1e6;
    return event;
  });
  // A throw keeps the claims (ruling FW-6): IAM may have recorded some or all of the events before the failure
  // reached us (a timeout, a dropped connection), and the port cannot tell, so releasing them would let
  // `usage.void` void a window IAM billed. They expire after the TTL; the takeover resends, and IAM answers
  // duplicates by idempotency key.
  const results = await iam.recordUsage(events);
  let deadLettered = 0;
  await sql.transaction(async (tx) => {
    for (const [index, result] of results.entries()) {
      const event = events[index]!;
      if (result.status === 'dead-lettered') {
        deadLettered++;
        await tx.query(
          `INSERT INTO usage_dead_letters (idempotency_key, tenant_id, event, error_code, error_message)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (idempotency_key) DO UPDATE
             SET event = EXCLUDED.event, error_code = EXCLUDED.error_code,
                 error_message = EXCLUDED.error_message, attempts = usage_dead_letters.attempts + 1,
                 last_failed_at = compute_now(), resolved_at = NULL`,
          [
            event.idempotencyKey,
            event.tenantId,
            JSON.stringify(event),
            result.error?.code ?? 'UNKNOWN',
            result.error?.message ?? '',
          ],
        );
      }
      const orphaned = result.status === 'reattributed' && result.identityId === undefined;
      await tx.query(
        `UPDATE usage_windows
            SET recorded_at = compute_now(), outcome = $2,
                claimed_at = CASE WHEN claimed_at = $5::timestamptz THEN NULL ELSE claimed_at END,
                identity_id = CASE WHEN $3::bool THEN NULL
                                   WHEN $2 = 'reattributed' THEN $4 ELSE identity_id END
          WHERE idempotency_key = $1`,
        [event.idempotencyKey, result.status, orphaned, result.identityId ?? null, claim],
      );
    }
    // A retried window that IAM now accepted closes its dead letter (usage.retry clears the window's outcome and
    // leaves the letter open until this pass records it).
    const accepted = results.flatMap((result, index) =>
      result.status === 'dead-lettered' ? [] : [events[index]!.idempotencyKey],
    );
    if (accepted.length > 0)
      await tx.query(
        `UPDATE usage_dead_letters SET resolved_at = compute_now()
          WHERE resolved_at IS NULL AND idempotency_key = ANY($1::text[])`,
        [accepted],
      );
  });
  return { sent: rows.length, deadLettered, more: rows.length === limit };
}
