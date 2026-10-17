import {
  ComputeError,
  isComputeError,
  parseDuration,
  strictObject,
  type CallContext,
  type Caller,
  type Duration,
  type InputSchema,
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
import { attachMachine, parseAttach } from './attach.js';
import { canonical, fail, id, int, object, optional, tenant } from './input.js';
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
/**
 * How early an account counts as due: its pass ran a little after the `all` tick that enqueued
 * it, so without slack the next tick (one period later) would find it just short and skip it.
 */
const dueSlackMs = (everyMs: number) => Math.min(everyMs / 10, 30_000);

async function seedAccounts(
  deps: DiscoveryDeps,
  context: ReconcileContext,
  everyMs: number,
): Promise<void> {
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
        WHERE next_at <= compute_now() + make_interval(secs => $2::float8)
          AND account_id = ANY($1::text[]) ORDER BY account_id`,
      [discovering, dueSlackMs(everyMs) / 1000],
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
  /** When the pass started (`compute_now()` as text): the next one is due a period after it. */
  startedAt: string,
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
        SET next_at = $3::timestamptz + make_interval(secs => $2::float8), last_ok_at = compute_now(),
            last_error = NULL
      WHERE account_id = $1`,
    [account.id, everyMs / 1000, startedAt],
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
  const { rows: started } = await context.sql.query<{ at: string }>(
    `SELECT compute_now()::text AS at`,
  );
  const startedAt = started[0]!.at;
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
    recordPass(deps, tx, account, machines, everyMs, startedAt),
  );
  await after?.(account, previous);
}

// --- Label-driven auto-attach (opt-in, D8) -----------------------------------------------------

/** GCE-style labels that ask for a machine to be attached. */
export const autoAttachLabels = {
  tenant: 'better-compute-tenant',
  pool: 'better-compute-pool',
  owner: 'better-compute-owner',
} as const;

/** `autoAttachError.code` of a machine labelled for a tenant its account may not serve. */
export const autoAttachRefused = 'AUTO_ATTACH_REFUSED';

async function recordAutoAttachError(
  context: ReconcileContext,
  accountId: string,
  externalId: string,
  error: { code: string; message: string },
): Promise<void> {
  await context.sql.transaction((tx) =>
    tx.query(
      `UPDATE provider_machines
          SET machine = machine || jsonb_build_object('autoAttachError', $3::jsonb)
        WHERE account_id = $1 AND external_id = $2`,
      [
        accountId,
        externalId,
        JSON.stringify({ ...error, message: error.message.slice(0, 500), at: context.clock.now() }),
      ],
    ),
  );
}

/**
 * After an account's pass: every free machine labelled with both `better-compute-tenant` and
 * `better-compute-pool` is attached to that tenant's pool (`onDelete: 'detach'`), each in its own
 * transaction. A label may name only the account's own tenant, unless the platform owns the
 * account. Failures are recorded on the machine (`machine.autoAttachError`), never the pass.
 */
async function autoAttach(
  deps: DiscoveryDeps,
  context: ReconcileContext,
  settings: { ownerIdentityId: string },
  account: ProviderAccount,
  previous: Map<string, StoredMachine>,
): Promise<void> {
  const rootTenantId = context.iam.rootTenantId;
  const { rows } = await context.sql.query<{
    external_id: string;
    machine: StoredMachine | string;
  }>(
    `SELECT external_id, machine FROM provider_machines
      WHERE account_id = $1 AND instance_id IS NULL AND gone_at IS NULL ORDER BY external_id`,
    [account.id],
  );
  for (const row of rows) {
    const machine = json(row.machine);
    const labels = machine.labels ?? {};
    const tenantId = labels[autoAttachLabels.tenant];
    const poolId = labels[autoAttachLabels.pool];
    if (tenantId === undefined || poolId === undefined) continue;
    // A machine whose ownership label names an instance belongs to someone already.
    if (machine.claimedBy !== undefined) continue;
    const platformAccount = rootTenantId !== undefined && account.tenantId === rootTenantId;
    if (tenantId !== account.tenantId && !platformAccount) {
      if (previous.get(row.external_id)?.autoAttachError?.code !== autoAttachRefused)
        await context.sql.transaction((tx) =>
          publishMachine(deps, tx, account, 'provider.machine.changed', {
            externalId: row.external_id,
            changes: ['autoAttachRefused'],
          }),
        );
      await recordAutoAttachError(context, account.id, row.external_id, {
        code: autoAttachRefused,
        message: `Provider account ${account.id} of tenant ${account.tenantId} cannot attach machines to tenant ${tenantId}`,
      });
      continue;
    }
    // The platform's own service identity attaches (its tenant: the root tenant, else the account's).
    const caller: Caller = {
      identityId: settings.ownerIdentityId,
      identityKind: 'service',
      tenantId: rootTenantId ?? account.tenantId,
      sessionId: 'vps.discovery',
      sessionKind: 'role',
      mfa: false,
    };
    try {
      const input = parseAttach({
        tenantId,
        poolId,
        externalId: row.external_id,
        ownerIdentityId: labels[autoAttachLabels.owner] ?? settings.ownerIdentityId,
        onDelete: 'detach',
        // A key the API would refuse ('/' in machine ids) is fine here: it only derives the id.
        idempotencyKey: 'auto-attach',
      });
      await context.sql.transaction((tx) =>
        attachMachine(
          tx,
          {
            events: deps.events,
            work: deps.work,
            authz: deps.authz,
            runtime: deps.runtime,
            ...(rootTenantId !== undefined ? { rootTenantId } : {}),
          },
          {
            ...input,
            // Per account: one machine id may exist in several accounts.
            idempotencyKey: `auto:${account.id}:${row.external_id}`,
            caller,
            accountId: account.id,
          },
        ),
      );
    } catch (error) {
      await recordAutoAttachError(context, account.id, row.external_id, {
        code: isComputeError(error) ? error.code : 'INTERNAL_ERROR',
        message: String((error as Error)?.message ?? error),
      });
    }
  }
}

/**
 * The `vps.discovery` reconciler (shardBy none): key `all` every `options.every`, and one key per
 * account. `deps` builds what it needs from the run's context (the module's provider clients).
 */
export function discoveryReconciler(
  options: DiscoveryOptions,
  deps: (context: ModuleContext) => DiscoveryDeps,
): Reconciler {
  const every = options.every ?? '5m';
  const everyMs = parseDuration(every);
  const settings = options.autoAttach || undefined;
  if (settings !== undefined && !/^[A-Za-z0-9._:@-]{1,128}$/.test(String(settings.ownerIdentityId)))
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ discovery: { autoAttach } }).ownerIdentityId must be an identity id',
    );
  return {
    name: discoveryWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seedAccounts(resolved, context, everyMs);
      else
        await discoverAccount(
          resolved,
          context,
          key,
          everyMs,
          settings
            ? (account, previous) => autoAttach(resolved, context, settings, account, previous)
            : undefined,
        );
      return 'DONE';
    },
  };
}

// --- API: providerAccounts.machines and providerAccounts.discover ---------------------------------

export interface ListMachinesInput {
  tenantId: string;
  accountId: string;
  /** `free` (default): not attached; `attached`: attached or created by better-compute; `all`. */
  filter: 'free' | 'attached' | 'all';
  includeGone: boolean;
  cursor?: string;
  limit: number;
}

export interface DiscoverInput {
  tenantId: string;
  accountId: string;
  /**
   * `wait: true` holds the answer until a pass that started after the call has finished, through
   * the envelope's async-with-wait (at most 30 s).
   */
  wait?: { timeoutMs: number };
  /** Set by the handler: when the pass was asked for (`compute_now()`, epoch ms). */
  requestedAt?: number;
}

const tenantField: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant that owns the provider account',
};
const accountField: InputSchema = {
  type: 'string',
  pattern: '^pacct_[0-9a-hjkmnp-tv-z]{26,52}$',
  maxLength: 58,
  description: 'The provider account',
};

export const discoverySchemas = {
  listMachines: strictObject(
    {
      tenantId: tenantField,
      accountId: accountField,
      filter: {
        enum: ['free', 'attached', 'all'],
        default: 'free',
        description: 'free: not attached; attached: attached to or created as an instance; all',
      },
      includeGone: {
        type: 'boolean',
        default: false,
        description: 'Also list machines the provider no longer reports',
      },
      cursor: { type: 'string', maxLength: 1024, description: 'From the previous page' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    },
    ['tenantId', 'accountId'],
  ),
  discover: strictObject(
    {
      tenantId: tenantField,
      accountId: accountField,
      wait: {
        type: 'boolean',
        default: false,
        description: 'Hold the answer (at most 30 s) until a pass started after the call finished',
      },
    },
    ['tenantId', 'accountId'],
  ),
};

const cursorOf = (zone: string, externalId: string) =>
  Buffer.from(JSON.stringify([zone, externalId])).toString('base64url');

function parseCursor(value: unknown): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === 'string')
    )
      return parsed as [string, string];
  } catch {
    // Falls through to the refusal.
  }
  fail('cursor is invalid');
}

export function parseListMachines(raw: unknown): ListMachinesInput {
  const input = object(raw, ['tenantId', 'accountId', 'filter', 'includeGone', 'cursor', 'limit']);
  if (
    input.filter !== undefined &&
    input.filter !== 'free' &&
    input.filter !== 'attached' &&
    input.filter !== 'all'
  )
    fail('filter must be free, attached or all');
  if (input.includeGone !== undefined && typeof input.includeGone !== 'boolean')
    fail('includeGone must be a boolean');
  const result: ListMachinesInput = {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    filter: (input.filter as ListMachinesInput['filter'] | undefined) ?? 'free',
    includeGone: input.includeGone === true,
    limit: optional(input.limit, (value) => int(value, 'limit', 1, 500)) ?? 100,
  };
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 1024) fail('cursor is invalid');
    parseCursor(input.cursor);
    result.cursor = input.cursor;
  }
  return result;
}

export function parseDiscover(raw: unknown): DiscoverInput {
  const input = object(raw, ['tenantId', 'accountId', 'wait']);
  if (input.wait !== undefined && typeof input.wait !== 'boolean') fail('wait must be a boolean');
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    // The envelope's async-with-wait holds a mutation's answer for at most 30 s.
    ...(input.wait === true ? { wait: { timeoutMs: 30_000 } } : {}),
  };
}

interface ListedMachine {
  external_id: string;
  machine: StoredMachine | string;
  instance_id: string | null;
  instance_tenant_id: string | null;
  zone: string;
  first_seen_ms: number;
  last_seen_ms: number;
  gone_ms: number | null;
}

function machineView(
  accountId: string,
  row: ListedMachine,
  /** Whether the instance holding the machine may be named (see `listMachines`). */
  showHolder: boolean,
): ProviderMachineView {
  const machine = json(row.machine);
  const view: ProviderMachineView = {
    accountId,
    externalId: row.external_id,
    state: machine.state,
    labels: { ...(machine.labels ?? {}) },
    networks: machine.networks ?? [],
    addresses: [...(machine.addresses ?? [])],
    firstSeenAt: Math.round(Number(row.first_seen_ms)),
    lastSeenAt: Math.round(Number(row.last_seen_ms)),
  };
  if (machine.name !== undefined) view.name = machine.name;
  if (machine.zone !== undefined) view.zone = machine.zone;
  if (machine.region !== undefined) view.region = machine.region;
  if (machine.machineType !== undefined) view.machineType = machine.machineType;
  if (machine.vcpu !== undefined) view.vcpu = machine.vcpu;
  if (machine.memoryGiB !== undefined) view.memoryGiB = machine.memoryGiB;
  if (machine.gpus !== undefined) view.gpus = { ...machine.gpus };
  if (machine.reservation !== undefined) view.reservation = machine.reservation;
  if (showHolder && row.instance_id !== null) view.instanceId = row.instance_id;
  if (showHolder && row.instance_tenant_id !== null) view.tenantId = row.instance_tenant_id;
  if (row.gone_ms !== null) view.goneAt = Math.round(Number(row.gone_ms));
  return view;
}

async function ownAccount(
  tx: SqlTx,
  input: { tenantId: string; accountId: string },
): Promise<ProviderAccount> {
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  return account;
}

async function lastPass(tx: SqlTx, accountId: string): Promise<number | undefined> {
  const { rows } = await tx.query<{ ok_ms: number | null }>(
    `SELECT (extract(epoch FROM last_ok_at) * 1000)::float8 AS ok_ms FROM provider_discovery
      WHERE account_id = $1`,
    [accountId],
  );
  const ms = rows[0]?.ok_ms;
  return ms === null || ms === undefined ? undefined : Math.round(Number(ms));
}

/** `providerAccounts.machines`: a page of the account's machines, ordered by (zone, externalId). */
export async function listMachines(
  tx: SqlTx,
  input: ListMachinesInput,
  /**
   * `platform`: the caller is of the IAM root tenant. A machine held by an instance of another
   * tenant (the account's pool is offered to it) is listed without that instance's id and tenant,
   * except to the platform.
   */
  options: { platform?: boolean } = {},
): Promise<{ items: ProviderMachineView[]; cursor?: string; discoveredAt?: number }> {
  const platform = options.platform === true;
  await ownAccount(tx, input);
  const after = input.cursor !== undefined ? parseCursor(input.cursor) : undefined;
  const { rows } = await tx.query<ListedMachine>(
    `SELECT m.external_id, m.machine, m.instance_id, i.tenant_id AS instance_tenant_id,
            coalesce(m.machine->>'zone', '') AS zone,
            (extract(epoch FROM m.first_seen_at) * 1000)::float8 AS first_seen_ms,
            (extract(epoch FROM m.last_seen_at) * 1000)::float8 AS last_seen_ms,
            (extract(epoch FROM m.gone_at) * 1000)::float8 AS gone_ms
       FROM provider_machines m LEFT JOIN instances i ON i.id = m.instance_id
      WHERE m.account_id = $1
        AND ($2::boolean OR m.gone_at IS NULL)
        AND ($3::text = 'all' OR ($3::text = 'free') = (m.instance_id IS NULL))
        AND ($4::text IS NULL OR (coalesce(m.machine->>'zone', ''), m.external_id) > ($4::text, $5::text))
      ORDER BY coalesce(m.machine->>'zone', ''), m.external_id
      LIMIT $6`,
    [
      input.accountId,
      input.includeGone,
      input.filter,
      after?.[0] ?? null,
      after?.[1] ?? null,
      input.limit + 1,
    ],
  );
  const page = rows.slice(0, input.limit);
  const result: { items: ProviderMachineView[]; cursor?: string; discoveredAt?: number } = {
    items: page.map((row) =>
      machineView(
        input.accountId,
        row,
        platform ||
          row.instance_tenant_id === null ||
          row.instance_tenant_id === input.tenantId,
      ),
    ),
  };
  if (rows.length > input.limit) {
    const last = page[page.length - 1]!;
    result.cursor = cursorOf(last.zone, last.external_id);
  }
  const discovered = await lastPass(tx, input.accountId);
  if (discovered !== undefined) result.discoveredAt = discovered;
  return result;
}

/**
 * `providerAccounts.discover`: the account's next pass is due now, and its key is enqueued. The
 * answer carries `discoveredAt` once a pass that started after the call has finished (`poll`).
 */
export async function requestDiscovery(
  deps: Pick<DiscoveryDeps, 'clients' | 'clock' | 'secrets' | 'log' | 'work' | 'rootTenantId'>,
  tx: SqlTx,
  input: DiscoverInput,
): Promise<{ queued: true; discoveredAt?: number }> {
  const account = await ownAccount(tx, input);
  // Building the client validates its config; it calls no provider API.
  if (!discovers(await deps.clients.client(account, deps)))
    throw new ComputeError('UNSUPPORTED', `Provider ${account.provider} cannot list its machines`);
  const { rows } = await tx.query<{ now_ms: number }>(
    `INSERT INTO provider_discovery (account_id, next_at) VALUES ($1, compute_now())
     ON CONFLICT (account_id) DO UPDATE SET next_at = compute_now()
     RETURNING (extract(epoch FROM compute_now()) * 1000)::float8 AS now_ms`,
    [account.id],
  );
  // What `poll` compares the next pass with (the envelope hands it the same validated input).
  input.requestedAt = Math.floor(Number(rows[0]!.now_ms));
  await deps.work.enqueue(tx, discoveryWork, account.id);
  return { queued: true };
}

type DiscoverOutput = { queued: true; discoveredAt?: number };

/** The `poll` of `providerAccounts.discover`: done once a pass finished after the call. */
export const discoverPoll = {
  done: (output: DiscoverOutput): boolean => output.discoveredAt !== undefined,
  async refresh(
    context: { sql: SqlTx },
    input: DiscoverInput,
    output: DiscoverOutput,
  ): Promise<DiscoverOutput> {
    const discovered = await lastPass(context.sql, input.accountId);
    if (discovered === undefined || input.requestedAt === undefined) return output;
    return discovered >= input.requestedAt ? { queued: true, discoveredAt: discovered } : output;
  },
};
