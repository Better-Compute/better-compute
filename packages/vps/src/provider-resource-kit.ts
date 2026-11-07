import {
  ComputeError,
  strictObject,
  type InputSchema,
  isComputeError,
  type CallContext,
  type Json,
  type MethodContext,
  type ProviderImpl,
  type ProviderResourceState,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderAccount } from './accounts.js';
import { fail } from './input.js';
import { visibleVpsPool } from './instances.js';
import { zoneRegion, type NetworkDeps } from './networks.js';

// The helpers the provider resources (provider-resources.ts: volumes, snapshots, addresses) and the edge resources
// (provider-edge.ts: certificates, load balancers, DNS) share: the provider lookup, the ownership checks, the IAM
// projection, events, and the reconciler's `Run`. Internal to the package (index.ts does not export this file).

/** The state a provider resource row's `state` column holds. */
export type ProviderResourceStatus = ProviderResourceState['state'];

export const providerResourcePollMs = 5_000;
/** How soon a rate-limited or unavailable provider is tried again. */
const retryMs = 30_000;
/** A run stops starting provider calls after this long (the lease is 60 s); the rest waits for the next run. */
const runBudgetMs = 40_000;

/** The columns every provider resource table ends with (state, idempotency, version). */
export const columns = `
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'updating', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  -- Set (in its own transaction) before the first provider create: a create whose answer was lost may have made it.
  ensure_requested bool NOT NULL DEFAULT false,
  ready_at timestamptz,
  deleted_at timestamptz,
  metered_until timestamptz,
  -- The caller identity: idempotency keys are scoped to (tenant, caller), as the id derives from them.
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, created_by, idempotency_key)`;

export const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
export const uniqueViolation = (error: unknown) => code(error) === '23505';

// --- Dependencies and shared checks ------------------------------------------------------------

/** What the handlers and the reconciler need beyond a transaction (the networks' dependencies). */
export type ProviderResourceDeps = NetworkDeps;

export type Family =
  | 'providerVolume'
  | 'providerVolume.snapshot'
  | 'providerAddress'
  | 'providerCertificate'
  | 'providerLoadBalancer'
  | 'providerDnsZone'
  | 'providerDnsRecord';
export const subjectOf: Record<Family, string> = {
  providerVolume: 'provider-volume',
  'providerVolume.snapshot': 'provider-snapshot',
  providerAddress: 'provider-address',
  providerCertificate: 'provider-certificate',
  providerLoadBalancer: 'provider-load-balancer',
  providerDnsZone: 'provider-dns-zone',
  providerDnsRecord: 'provider-dns-record',
};
export const idField: Record<Family, string> = {
  providerVolume: 'volumeId',
  'providerVolume.snapshot': 'snapshotId',
  providerAddress: 'addressId',
  providerCertificate: 'certificateId',
  providerLoadBalancer: 'loadBalancerId',
  providerDnsZone: 'zoneId',
  providerDnsRecord: 'recordId',
};

/** The `ProviderImpl` members a provider resource is converged through, and what each provides (for messages). */
export type ResourceNeed = 'volumes' | 'addresses' | 'certificates' | 'loadBalancers' | 'dns';
const needText: Record<ResourceNeed, string> = {
  volumes: 'volumes',
  addresses: 'reserved addresses',
  certificates: 'certificates',
  loadBalancers: 'load balancers',
  dns: 'DNS zones',
};
/** The tables of the provider resources (`Run.write`, `assertNameFree`). */
export type ResourceTable =
  | 'provider_volumes'
  | 'provider_snapshots'
  | 'provider_addresses'
  | 'provider_certificates'
  | 'provider_load_balancers'
  | 'provider_dns_zones'
  | 'provider_dns_records';

export async function publish(
  deps: Pick<ProviderResourceDeps, 'events'>,
  tx: SqlTx,
  family: Family,
  row: { id: string; tenant_id: string },
  verb: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type: `${family}.${verb}`,
    tenantId: row.tenant_id,
    subject: `${subjectOf[family]}/${row.id}`,
    data: { [idField[family]]: row.id, ...data },
  });
}

export interface ResourceProvider {
  accountId: string;
  account: ProviderAccount;
  client: ProviderImpl;
  regions: string[];
  /** The zones the account configures (zonal providers: GCE, AWS); a resource may name one as its region. */
  zones: string[];
}

/** The pool's account and client when its provider implements `need`; otherwise UNSUPPORTED. */
export async function resourceProvider(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  need: ResourceNeed,
): Promise<ResourceProvider> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  const what = needText[need];
  if (pool.class !== 'provider' || pool.providerAccountId === undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `Pool ${poolId} is not a provider pool; ${what} live on provider accounts`,
    );
  // R1: only an account of the pool's owner tenant.
  const account = await readAccount(tx, pool.providerAccountId, pool.ownerTenantId);
  if (!account) throw new ComputeError('UNSUPPORTED', `Pool ${poolId} has no provider account`);
  const client = await deps.clients.client(account, deps);
  if (typeof client[need] !== 'object' || client[need] === null)
    throw new ComputeError('UNSUPPORTED', `Provider ${account.provider} does not provide ${what}`);
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  // Providers without zones (DigitalOcean) configure regions; zonal ones configure zones (GCE), or a region and its
  // zones (AWS).
  const zones = [...new Set(strings(account.config.zones))];
  const regions = [
    ...new Set([
      ...strings(account.config.regions),
      ...strings([account.config.region]),
      ...zones.map(zoneRegion),
    ]),
  ];
  return { accountId: account.id, account, client, regions, zones };
}

/**
 * The resource's region is one the account uses, or (AWS A5, `ProviderVolumeSpec.zone`) one of its configured zones:
 * a zonal volume names its zone as its region.
 */
export function assertRegion(provider: ResourceProvider, region: string): void {
  if (provider.regions.length > 0 && !provider.regions.includes(region) && !provider.zones.includes(region))
    throw new ComputeError(
      'INVALID_INPUT',
      `Region ${region} is not one the provider account uses (${provider.regions.join(', ')})`,
    );
}

/** The region an offer id names: `nyc3/s-1vcpu-1gb` is in nyc3, `us-central1-a/n2-standard-2` in us-central1. */
export function offerRegion(offerId: string | null): string | undefined {
  const slash = offerId?.indexOf('/') ?? -1;
  if (!offerId || slash <= 0) return undefined;
  return offerId.slice(0, slash);
}

export interface TargetInstance {
  id: string;
  tenant_id: string;
  provider_account_id: string | null;
  state: string;
  desired_state: string;
  offer_id: string | null;
  /** The tenant network subnet it is on; null on no tenant network. */
  subnet_id: string | null;
}

/**
 * The instance a volume is attached to or an address assigned to: ACCESS_DENIED when it is another tenant's,
 * INVALID_INPUT on another provider account or in another region, INVALID_STATE when it is being deleted.
 */
export async function targetInstance(
  tx: SqlTx,
  tenantId: string,
  instanceId: string,
  resource: { provider_account_id: string; region: string },
): Promise<TargetInstance> {
  const { rows } = await tx.query<TargetInstance>(
    `SELECT i.id, i.tenant_id, i.provider_account_id, i.state, i.desired_state, f.offer_id, i.subnet_id
       FROM instances i LEFT JOIN flavors f ON f.id = i.flavor_id
      WHERE i.id = $1 AND NOT i.draft`,
    [instanceId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Instance ${instanceId} not found`);
  if (row.tenant_id !== tenantId)
    throw new ComputeError('ACCESS_DENIED', `Instance ${instanceId} belongs to another tenant`);
  if (row.provider_account_id !== resource.provider_account_id)
    throw new ComputeError(
      'INVALID_INPUT',
      `Instance ${instanceId} is not on the provider account ${resource.provider_account_id}`,
    );
  if (row.desired_state === 'deleted' || ['deleting', 'deleted'].includes(row.state))
    throw new ComputeError('INVALID_STATE', `Instance ${instanceId} is being deleted`);
  const region = offerRegion(row.offer_id);
  // A zonal offer in the resource's region, or (a resource named by its zone) a regional offer of that zone's region.
  if (
    region !== undefined &&
    region !== resource.region &&
    zoneRegion(region) !== resource.region &&
    zoneRegion(resource.region) !== region
  )
    throw new ComputeError(
      'INVALID_INPUT',
      `Instance ${instanceId} is in ${region}, not in ${resource.region}`,
    );
  return row;
}

export async function lockTenant(tx: SqlTx, tenantId: string): Promise<void> {
  // Concurrent creates of one tenant book quota and take names one after the other.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('better-compute:provider-resources:' || $1))`,
    [tenantId],
  );
}

export async function assertNameFree(
  tx: SqlTx,
  table: ResourceTable,
  tenantId: string,
  name: string,
): Promise<void> {
  const taken = await tx.query(
    `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [tenantId, name],
  );
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `${name} already exists`);
}

export function caller(context: MethodContext): string {
  if (!context.caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  return context.caller.identityId;
}
export const sameRequest = (row: { request_hash: string }, hash: string) => {
  if (row.request_hash !== hash)
    throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
};

export function volumeAuthz(
  row: {
    id: string;
    tenantId: string;
    accountId: string;
    poolId: string;
    region: string;
    projectId?: string;
  },
  type:
    | 'provider-volume'
    | 'provider-snapshot'
    | 'provider-address'
    | 'provider-certificate'
    | 'provider-load-balancer'
    | 'provider-dns-zone',
  ownerId: string,
  extra: Record<string, string> = {},
) {
  return {
    type,
    id: row.id,
    tenantId: row.tenantId,
    attributes: {
      providerAccountId: row.accountId,
      poolId: row.poolId,
      region: row.region,
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
      ...extra,
    },
    parentType: 'tenant',
    parentId: row.tenantId,
    ownerId,
  };
}

// --- The reconciler ----------------------------------------------------------------------------

export const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);
/** Errors after which the provider may be tried again soon. */
export const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];
/** Of those, the ones after which the provider may have done what was asked (its answer was lost). */
export const ambiguousCodes = ['UNAVAILABLE', 'TIMEOUT'];
/**
 * Refusals of an `ensureVolume` after which the provider holds no volume of that name for us (an ensure finds an
 * existing one by name before it creates). Any other error (`PROVIDER_ERROR` for an accepted create with no body,
 * `INVALID_STATE` for one of ours formatted otherwise) may mean a volume exists.
 */
export const refusedCodes = [
  'QUOTA_EXCEEDED',
  'CONFLICT',
  'INVALID_INPUT',
  'UNSUPPORTED',
  'ACCESS_DENIED',
  'UNAUTHENTICATED',
  'NOT_FOUND',
];

/** The machine an attached volume or an assigned address names (`outputs.attachedTo` / `outputs.assignedTo`). */
export const output = (state: ProviderResourceState | undefined, name: string): string | undefined => {
  const value = state?.outputs?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
export const outputGiB = (state: ProviderResourceState | undefined): number | undefined => {
  const value = Number(output(state, 'sizeGiB'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

export type Fields = Record<string, string | number | boolean | null>;

/** `SET a = $3, b = $4` for the fields, numbered after the two guard parameters. */
export function assignments(fields: Fields): { sql: string; params: unknown[] } {
  const names = Object.keys(fields);
  return {
    sql: names.map((name, index) => `${name} = $${index + 3}`).join(', '),
    params: names.map((name) => fields[name]),
  };
}

/** One run of one resource: the provider calls it made and what it decided to do next. */
export class Run {
  /** Something is in flight at the provider: look again soon. */
  inFlight = false;
  /** The provider asked us to slow down. */
  backoff = false;
  /** The run ran out of time, or the row changed meanwhile: continue at once. */
  again = false;
  /** The code of the last provider error `attempt` caught (a transient one, or the one behind an `error` state). */
  lastCode: string | undefined;
  /** That error's `details.reason`, when it had one. */
  lastReason: string | undefined;
  /** The last `attempt` called nothing: the run's budget was spent (the provider was not asked). */
  skipped = false;
  readonly #started: number;

  constructor(
    readonly deps: ProviderResourceDeps,
    readonly sql: SqlExecutor,
    readonly signal: AbortSignal,
  ) {
    this.#started = deps.clock.now();
  }

  next(): number | undefined {
    const now = this.deps.clock.now();
    if (this.backoff) return now + retryMs;
    if (this.again) return now;
    return this.inFlight ? now + providerResourcePollMs : undefined;
  }

  call(idempotencyKey: string): CallContext {
    return {
      idempotencyKey,
      signal: this.signal,
      clock: this.deps.clock,
      secrets: this.deps.secrets,
      log: this.deps.log,
    };
  }

  /**
   * Runs a provider call. A transient failure (or an aborted run) is `undefined` and backs off; any other throw is
   * an `error` state carrying its message. Past the run's budget nothing is called (`undefined`, continue at once).
   */
  async attempt(
    what: string,
    op: () => Promise<ProviderResourceState | undefined>,
  ): Promise<ProviderResourceState | 'missing' | undefined> {
    this.skipped = false;
    if (this.deps.clock.now() - this.#started > runBudgetMs) {
      this.again = true;
      this.skipped = true;
      return undefined;
    }
    this.lastCode = undefined;
    this.lastReason = undefined;
    try {
      return (await op()) ?? 'missing';
    } catch (error) {
      if (this.signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
        this.lastCode = this.signal.aborted ? 'TIMEOUT' : (error as ComputeError).code;
        this.deps.log.warn('providerResources: provider busy, retrying', {
          what,
          error: text(error),
        });
        this.backoff = true;
        return undefined;
      }
      this.lastCode = isComputeError(error) ? error.code : undefined;
      const reason = isComputeError(error) ? error.details?.reason : undefined;
      this.lastReason = typeof reason === 'string' ? reason : undefined;
      return { id: '', state: 'error', message: text(error) };
    }
  }

  /** The account's client when its provider still provides `need`; otherwise an error message. */
  async client<K extends ResourceNeed>(
    account: ProviderAccount | undefined,
    accountId: string,
    need: K,
  ): Promise<NonNullable<ProviderImpl[K]> | string> {
    try {
      if (!account)
        throw new ComputeError('NOT_FOUND', `Provider account ${accountId} not found`);
      const client = await this.deps.clients.client(account, this.deps);
      const impl = client[need];
      if (!impl)
        throw new ComputeError(
          'UNSUPPORTED',
          `Provider ${account.provider} does not provide ${needText[need]}`,
        );
      return impl as NonNullable<ProviderImpl[K]>;
    } catch (error) {
      return text(error);
    }
  }

  /**
   * Writes observed fields of one row, guarded by the version the run decided on; publishes `event` when the row
   * changed. Answers whether it wrote (a row changed meanwhile is left alone and the run continues at once).
   * `before` runs first in the same transaction, only while the row is still at that version.
   */
  async write(
    table: ResourceTable,
    row: { id: string; version: number | string },
    fields: Fields,
    after?: (tx: SqlTx) => Promise<void>,
    before?: (tx: SqlTx) => Promise<void>,
  ): Promise<boolean> {
    const set = assignments(fields);
    const written = await this.sql.transaction(async (tx) => {
      if (before) {
        const current = await tx.query(`SELECT id FROM ${table} WHERE id = $1 AND version = $2 FOR UPDATE`, [
          row.id,
          row.version,
        ]);
        if (current.rows.length === 0) return false;
        await before(tx);
      }
      const { rows } = await tx.query(
        `UPDATE ${table} SET ${set.sql} WHERE id = $1 AND version = $2 RETURNING id`,
        [row.id, row.version, ...set.params],
      );
      if (rows.length === 0) return false;
      await after?.(tx);
      return true;
    });
    if (!written) this.again = true;
    return written;
  }
}

/** A row's state and message (cleared, or the provider's, at most 500 characters). */
export function settled(
  state: ProviderResourceStatus,
  message?: string,
): { state: ProviderResourceStatus; message: string | null } {
  return { state, message: message ? message.slice(0, 500) : null };
}

// --- Input and its JSON Schema -----------------------------------------------------------------

export const resourceName = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
export const regionName = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

export function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !resourceName.test(value))
    fail('name must be 1-42 lower-case letters, digits or -, starting with a letter');
  return value;
}
export function regionOf(value: unknown): string {
  if (typeof value !== 'string' || !regionName.test(value))
    fail('region must be a provider region, e.g. nyc3 or us-central1');
  return value;
}
export function descriptionOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value))
    return fail('description must be text of at most 256 characters');
  return value;
}
export function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be true or false`);
  return value;
}

export const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
export const tenantIdSchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
export const keySchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
};
export const nameSchema = (description: string): InputSchema => ({
  type: 'string',
  pattern: resourceName.source,
  maxLength: 42,
  description,
});
export const regionSchema: InputSchema = {
  type: 'string',
  pattern: regionName.source,
  maxLength: 40,
  description: "A region of the pool's provider account, e.g. nyc3",
};

export const descriptionSchema: InputSchema = {
  type: 'string',
  maxLength: 256,
  description: 'What it is for',
};

export const listSchema = strictObject(
  {
    tenantId: tenantIdSchema,
    poolId: idOf('pool', 'Only those of this pool'),
    projectId: idOf('prj', 'Only those of this project'),
    includeDeleted: { type: 'boolean', default: false, description: 'Include deleted ones' },
  },
  ['tenantId'],
);
