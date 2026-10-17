import {
  ComputeError,
  isComputeError,
  parseDuration,
  type CallContext,
  type Duration,
  type ExternalMachine,
  type Json,
  type Migration,
  type ModuleContext,
  type ProviderImpl,
  type ReconcileContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderAccount } from './accounts.js';
import { canonical } from './input.js';
import { instanceWork, type InstanceDeps } from './instances.js';

// Provider machines (R5, D8): the `vps.discovery` worker lists every machine each provider account
// can see (`ProviderImpl.discover`) into `provider_machines`, links the ones better-compute created
// or attached to their instance, and marks the ones that disappeared `gone`. It only reads the
// provider. Key `all` (periodic) seeds one `provider_discovery` row per account whose provider can
// discover and enqueues the accounts that are due; key `<accountId>` runs one account's pass:
// `discover` outside any transaction (45 s budget), then one transaction that writes the machines
// and publishes provider.machine.discovered / changed / gone.

/** The work kind of the discovery reconciler (keys: `all`, or a provider account id). */
export const discoveryWork = 'vps.discovery';

/** How long one account's `discover` may run (a reconciler run stays under claimTtlMs, 60 s). */
export const discoveryBudgetMs = 45_000;
/** Machines written per statement. */
const batchSize = 500;

export interface DiscoveryOptions {
  /** How often each account is listed (default `5m`). */
  every?: Duration;
  /**
   * Label-driven auto-attach (default off): a free machine labelled `better-compute-tenant=<t>`
   * and `better-compute-pool=<p>` is attached to that tenant's pool, owned by the label
   * `better-compute-owner` or else this identity.
   */
  autoAttach?: { ownerIdentityId: string } | false;
}

export const providerMachinesMigration: Migration = {
  name: 'vps/0023_provider_machines',
  sql: `
CREATE TABLE provider_machines (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  external_id text NOT NULL,
  -- The ExternalMachine as last seen.
  machine jsonb NOT NULL,
  -- The attached or created instance; NULL when free.
  instance_id text REFERENCES instances,
  first_seen_at timestamptz NOT NULL DEFAULT compute_now(),
  last_seen_at timestamptz NOT NULL,
  gone_at timestamptz,
  PRIMARY KEY (account_id, external_id)
);
CREATE INDEX provider_machines_free ON provider_machines (account_id) WHERE instance_id IS NULL AND gone_at IS NULL;
-- The next discovery pass per account.
CREATE TABLE provider_discovery (
  account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL,
  last_ok_at timestamptz,
  last_error text
);
`,
};

/** A machine as `providerAccounts.machines` shows it. */
export interface ProviderMachineView {
  accountId: string;
  externalId: string;
  name?: string;
  state: ExternalMachine['state'];
  zone?: string;
  region?: string;
  machineType?: string;
  vcpu?: number;
  memoryGiB?: number;
  gpus?: { model: string; count: number };
  labels: Record<string, string>;
  networks: NonNullable<ExternalMachine['networks']>;
  reservation?: string;
  addresses: string[];
  /** Set when attached or created by better-compute. */
  instanceId?: string;
  tenantId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  goneAt?: number;
}

/** A machine as stored: the ExternalMachine, plus what auto-attach last recorded about it. */
export type StoredMachine = ExternalMachine & {
  autoAttachError?: { code: string; message: string; at: number };
};

/** What the discovery reconciler needs beyond its context. */
export type DiscoveryDeps = InstanceDeps;

/** The machine as JSON (undefined members dropped), as `provider_machines.machine` holds it. */
function stored(machine: ExternalMachine): StoredMachine {
  return JSON.parse(JSON.stringify(machine)) as StoredMachine;
}

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

/** Which of the watched fields (state, shape, networks, claimedBy) differ between two sightings. */
export function machineChanges(before: ExternalMachine, after: ExternalMachine): string[] {
  // Canonical JSON: jsonb hands keys back in its own order.
  const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
  const changes: string[] = [];
  if (before.state !== after.state) changes.push('state');
  if (
    !same(
      [before.machineType, before.vcpu, before.memoryGiB, before.gpus],
      [after.machineType, after.vcpu, after.memoryGiB, after.gpus],
    )
  )
    changes.push('shape');
  if (!same(before.networks, after.networks) || !same(before.addresses, after.addresses))
    changes.push('networks');
  if (!same(before.claimedBy, after.claimedBy)) changes.push('claimedBy');
  return changes;
}

async function publishMachine(
  deps: Pick<DiscoveryDeps, 'events'>,
  tx: SqlTx,
  account: Pick<ProviderAccount, 'id' | 'tenantId'>,
  type: string,
  data: Record<string, Json>,
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: account.tenantId,
    subject: `provider-account/${account.id}`,
    data: { accountId: account.id, ...data },
  });
}

/** Whether a client lists the account's machines. */
const discovers = (client: ProviderImpl): boolean => typeof client.discover === 'function';

/** Key `all`: seeds a row per discovering account, then enqueues the accounts that are due. */
async function seedAccounts(deps: DiscoveryDeps, context: ReconcileContext): Promise<void> {
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT id FROM provider_accounts ORDER BY id`,
  );
  const discovering: string[] = [];
  for (const { id } of rows) {
    // Building a client validates the config and calls no provider API.
    try {
      const account = await context.sql.transaction((tx) => readAccount(tx, id));
      if (account && discovers(await deps.clients.client(account, deps))) discovering.push(id);
    } catch (error) {
      deps.log.warn('vps.discovery: skipping a provider account whose client cannot be built', {
        accountId: id,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
  await context.sql.transaction(async (tx) => {
    if (discovering.length > 0)
      await tx.query(
        `INSERT INTO provider_discovery (account_id, next_at)
         SELECT a, compute_now() FROM unnest($1::text[]) AS a ON CONFLICT DO NOTHING`,
        [discovering],
      );
    const due = await tx.query<{ account_id: string }>(
      `SELECT account_id FROM provider_discovery
        WHERE next_at <= compute_now() AND account_id = ANY($1::text[]) ORDER BY account_id`,
      [discovering],
    );
    const ids = due.rows.map((row) => row.account_id);
    if (ids.length === 0) return;
    if (context.work.enqueueMany) await context.work.enqueueMany(tx, discoveryWork, ids);
    else for (const id of ids) await context.work.enqueue(tx, discoveryWork, id);
  });
}

interface MachineRow {
  external_id: string;
  machine: StoredMachine | string;
  instance_id: string | null;
  gone_at: Date | null;
}

/**
 * Writes one pass of an account (in its transaction): every machine seen is upserted (seen now,
 * not gone, linked to its live instance), the rest of the account's machines are marked gone, and
 * each first sighting, change and disappearance is published.
 */
async function recordPass(
  deps: DiscoveryDeps,
  tx: SqlTx,
  account: ProviderAccount,
  machines: readonly ExternalMachine[],
  everyMs: number,
): Promise<Map<string, StoredMachine>> {
  const previous = new Map<string, MachineRow>();
  const { rows } = await tx.query<MachineRow>(
    `SELECT external_id, machine, instance_id, gone_at FROM provider_machines
      WHERE account_id = $1 FOR UPDATE`,
    [account.id],
  );
  for (const row of rows) previous.set(row.external_id, row);
  // A provider that lists a machine twice: the last sighting wins.
  const seen = new Map<string, ExternalMachine>();
  for (const machine of machines) seen.set(machine.id, machine);
  const entries = [...seen.values()];
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize);
    await tx.query(
      `INSERT INTO provider_machines (account_id, external_id, machine, instance_id, last_seen_at)
       SELECT $1, m->>'id', m,
              (SELECT i.id FROM instances i
                WHERE i.provider_account_id = $1 AND i.external_id = m->>'id' AND i.state <> 'deleted'
                ORDER BY i.id LIMIT 1),
              compute_now()
         FROM jsonb_array_elements($2::jsonb) AS m
       ON CONFLICT (account_id, external_id) DO UPDATE
         SET machine = EXCLUDED.machine, instance_id = EXCLUDED.instance_id,
             last_seen_at = EXCLUDED.last_seen_at, gone_at = NULL`,
      [account.id, JSON.stringify(batch.map(stored))],
    );
  }
  const gone = await tx.query<{ external_id: string; instance_id: string | null }>(
    `UPDATE provider_machines SET gone_at = compute_now()
      WHERE account_id = $1 AND gone_at IS NULL AND NOT (external_id = ANY($2::text[]))
      RETURNING external_id, instance_id`,
    [account.id, [...seen.keys()]],
  );
  await tx.query(
    `UPDATE provider_discovery
        SET next_at = compute_now() + make_interval(secs => $2::float8), last_ok_at = compute_now(),
            last_error = NULL
      WHERE account_id = $1`,
    [account.id, everyMs / 1000],
  );

  for (const machine of entries) {
    const before = previous.get(machine.id);
    if (!before || before.gone_at !== null) {
      await publishMachine(deps, tx, account, 'provider.machine.discovered', {
        externalId: machine.id,
        machineType: machine.machineType ?? null,
        gpus: machine.gpus ? { ...machine.gpus } : null,
      });
      continue;
    }
    const changes = machineChanges(json(before.machine), machine);
    if (changes.length > 0)
      await publishMachine(deps, tx, account, 'provider.machine.changed', {
        externalId: machine.id,
        changes,
      });
  }
  for (const row of gone.rows) {
    await publishMachine(deps, tx, account, 'provider.machine.gone', {
      externalId: row.external_id,
      ...(row.instance_id !== null ? { instanceId: row.instance_id } : {}),
    });
    // Its instance learns it is gone now, not at its next steady poll.
    if (row.instance_id !== null) await deps.work.enqueue(tx, instanceWork, row.instance_id);
  }
  return new Map([...previous].map(([id, row]) => [id, json(row.machine)]));
}

async function recordFailure(
  tx: SqlTx,
  accountId: string,
  error: unknown,
  retryInMs: number,
): Promise<void> {
  const code = isComputeError(error) ? error.code : 'PROVIDER_ERROR';
  const message = String((error as Error)?.message ?? error).slice(0, 500);
  await tx.query(
    `UPDATE provider_discovery
        SET next_at = compute_now() + make_interval(secs => $2::float8), last_error = $3
      WHERE account_id = $1`,
    [accountId, retryInMs / 1000, `${code}: ${message}`],
  );
}

/** Key `<accountId>`: one discovery pass of one account. */
async function discoverAccount(
  deps: DiscoveryDeps,
  context: ReconcileContext,
  accountId: string,
  everyMs: number,
  after?: (account: ProviderAccount, previous: Map<string, StoredMachine>) => Promise<void>,
): Promise<void> {
  const account = await context.sql.transaction((tx) => readAccount(tx, accountId));
  if (!account) return;
  const client = await deps.clients.client(account, deps);
  if (!client.discover) return;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(discoveryBudgetMs)]);
  const call: CallContext = {
    idempotencyKey: `discovery:${account.id}`,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  const machines: ExternalMachine[] = [];
  try {
    for await (const machine of client.discover(call)) {
      if (signal.aborted)
        throw new ComputeError('UNAVAILABLE', `Listing ${account.name} took over 45 s`);
      machines.push(machine);
    }
  } catch (failure) {
    const error =
      signal.aborted && !isComputeError(failure)
        ? new ComputeError('UNAVAILABLE', `Listing ${account.name} took over 45 s`)
        : failure;
    const retryAfterMs = isComputeError(error, 'RATE_LIMITED') ? error.retryAfterMs : undefined;
    await context.sql.transaction(async (tx) => {
      // Rate limited: this account again after the provider's back-off; the worker goes on.
      if (retryAfterMs !== undefined) {
        await recordFailure(tx, account.id, error, retryAfterMs);
        await context.work.enqueue(tx, discoveryWork, account.id, {
          notBefore: deps.clock.now() + retryAfterMs,
        });
      } else await recordFailure(tx, account.id, error, everyMs);
    });
    deps.log.warn('vps.discovery: listing a provider account failed', {
      accountId: account.id,
      error: String((error as Error)?.message ?? error),
    });
    return;
  }
  const previous = await context.sql.transaction((tx) =>
    recordPass(deps, tx, account, machines, everyMs),
  );
  await after?.(account, previous);
}

/**
 * The `vps.discovery` reconciler (shardBy none): key `all` every `options.every`, and one key per
 * account. `deps` builds what it needs from the run's context (the module's provider clients).
 */
export function discoveryReconciler(
  options: DiscoveryOptions,
  deps: (context: ModuleContext) => DiscoveryDeps,
  hooks: {
    /** Runs after an account's pass committed (auto-attach). */
    afterPass?: (
      context: ReconcileContext,
      account: ProviderAccount,
      previous: Map<string, StoredMachine>,
    ) => Promise<void>;
  } = {},
): Reconciler {
  const every = options.every ?? '5m';
  const everyMs = parseDuration(every);
  return {
    name: discoveryWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seedAccounts(resolved, context);
      else
        await discoverAccount(
          resolved,
          context,
          key,
          everyMs,
          hooks.afterPass
            ? (account, previous) => hooks.afterPass!(context, account, previous)
            : undefined,
        );
      return 'DONE';
    },
  };
}
