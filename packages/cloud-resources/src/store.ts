import {
  ComputeError,
  type Clock,
  type EventPublisher,
  type Json,
  type Logger,
  type ModuleContext,
  type ProviderImpl,
  type ProviderResourceFamily,
  type ProviderResourceKind,
  type ProviderResources,
  type SecretBroker,
  type SecretRef,
  type SqlTx,
} from '@better-compute/core';
import {
  accountRefRefusal,
  readAccount,
  visibleVpsPool,
  zoneRegion,
  type ClientDeps,
  type ProviderAccount,
  type ProviderClients,
} from '@better-compute/vps';
import type { CloudResourceState, CloudResourceView } from './types.js';

// Rows, views, events and the provider lookup shared by the API and the reconciler.

/** The work kind of the reconciler: a resource id, `all` (the 30 s sweep) or `refresh` (5 min). */
export const resourcesWork = 'cloud.resources';

/** The ownership labels every resource carries at the provider. */
export const resourceLabels = {
  managed: 'better-compute-managed',
  resource: 'better-compute-resource',
  tenant: 'better-compute-tenant',
} as const;

/** What the handlers and the reconciler need beyond a transaction. */
export interface CloudResourcesDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  authz: ModuleContext['authz'];
  log: Logger;
  /** Resolves accounts' SecretRefs, and seals secret outputs (`put`). Absent: secret outputs are refused. */
  secrets?: SecretBroker;
  clients: ProviderClients;
  /** The IAM root tenant: its provider accounts are the platform's (ruling F1). */
  rootTenantId?: string;
  /** The host's workload issuer: provider accounts' identity (`ClientDeps.workload`). */
  workload?: ClientDeps['workload'];
  /** How many resources of a kind a tenant may have that are not deleted. */
  quotaOf(kind: string): number;
}

export interface ResourceRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  provider: string;
  kind: string;
  family: ProviderResourceFamily;
  name: string;
  description: string | null;
  region: string | null;
  parent_id: string | null;
  spec: Record<string, unknown> | string;
  provider_name: string;
  provider_id: string | null;
  state: CloudResourceState;
  desired_state: 'present' | 'deleted' | 'released';
  message: string | null;
  outputs: Record<string, string> | string;
  secret_outputs: Record<string, SecretRef> | string;
  adopted: boolean;
  /** An adopted resource whose spec the tenant changed since (until then it is observed). */
  spec_changed: boolean;
  /** The kind's `identity(spec)` within the parent, when it declares one. */
  identity: string | null;
  created_by: string;
  request_hash: string;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  provisioned_at: Date | string | null;
  ready_at: Date | string | null;
  deleted_at: Date | string | null;
  /** When the reconciler first sent an `ensure` (cloud-resources/0004); null: the provider was never asked. */
  ensure_sent_at: Date | string | null;
  /** The better-compute networks the spec names (cloud-resources/0005). */
  network_ids: string[];
  /** Passes in a row that ended in an error the provider will not get over by itself (cloud-resources/0006). */
  attempts: number;
  /** The sweeps leave the row alone until then (cloud-resources/0006); null: no wait. */
  next_attempt_at: Date | string | null;
}

export const resourceColumns = `id, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family, name,
  description, region, parent_id, spec, provider_name, provider_id, state, desired_state, message, outputs,
  secret_outputs, adopted, spec_changed, identity, created_by, encode(request_hash, 'hex') AS request_hash, version, created_at, updated_at,
  provisioned_at, ready_at, deleted_at, ensure_sent_at, network_ids, attempts, next_attempt_at`;

export const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;
const ms = (value: Date | string) => new Date(value).getTime();

export function resourceView(row: ResourceRow): CloudResourceView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    provider: row.provider,
    kind: row.kind,
    family: row.family,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.region !== null ? { region: row.region } : {}),
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    spec: json(row.spec),
    providerName: row.provider_name,
    ...(row.provider_id !== null ? { providerId: row.provider_id } : {}),
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    outputs: json(row.outputs),
    secretOutputs: json(row.secret_outputs),
    adopted: row.adopted,
    version: Number(row.version),
    createdAt: ms(row.created_at),
    ...(row.ready_at !== null ? { readyAt: ms(row.ready_at) } : {}),
    ...(row.deleted_at !== null ? { deletedAt: ms(row.deleted_at) } : {}),
  };
}

/** `lock: true` (or `'update'`) reads the row FOR UPDATE; `'share'` FOR SHARE (a child's create holds its parent). */
export async function readResource(
  tx: SqlTx,
  ref: { resourceId: string; tenantId?: string },
  options: { lock?: boolean | 'update' | 'share' } = {},
): Promise<ResourceRow | undefined> {
  const lock =
    options.lock === 'share' ? ' FOR SHARE' : options.lock ? ' FOR UPDATE' : '';
  const { rows } = await tx.query<ResourceRow>(
    `SELECT ${resourceColumns} FROM cloud_resources
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${lock}`,
    [ref.resourceId, ref.tenantId ?? null],
  );
  return rows[0];
}

/** The tenant's resource, or NOT_FOUND (another tenant's resource is not found either). */
export async function requireResource(
  tx: SqlTx,
  ref: { resourceId: string; tenantId: string },
  options: { lock?: boolean } = {},
): Promise<ResourceRow> {
  const row = await readResource(tx, ref, options);
  if (!row) throw new ComputeError('NOT_FOUND', `Cloud resource ${ref.resourceId} not found`);
  return row;
}

export async function resourceViewOf(tx: SqlTx, resourceId: string): Promise<CloudResourceView> {
  return resourceView((await readResource(tx, { resourceId }))!);
}

/** Publishes a `cloud.resource.*` event (subject: the resource), never a secret value. */
export async function publish(
  deps: Pick<CloudResourcesDeps, 'events'>,
  tx: SqlTx,
  resource: { id: string; tenant_id: string; kind: string },
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type: `cloud.resource.${type}`,
    tenantId: resource.tenant_id,
    subject: `cloud-resource/${resource.id}`,
    data: { resourceId: resource.id, kind: resource.kind, ...data },
  });
}

/**
 * The provider-side name: `bc-r-` and 24 characters of the id's body (lower-case base32), so it fits every
 * provider's naming rule we know (at most 29 characters, a letter first). Ids derive from a sha256, so names do not
 * collide.
 */
export function providerResourceName(resourceId: string): string {
  const body = resourceId.slice(resourceId.indexOf('_') + 1).toLowerCase();
  return `bc-r-${body.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
}

/** A provider pool's account, its regions, and its client's `resources`. */
export interface ResourcesProvider {
  account: ProviderAccount;
  /** Regions the account configures (directly, or as the regions of its zones); empty: any. */
  regions: string[];
  /** Whether the account enables provider previews (`previews: true` in its config). */
  previews: boolean;
  resources: ProviderResources;
  client: ProviderImpl;
}

export const clientDeps = (deps: CloudResourcesDeps): ClientDeps => ({
  clock: deps.clock,
  secrets: deps.secrets ?? noSecrets,
  log: deps.log,
  ...(deps.rootTenantId !== undefined ? { rootTenantId: deps.rootTenantId } : {}),
  ...(deps.workload ? { workload: deps.workload } : {}),
});

export const noSecrets: SecretBroker = {
  resolve: async () => {
    throw new ComputeError(
      'INVALID_CONFIG',
      'No secret broker: pass cloudResources({ secrets }) or run a secret broker',
    );
  },
  put: async () => {
    throw new ComputeError(
      'INVALID_CONFIG',
      'No secret broker: pass cloudResources({ secrets }) or run a secret broker',
    );
  },
};

/** The account's client when its provider implements `resources`; otherwise UNSUPPORTED. */
export async function accountResources(
  deps: CloudResourcesDeps,
  account: ProviderAccount,
): Promise<ResourcesProvider> {
  const client = await deps.clients.client(account, clientDeps(deps));
  if (typeof client.resources !== 'object' || client.resources === null)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} does not serve cloud resources`,
    );
  const strings = (value: Json | undefined) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    account,
    regions: [
      ...new Set([
        ...strings(account.config.regions),
        ...strings(account.config.zones).map(zoneRegion),
      ]),
    ],
    previews: account.config.previews === true,
    resources: client.resources,
    client,
  };
}

/**
 * The pool's account and its cloud resources, for a pool the tenant owns or is offered: NOT_FOUND for a pool it
 * cannot see; UNSUPPORTED for a pool that is not a provider pool or whose provider serves no resources.
 */
export async function poolResources(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<ResourcesProvider & { poolOwnerTenantId: string }> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  if (pool.class !== 'provider' || pool.providerAccountId === undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `Pool ${poolId} is not a provider pool; cloud resources live on provider accounts`,
    );
  // R1: only an account of the pool's owner tenant.
  const account = await readAccount(tx, pool.providerAccountId, pool.ownerTenantId);
  if (!account) throw new ComputeError('UNSUPPORTED', `Pool ${poolId} has no provider account`);
  return { ...(await accountResources(deps, account)), poolOwnerTenantId: pool.ownerTenantId };
}

/**
 * Whether the provider can release a resource of the kind (take its ownership labels off and leave it running): it
 * implements `release`, and does not say otherwise for the kind. A provider whose kinds differ (a kind owned by its
 * name has no labels to take off) says so through an optional, pure `releasable(kind)` next to `release`; without
 * it, every kind counts as releasable and a refusal shows only when the reconciler calls `release`.
 */
export function canRelease(resources: ProviderResources, kind: string): boolean {
  if (typeof resources.release !== 'function') return false;
  const releasable = (resources as { releasable?: (kind: string) => boolean }).releasable;
  return typeof releasable !== 'function' || releasable.call(resources, kind) !== false;
}

/** The kind the provider serves, or UNSUPPORTED naming the ones it does. */
export function kindOf(
  provider: Pick<ResourcesProvider, 'resources' | 'account'>,
  kind: string,
): ProviderResourceKind {
  const kinds = provider.resources.kinds();
  const found = kinds.find((entry) => entry.kind === kind);
  if (!found)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider.account.provider} does not serve ${kind}`,
      undefined,
      { kind, kinds: kinds.map((entry) => entry.kind) },
    );
  return found;
}

/**
 * A tenant-scoped resolver: a provider resolving a spec's SecretRef can only reach the tenant's own secrets. The ref
 * is checked here, not left to the store: a tenant names only `secret://<its tenant>/…`, never `env://` (the control
 * plane's own environment), `vault://` or another tenant's ref, whatever a host's store would serve. The root
 * tenant names any ref, as its provider accounts do.
 */
export function tenantSecrets(deps: CloudResourcesDeps, tenantId: string) {
  const broker = deps.secrets ?? noSecrets;
  return {
    resolve: async (ref: SecretRef) => {
      if (accountRefRefusal(ref, { tenantId }, { rootTenantId: deps.rootTenantId }) !== undefined)
        throw new ComputeError(
          'ACCESS_DENIED',
          `A spec may only name the tenant's own secrets (secret://${tenantId}/…)`,
          undefined,
          { reason: 'secretRefScope' },
        );
      return broker.resolve(ref, { tenantId });
    },
  };
}
