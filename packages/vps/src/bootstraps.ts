import {
  ComputeError,
  draftId,
  isComputeError,
  type CallContext,
  type Clock,
  type EventPublisher,
  type Json,
  type Logger,
  type MethodContext,
  type Migration,
  type ModuleContext,
  type PkiPort,
  type ProviderImpl,
  type SecretResolver,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderClients } from './accounts.js';
import { canonical, id, key, object, sha256Hex, tenant } from './input.js';

// Platform-owned provider machines (PLAN.md §3.6): a server rented from a provider (Hetzner Robot)
// becomes a vps-host or metal-host node running bcd. `providerAccounts.bootstrap` records the
// request; the `vps.bootstraps` reconciler drives it:
//   claiming     → ProviderImpl.create claims (or orders) the machine, keyed by the bootstrap id;
//   identifying  → ProviderImpl.identify reads its SMBIOS UUID (rescue);
//   installing   → a single-use `provisioned` join token bound to that UUID (expect.productUuid,
//                  short TTL) is minted and handed to ProviderImpl.bootstrap, which delivers it
//                  through rescue/installimage only — never user data. The token's secret is never
//                  stored: a retry revokes the last token and mints a new one;
//   joining      → waits until a node of the pool reports that UUID in its inventory;
//   joined | failed.

/** The work kind (key: bootstrap id) of the bootstrap reconciler. */
export const bootstrapWork = 'vps.bootstraps';

export const bootstrapStates = [
  'claiming',
  'identifying',
  'installing',
  'joining',
  'joined',
  'failed',
] as const;
export type BootstrapState = (typeof bootstrapStates)[number];

/** A bootstrap as the API shows it (no token, ever). */
export interface ProviderBootstrap {
  id: string;
  tenantId: string;
  accountId: string;
  poolId: string;
  offerId?: string;
  machineId?: string;
  state: BootstrapState;
  productUuid?: string;
  nodeId?: string;
  error?: { code: string; message: string };
  attempts: number;
  version: number;
}

export interface BootstrapInput {
  tenantId: string;
  accountId: string;
  poolId: string;
  /** A machine the account already has; or `offerId` to claim or order one. */
  machineId?: string;
  offerId?: string;
  idempotencyKey: string;
}

/** Where bcd comes from, and how long each phase may take. */
export interface BootstrapOptions {
  /** https URL of the bcd binary the machine installs. */
  bcdUrl: string;
  /** Its hex sha256 (the install verifies it). */
  sha256: string;
  /**
   * The control plane URL the installed bcd joins through (`bcd join --server`): it serves
   * `/.well-known/better-compute` with the gateway and the join pins. Providers that install an OS
   * (Hetzner Robot) need it.
   */
  controlPlaneUrl?: string;
  /**
   * The pins the installed bcd checks the well-known document against (`sha256/<base64>` SPKI
   * pins: the gateway serving CA, JoinService's signing and encryption keys; e.g. from the PKI
   * bundle). Required by providers that install an OS.
   */
  pins?: { servingCa: string; joinSigning: string; joinEncryption: string };
  /** Join token lifetime (default 2 h, at most 6 h). */
  tokenTtlSeconds?: number;
  /** How long `joining` waits for the node (default 1 h). */
  joinTimeoutMs?: number;
  /** Provider failures tolerated before `failed` (default 3). */
  maxAttempts?: number;
}

export const vpsProviderBootstrapsMigration: Migration = {
  name: 'vps/0003_provider_bootstraps',
  sql: `
CREATE TABLE provider_bootstraps (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL REFERENCES provider_accounts,
  pool_id text NOT NULL REFERENCES pools,
  offer_id text,
  machine_id text,
  state text NOT NULL CHECK (state IN ('claiming', 'identifying', 'installing', 'joining', 'joined', 'failed')),
  product_uuid text,
  -- The last token minted (its secret is never stored); revoked when a retry mints another.
  join_token_id text,
  node_id text,
  error jsonb,
  attempts int NOT NULL DEFAULT 0,
  owner_identity_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key)
);
CREATE INDEX provider_bootstraps_live ON provider_bootstraps (state) WHERE state NOT IN ('joined', 'failed');
`,
};

export function parseBootstrap(raw: unknown): BootstrapInput {
  const input = object(raw, [
    'tenantId',
    'accountId',
    'poolId',
    'machineId',
    'offerId',
    'idempotencyKey',
  ]);
  const result: BootstrapInput = {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    poolId: id(input.poolId, 'pool', 'poolId'),
    idempotencyKey: key(input.idempotencyKey),
  };
  const machineRef = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
      throw new ComputeError('INVALID_INPUT', `${field} is invalid`);
    return value;
  };
  if ((input.machineId === undefined) === (input.offerId === undefined))
    throw new ComputeError('INVALID_INPUT', 'Name exactly one of machineId and offerId');
  if (input.machineId !== undefined) result.machineId = machineRef(input.machineId, 'machineId');
  if (input.offerId !== undefined) result.offerId = machineRef(input.offerId, 'offerId');
  return result;
}

interface BootstrapRow {
  id: string;
  tenant_id: string;
  account_id: string;
  pool_id: string;
  offer_id: string | null;
  machine_id: string | null;
  state: BootstrapState;
  product_uuid: string | null;
  join_token_id: string | null;
  node_id: string | null;
  error: { code: string; message: string } | string | null;
  attempts: number;
  request_hash: string;
  version: string | number;
  updated_at: Date;
}

const columns = `id, tenant_id, account_id, pool_id, offer_id, machine_id, state, product_uuid, join_token_id,
  node_id, error, attempts, request_hash, version, updated_at`;

function view(row: BootstrapRow): ProviderBootstrap {
  const out: ProviderBootstrap = {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    poolId: row.pool_id,
    state: row.state,
    attempts: row.attempts,
    version: Number(row.version),
  };
  if (row.offer_id !== null) out.offerId = row.offer_id;
  if (row.machine_id !== null) out.machineId = row.machine_id;
  if (row.product_uuid !== null) out.productUuid = row.product_uuid;
  if (row.node_id !== null) out.nodeId = row.node_id;
  if (row.error !== null)
    out.error = typeof row.error === 'string' ? JSON.parse(row.error) : row.error;
  return out;
}

async function readBootstrap(
  tx: SqlTx,
  bootstrapId: string,
  options: { lock?: boolean } = {},
): Promise<BootstrapRow | undefined> {
  const { rows } = await tx.query<BootstrapRow>(
    `SELECT ${columns} FROM provider_bootstraps WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [bootstrapId],
  );
  return rows[0];
}

/** What the bootstrap handler and reconciler need beyond a transaction. */
export interface BootstrapDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
  pki?: PkiPort;
  options?: BootstrapOptions;
}

async function clientFor(
  deps: BootstrapDeps,
  tx: SqlTx,
  accountId: string,
  tenantId: string,
): Promise<ProviderImpl> {
  const account = await readAccount(tx, accountId, tenantId);
  if (!account) throw new ComputeError('NOT_FOUND', `Provider account ${accountId} not found`);
  return deps.clients.client(account, deps);
}

async function publish(
  deps: BootstrapDeps,
  tx: SqlTx,
  row: Pick<BootstrapRow, 'id' | 'tenant_id'>,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenant_id,
    subject: `provider-bootstrap/${row.id}`,
    data: { bootstrapId: row.id, ...data },
  });
}

/**
 * `providerAccounts.bootstrap` (in the method's transaction): checks the account can identify and
 * bootstrap machines and the pool runs bcd for this tenant, then records the request. A retry with
 * the same key returns its current status; a different request under the key is CONFLICT.
 */
export async function startBootstrap(
  deps: BootstrapDeps,
  context: MethodContext,
  input: BootstrapInput,
): Promise<ProviderBootstrap> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const tx = context.sql;
  const { idempotencyKey: _key, ...request } = input;
  const hash = await sha256Hex(canonical(request));
  const bootstrapId = await draftId(
    'pboot',
    input.tenantId,
    caller.identityId,
    input.idempotencyKey,
  );
  const existing = await readBootstrap(tx, bootstrapId, { lock: true });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return view(existing);
  }
  if (!deps.options)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Bootstrapping machines needs vps({ bootstrap: { bcdUrl, sha256 } })',
    );
  if (!deps.pki)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Bootstrapping machines needs the host PKI (join tokens)',
    );
  const client = await clientFor(deps, tx, input.accountId, input.tenantId);
  if (typeof client.identify !== 'function' || typeof client.bootstrap !== 'function')
    throw new ComputeError('UNSUPPORTED', 'This provider cannot identify and bootstrap machines');
  const { rows } = await tx.query<{
    owner_tenant_id: string;
    class: string;
    agent: string;
    archived: boolean;
  }>(
    `SELECT owner_tenant_id, class, agent, archived_at IS NOT NULL AS archived FROM pools WHERE id = $1`,
    [input.poolId],
  );
  const pool = rows[0];
  if (!pool || pool.owner_tenant_id !== input.tenantId)
    throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
  if (pool.archived) throw new ComputeError('INVALID_STATE', `Pool ${input.poolId} is archived`);
  if ((pool.class !== 'vps-host' && pool.class !== 'metal-host') || pool.agent !== 'bcd')
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${input.poolId} is ${pool.class} (agent ${pool.agent}); machines join vps-host or metal-host pools that run bcd`,
    );
  const state: BootstrapState = input.offerId !== undefined ? 'claiming' : 'identifying';
  const inserted = await tx.query<BootstrapRow>(
    `INSERT INTO provider_bootstraps (id, tenant_id, account_id, pool_id, offer_id, machine_id, state,
                                      owner_identity_id, idempotency_key, request_hash, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
     RETURNING ${columns}`,
    [
      bootstrapId,
      input.tenantId,
      input.accountId,
      input.poolId,
      input.offerId ?? null,
      input.machineId ?? null,
      state,
      caller.identityId,
      input.idempotencyKey,
      hash,
    ],
  );
  const row = inserted.rows[0]!;
  await deps.work.enqueue(tx, bootstrapWork, bootstrapId);
  await publish(deps, tx, row, 'provider.bootstrap.started', {
    accountId: input.accountId,
    poolId: input.poolId,
  });
  return view(row);
}

type Patch = Partial<{
  state: BootstrapState;
  machine_id: string;
  product_uuid: string;
  join_token_id: string | null;
  node_id: string;
  error: { code: string; message: string } | null;
  attempts: number;
}>;

async function update(tx: SqlTx, row: BootstrapRow, patch: Patch): Promise<BootstrapRow> {
  const sets = ['version = version + 1', 'updated_at = compute_now()'];
  const params: unknown[] = [row.id, row.version];
  for (const [column, value] of Object.entries(patch)) {
    params.push(column === 'error' && value !== null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}${column === 'error' ? '::jsonb' : ''}`);
  }
  const { rows } = await tx.query<BootstrapRow>(
    `UPDATE provider_bootstraps SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING ${columns}`,
    params,
  );
  if (!rows[0]) throw new ComputeError('CONFLICT', `Bootstrap ${row.id} changed concurrently`);
  return rows[0];
}

async function revokeToken(tx: SqlTx, tokenId: string | null): Promise<void> {
  if (tokenId)
    await tx.query(
      `UPDATE join_tokens SET revoked_at = compute_now() WHERE id = $1 AND revoked_at IS NULL`,
      [tokenId],
    );
}

const retryable = (error: unknown) =>
  !isComputeError(error) ||
  ['PROVIDER_ERROR', 'RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT', 'CONFLICT'].includes(error.code);

/** How often `joining` looks for the node. */
export const joinPollMs = 30_000;

/**
 * One step of one bootstrap: provider calls run outside any transaction; each outcome is written
 * in its own short one, guarded by the row version. Returns the next wake-up, or undefined when done.
 */
export async function reconcileBootstrap(
  deps: BootstrapDeps,
  sql: SqlExecutor,
  bootstrapId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  let row = await sql.transaction((tx) => readBootstrap(tx, bootstrapId));
  if (!row || row.state === 'joined' || row.state === 'failed') return undefined;
  const now = deps.clock.now();
  const options = deps.options;
  if (!options || !deps.pki) {
    await sql.transaction(async (tx) => {
      const current = await readBootstrap(tx, bootstrapId, { lock: true });
      if (current)
        await update(tx, current, {
          state: 'failed',
          error: {
            code: 'INVALID_CONFIG',
            message: 'vps({ bootstrap }) and the host PKI are required',
          },
        });
    });
    return undefined;
  }

  if (row.state === 'joining') {
    return sql.transaction(async (tx) => {
      const current = await readBootstrap(tx, bootstrapId, { lock: true });
      if (!current || current.state !== 'joining') return deps.clock.now();
      const node = await tx.query<{ id: string }>(
        `SELECT n.id FROM nodes n
           JOIN node_inventory ni ON ni.node_id = n.id
           JOIN inventory_snapshots s ON s.id = ni.applied_snapshot_id
          WHERE n.pool_id = $1 AND lower(s.sections->'system'->>'productUuid') = $2
            -- Reported by the installed system, not a node that was there before the install.
            AND s.collected_at >= $3
          ORDER BY n.id LIMIT 1`,
        [current.pool_id, current.product_uuid, current.updated_at],
      );
      if (node.rows[0]) {
        const joined = await update(tx, current, { state: 'joined', node_id: node.rows[0].id });
        await publish(deps, tx, joined, 'provider.bootstrap.joined', { nodeId: node.rows[0].id });
        return undefined;
      }
      if (now - current.updated_at.getTime() > (options.joinTimeoutMs ?? 60 * 60_000)) {
        await revokeToken(tx, current.join_token_id);
        const failed = await update(tx, current, {
          state: 'failed',
          join_token_id: null,
          error: { code: 'JOIN_TIMEOUT', message: 'The machine did not join in time' },
        });
        await publish(deps, tx, failed, 'provider.bootstrap.failed', { code: 'JOIN_TIMEOUT' });
        return undefined;
      }
      return now + joinPollMs;
    });
  }

  const client = await sql.transaction((tx) =>
    clientFor(deps, tx, row!.account_id, row!.tenant_id),
  );
  const call: CallContext = {
    idempotencyKey: row.id,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  try {
    if (row.state === 'claiming') {
      const machine = await client.create(
        { offerId: row.offer_id!, image: '', userData: '', name: row.id },
        call,
      );
      row = await sql.transaction(async (tx) =>
        update(tx, (await readBootstrap(tx, bootstrapId, { lock: true }))!, {
          state: 'identifying',
          machine_id: machine.id,
        }),
      );
    }
    const machine = await client.get(row.machine_id!, call);
    if (!machine)
      throw new ComputeError(
        'NOT_FOUND',
        `Machine ${row.machine_id} is not in the provider account`,
      );
    if (row.state === 'identifying') {
      const { productUuid } = await client.identify!(machine, call);
      row = await sql.transaction(async (tx) =>
        update(tx, (await readBootstrap(tx, bootstrapId, { lock: true }))!, {
          state: 'installing',
          product_uuid: productUuid.toLowerCase(),
        }),
      );
    }
    // installing: a fresh single-use token bound to the machine, then the install.
    const token = await sql.transaction(async (tx) => {
      const current = (await readBootstrap(tx, bootstrapId, { lock: true }))!;
      await revokeToken(tx, current.join_token_id);
      const minted = await deps.pki!.issueJoinToken(tx, {
        tenantId: current.tenant_id,
        role: 'provisioned',
        poolId: current.pool_id,
        ttlSeconds: Math.min(options.tokenTtlSeconds ?? 7_200, 21_600),
        maxUses: 1,
        expect: { productUuid: current.product_uuid! },
      });
      row = await update(tx, current, { join_token_id: minted.id });
      return minted.token;
    });
    await client.bootstrap!(
      machine,
      {
        joinToken: token,
        bcdUrl: options.bcdUrl,
        sha256: options.sha256,
        ...(options.controlPlaneUrl ? { controlPlaneUrl: options.controlPlaneUrl } : {}),
        ...(options.pins ? { pins: options.pins } : {}),
      },
      call,
    );
    await sql.transaction(async (tx) => {
      const installed = await update(tx, (await readBootstrap(tx, bootstrapId, { lock: true }))!, {
        state: 'joining',
        error: null,
      });
      await publish(deps, tx, installed, 'provider.bootstrap.installed', {
        machineId: machine.id,
      });
    });
    return deps.clock.now() + joinPollMs;
  } catch (error) {
    const code = isComputeError(error) ? error.code : 'PROVIDER_ERROR';
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    return sql.transaction(async (tx) => {
      const current = await readBootstrap(tx, bootstrapId, { lock: true });
      if (!current) return undefined;
      const attempts = current.attempts + 1;
      if (retryable(error) && attempts < (options.maxAttempts ?? 3)) {
        await update(tx, current, { attempts, error: { code, message } });
        return deps.clock.now() + Math.min(30_000 * 2 ** attempts, 10 * 60_000);
      }
      await revokeToken(tx, current.join_token_id);
      const failed = await update(tx, current, {
        state: 'failed',
        attempts,
        join_token_id: null,
        error: { code, message },
      });
      await publish(deps, tx, failed, 'provider.bootstrap.failed', { code });
      return undefined;
    });
  }
}
