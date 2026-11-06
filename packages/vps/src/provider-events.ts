import {
  isComputeError,
  type CallContext,
  type Condition,
  type Duration,
  type Json,
  type Migration,
  type ModuleContext,
  type ProviderEvent,
  type ProviderImpl,
  type ReconcileContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { noticeNodeInterruption } from '@better-compute/capacity';
import { readAccount, type ProviderAccount } from './accounts.js';
import { reservationsWork } from './provider-reservations.js';
import {
  instanceWork,
  publishInstance,
  readInstance,
  withCondition,
  withoutCondition,
  type InstanceDeps,
} from './instances.js';

// Provider event intake (AWS A4, AD12): the `vps.provider-events` worker polls every provider
// account whose client has `pollEvents` (an EC2 account's EventBridge → SQS queue) and lets events
// wake reconcilers early. Polling stays the source of truth: no event writes machine state.
// Key `all` (periodic, 15 s) enqueues the accounts that can poll and prunes old event ids; key
// `<accountId>` long-polls one account (outside any transaction), handles every event of a batch
// in transactions of at most 100 events and acks it only after the last commits. An unacked batch
// comes again; the ids already handled are in `provider_event_seen` by then, so each event is
// processed once. A run polls again while the queue returns full batches of messages.
//
// | event | effect |
// |---|---|
// | machine-changed, api-call | the instance's reconcile is enqueued |
// | interruption-warning | `InterruptionPending` condition, `instance.interruption`; the node the machine backs (a joined provider bootstrap) gets the NoSchedule taint `<provider>.spot/interruption` and its reservations the spot notice up to the deadline. Past its deadline: only the reconcile |
// | machine-changed, state running, after a pending interruption's deadline | both conditions cleared, the taint removed (`node.tainted` with it in `removed`) |
// | rebalance-recommended | `RebalanceRecommended` condition, `instance.rebalance-recommended` |
// | maintenance-scheduled | `MaintenanceScheduled` condition (cleared when completed or canceled), `instance.maintenance` |
// | reservation-changed | the account's `vps.reservations` scan is enqueued |
// | health | `instance.health` |
// Machines that are no live instance (or joined bootstrap) are ignored.

/** The work kind of the provider events reconciler (keys: `all`, or a provider account id). */
export const providerEventsWork = 'vps.provider-events';

export const interruptionCondition = 'InterruptionPending';
export const rebalanceCondition = 'RebalanceRecommended';
export const maintenanceCondition = 'MaintenanceScheduled';

/** The NoSchedule taint key a node backed by an interrupted machine gets (`aws.spot/interruption`). */
export const interruptionTaintKey = (provider: string): string => `${provider}.spot/interruption`;

export interface ProviderEventsOptions {
  /** How often every account is polled (default `15s`). */
  every?: Duration;
  /** The long poll per call (default 10 000 ms, at most 10 000). */
  waitMs?: number;
  /**
   * A run's time budget per account (default 12 000 ms: inside the work queue's 15 s claim). A run
   * polls again while batches come back full and the budget lasts.
   */
  budgetMs?: number;
  /**
   * How long seen event ids are kept after they were last delivered (default 24 h). An event older
   * than this, less a margin (an hour at most), is dropped unprocessed: its id may be pruned.
   */
  retainMs?: number;
}

export const providerEventsMigration: Migration = {
  name: 'vps/0090_provider_events',
  sql: `
-- Event ids each account's intake already handled (AWS A4): a redelivered event is dropped.
CREATE TABLE provider_event_seen (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  event_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX provider_event_seen_at ON provider_event_seen (seen_at);
`,
};

export const providerInterruptionsMigration: Migration = {
  name: 'vps/0091_provider_interruptions',
  sql: `
-- Machines with a pending provider interruption (AWS A4): a running state change after the deadline
-- (a Spot instance stopped or hibernated and back) clears the instance conditions and node taint.
CREATE TABLE provider_interruptions (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  machine_id text NOT NULL,
  deadline timestamptz NOT NULL,
  PRIMARY KEY (account_id, machine_id)
);
`,
};

const maxBatch = 10;
/** Events handled per transaction. */
const maxChunk = 100;
const maxRounds = 8;

/** How old an event may be for `retainMs`: the retention less a margin (a quarter, an hour at most). */
export const maxEventAgeMs = (retainMs: number): number => retainMs - Math.min(3_600_000, retainMs / 4);

/** Whether a client reads provider events. */
const polls = (client: ProviderImpl): boolean => typeof client.pollEvents === 'function';

export function providerEventsReconciler(
  options: ProviderEventsOptions,
  deps: (context: ModuleContext) => InstanceDeps,
): Reconciler {
  const waitMs = Math.max(0, Math.min(10_000, options.waitMs ?? 10_000));
  const budgetMs = Math.max(1_000, options.budgetMs ?? 12_000);
  const retainMs = Math.max(60_000, options.retainMs ?? 86_400_000);
  return {
    name: providerEventsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.every ?? '15s' }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seedAccounts(resolved, context, retainMs);
      else await pollAccount(resolved, context, key, { waitMs, budgetMs, maxAgeMs: maxEventAgeMs(retainMs) });
      return 'DONE';
    },
  };
}

async function seedAccounts(
  deps: InstanceDeps,
  context: ReconcileContext,
  retainMs: number,
): Promise<void> {
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT id FROM provider_accounts ORDER BY id`,
  );
  const polling: string[] = [];
  for (const { id } of rows) {
    // Building a client validates the config and calls no provider API (clients are cached).
    try {
      const account = await context.sql.transaction((tx) => readAccount(tx, id));
      if (account && polls(await deps.clients.client(account, deps))) polling.push(id);
    } catch (error) {
      deps.log.warn('vps.provider-events: skipping a provider account whose client cannot be built', {
        accountId: id,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
  await context.sql.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM provider_event_seen WHERE seen_at < compute_now() - make_interval(secs => $1::float8)`,
      [retainMs / 1000],
    );
    // A pending interruption whose machine is no live instance or joined node any more (terminated,
    // deleted) has nothing left to clear. One that may still run again is kept, however long.
    await tx.query(
      `DELETE FROM provider_interruptions p
        WHERE p.deadline < compute_now()
          AND NOT EXISTS (SELECT 1 FROM instances i
                           WHERE i.provider_account_id = p.account_id AND i.external_id = p.machine_id
                             AND NOT i.draft AND i.state <> 'deleted')
          AND NOT EXISTS (SELECT 1 FROM provider_bootstraps b
                           WHERE b.account_id = p.account_id AND b.machine_id = p.machine_id
                             AND b.state = 'joined')`,
    );
    if (polling.length === 0) return;
    if (context.work.enqueueMany) await context.work.enqueueMany(tx, providerEventsWork, polling);
    else for (const id of polling) await context.work.enqueue(tx, providerEventsWork, id);
  });
}

async function pollAccount(
  deps: InstanceDeps,
  context: ReconcileContext,
  accountId: string,
  limits: { waitMs: number; budgetMs: number; maxAgeMs: number },
): Promise<void> {
  const account = await context.sql.transaction((tx) => readAccount(tx, accountId));
  if (!account) return;
  const client = await deps.clients.client(account, deps);
  if (!client.pollEvents) return;
  const started = Date.now();
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(limits.budgetMs + 5_000)]);
  const call: CallContext = {
    idempotencyKey: `events:${account.id}`,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  for (let round = 0; round < maxRounds; round++) {
    const left = limits.budgetMs - (Date.now() - started);
    if (left <= 0) break;
    let batch;
    try {
      batch = await client.pollEvents(call, {
        waitMs: Math.min(limits.waitMs, Math.max(0, left - 1_000)),
        max: maxBatch,
      });
    } catch (error) {
      const retryAfterMs = isComputeError(error, 'RATE_LIMITED') ? error.retryAfterMs : undefined;
      if (retryAfterMs !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, providerEventsWork, account.id, {
            notBefore: deps.clock.now() + retryAfterMs,
          }),
        );
      deps.log.warn('vps.provider-events: polling a provider account failed', {
        accountId: account.id,
        error: String((error as Error)?.message ?? error),
      });
      return;
    }
    // Every event, in chunks of at most `maxChunk`, each in its own transaction (one Health message
    // can name hundreds of instances). A failure leaves the batch unacked to come again: the ids
    // already committed are in provider_event_seen, so the retry handles only the rest.
    const events = batch.events;
    for (let start = 0; start < events.length; start += maxChunk) {
      const chunk = events.slice(start, start + maxChunk);
      await context.sql.transaction((tx) =>
        handleEvents(deps, tx, account, chunk, { maxAgeMs: limits.maxAgeMs }),
      );
    }
    // Only after every chunk committed: a failure above leaves the batch to come again.
    try {
      await batch.ack();
    } catch (error) {
      deps.log.warn('vps.provider-events: acknowledging provider events failed', {
        accountId: account.id,
        error: String((error as Error)?.message ?? error),
      });
      return;
    }
    // Messages, not events: ten forged messages mapped to nothing may still have more behind them,
    // and one message naming many instances says nothing about what is left.
    const received = Number.isFinite(batch.received) ? batch.received! : events.length;
    if (received < maxBatch) break;
  }
}

interface Target {
  instanceId?: string;
  /** The node a joined provider bootstrap of this machine became. */
  nodeId?: string;
}

/**
 * Some events in one transaction: events older than `maxAgeMs` (default 23 h) are dropped, then
 * new ids only (`provider_event_seen`; a repeated id's `seen_at` is refreshed, so an id that keeps
 * coming, like a still-scheduled event the no-queue scan reports every 5 minutes, stays seen), then
 * each event's effect on the live instance or joined node its machine is. Returns the ids handled.
 */
export async function handleEvents(
  deps: InstanceDeps,
  tx: SqlTx,
  account: Pick<ProviderAccount, 'id' | 'tenantId' | 'provider'>,
  events: readonly ProviderEvent[],
  options: { maxAgeMs?: number } = {},
): Promise<string[]> {
  const oldest = deps.clock.now() - (options.maxAgeMs ?? maxEventAgeMs(86_400_000));
  const byId = new Map<string, ProviderEvent>();
  let stale = 0;
  for (const event of events) {
    if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 256 || byId.has(event.id))
      continue;
    // A redelivery after an outage, a DLQ redrive or lost acks: its id may be pruned by now.
    if (!Number.isFinite(event.at) || event.at < oldest) stale += 1;
    else byId.set(event.id, event);
  }
  if (stale > 0)
    deps.log.warn('vps.provider-events: dropped provider events older than the seen-id retention', {
      accountId: account.id,
      stale,
    });
  if (byId.size === 0) return [];
  await tx.query(
    `UPDATE provider_event_seen SET seen_at = compute_now()
      WHERE account_id = $1 AND event_id = ANY($2::text[])`,
    [account.id, [...byId.keys()]],
  );
  const { rows: fresh } = await tx.query<{ event_id: string }>(
    `INSERT INTO provider_event_seen (account_id, event_id)
     SELECT $1, e FROM unnest($2::text[]) AS e ON CONFLICT DO NOTHING RETURNING event_id`,
    [account.id, [...byId.keys()]],
  );
  const handled = [...byId.keys()].filter((id) => fresh.some((row) => row.event_id === id));
  if (handled.length === 0) return [];
  const todo = handled.map((id) => byId.get(id)!);

  const machines = [
    ...new Set(todo.map((event) => event.machineId).filter((id): id is string => typeof id === 'string')),
  ];
  const targets = new Map<string, Target>();
  if (machines.length > 0) {
    const { rows: instances } = await tx.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM instances
        WHERE provider_account_id = $1 AND external_id = ANY($2::text[]) AND NOT draft AND state <> 'deleted'
        ORDER BY id`,
      [account.id, machines],
    );
    for (const row of instances) targets.set(row.external_id, { instanceId: row.id });
    const { rows: nodes } = await tx.query<{ machine_id: string; node_id: string }>(
      `SELECT machine_id, node_id FROM provider_bootstraps
        WHERE account_id = $1 AND machine_id = ANY($2::text[]) AND state = 'joined' AND node_id IS NOT NULL
        ORDER BY id`,
      [account.id, machines],
    );
    for (const row of nodes)
      targets.set(row.machine_id, { ...targets.get(row.machine_id), nodeId: row.node_id });
  }

  const wake = new Set<string>();
  let reservations = false;
  for (const event of todo) {
    if (event.kind === 'reservation-changed') {
      reservations = true;
      continue;
    }
    const target = event.machineId === undefined ? undefined : targets.get(event.machineId);
    if (!target) continue;
    switch (event.kind) {
      case 'machine-changed':
        if (event.details?.state === 'running') await interruptionOver(deps, tx, account, event, target);
        if (target.instanceId) wake.add(target.instanceId);
        break;
      case 'api-call':
        if (target.instanceId) wake.add(target.instanceId);
        break;
      case 'interruption-warning':
        // Past its deadline the machine is reclaimed (or stopped and back): the reconcile reads
        // which, and nothing is marked, tainted or cut on a warning that is over.
        if (interruptionDeadline(event) > deps.clock.now())
          await interruption(deps, tx, account, event, target);
        if (target.instanceId) wake.add(target.instanceId);
        break;
      case 'rebalance-recommended':
        if (target.instanceId)
          await conditionEvent(deps, tx, target.instanceId, event, {
            set: {
              type: rebalanceCondition,
              status: 'true',
              reason: 'RebalanceRecommended',
              message: 'the provider recommends moving work off this machine (elevated interruption risk)',
            },
            type: 'instance.rebalance-recommended',
          });
        break;
      case 'maintenance-scheduled':
        if (target.instanceId) await maintenance(deps, tx, target.instanceId, event);
        break;
      case 'health':
        if (target.instanceId)
          await conditionEvent(deps, tx, target.instanceId, event, { type: 'instance.health' });
        break;
    }
  }
  if (wake.size > 0) {
    const keys = [...wake].sort();
    if (deps.work.enqueueMany) await deps.work.enqueueMany(tx, instanceWork, keys);
    else for (const key of keys) await deps.work.enqueue(tx, instanceWork, key);
  }
  if (reservations) await deps.work.enqueue(tx, reservationsWork, account.id);
  return handled;
}

/**
 * The provider's short facts as tenants may see them: at most 8 string entries of printable text,
 * keys up to 64 and values up to 128 characters; anything else is left out.
 */
export function eventDetails(details: ProviderEvent['details']): Record<string, string> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (Object.keys(out).length >= 8) break;
    if (!/^[A-Za-z][\w.-]{0,63}$/.test(key) || typeof value !== 'string') continue;
    if (value.length === 0 || value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Event data: the account, the machine, the deadline and the provider's short facts. */
function eventData(event: ProviderEvent, accountId: string): Record<string, Json> {
  const details = eventDetails(event.details);
  return {
    accountId,
    ...(event.machineId !== undefined ? { machineId: event.machineId } : {}),
    ...(Number.isFinite(event.deadline) ? { deadline: event.deadline! } : {}),
    ...(details ? { details } : {}),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Sets (or clears) one condition on a locked instance and publishes `type`. */
async function conditionEvent(
  deps: InstanceDeps,
  tx: SqlTx,
  instanceId: string,
  event: ProviderEvent,
  change: {
    set?: Omit<Condition, 'since'>;
    clear?: string;
    type: string;
  },
  accountId?: string,
): Promise<void> {
  const row = await readInstance(tx, instanceId, { lock: true });
  if (!row || row.state === 'deleted') return;
  let conditions = row.conditions;
  if (change.set) conditions = withCondition(conditions, change.set, deps.clock.now());
  if (change.clear) conditions = withoutCondition(conditions, change.clear);
  if (change.set || change.clear)
    // No version bump (like DiskTypeUnknown): the row is locked and nothing a tenant edits changes.
    await tx.query(`UPDATE instances SET conditions = $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify(conditions),
    ]);
  await publishInstance(deps, tx, { ...row, conditions }, change.type, {
    instanceId: row.id,
    ...eventData(event, accountId ?? row.providerAccountId ?? ''),
  });
}

async function maintenance(
  deps: InstanceDeps,
  tx: SqlTx,
  instanceId: string,
  event: ProviderEvent,
): Promise<void> {
  const facts = eventDetails(event.details);
  const status = facts?.status ?? 'scheduled';
  const over = /^(completed|canceled|cancelled|closed|resolved)$/i.test(status);
  const when = event.deadline === undefined ? 'soon' : `at ${iso(event.deadline)}`;
  await conditionEvent(
    deps,
    tx,
    instanceId,
    event,
    over
      ? { clear: maintenanceCondition, type: 'instance.maintenance' }
      : {
          set: {
            type: maintenanceCondition,
            status: 'true',
            reason: facts?.code?.slice(0, 64) ?? 'Scheduled',
            message: `the provider scheduled maintenance of this machine ${when}`,
          },
          type: 'instance.maintenance',
        },
  );
}

/** An interruption's deadline: the provider's, or its time when it names none. */
const interruptionDeadline = (event: ProviderEvent): number =>
  Number.isFinite(event.deadline) ? event.deadline! : event.at;

async function interruption(
  deps: InstanceDeps,
  tx: SqlTx,
  account: Pick<ProviderAccount, 'id' | 'provider'>,
  event: ProviderEvent,
  target: Target,
): Promise<void> {
  const deadline = interruptionDeadline(event);
  // Remembered until the machine is seen running after the deadline (stop or hibernate).
  await tx.query(
    `INSERT INTO provider_interruptions (account_id, machine_id, deadline) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (account_id, machine_id) DO UPDATE
       SET deadline = GREATEST(provider_interruptions.deadline, EXCLUDED.deadline)`,
    [account.id, event.machineId, iso(deadline)],
  );
  if (target.instanceId)
    await conditionEvent(
      deps,
      tx,
      target.instanceId,
      event,
      {
        set: {
          type: interruptionCondition,
          status: 'true',
          reason: 'SpotInterruption',
          message: `the provider reclaims this machine at ${iso(deadline)}`,
        },
        type: 'instance.interruption',
      },
      account.id,
    );
  if (!target.nodeId) return;
  // Reservations first, then the node (reservation → node → node_resources, the placer's and host
  // sync's lock order; noticeNodeInterruption locks the node before any release): each holding the
  // node past the deadline gets the spot notice, so it ends by then or is placed again elsewhere.
  const noticed = await noticeNodeInterruption(deps, tx, target.nodeId, deadline, {
    reason: 'ProviderInterruption',
    message: `the machine behind node ${target.nodeId} is reclaimed by its provider at ${iso(deadline)}`,
    data: { reason: 'interruption' },
  });
  const taint = `taint:${interruptionTaintKey(account.provider)}`;
  const { rows } = await tx.query<{ owner_tenant_id: string; no_schedule_reasons: string[] }>(
    `SELECT owner_tenant_id, no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE`,
    [target.nodeId],
  );
  const node = rows[0];
  if (!node || node.no_schedule_reasons.includes(taint)) return;
  await tx.query(
    `UPDATE nodes SET no_schedule_reasons = $2::text[], version = version + 1 WHERE id = $1`,
    [target.nodeId, [...new Set([...node.no_schedule_reasons, taint])].sort()],
  );
  await deps.events.publish(tx, {
    type: 'node.tainted',
    tenantId: node.owner_tenant_id,
    subject: `node/${target.nodeId}`,
    data: {
      nodeId: target.nodeId,
      added: [interruptionTaintKey(account.provider)],
      removed: [],
      reason: 'interruption',
      deadline,
      reservations: noticed,
    },
  });
}

/**
 * The machine runs again after a pending interruption's deadline (EC2 `instance-action` stop or
 * hibernate, the instance id kept): the instance loses `InterruptionPending` and
 * `RebalanceRecommended`, and the node it backs the interruption taint (`node.tainted` with the
 * key in `removed`). A running change from before the deadline (delivered out of order) clears
 * nothing. Locks the instance, then the node.
 */
async function interruptionOver(
  deps: InstanceDeps,
  tx: SqlTx,
  account: Pick<ProviderAccount, 'id' | 'provider'>,
  event: ProviderEvent,
  target: Target,
): Promise<void> {
  const { rowCount } = await tx.query(
    `DELETE FROM provider_interruptions
      WHERE account_id = $1 AND machine_id = $2 AND deadline < $3::timestamptz`,
    [account.id, event.machineId, iso(event.at)],
  );
  if (!rowCount) return;
  if (target.instanceId) {
    const row = await readInstance(tx, target.instanceId, { lock: true });
    if (row && row.state !== 'deleted') {
      const conditions = withoutCondition(withoutCondition(row.conditions, interruptionCondition), rebalanceCondition);
      if (conditions.length !== row.conditions.length)
        // No version bump, as when the conditions were set.
        await tx.query(`UPDATE instances SET conditions = $2::jsonb WHERE id = $1`, [
          row.id,
          JSON.stringify(conditions),
        ]);
    }
  }
  if (!target.nodeId) return;
  const key = interruptionTaintKey(account.provider);
  const { rows } = await tx.query<{ owner_tenant_id: string; no_schedule_reasons: string[] }>(
    `SELECT owner_tenant_id, no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE`,
    [target.nodeId],
  );
  const node = rows[0];
  if (!node || !node.no_schedule_reasons.includes(`taint:${key}`)) return;
  await tx.query(
    `UPDATE nodes SET no_schedule_reasons = $2::text[], version = version + 1 WHERE id = $1`,
    [target.nodeId, node.no_schedule_reasons.filter((reason) => reason !== `taint:${key}`)],
  );
  await deps.events.publish(tx, {
    type: 'node.tainted',
    tenantId: node.owner_tenant_id,
    subject: `node/${target.nodeId}`,
    data: { nodeId: target.nodeId, added: [], removed: [key], reason: 'interruption-over' },
  });
}
