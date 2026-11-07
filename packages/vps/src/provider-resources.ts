import { chargeQuota, refundQuota } from '@better-compute/capacity';
import {
  ComputeError,
  draftId,
  isComputeError,
  newId,
  strictObject,
  type AdmissionPlan,
  type CallContext,
  type InputSchema,
  type Json,
  type MethodContext,
  type Migration,
  type ModuleContext,
  type ProviderAddresses,
  type ProviderImpl,
  type ProviderResourceState,
  type ProviderVolumes,
  type ProviderVolumeSpec,
  type Reconciler,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderAccount } from './accounts.js';
import { visibleVpsPool } from './instances.js';
import { canonical, fail, id, int, key, object, optional, sha256Hex, tenant } from './input.js';
import { providerResourceName, zoneRegion, type NetworkDeps } from './networks.js';

// Provider volumes, snapshots and addresses (DigitalOcean P2, R5): a tenant's block volumes, their snapshots and its
// reserved public addresses on a provider account, typed provider resources next to its instances. The API records
// what the tenant wants (`desired_state`, the wanted attachment or assignment) in the method's transaction; the
// `vps.provider-resources` reconciler converges the provider through `ProviderImpl.volumes` and
// `ProviderImpl.addresses`, outside any transaction, and writes back what it observed in short transactions
// guarded by the row's version (a change made meanwhile wakes it again instead of being overwritten).
//
// Quota: a volume books its size as `diskGiB` on (tenant, pool), as a provider instance's disk does, and growing it
// books the difference; an address books one `addresses`. A missing quota row grants nothing (fail closed, as for
// provider instances). The booking comes back once the provider deleted the resource.
//
// Ownership: an instance of another tenant is ACCESS_DENIED for attach and assign; one on another provider account
// or in another region is INVALID_INPUT before any provider call. A volume is attached to one instance at a time and
// an address assigned to one: a second attach or assign is CONFLICT (never moved silently). An attached volume or an
// assigned address is not deleted (INVALID_STATE until it is detached or unassigned). Resize only grows.

/** The work kind of the reconciler (key: a `pvol_`, `psnap_` or `paddr_` id, or `all` for the periodic sweep). */
export const providerResourcesWork = 'vps.provider-resources';
/** The quota resource a provider volume books its GiB on (the one a provider instance's disk books). */
export const volumeQuotaResource = 'diskGiB';
/** The quota resource a reserved address books one of. */
export const addressQuotaResource = 'addresses';
/** The largest provider volume, in GiB (DigitalOcean's limit; other providers refuse larger ones themselves). */
export const maxProviderVolumeGiB = 16_384;
/** At most this many snapshots (not deleted) per volume. */
export const maxSnapshotsPerVolume = 25;
export const providerResourcePollMs = 5_000;
/** How soon a rate-limited or unavailable provider is tried again. */
const retryMs = 30_000;
/** A run stops starting provider calls after this long (the lease is 60 s); the rest waits for the next run. */
const runBudgetMs = 40_000;

const columns = `
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

/** (DO P2) Tenant block volumes on a provider account, and which instance each is attached to. */
export const providerVolumesMigration: Migration = {
  name: 'vps/0066_provider_volumes',
  sql: `
CREATE TABLE provider_volumes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  description text,
  region text NOT NULL,
  -- What the tenant asked for (grows only), and what the provider last reported.
  size_gib int NOT NULL CHECK (size_gib >= 1),
  observed_size_gib int,
  filesystem text CHECK (filesystem IN ('ext4', 'xfs', 'none')),
  source_snapshot_id text,
  -- Deleted with the instance it is attached to when that instance is deleted; otherwise only detached.
  delete_with_instance bool NOT NULL DEFAULT false,
  external_id text,
  device text,
  -- The diskGiB booked on (tenant, pool): refunded once the provider deleted the volume.
  charged_gib int NOT NULL DEFAULT 0 CHECK (charged_gib >= 0),${columns}
);
-- A deleted volume's name is free again.
CREATE UNIQUE INDEX provider_volumes_name ON provider_volumes (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX provider_volumes_live ON provider_volumes (state) WHERE state <> 'deleted';
CREATE TRIGGER provider_volumes_stamp_deleted BEFORE UPDATE ON provider_volumes
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();

CREATE TABLE provider_volume_attachments (
  id text PRIMARY KEY,
  volume_id text NOT NULL REFERENCES provider_volumes,
  instance_id text NOT NULL REFERENCES instances,
  -- The machine the provider attached the volume to (the instance's external id when it was attached).
  machine_id text,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  created_at timestamptz NOT NULL DEFAULT compute_now()
);
-- A block volume is attached to one instance at a time.
CREATE UNIQUE INDEX provider_volume_attachments_live ON provider_volume_attachments (volume_id) WHERE state <> 'deleted';
CREATE INDEX provider_volume_attachments_instance ON provider_volume_attachments (instance_id) WHERE state <> 'deleted';
`,
};

/** (DO P2) Snapshots of provider volumes; a snapshot outlives its volume and restores into a new one. */
export const providerSnapshotsMigration: Migration = {
  name: 'vps/0067_provider_snapshots',
  sql: `
CREATE TABLE provider_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  volume_id text NOT NULL REFERENCES provider_volumes,
  name text NOT NULL,
  region text NOT NULL,
  -- What the provider reported once the snapshot was ready.
  size_gib int,
  external_id text,${columns}
);
CREATE UNIQUE INDEX provider_snapshots_name ON provider_snapshots (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX provider_snapshots_live ON provider_snapshots (state) WHERE state <> 'deleted';
CREATE INDEX provider_snapshots_volume ON provider_snapshots (volume_id) WHERE state <> 'deleted';
CREATE TRIGGER provider_snapshots_stamp_deleted BEFORE UPDATE ON provider_snapshots
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();
ALTER TABLE provider_volumes ADD CONSTRAINT provider_volumes_source_snapshot
  FOREIGN KEY (source_snapshot_id) REFERENCES provider_snapshots;
`,
};

/** (DO P2) Reserved public addresses on a provider account, and the instance each is assigned to. */
export const providerAddressesMigration: Migration = {
  name: 'vps/0068_provider_addresses',
  sql: `
CREATE TABLE provider_addresses (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  description text,
  region text NOT NULL,
  family text NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
  external_id text,
  address text,
  -- The provider's fingerprint output at reserve time (DO: a reserved IPv6's reservation time; a reserved IPv4 has
  -- none): an address at external_id that does not show it is another reservation, never released or taken over.
  fingerprint text,
  -- The reservation is gone: released at the provider outside better-compute, or its IP handed to another row's
  -- reserve. external_id is cleared, and the row never calls the provider again (its delete only finishes it).
  lost bool NOT NULL DEFAULT false,
  -- The instance the tenant wants the address on (NULL: unassigned), and the machine the provider last reported.
  instance_id text REFERENCES instances,
  assigned_machine text,
  assignment_state text NOT NULL DEFAULT 'none'
    CHECK (assignment_state IN ('none', 'pending', 'ready', 'deleting', 'error')),
  assignment_message text,
  -- The addresses quota booked on (tenant, pool): refunded once the provider released the address.
  charged int NOT NULL DEFAULT 0 CHECK (charged >= 0),${columns}
);
CREATE UNIQUE INDEX provider_addresses_name ON provider_addresses (tenant_id, name) WHERE state <> 'deleted';
-- One live row per reservation: a reserve handed an IP another live row records marks that row lost first.
CREATE UNIQUE INDEX provider_addresses_external ON provider_addresses (provider_account_id, external_id)
  WHERE state <> 'deleted' AND external_id IS NOT NULL;
CREATE INDEX provider_addresses_live ON provider_addresses (state) WHERE state <> 'deleted';
CREATE INDEX provider_addresses_instance ON provider_addresses (instance_id) WHERE instance_id IS NOT NULL;
CREATE TRIGGER provider_addresses_stamp_deleted BEFORE UPDATE ON provider_addresses
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();
`,
};

// --- Views and input ---------------------------------------------------------------------------

export type ProviderResourceStatus = ProviderResourceState['state'];
export type AttachmentState = 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';
type Desired = 'present' | 'deleted';

export interface ProviderVolumeView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  name: string;
  description?: string;
  region: string;
  /** What the tenant asked for; the provider may still be growing it (`state: updating`). */
  sizeGiB: number;
  filesystem?: 'ext4' | 'xfs' | 'none';
  sourceSnapshotId?: string;
  deleteWithInstance: boolean;
  /** The guest path the volume appears at once attached. */
  device?: string;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  /** The instance the volume is attached to, or being attached to or detached from. */
  attachment?: { instanceId: string; state: AttachmentState; desiredState: Desired; message?: string };
  version: number;
  createdAt: string;
}

export interface ProviderSnapshotView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  volumeId: string;
  name: string;
  region: string;
  sizeGiB?: number;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  createdAt: string;
}

export interface ProviderAddressView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  name: string;
  description?: string;
  region: string;
  family: 'ipv4' | 'ipv6';
  /** The reserved address, once the provider reserved it. */
  address?: string;
  instanceId?: string;
  assignmentState: 'none' | 'pending' | 'ready' | 'deleting' | 'error';
  assignmentMessage?: string;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  version: number;
  createdAt: string;
}

export interface CreateProviderVolumeInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  description?: string;
  region: string;
  sizeGiB: number;
  filesystem?: 'ext4' | 'xfs' | 'none';
  deleteWithInstance?: boolean;
  /** Attaches the volume to this instance once both exist. */
  instanceId?: string;
  idempotencyKey: string;
}
export type ProviderVolumeRef = { tenantId: string; volumeId: string };
export interface ListProviderVolumesInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}
export interface AttachProviderVolumeInput extends ProviderVolumeRef {
  instanceId: string;
}
export interface ResizeProviderVolumeInput extends ProviderVolumeRef {
  sizeGiB: number;
}
export interface SnapshotProviderVolumeInput extends ProviderVolumeRef {
  name: string;
  idempotencyKey: string;
}
export type ProviderSnapshotRef = { tenantId: string; snapshotId: string };
export interface ListProviderSnapshotsInput {
  tenantId: string;
  volumeId?: string;
  includeDeleted?: boolean;
}
export interface RestoreProviderSnapshotInput extends ProviderSnapshotRef {
  name: string;
  description?: string;
  /** At least the snapshot's size; absent: the snapshot's size. */
  sizeGiB?: number;
  filesystem?: 'ext4' | 'xfs' | 'none';
  deleteWithInstance?: boolean;
  idempotencyKey: string;
}
export interface CreateProviderAddressInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  description?: string;
  region: string;
  family: 'ipv4' | 'ipv6';
  idempotencyKey: string;
}
export type ProviderAddressRef = { tenantId: string; addressId: string };
export interface ListProviderAddressesInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}
export interface AssignProviderAddressInput extends ProviderAddressRef {
  instanceId: string;
}

const resourceName = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
const regionName = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const filesystems = ['ext4', 'xfs', 'none'] as const;

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !resourceName.test(value))
    fail('name must be 1-42 lower-case letters, digits or -, starting with a letter');
  return value;
}
function regionOf(value: unknown): string {
  if (typeof value !== 'string' || !regionName.test(value))
    fail('region must be a provider region, e.g. nyc3 or us-central1');
  return value;
}
function descriptionOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value))
    return fail('description must be text of at most 256 characters');
  return value;
}
function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be true or false`);
  return value;
}
function filesystemOf(value: unknown): 'ext4' | 'xfs' | 'none' {
  if (!filesystems.includes(value as never)) fail('filesystem must be ext4, xfs or none');
  return value as 'ext4' | 'xfs' | 'none';
}
const sizeOf = (value: unknown) => int(value, 'sizeGiB', 1, maxProviderVolumeGiB);
const volumeIdOf = (value: unknown) => id(value, 'pvol', 'volumeId');
const snapshotIdOf = (value: unknown) => id(value, 'psnap', 'snapshotId');
const addressIdOf = (value: unknown) => id(value, 'paddr', 'addressId');
const instanceIdOf = (value: unknown) => id(value, 'inst', 'instanceId');

export function parseCreateProviderVolume(raw: unknown): CreateProviderVolumeInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'description',
    'region',
    'sizeGiB',
    'filesystem',
    'deleteWithInstance',
    'instanceId',
    'idempotencyKey',
  ]);
  const out: CreateProviderVolumeInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: nameOf(input.name),
    region: regionOf(input.region),
    sizeGiB: sizeOf(input.sizeGiB),
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  const description = optional(input.description, descriptionOf);
  if (description !== undefined) out.description = description;
  const filesystem = optional(input.filesystem, filesystemOf);
  if (filesystem !== undefined) out.filesystem = filesystem;
  if (input.deleteWithInstance !== undefined)
    out.deleteWithInstance = bool(input.deleteWithInstance, 'deleteWithInstance');
  const instanceId = optional(input.instanceId, instanceIdOf);
  if (instanceId !== undefined) out.instanceId = instanceId;
  return out;
}
export function parseProviderVolumeRef(raw: unknown): ProviderVolumeRef {
  const input = object(raw, ['tenantId', 'volumeId']);
  return { tenantId: tenant(input.tenantId), volumeId: volumeIdOf(input.volumeId) };
}
function parseListInput(raw: unknown): ListProviderVolumesInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListProviderVolumesInput = { tenantId: tenant(input.tenantId) };
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) out.poolId = poolId;
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.includeDeleted !== undefined)
    out.includeDeleted = bool(input.includeDeleted, 'includeDeleted');
  return out;
}
export const parseListProviderVolumes = parseListInput;
export const parseListProviderAddresses: (raw: unknown) => ListProviderAddressesInput =
  parseListInput;
export function parseAttachProviderVolume(raw: unknown): AttachProviderVolumeInput {
  const input = object(raw, ['tenantId', 'volumeId', 'instanceId']);
  return {
    tenantId: tenant(input.tenantId),
    volumeId: volumeIdOf(input.volumeId),
    instanceId: instanceIdOf(input.instanceId),
  };
}
export function parseResizeProviderVolume(raw: unknown): ResizeProviderVolumeInput {
  const input = object(raw, ['tenantId', 'volumeId', 'sizeGiB']);
  return {
    tenantId: tenant(input.tenantId),
    volumeId: volumeIdOf(input.volumeId),
    sizeGiB: sizeOf(input.sizeGiB),
  };
}
export function parseSnapshotProviderVolume(raw: unknown): SnapshotProviderVolumeInput {
  const input = object(raw, ['tenantId', 'volumeId', 'name', 'idempotencyKey']);
  return {
    tenantId: tenant(input.tenantId),
    volumeId: volumeIdOf(input.volumeId),
    name: nameOf(input.name),
    idempotencyKey: key(input.idempotencyKey),
  };
}
export function parseProviderSnapshotRef(raw: unknown): ProviderSnapshotRef {
  const input = object(raw, ['tenantId', 'snapshotId']);
  return { tenantId: tenant(input.tenantId), snapshotId: snapshotIdOf(input.snapshotId) };
}
export function parseListProviderSnapshots(raw: unknown): ListProviderSnapshotsInput {
  const input = object(raw, ['tenantId', 'volumeId', 'includeDeleted']);
  const out: ListProviderSnapshotsInput = { tenantId: tenant(input.tenantId) };
  const volumeId = optional(input.volumeId, volumeIdOf);
  if (volumeId !== undefined) out.volumeId = volumeId;
  if (input.includeDeleted !== undefined)
    out.includeDeleted = bool(input.includeDeleted, 'includeDeleted');
  return out;
}
export function parseRestoreProviderSnapshot(raw: unknown): RestoreProviderSnapshotInput {
  const input = object(raw, [
    'tenantId',
    'snapshotId',
    'name',
    'description',
    'sizeGiB',
    'filesystem',
    'deleteWithInstance',
    'idempotencyKey',
  ]);
  const out: RestoreProviderSnapshotInput = {
    tenantId: tenant(input.tenantId),
    snapshotId: snapshotIdOf(input.snapshotId),
    name: nameOf(input.name),
    idempotencyKey: key(input.idempotencyKey),
  };
  const description = optional(input.description, descriptionOf);
  if (description !== undefined) out.description = description;
  const sizeGiB = optional(input.sizeGiB, sizeOf);
  if (sizeGiB !== undefined) out.sizeGiB = sizeGiB;
  const filesystem = optional(input.filesystem, filesystemOf);
  if (filesystem !== undefined) out.filesystem = filesystem;
  if (input.deleteWithInstance !== undefined)
    out.deleteWithInstance = bool(input.deleteWithInstance, 'deleteWithInstance');
  return out;
}
export function parseCreateProviderAddress(raw: unknown): CreateProviderAddressInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'description',
    'region',
    'family',
    'idempotencyKey',
  ]);
  if (input.family !== undefined && input.family !== 'ipv4' && input.family !== 'ipv6')
    fail('family must be ipv4 or ipv6');
  const out: CreateProviderAddressInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: nameOf(input.name),
    region: regionOf(input.region),
    family: (input.family as 'ipv4' | 'ipv6' | undefined) ?? 'ipv4',
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  const description = optional(input.description, descriptionOf);
  if (description !== undefined) out.description = description;
  return out;
}
export function parseProviderAddressRef(raw: unknown): ProviderAddressRef {
  const input = object(raw, ['tenantId', 'addressId']);
  return { tenantId: tenant(input.tenantId), addressId: addressIdOf(input.addressId) };
}
export function parseAssignProviderAddress(raw: unknown): AssignProviderAddressInput {
  const input = object(raw, ['tenantId', 'addressId', 'instanceId']);
  return {
    tenantId: tenant(input.tenantId),
    addressId: addressIdOf(input.addressId),
    instanceId: instanceIdOf(input.instanceId),
  };
}

// JSON Schema descriptions of the inputs, for the generated reference and tool schemas.
const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantIdSchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const keySchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
};
const nameSchema = (description: string): InputSchema => ({
  type: 'string',
  pattern: resourceName.source,
  maxLength: 42,
  description,
});
const regionSchema: InputSchema = {
  type: 'string',
  pattern: regionName.source,
  maxLength: 40,
  description: "A region of the pool's provider account, e.g. nyc3",
};
const sizeSchema = (description: string): InputSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: maxProviderVolumeGiB,
  description,
});
const descriptionSchema: InputSchema = {
  type: 'string',
  maxLength: 256,
  description: 'What it is for',
};
const filesystemSchema: InputSchema = {
  enum: [...filesystems],
  description: 'The filesystem the provider formats the volume with; none (or absent) leaves it raw',
};
const deleteWithInstanceSchema: InputSchema = {
  type: 'boolean',
  default: false,
  description:
    'Delete the volume with the instance it is attached to; otherwise deleting the instance only detaches it',
};
const volumeIdSchema = idOf('pvol', 'The provider volume');
const snapshotIdSchema = idOf('psnap', 'The provider volume snapshot');
const addressIdSchema = idOf('paddr', 'The reserved address');
const instanceIdSchema = idOf('inst', 'An instance of the tenant on the same provider account and region');
const listSchema = strictObject(
  {
    tenantId: tenantIdSchema,
    poolId: idOf('pool', 'Only those of this pool'),
    projectId: idOf('prj', 'Only those of this project'),
    includeDeleted: { type: 'boolean', default: false, description: 'Include deleted ones' },
  },
  ['tenantId'],
);

export const providerResourceSchemas = {
  createVolume: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the volume belongs to'),
      poolId: idOf('pool', 'A provider pool offered to the tenant, whose account provides volumes'),
      name: nameSchema('The volume name, unique in the tenant, e.g. data'),
      description: descriptionSchema,
      region: regionSchema,
      sizeGiB: sizeSchema('The size in GiB (it can grow later, never shrink)'),
      filesystem: filesystemSchema,
      deleteWithInstance: deleteWithInstanceSchema,
      instanceId: instanceIdSchema,
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'name', 'region', 'sizeGiB', 'idempotencyKey'],
  ),
  volume: strictObject({ tenantId: tenantIdSchema, volumeId: volumeIdSchema }, [
    'tenantId',
    'volumeId',
  ]),
  listVolumes: listSchema,
  attachVolume: strictObject(
    { tenantId: tenantIdSchema, volumeId: volumeIdSchema, instanceId: instanceIdSchema },
    ['tenantId', 'volumeId', 'instanceId'],
  ),
  resizeVolume: strictObject(
    {
      tenantId: tenantIdSchema,
      volumeId: volumeIdSchema,
      sizeGiB: sizeSchema('The new size in GiB: at least the current one'),
    },
    ['tenantId', 'volumeId', 'sizeGiB'],
  ),
  snapshotVolume: strictObject(
    {
      tenantId: tenantIdSchema,
      volumeId: volumeIdSchema,
      name: nameSchema('The snapshot name, unique in the tenant'),
      idempotencyKey: keySchema,
    },
    ['tenantId', 'volumeId', 'name', 'idempotencyKey'],
  ),
  snapshot: strictObject({ tenantId: tenantIdSchema, snapshotId: snapshotIdSchema }, [
    'tenantId',
    'snapshotId',
  ]),
  listSnapshots: strictObject(
    {
      tenantId: tenantIdSchema,
      volumeId: idOf('pvol', 'Only the snapshots of this volume'),
      includeDeleted: { type: 'boolean', default: false, description: 'Include deleted ones' },
    },
    ['tenantId'],
  ),
  restoreSnapshot: strictObject(
    {
      tenantId: tenantIdSchema,
      snapshotId: snapshotIdSchema,
      name: nameSchema('The new volume name, unique in the tenant'),
      description: descriptionSchema,
      sizeGiB: sizeSchema("The new volume's size in GiB: at least the snapshot's (the default)"),
      filesystem: filesystemSchema,
      deleteWithInstance: deleteWithInstanceSchema,
      idempotencyKey: keySchema,
    },
    ['tenantId', 'snapshotId', 'name', 'idempotencyKey'],
  ),
  createAddress: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the address belongs to'),
      poolId: idOf(
        'pool',
        'A provider pool offered to the tenant, whose account provides addresses',
      ),
      name: nameSchema('The address name, unique in the tenant, e.g. ingress'),
      description: descriptionSchema,
      region: regionSchema,
      family: { enum: ['ipv4', 'ipv6'], default: 'ipv4', description: 'The address family' },
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'name', 'region', 'idempotencyKey'],
  ),
  address: strictObject({ tenantId: tenantIdSchema, addressId: addressIdSchema }, [
    'tenantId',
    'addressId',
  ]),
  listAddresses: listSchema,
  assignAddress: strictObject(
    { tenantId: tenantIdSchema, addressId: addressIdSchema, instanceId: instanceIdSchema },
    ['tenantId', 'addressId', 'instanceId'],
  ),
};

// --- Rows --------------------------------------------------------------------------------------

interface VolumeRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  name: string;
  description: string | null;
  region: string;
  size_gib: number;
  observed_size_gib: number | null;
  filesystem: 'ext4' | 'xfs' | 'none' | null;
  source_snapshot_id: string | null;
  delete_with_instance: boolean;
  external_id: string | null;
  device: string | null;
  charged_gib: number;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

interface AttachmentRow {
  id: string;
  volume_id: string;
  instance_id: string;
  machine_id: string | null;
  state: AttachmentState;
  desired_state: Desired;
  message: string | null;
}

interface SnapshotRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  volume_id: string;
  name: string;
  region: string;
  size_gib: number | null;
  external_id: string | null;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

interface AddressRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  name: string;
  description: string | null;
  region: string;
  family: 'ipv4' | 'ipv6';
  external_id: string | null;
  address: string | null;
  fingerprint: string | null;
  lost: boolean;
  instance_id: string | null;
  assigned_machine: string | null;
  assignment_state: ProviderAddressView['assignmentState'];
  assignment_message: string | null;
  charged: number;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

const common = `state, desired_state, message, ensure_requested, encode(request_hash, 'hex') AS request_hash,
  version, created_at`;
const volumeColumns = `id, tenant_id, project_id, pool_id, provider_account_id, name, description, region, size_gib,
  observed_size_gib, filesystem, source_snapshot_id, delete_with_instance, external_id, device, charged_gib, ${common}`;
const snapshotColumns = `id, tenant_id, project_id, pool_id, provider_account_id, volume_id, name, region, size_gib,
  external_id, ${common}`;
const addressColumns = `id, tenant_id, project_id, pool_id, provider_account_id, name, description, region, family,
  external_id, address, fingerprint, lost, instance_id, assigned_machine, assignment_state, assignment_message, charged, ${common}`;
const attachmentColumns = `id, volume_id, instance_id, machine_id, state, desired_state, message`;

const iso = (value: Date | string) => new Date(value).toISOString();

export function providerVolumeView(
  row: VolumeRow,
  attachment?: AttachmentRow,
): ProviderVolumeView {
  const view: ProviderVolumeView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    region: row.region,
    sizeGiB: Number(row.size_gib),
    deleteWithInstance: row.delete_with_instance,
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.description) view.description = row.description;
  if (row.filesystem) view.filesystem = row.filesystem;
  if (row.source_snapshot_id) view.sourceSnapshotId = row.source_snapshot_id;
  if (row.device) view.device = row.device;
  if (row.message) view.message = row.message;
  if (attachment)
    view.attachment = {
      instanceId: attachment.instance_id,
      state: attachment.state,
      desiredState: attachment.desired_state,
      ...(attachment.message ? { message: attachment.message } : {}),
    };
  return view;
}

export function providerSnapshotView(row: SnapshotRow): ProviderSnapshotView {
  const view: ProviderSnapshotView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    volumeId: row.volume_id,
    name: row.name,
    region: row.region,
    state: row.state,
    desiredState: row.desired_state,
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.size_gib !== null) view.sizeGiB = Number(row.size_gib);
  if (row.message) view.message = row.message;
  return view;
}

export function providerAddressView(row: AddressRow): ProviderAddressView {
  const view: ProviderAddressView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    region: row.region,
    family: row.family,
    assignmentState: row.assignment_state,
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.description) view.description = row.description;
  if (row.address) view.address = row.address;
  if (row.instance_id) view.instanceId = row.instance_id;
  if (row.assignment_message) view.assignmentMessage = row.assignment_message;
  if (row.message) view.message = row.message;
  return view;
}

async function readVolume(
  tx: SqlTx,
  volumeId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<VolumeRow | undefined> {
  const { rows } = await tx.query<VolumeRow>(
    `SELECT ${volumeColumns} FROM provider_volumes
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [volumeId, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireVolume(
  tx: SqlTx,
  ref: ProviderVolumeRef,
  lock = false,
): Promise<VolumeRow> {
  const row = await readVolume(tx, ref.volumeId, { tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `Volume ${ref.volumeId} not found`);
  return row;
}
async function liveAttachments(tx: SqlTx, volumeIds: readonly string[]): Promise<AttachmentRow[]> {
  if (volumeIds.length === 0) return [];
  const { rows } = await tx.query<AttachmentRow>(
    `SELECT ${attachmentColumns} FROM provider_volume_attachments
      WHERE volume_id = ANY($1::text[]) AND state <> 'deleted' ORDER BY created_at, id`,
    [volumeIds],
  );
  return rows;
}
async function volumeViewOf(tx: SqlTx, volumeId: string): Promise<ProviderVolumeView> {
  const row = await readVolume(tx, volumeId);
  if (!row) throw new ComputeError('NOT_FOUND', `Volume ${volumeId} not found`);
  const [attachment] = await liveAttachments(tx, [volumeId]);
  return providerVolumeView(row, attachment);
}
async function readSnapshot(
  tx: SqlTx,
  snapshotId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<SnapshotRow | undefined> {
  const { rows } = await tx.query<SnapshotRow>(
    `SELECT ${snapshotColumns} FROM provider_snapshots
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [snapshotId, options.tenantId ?? null],
  );
  return rows[0];
}
async function readAddress(
  tx: SqlTx,
  addressId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<AddressRow | undefined> {
  const { rows } = await tx.query<AddressRow>(
    `SELECT ${addressColumns} FROM provider_addresses
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [addressId, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireAddress(
  tx: SqlTx,
  ref: ProviderAddressRef,
  lock = false,
): Promise<AddressRow> {
  const row = await readAddress(tx, ref.addressId, { tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `Address ${ref.addressId} not found`);
  return row;
}

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
const uniqueViolation = (error: unknown) => code(error) === '23505';

// --- Dependencies and shared checks ------------------------------------------------------------

/** What the handlers and the reconciler need beyond a transaction (the networks' dependencies). */
export type ProviderResourceDeps = NetworkDeps;

type Family = 'providerVolume' | 'providerVolume.snapshot' | 'providerAddress';
const subjectOf: Record<Family, string> = {
  providerVolume: 'provider-volume',
  'providerVolume.snapshot': 'provider-snapshot',
  providerAddress: 'provider-address',
};
const idField: Record<Family, string> = {
  providerVolume: 'volumeId',
  'providerVolume.snapshot': 'snapshotId',
  providerAddress: 'addressId',
};

async function publish(
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

interface ResourceProvider {
  accountId: string;
  account: ProviderAccount;
  client: ProviderImpl;
  regions: string[];
}

/** The pool's account and client when its provider implements `need`; otherwise UNSUPPORTED. */
async function resourceProvider(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  need: 'volumes' | 'addresses',
): Promise<ResourceProvider> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  const what = need === 'volumes' ? 'volumes' : 'reserved addresses';
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
  // Providers without zones (DigitalOcean) configure regions; zonal ones (GCE) configure zones.
  const regions = [
    ...new Set([...strings(account.config.regions), ...strings(account.config.zones).map(zoneRegion)]),
  ];
  return { accountId: account.id, account, client, regions };
}

function assertRegion(provider: ResourceProvider, region: string): void {
  if (provider.regions.length > 0 && !provider.regions.includes(region))
    throw new ComputeError(
      'INVALID_INPUT',
      `Region ${region} is not one the provider account uses (${provider.regions.join(', ')})`,
    );
}

/** The region an offer id names: `nyc3/s-1vcpu-1gb` is in nyc3, `us-central1-a/n2-standard-2` in us-central1. */
function offerRegion(offerId: string | null): string | undefined {
  const slash = offerId?.indexOf('/') ?? -1;
  if (!offerId || slash <= 0) return undefined;
  return offerId.slice(0, slash);
}

interface TargetInstance {
  id: string;
  tenant_id: string;
  provider_account_id: string | null;
  state: string;
  desired_state: string;
  offer_id: string | null;
}

/**
 * The instance a volume is attached to or an address assigned to: ACCESS_DENIED when it is another tenant's,
 * INVALID_INPUT on another provider account or in another region, INVALID_STATE when it is being deleted.
 */
async function targetInstance(
  tx: SqlTx,
  tenantId: string,
  instanceId: string,
  resource: { provider_account_id: string; region: string },
): Promise<TargetInstance> {
  const { rows } = await tx.query<TargetInstance>(
    `SELECT i.id, i.tenant_id, i.provider_account_id, i.state, i.desired_state, f.offer_id
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
  if (region !== undefined && region !== resource.region && zoneRegion(region) !== resource.region)
    throw new ComputeError(
      'INVALID_INPUT',
      `Instance ${instanceId} is in ${region}, not in ${resource.region}`,
    );
  return row;
}

async function lockTenant(tx: SqlTx, tenantId: string): Promise<void> {
  // Concurrent creates of one tenant book quota and take names one after the other.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('better-compute:provider-resources:' || $1))`,
    [tenantId],
  );
}

async function assertNameFree(
  tx: SqlTx,
  table: 'provider_volumes' | 'provider_snapshots' | 'provider_addresses',
  tenantId: string,
  name: string,
): Promise<void> {
  const taken = await tx.query(
    `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [tenantId, name],
  );
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `${name} already exists`);
}

function caller(context: MethodContext): string {
  if (!context.caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  return context.caller.identityId;
}
const sameRequest = (row: { request_hash: string }, hash: string) => {
  if (row.request_hash !== hash)
    throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
};

function volumeAuthz(
  row: {
    id: string;
    tenantId: string;
    accountId: string;
    poolId: string;
    region: string;
    projectId?: string;
  },
  type: 'provider-volume' | 'provider-snapshot' | 'provider-address',
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

// --- Volumes API -------------------------------------------------------------------------------

const volumeHash = (input: CreateProviderVolumeInput) =>
  sha256Hex(
    canonical({
      poolId: input.poolId,
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      region: input.region,
      sizeGiB: input.sizeGiB,
      filesystem: input.filesystem,
      deleteWithInstance: input.deleteWithInstance === true,
      instanceId: input.instanceId,
    }),
  );

/**
 * `providerVolumes.create` transaction 1: the idempotency lookup, the pool, provider, region and name checks, and
 * the authz projection row the decision reads (`provider-volume/<id>`, the id derived from tenant, caller and key).
 */
export async function prepareCreateProviderVolume(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderVolumeInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ProviderVolumeView>> {
  const identity = caller(context);
  const volumeId = await draftId('pvol', input.tenantId, identity, input.idempotencyKey);
  const existing = await readVolume(tx, volumeId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, await volumeHash(input));
    return { status: 'replay', result: await volumeViewOf(tx, volumeId) };
  }
  // Refusals come before anything is staged, so a refused request leaves no projection row behind.
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'volumes');
  assertRegion(provider, input.region);
  await assertNameFree(tx, 'provider_volumes', input.tenantId, input.name);
  await context.authz.upsert(
    tx,
    volumeAuthz(
      {
        id: volumeId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        region: input.region,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      'provider-volume',
      identity,
    ),
  );
  return { status: 'decide', resource: { type: 'provider-volume', id: volumeId } };
}

/** `providerVolumes.create` refused or abandoned: the projection row staged for a volume never created goes. */
export async function clearStagedProviderVolume(
  context: MethodContext,
  input: CreateProviderVolumeInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const volumeId = await draftId(
    'pvol',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readVolume(tx, volumeId)))
    await context.authz.remove(tx, { type: 'provider-volume', id: volumeId, tenantId: input.tenantId });
}

interface NewVolume {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  provider: ResourceProvider;
  name: string;
  description?: string;
  region: string;
  sizeGiB: number;
  filesystem?: 'ext4' | 'xfs' | 'none';
  sourceSnapshotId?: string;
  deleteWithInstance: boolean;
  instanceId?: string;
  createdBy: string;
  idempotencyKey: string;
  hash: string;
}

/** Books the quota, writes the volume (and its attachment) `pending`, projects it and wakes the reconciler. */
async function insertVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  volume: NewVolume,
): Promise<ProviderVolumeView> {
  await lockTenant(tx, volume.tenantId);
  await assertNameFree(tx, 'provider_volumes', volume.tenantId, volume.name);
  const target =
    volume.instanceId !== undefined
      ? await targetInstance(tx, volume.tenantId, volume.instanceId, {
          provider_account_id: volume.provider.accountId,
          region: volume.region,
        })
      : undefined;
  await chargeQuota(tx, volume.tenantId, volume.poolId, { [volumeQuotaResource]: volume.sizeGiB });
  try {
    await tx.query(
      `INSERT INTO provider_volumes (id, tenant_id, project_id, pool_id, provider_account_id, name, description, region,
                                     size_gib, filesystem, source_snapshot_id, delete_with_instance, charged_gib,
                                     state, desired_state, created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $9, 'pending', 'present', $13, $14,
               decode($15, 'hex'), 1)`,
      [
        volume.id,
        volume.tenantId,
        volume.projectId ?? null,
        volume.poolId,
        volume.provider.accountId,
        volume.name,
        volume.description ?? null,
        volume.region,
        volume.sizeGiB,
        volume.filesystem ?? null,
        volume.sourceSnapshotId ?? null,
        volume.deleteWithInstance,
        volume.createdBy,
        volume.idempotencyKey,
        volume.hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('name'))
        throw new ComputeError('CONFLICT', `${volume.name} already exists`);
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    }
    throw error;
  }
  if (target)
    await tx.query(
      `INSERT INTO provider_volume_attachments (id, volume_id, instance_id, state, desired_state)
       VALUES ($1, $2, $3, 'pending', 'present')`,
      [newId('pvatt'), volume.id, target.id],
    );
  await deps.authz.upsert(
    tx,
    volumeAuthz(
      {
        id: volume.id,
        tenantId: volume.tenantId,
        accountId: volume.provider.accountId,
        poolId: volume.poolId,
        region: volume.region,
        ...(volume.projectId !== undefined ? { projectId: volume.projectId } : {}),
      },
      'provider-volume',
      volume.createdBy,
    ),
  );
  await deps.work.enqueue(tx, providerResourcesWork, volume.id);
  await publish(deps, tx, 'providerVolume', { id: volume.id, tenant_id: volume.tenantId }, 'created', {
    poolId: volume.poolId,
    providerAccountId: volume.provider.accountId,
    name: volume.name,
    region: volume.region,
    sizeGiB: volume.sizeGiB,
    ...(volume.sourceSnapshotId !== undefined ? { sourceSnapshotId: volume.sourceSnapshotId } : {}),
    ...(target ? { instanceId: target.id } : {}),
  });
  return volumeViewOf(tx, volume.id);
}

/**
 * `providerVolumes.create` (in the method's transaction): books `sizeGiB` of `diskGiB` quota, records the volume
 * `pending` (attached to `instanceId` once both exist) and wakes the reconciler. A retry with the same key returns
 * the volume; another request under the key is CONFLICT.
 */
export async function createProviderVolume(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderVolumeInput,
): Promise<ProviderVolumeView> {
  const tx = context.sql;
  const identity = caller(context);
  const volumeId = await draftId('pvol', input.tenantId, identity, input.idempotencyKey);
  const hash = await volumeHash(input);
  const existing = await readVolume(tx, volumeId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return volumeViewOf(tx, volumeId);
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'volumes');
  assertRegion(provider, input.region);
  return insertVolume(deps, tx, {
    id: volumeId,
    tenantId: input.tenantId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    poolId: input.poolId,
    provider,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    region: input.region,
    sizeGiB: input.sizeGiB,
    ...(input.filesystem !== undefined ? { filesystem: input.filesystem } : {}),
    deleteWithInstance: input.deleteWithInstance === true,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    createdBy: identity,
    idempotencyKey: input.idempotencyKey,
    hash,
  });
}

export async function getProviderVolume(
  tx: SqlTx,
  ref: ProviderVolumeRef,
): Promise<ProviderVolumeView> {
  const row = await requireVolume(tx, ref);
  const [attachment] = await liveAttachments(tx, [row.id]);
  return providerVolumeView(row, attachment);
}

export async function listProviderVolumes(
  tx: SqlTx,
  input: ListProviderVolumesInput,
): Promise<{ items: ProviderVolumeView[] }> {
  const { rows } = await tx.query<VolumeRow>(
    `SELECT ${volumeColumns} FROM provider_volumes
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  const attachments = await liveAttachments(
    tx,
    rows.map((row) => row.id),
  );
  const byVolume = new Map(attachments.map((attachment) => [attachment.volume_id, attachment]));
  return { items: rows.map((row) => providerVolumeView(row, byVolume.get(row.id))) };
}

/** A volume the tenant may still change: not deleted or being deleted (INVALID_STATE otherwise). */
async function openVolume(tx: SqlTx, ref: ProviderVolumeRef): Promise<VolumeRow> {
  const row = await requireVolume(tx, ref, true);
  if (row.desired_state === 'deleted' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Volume ${ref.volumeId} is being deleted`);
  return row;
}

async function touchVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  row: VolumeRow,
  data: Record<string, Json>,
): Promise<void> {
  await tx.query(`UPDATE provider_volumes SET version = version + 1 WHERE id = $1`, [row.id]);
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerVolume', row, 'updated', data);
}

/**
 * `providerVolumes.attach`: the instance (the tenant's, on the volume's account and region) gets the volume once
 * both exist. Attaching to the instance it is attached to returns the volume; to another one is CONFLICT.
 */
export async function attachProviderVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: AttachProviderVolumeInput,
): Promise<ProviderVolumeView> {
  const row = await openVolume(tx, input);
  const [live] = await liveAttachments(tx, [row.id]);
  if (live) {
    if (live.desired_state === 'present' && live.instance_id === input.instanceId)
      return volumeViewOf(tx, row.id);
    if (live.desired_state === 'present')
      throw new ComputeError(
        'CONFLICT',
        `Volume ${row.id} is attached to instance ${live.instance_id}; detach it first`,
      );
    throw new ComputeError(
      'INVALID_STATE',
      `Volume ${row.id} is being detached from instance ${live.instance_id}; attach it once it is detached`,
    );
  }
  const target = await targetInstance(tx, input.tenantId, input.instanceId, row);
  await tx.query(
    `INSERT INTO provider_volume_attachments (id, volume_id, instance_id, state, desired_state)
     VALUES ($1, $2, $3, 'pending', 'present')`,
    [newId('pvatt'), row.id, target.id],
  );
  await touchVolume(deps, tx, row, { attach: target.id });
  return volumeViewOf(tx, row.id);
}

/** `providerVolumes.detach`: the volume leaves its instance. A volume attached to nothing is returned as it is. */
export async function detachProviderVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderVolumeRef,
): Promise<ProviderVolumeView> {
  const row = await requireVolume(tx, input, true);
  const [live] = await liveAttachments(tx, [row.id]);
  if (!live || live.desired_state === 'deleted') return volumeViewOf(tx, row.id);
  if (row.delete_with_instance) {
    // Once its instance is being deleted, the volume goes with the machine (whose delete may already name it):
    // a detach now could make the reconciler ensure again a volume the provider is deleting.
    const { rows } = await tx.query<{ desired_state: string; state: string }>(
      `SELECT desired_state, state FROM instances WHERE id = $1`,
      [live.instance_id],
    );
    if (rows[0] && (rows[0].desired_state === 'deleted' || ['deleting', 'deleted'].includes(rows[0].state)))
      throw new ComputeError(
        'INVALID_STATE',
        `Instance ${live.instance_id} is being deleted, and volume ${row.id} (deleteWithInstance) is deleted with it`,
      );
  }
  await tx.query(
    `UPDATE provider_volume_attachments SET desired_state = 'deleted',
            state = CASE WHEN state = 'ready' THEN 'deleting' ELSE state END
      WHERE id = $1`,
    [live.id],
  );
  await touchVolume(deps, tx, row, { detach: live.instance_id });
  return volumeViewOf(tx, row.id);
}

/**
 * `providerVolumes.resize`: grows the volume (INVALID_INPUT for a smaller size; the same size returns it as it is),
 * booking the difference on the tenant's `diskGiB` quota.
 */
export async function resizeProviderVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ResizeProviderVolumeInput,
): Promise<ProviderVolumeView> {
  const row = await openVolume(tx, input);
  const current = Number(row.size_gib);
  if (input.sizeGiB < current)
    throw new ComputeError(
      'INVALID_INPUT',
      `A volume only grows: ${row.id} is ${current} GiB, ${input.sizeGiB} GiB is smaller`,
    );
  if (input.sizeGiB === current) return volumeViewOf(tx, row.id);
  const grow = input.sizeGiB - current;
  await chargeQuota(tx, row.tenant_id, row.pool_id, { [volumeQuotaResource]: grow });
  await tx.query(
    `UPDATE provider_volumes SET size_gib = $2, charged_gib = charged_gib + $3 WHERE id = $1`,
    [row.id, input.sizeGiB, grow],
  );
  await touchVolume(deps, tx, row, { sizeGiB: input.sizeGiB, previousSizeGiB: current });
  return volumeViewOf(tx, row.id);
}

/**
 * `providerVolumes.delete`: INVALID_STATE while it is attached (detach it first). The reconciler deletes it at the
 * provider, then refunds its quota. Deleting a volume being deleted returns it.
 */
export async function deleteProviderVolume(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderVolumeRef,
): Promise<ProviderVolumeView> {
  const row = await requireVolume(tx, input, true);
  if (row.desired_state === 'deleted') return volumeViewOf(tx, row.id);
  const [live] = await liveAttachments(tx, [row.id]);
  if (live?.desired_state === 'present')
    throw new ComputeError(
      'INVALID_STATE',
      `Volume ${row.id} is attached to instance ${live.instance_id}; detach it first`,
    );
  await tx.query(
    `UPDATE provider_volumes SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerVolume', row, 'deleting');
  return volumeViewOf(tx, row.id);
}

// --- Snapshots API -----------------------------------------------------------------------------

/**
 * `providerVolumes.snapshot` (decided on the volume): records a snapshot `pending` and wakes the reconciler. The id
 * derives from tenant, caller and key, so a retry returns the same snapshot.
 */
export async function snapshotProviderVolume(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: SnapshotProviderVolumeInput,
): Promise<ProviderSnapshotView> {
  const tx = context.sql;
  const identity = caller(context);
  const snapshotId = await draftId('psnap', input.tenantId, identity, input.idempotencyKey);
  const hash = await sha256Hex(canonical({ volumeId: input.volumeId, name: input.name }));
  const existing = await readSnapshot(tx, snapshotId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return providerSnapshotView(existing);
  }
  const volume = await openVolume(tx, input);
  await lockTenant(tx, input.tenantId);
  await assertNameFree(tx, 'provider_snapshots', input.tenantId, input.name);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_snapshots WHERE volume_id = $1 AND state <> 'deleted'`,
    [volume.id],
  );
  if (Number(live.rows[0]!.count) >= maxSnapshotsPerVolume)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A volume has at most ${maxSnapshotsPerVolume} snapshots that are not deleted`,
      undefined,
      { limit: maxSnapshotsPerVolume },
    );
  try {
    await tx.query(
      `INSERT INTO provider_snapshots (id, tenant_id, project_id, pool_id, provider_account_id, volume_id, name, region,
                                       state, desired_state, created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'present', $9, $10, decode($11, 'hex'), 1)`,
      [
        snapshotId,
        input.tenantId,
        volume.project_id,
        volume.pool_id,
        volume.provider_account_id,
        volume.id,
        input.name,
        volume.region,
        identity,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Snapshot ${input.name} already exists`);
    throw error;
  }
  await deps.authz.upsert(
    tx,
    volumeAuthz(
      {
        id: snapshotId,
        tenantId: input.tenantId,
        accountId: volume.provider_account_id,
        poolId: volume.pool_id,
        region: volume.region,
        ...(volume.project_id ? { projectId: volume.project_id } : {}),
      },
      'provider-snapshot',
      identity,
      { volumeId: volume.id },
    ),
  );
  await deps.work.enqueue(tx, providerResourcesWork, snapshotId);
  await publish(
    deps,
    tx,
    'providerVolume.snapshot',
    { id: snapshotId, tenant_id: input.tenantId },
    'created',
    { volumeId: volume.id, name: input.name },
  );
  return providerSnapshotView((await readSnapshot(tx, snapshotId))!);
}

export async function listProviderSnapshots(
  tx: SqlTx,
  input: ListProviderSnapshotsInput,
): Promise<{ items: ProviderSnapshotView[] }> {
  const { rows } = await tx.query<SnapshotRow>(
    `SELECT ${snapshotColumns} FROM provider_snapshots
      WHERE tenant_id = $1 AND ($2::text IS NULL OR volume_id = $2) AND ($3 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.volumeId ?? null, input.includeDeleted === true],
  );
  return { items: rows.map(providerSnapshotView) };
}

export async function getProviderSnapshot(
  tx: SqlTx,
  ref: ProviderSnapshotRef,
): Promise<ProviderSnapshotView> {
  const row = await readSnapshot(tx, ref.snapshotId, { tenantId: ref.tenantId });
  if (!row) throw new ComputeError('NOT_FOUND', `Snapshot ${ref.snapshotId} not found`);
  return providerSnapshotView(row);
}

/** `providerSnapshots.delete`: the reconciler deletes it at the provider. Deleting one being deleted returns it. */
export async function deleteProviderSnapshot(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderSnapshotRef,
): Promise<ProviderSnapshotView> {
  const row = await readSnapshot(tx, input.snapshotId, { tenantId: input.tenantId, lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Snapshot ${input.snapshotId} not found`);
  if (row.desired_state === 'deleted') return providerSnapshotView(row);
  await tx.query(
    `UPDATE provider_snapshots SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerVolume.snapshot', row, 'deleting', { volumeId: row.volume_id });
  return providerSnapshotView((await readSnapshot(tx, row.id))!);
}

/**
 * `providerSnapshots.restore` (decided on the snapshot): a new volume made from a ready snapshot (INVALID_STATE
 * before), in the snapshot's pool and region, at least the snapshot's size (INVALID_INPUT for less).
 */
export async function restoreProviderSnapshot(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: RestoreProviderSnapshotInput,
): Promise<ProviderVolumeView> {
  const tx = context.sql;
  const identity = caller(context);
  const volumeId = await draftId('pvol', input.tenantId, identity, input.idempotencyKey);
  const hash = await sha256Hex(
    canonical({
      snapshotId: input.snapshotId,
      name: input.name,
      description: input.description,
      sizeGiB: input.sizeGiB,
      filesystem: input.filesystem,
      deleteWithInstance: input.deleteWithInstance === true,
    }),
  );
  const existing = await readVolume(tx, volumeId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return volumeViewOf(tx, volumeId);
  }
  const snapshot = await readSnapshot(tx, input.snapshotId, { tenantId: input.tenantId });
  if (!snapshot) throw new ComputeError('NOT_FOUND', `Snapshot ${input.snapshotId} not found`);
  if (snapshot.state !== 'ready' || snapshot.desired_state !== 'present')
    throw new ComputeError(
      'INVALID_STATE',
      `Snapshot ${snapshot.id} is ${snapshot.desired_state === 'deleted' ? 'being deleted' : snapshot.state}; only a ready snapshot restores`,
    );
  const minimum = snapshot.size_gib === null ? 1 : Number(snapshot.size_gib);
  const sizeGiB = input.sizeGiB ?? minimum;
  if (sizeGiB < minimum)
    throw new ComputeError(
      'INVALID_INPUT',
      `A volume restored from snapshot ${snapshot.id} is at least ${minimum} GiB`,
    );
  const provider = await resourceProvider(
    deps,
    tx,
    input.tenantId,
    snapshot.pool_id,
    'volumes',
  );
  if (provider.accountId !== snapshot.provider_account_id)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${snapshot.pool_id} is no longer on the snapshot's provider account`,
    );
  return insertVolume(deps, tx, {
    id: volumeId,
    tenantId: input.tenantId,
    ...(snapshot.project_id ? { projectId: snapshot.project_id } : {}),
    poolId: snapshot.pool_id,
    provider,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    region: snapshot.region,
    sizeGiB,
    ...(input.filesystem !== undefined ? { filesystem: input.filesystem } : {}),
    sourceSnapshotId: snapshot.id,
    deleteWithInstance: input.deleteWithInstance === true,
    createdBy: identity,
    idempotencyKey: input.idempotencyKey,
    hash,
  });
}

// --- Addresses API -----------------------------------------------------------------------------

const addressHash = (input: CreateProviderAddressInput) =>
  sha256Hex(
    canonical({
      poolId: input.poolId,
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      region: input.region,
      family: input.family,
    }),
  );

/** `providerAddresses.create` transaction 1, as `providerVolumes.create`'s: decided on `provider-address/<id>`. */
export async function prepareCreateProviderAddress(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderAddressInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ProviderAddressView>> {
  const identity = caller(context);
  const addressId = await draftId('paddr', input.tenantId, identity, input.idempotencyKey);
  const existing = await readAddress(tx, addressId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, await addressHash(input));
    return { status: 'replay', result: providerAddressView(existing) };
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'addresses');
  assertRegion(provider, input.region);
  await assertNameFree(tx, 'provider_addresses', input.tenantId, input.name);
  await context.authz.upsert(
    tx,
    volumeAuthz(
      {
        id: addressId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        region: input.region,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      'provider-address',
      identity,
      { family: input.family },
    ),
  );
  return { status: 'decide', resource: { type: 'provider-address', id: addressId } };
}

export async function clearStagedProviderAddress(
  context: MethodContext,
  input: CreateProviderAddressInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const addressId = await draftId(
    'paddr',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readAddress(tx, addressId)))
    await context.authz.remove(tx, {
      type: 'provider-address',
      id: addressId,
      tenantId: input.tenantId,
    });
}

/**
 * `providerAddresses.create` (in the method's transaction): books one `addresses` quota, records the address
 * `pending` and wakes the reconciler, which reserves it.
 */
export async function createProviderAddress(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderAddressInput,
): Promise<ProviderAddressView> {
  const tx = context.sql;
  const identity = caller(context);
  const addressId = await draftId('paddr', input.tenantId, identity, input.idempotencyKey);
  const hash = await addressHash(input);
  const existing = await readAddress(tx, addressId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return providerAddressView(existing);
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'addresses');
  assertRegion(provider, input.region);
  await lockTenant(tx, input.tenantId);
  await assertNameFree(tx, 'provider_addresses', input.tenantId, input.name);
  await chargeQuota(tx, input.tenantId, input.poolId, { [addressQuotaResource]: 1 });
  try {
    await tx.query(
      `INSERT INTO provider_addresses (id, tenant_id, project_id, pool_id, provider_account_id, name, description,
                                       region, family, charged, state, desired_state, created_by, idempotency_key,
                                       request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'pending', 'present', $10, $11, decode($12, 'hex'), 1)`,
      [
        addressId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        provider.accountId,
        input.name,
        input.description ?? null,
        input.region,
        input.family,
        identity,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Address ${input.name} already exists`);
    throw error;
  }
  await deps.authz.upsert(
    tx,
    volumeAuthz(
      {
        id: addressId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        region: input.region,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      'provider-address',
      identity,
      { family: input.family },
    ),
  );
  await deps.work.enqueue(tx, providerResourcesWork, addressId);
  await publish(deps, tx, 'providerAddress', { id: addressId, tenant_id: input.tenantId }, 'created', {
    poolId: input.poolId,
    providerAccountId: provider.accountId,
    name: input.name,
    region: input.region,
    family: input.family,
  });
  return providerAddressView((await readAddress(tx, addressId))!);
}

export async function getProviderAddress(
  tx: SqlTx,
  ref: ProviderAddressRef,
): Promise<ProviderAddressView> {
  return providerAddressView(await requireAddress(tx, ref));
}

export async function listProviderAddresses(
  tx: SqlTx,
  input: ListProviderAddressesInput,
): Promise<{ items: ProviderAddressView[] }> {
  const { rows } = await tx.query<AddressRow>(
    `SELECT ${addressColumns} FROM provider_addresses
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  return { items: rows.map(providerAddressView) };
}

async function openAddress(tx: SqlTx, ref: ProviderAddressRef): Promise<AddressRow> {
  const row = await requireAddress(tx, ref, true);
  if (row.desired_state === 'deleted' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Address ${ref.addressId} is being deleted`);
  if (row.lost)
    throw new ComputeError(
      'INVALID_STATE',
      `Address ${ref.addressId} no longer holds its reservation at the provider; delete it`,
    );
  return row;
}

/**
 * `providerAddresses.assign`: the instance (the tenant's, on the address's account and region; ACCESS_DENIED for
 * another tenant's) gets the address. Assigned to it already: returned as it is; to another one: CONFLICT.
 */
export async function assignProviderAddress(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: AssignProviderAddressInput,
): Promise<ProviderAddressView> {
  const row = await openAddress(tx, input);
  if (row.instance_id === input.instanceId) return providerAddressView(row);
  if (row.instance_id !== null)
    throw new ComputeError(
      'CONFLICT',
      `Address ${row.id} is assigned to instance ${row.instance_id}; unassign it first`,
    );
  const target = await targetInstance(tx, input.tenantId, input.instanceId, row);
  await tx.query(
    `UPDATE provider_addresses SET instance_id = $2, assignment_state = 'pending', assignment_message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id, target.id],
  );
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerAddress', row, 'updated', { assign: target.id });
  return providerAddressView((await readAddress(tx, row.id))!);
}

/** `providerAddresses.unassign`: the address leaves its instance; an unassigned address is returned as it is. */
export async function unassignProviderAddress(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderAddressRef,
): Promise<ProviderAddressView> {
  const row = await requireAddress(tx, input, true);
  if (row.instance_id === null) return providerAddressView(row);
  await tx.query(
    `UPDATE provider_addresses SET instance_id = NULL,
            assignment_state = CASE WHEN assigned_machine IS NULL THEN 'none' ELSE 'deleting' END,
            assignment_message = NULL, version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerAddress', row, 'updated', { unassign: row.instance_id });
  return providerAddressView((await readAddress(tx, row.id))!);
}

/** `providerAddresses.delete`: INVALID_STATE while assigned (unassign it first); the reconciler releases it. */
export async function deleteProviderAddress(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderAddressRef,
): Promise<ProviderAddressView> {
  const row = await requireAddress(tx, input, true);
  if (row.desired_state === 'deleted') return providerAddressView(row);
  if (row.instance_id !== null)
    throw new ComputeError(
      'INVALID_STATE',
      `Address ${row.id} is assigned to instance ${row.instance_id}; unassign it first`,
    );
  await tx.query(
    `UPDATE provider_addresses SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, providerResourcesWork, row.id);
  await publish(deps, tx, 'providerAddress', row, 'deleting');
  return providerAddressView((await readAddress(tx, row.id))!);
}

// --- The reconciler ----------------------------------------------------------------------------

const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);
/** Errors after which the provider may be tried again soon. */
const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];
/** Of those, the ones after which the provider may have done what was asked (its answer was lost). */
const ambiguousCodes = ['UNAVAILABLE', 'TIMEOUT'];
/**
 * Refusals of an `ensureVolume` after which the provider holds no volume of that name for us (an ensure finds an
 * existing one by name before it creates). Any other error (`PROVIDER_ERROR` for an accepted create with no body,
 * `INVALID_STATE` for one of ours formatted otherwise) may mean a volume exists.
 */
const refusedCodes = [
  'QUOTA_EXCEEDED',
  'CONFLICT',
  'INVALID_INPUT',
  'UNSUPPORTED',
  'ACCESS_DENIED',
  'UNAUTHENTICATED',
  'NOT_FOUND',
];

/** The machine an attached volume or an assigned address names (`outputs.attachedTo` / `outputs.assignedTo`). */
const output = (state: ProviderResourceState | undefined, name: string): string | undefined => {
  const value = state?.outputs?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const outputGiB = (state: ProviderResourceState | undefined): number | undefined => {
  const value = Number(output(state, 'sizeGiB'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

type Fields = Record<string, string | number | boolean | null>;

/** `SET a = $3, b = $4` for the fields, numbered after the two guard parameters. */
function assignments(fields: Fields): { sql: string; params: unknown[] } {
  const names = Object.keys(fields);
  return {
    sql: names.map((name, index) => `${name} = $${index + 3}`).join(', '),
    params: names.map((name) => fields[name]),
  };
}

/** One run of one resource: the provider calls it made and what it decided to do next. */
class Run {
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
  async client<K extends 'volumes' | 'addresses'>(
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
          `Provider ${account.provider} does not provide ${need === 'volumes' ? 'volumes' : 'reserved addresses'}`,
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
    table: 'provider_volumes' | 'provider_snapshots' | 'provider_addresses',
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
function settled(
  state: ProviderResourceStatus,
  message?: string,
): { state: ProviderResourceStatus; message: string | null } {
  return { state, message: message ? message.slice(0, 500) : null };
}

// --- Volumes -----------------------------------------------------------------------------------

interface VolumeAttachment extends AttachmentRow {
  external_id: string | null;
  instance_state: string;
}

async function loadVolume(tx: SqlTx, volumeId: string) {
  const volume = await readVolume(tx, volumeId);
  if (!volume) return undefined;
  const attachments = await tx.query<VolumeAttachment>(
    `SELECT a.id, a.volume_id, a.instance_id, a.machine_id, a.state, a.desired_state, a.message,
            i.external_id, i.state AS instance_state
       FROM provider_volume_attachments a JOIN instances i ON i.id = a.instance_id
      WHERE a.volume_id = $1 AND a.state <> 'deleted' ORDER BY a.created_at, a.id`,
    [volumeId],
  );
  const source = volume.source_snapshot_id
    ? (
        await tx.query<{ external_id: string | null; state: string; desired_state: string }>(
          `SELECT external_id, state, desired_state FROM provider_snapshots WHERE id = $1`,
          [volume.source_snapshot_id],
        )
      ).rows[0]
    : undefined;
  return {
    volume,
    attachments: attachments.rows,
    source,
    account: await readAccount(tx, volume.provider_account_id),
  };
}
type LoadedVolume = NonNullable<Awaited<ReturnType<typeof loadVolume>>>;

async function writeAttachment(
  run: Run,
  attachment: VolumeAttachment,
  fields: { state: AttachmentState; machine_id?: string | null; message?: string | null },
  event?: { volume: VolumeRow; verb: string },
): Promise<void> {
  await run.sql.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE provider_volume_attachments
          SET state = $3, machine_id = coalesce($4, machine_id), message = $5
        WHERE id = $1 AND desired_state = $2 AND state <> 'deleted' RETURNING id`,
      [
        attachment.id,
        attachment.desired_state,
        fields.state,
        fields.machine_id ?? null,
        fields.message ?? null,
      ],
    );
    if (rows.length === 0) {
      run.again = true;
      return;
    }
    if (event && fields.state !== attachment.state)
      await publish(run.deps, tx, 'providerVolume', event.volume, event.verb, {
        instanceId: attachment.instance_id,
      });
  });
}

/**
 * One attachment toward what is wanted: attached to its instance's machine, or detached. `attachedTo` is the machine
 * the provider reports the volume on (undefined: attached to nothing).
 */
async function convergeAttachment(
  run: Run,
  volumes: ProviderVolumes,
  volume: VolumeRow,
  externalId: string,
  attachment: VolumeAttachment,
  attachedTo: string | undefined,
  detachOnly: boolean,
): Promise<void> {
  const machine = attachment.external_id;
  const instanceGone = attachment.instance_state === 'deleted';
  if (attachment.desired_state === 'present' && !detachOnly && !instanceGone) {
    if (!machine || ['deleting', 'lost', 'error'].includes(attachment.instance_state)) {
      // Waits for the instance's machine (an instance being deleted is detached by its delete).
      run.inFlight = true;
      return;
    }
    if (attachedTo === machine && attachment.state === 'ready') return;
    const result = await run.attempt(`attach ${attachment.id}`, () =>
      volumes.attachVolume(
        externalId,
        machine,
        run.call(`attach:${attachment.id}`),
        attachment.instance_id,
      ),
    );
    if (result === undefined) return;
    if (result === 'missing' || result.state === 'error') {
      await writeAttachment(run, attachment, {
        state: 'error',
        message: result === 'missing' ? 'The provider did not answer' : (result.message ?? null),
      });
      return;
    }
    if (result.state === 'ready') {
      await writeAttachment(
        run,
        attachment,
        { state: 'ready', machine_id: machine },
        { volume, verb: 'attached' },
      );
      return;
    }
    run.inFlight = true;
    await writeAttachment(run, attachment, { state: 'pending', machine_id: machine });
    return;
  }
  // Detach: from the machine it was sent to, else the one its instance has. The provider is asked even when it
  // reports the volume on no machine: an attach it is still running would attach it after the detach was settled
  // (DoVolumes.detachVolume answers `deleting` while one runs). A volume on a machine no attachment names is
  // detachStray's.
  const from = attachment.machine_id ?? machine ?? undefined;
  if (from === undefined) {
    // Never sent to a machine (its instance has none): nothing to detach.
    await settleDetached(run, attachment, volume);
    return;
  }
  const result = await run.attempt(`detach ${attachment.id}`, () =>
    volumes.detachVolume(externalId, from, run.call(`detach:${attachment.id}`)),
  );
  if (result === undefined) return;
  if (result === 'missing' || result.state === 'deleted') {
    await settleDetached(run, attachment, volume);
    return;
  }
  if (result.state === 'error') {
    await markAttachment(run, attachment, 'error', result.message ?? null);
    return;
  }
  run.inFlight = true;
  await markAttachment(run, attachment, 'deleting', null);
}

/**
 * Detaches the volume from `attachedTo` when no live attachment names that machine and it is a live instance's of
 * this deployment (an attach whose detach was settled before the provider finished it). A machine that is not one of
 * ours is never touched. Answers where the volume still is: `on` (undefined: nowhere), `busy` while the detach runs,
 * or the provider's refusal in `error`.
 */
async function detachStray(
  run: Run,
  volumes: ProviderVolumes,
  volume: VolumeRow,
  externalId: string,
  attachments: readonly VolumeAttachment[],
  attachedTo: string | undefined,
): Promise<{ on?: string; busy?: boolean; error?: string }> {
  if (attachedTo === undefined) return {};
  if (attachments.some((a) => a.machine_id === attachedTo || a.external_id === attachedTo))
    return { on: attachedTo };
  const ours = await run.sql.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT 1 FROM instances WHERE provider_account_id = $1 AND external_id = $2 AND state <> 'deleted' LIMIT 1`,
      [volume.provider_account_id, attachedTo],
    );
    return rows.length > 0;
  });
  if (!ours) return { on: attachedTo };
  run.deps.log.warn('providerResources: detaching a volume from a machine no attachment names', {
    volumeId: volume.id,
    machineId: attachedTo,
  });
  const result = await run.attempt(`detach ${volume.id} stray`, () =>
    volumes.detachVolume(externalId, attachedTo, run.call(`detach:${volume.id}:${attachedTo}`)),
  );
  if (result === undefined) return { on: attachedTo, busy: true };
  if (result === 'missing' || result.state === 'deleted') return {};
  if (result.state === 'error') return { on: attachedTo, error: result.message ?? 'The detach failed' };
  run.inFlight = true;
  return { on: attachedTo, busy: true };
}

/** Writes a detach's progress, whatever the attachment's wanted state (an instance delete detaches a wanted one). */
async function markAttachment(
  run: Run,
  attachment: VolumeAttachment,
  state: AttachmentState,
  message: string | null,
): Promise<void> {
  await run.sql.transaction((tx) =>
    tx.query(
      `UPDATE provider_volume_attachments SET state = $2, message = $3 WHERE id = $1 AND state <> 'deleted'`,
      [attachment.id, state, message],
    ),
  );
}

async function settleDetached(
  run: Run,
  attachment: VolumeAttachment,
  volume: VolumeRow,
): Promise<void> {
  await run.sql.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE provider_volume_attachments SET state = 'deleted', desired_state = 'deleted', message = NULL
        WHERE id = $1 AND state <> 'deleted' RETURNING id`,
      [attachment.id],
    );
    if (rows.length > 0 && attachment.machine_id !== null)
      await publish(run.deps, tx, 'providerVolume', volume, 'detached', {
        instanceId: attachment.instance_id,
      });
  });
}

async function finishVolume(run: Run, volume: VolumeRow): Promise<void> {
  await run.write(
    'provider_volumes',
    volume,
    { state: 'deleted', message: null, charged_gib: 0 },
    async (tx) => {
      if (Number(volume.charged_gib) > 0)
        await refundQuota(tx, volume.tenant_id, volume.pool_id, {
          [volumeQuotaResource]: Number(volume.charged_gib),
        });
      await run.deps.authz.remove(tx, { type: 'provider-volume', id: volume.id });
      await publish(run.deps, tx, 'providerVolume', volume, 'deleted');
    },
  );
}

/** Writes the volume's state and publishes `ready`, `resized` or `error` when they are new. */
async function setVolume(
  run: Run,
  volume: VolumeRow,
  fields: Fields & { state: ProviderResourceStatus },
): Promise<void> {
  const becameReady = fields.state === 'ready' && volume.state !== 'ready';
  const becameError =
    fields.state === 'error' && (volume.state !== 'error' || volume.message !== fields.message);
  const grew =
    typeof fields.observed_size_gib === 'number' &&
    volume.observed_size_gib !== null &&
    fields.observed_size_gib > Number(volume.observed_size_gib);
  await run.write(
    'provider_volumes',
    volume,
    { ...fields, ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
    async (tx) => {
      if (becameReady) await publish(run.deps, tx, 'providerVolume', volume, 'ready');
      if (grew)
        await publish(run.deps, tx, 'providerVolume', volume, 'resized', {
          sizeGiB: fields.observed_size_gib as number,
        });
      if (becameError)
        await publish(run.deps, tx, 'providerVolume', volume, 'error', {
          message: String(fields.message ?? ''),
        });
    },
  );
}

async function reconcileVolume(run: Run, volumeId: string): Promise<void> {
  const loaded = await run.sql.transaction((tx) => loadVolume(tx, volumeId));
  if (!loaded || loaded.volume.state === 'deleted') return;
  const { volume } = loaded;
  const volumes = await run.client(loaded.account, volume.provider_account_id, 'volumes');
  if (typeof volumes === 'string') {
    await setVolume(run, volume, settled('error', volumes));
    return;
  }
  if (volume.desired_state === 'deleted') await teardownVolume(run, volumes, loaded);
  else await convergeVolume(run, volumes, loaded);
}

function volumeSpec(volume: VolumeRow, snapshotId: string | undefined): ProviderVolumeSpec {
  return {
    name: providerResourceName(volume.id),
    region: volume.region,
    sizeGiB: Number(volume.size_gib),
    kind: 'block',
    ...(volume.filesystem ? { filesystem: volume.filesystem } : {}),
    ...(snapshotId !== undefined ? { snapshotId } : {}),
  };
}

/** The message of a volume the provider no longer has although vps made it and never deleted it. */
const volumeDeletedOutsideMessage =
  'The volume was deleted at the provider outside better-compute; its data is gone and it is never created again. Delete this volume';

/**
 * A volume vps made that the provider no longer has: `error` (published once), its external id kept, and never
 * created again. A detach asked meanwhile is settled without a provider call; a wanted attachment says why it is not.
 */
async function volumeGone(
  run: Run,
  volume: VolumeRow,
  attachments: readonly VolumeAttachment[],
): Promise<void> {
  run.deps.log.warn('providerResources: volume deleted at the provider outside better-compute', {
    volumeId: volume.id,
    providerAccountId: volume.provider_account_id,
  });
  for (const attachment of attachments) {
    if (attachment.desired_state === 'deleted') await settleDetached(run, attachment, volume);
    else if (attachment.state !== 'error' || attachment.message !== 'The volume is gone')
      await writeAttachment(run, attachment, { state: 'error', message: 'The volume is gone' });
  }
  await setVolume(run, volume, settled('error', volumeDeletedOutsideMessage));
}

async function convergeVolume(
  run: Run,
  volumes: ProviderVolumes,
  { volume, attachments, source }: LoadedVolume,
): Promise<void> {
  // A volume that goes with its instance's machine, while that machine is being deleted: no provider call (the
  // delete may already have taken it, and an ensure by name would make it again). The instance's finished delete
  // wakes it (onInstanceDeleted).
  if (
    volume.delete_with_instance &&
    attachments.some((a) => a.desired_state === 'present' && a.instance_state === 'deleting')
  )
    return;
  let ensured: ProviderResourceState | 'missing' | undefined;
  if (volume.external_id) {
    // Made already: only read. A volume gone from the provider was deleted outside better-compute; an ensure by name
    // would quietly make a new, empty one at the same guest path, so the row fails instead and nothing is created.
    const id = volume.external_id;
    const observed = await run.attempt(`get ${volume.id}`, () =>
      volumes.getVolume(id, run.call(`get:${volume.id}`)),
    );
    if (observed === undefined) return;
    if (observed === 'missing' || observed.state === 'deleted') {
      await volumeGone(run, volume, attachments);
      return;
    }
    ensured = observed;
  } else {
    let snapshotId: string | undefined;
    if (volume.source_snapshot_id) {
      // A restore waits for its snapshot's provider id; a snapshot that went away fails it.
      if (!source?.external_id) {
        if (!source || source.state === 'deleted' || source.state === 'error')
          await setVolume(run, volume, settled('error', `Snapshot ${volume.source_snapshot_id} is gone`));
        else run.inFlight = true;
        return;
      }
      snapshotId = source.external_id;
    }
    if (!volume.ensure_requested) {
      if (!(await run.write('provider_volumes', volume, { ensure_requested: true }))) return;
    }
    // First create, or a create whose answer was lost: the ensure finds by name what an earlier attempt made.
    ensured = await run.attempt(`ensure ${volume.id}`, () =>
      volumes.ensureVolume(volumeSpec(volume, snapshotId), run.call(`ensure:${volume.id}`)),
    );
  }
  if (ensured === undefined) return;
  if (ensured === 'missing' || ensured.state === 'error') {
    // A refusal created nothing: a delete then needs no provider call, and its quota is refunded at once.
    const refused =
      ensured !== 'missing' &&
      !volume.external_id &&
      run.lastCode !== undefined &&
      refusedCodes.includes(run.lastCode);
    await setVolume(run, volume, {
      ...settled('error', ensured === 'missing' ? 'The provider did not answer' : ensured.message),
      ...(refused ? { ensure_requested: false } : {}),
    });
    return;
  }
  const externalId = ensured.id || volume.external_id;
  const observed = outputGiB(ensured) ?? volume.observed_size_gib;
  const observedFields: Fields = {
    ...(externalId ? { external_id: externalId } : {}),
    ...(observed !== null && observed !== undefined ? { observed_size_gib: Number(observed) } : {}),
    ...(output(ensured, 'device') ? { device: output(ensured, 'device')! } : {}),
  };
  if (ensured.state !== 'ready' || !externalId) {
    run.inFlight = true;
    await setVolume(run, volume, {
      ...observedFields,
      ...settled(ensured.state === 'updating' ? 'updating' : 'pending'),
    });
    return;
  }
  let state: ProviderResourceStatus = 'ready';
  let size = observed === null || observed === undefined ? undefined : Number(observed);
  if (size !== undefined && size < Number(volume.size_gib)) {
    const resized = await run.attempt(`resize ${volume.id}`, () =>
      volumes.resizeVolume(
        externalId,
        Number(volume.size_gib),
        run.call(`resize:${volume.id}:${volume.size_gib}`),
      ),
    );
    if (resized === undefined) {
      await setVolume(run, volume, { ...observedFields, ...settled('updating') });
      return;
    }
    if (resized === 'missing' || resized.state === 'error') {
      await setVolume(run, volume, {
        ...observedFields,
        ...settled('error', resized === 'missing' ? 'The provider did not answer' : resized.message),
      });
      return;
    }
    if (resized.state === 'ready') size = outputGiB(resized) ?? Number(volume.size_gib);
    else {
      run.inFlight = true;
      state = 'updating';
    }
  }
  const stray = await detachStray(
    run,
    volumes,
    volume,
    externalId,
    attachments,
    output(ensured, 'attachedTo'),
  );
  if (stray.error !== undefined) {
    await setVolume(run, volume, { ...observedFields, ...settled('error', stray.error) });
    return;
  }
  // The attachments wait until a stray attachment is gone (an attach elsewhere would be CONFLICT meanwhile).
  if (!stray.busy)
    for (const attachment of attachments)
      await convergeAttachment(run, volumes, volume, externalId, attachment, stray.on, false);
  await setVolume(run, volume, {
    ...observedFields,
    ...(size !== undefined ? { observed_size_gib: size } : {}),
    ...settled(state),
  });
}

async function teardownVolume(
  run: Run,
  volumes: ProviderVolumes,
  { volume, attachments, source }: LoadedVolume,
): Promise<void> {
  let externalId = volume.external_id;
  if (!externalId) {
    // Never sent to the provider, or refused by it: nothing to delete there. Sent, with its answer lost: found by
    // name (never created to be deleted); a provider without `findVolume` falls back to the ensure by name.
    if (!volume.ensure_requested) {
      for (const attachment of attachments) await settleDetached(run, attachment, volume);
      await finishVolume(run, volume);
      return;
    }
    const find = volumes.findVolume?.bind(volumes);
    const name = providerResourceName(volume.id);
    const ensured = await run.attempt(`find ${volume.id}`, () =>
      find
        ? find(name, volume.region, run.call(`find:${volume.id}`))
        : volumes.ensureVolume(
            volumeSpec(volume, source?.external_id ?? undefined),
            run.call(`ensure:${volume.id}`),
          ),
    );
    if (ensured === undefined) return;
    if (ensured === 'missing' && find) {
      for (const attachment of attachments) await settleDetached(run, attachment, volume);
      await finishVolume(run, volume);
      return;
    }
    if (ensured === 'missing' || ensured.state === 'error' || !ensured.id) {
      await setVolume(
        run,
        volume,
        settled('error', ensured === 'missing' ? 'The provider did not answer' : ensured.message),
      );
      return;
    }
    externalId = ensured.id;
    if (!(await run.write('provider_volumes', volume, { external_id: externalId }))) return;
  }
  const id = externalId;
  const observed = await run.attempt(`get ${volume.id}`, () =>
    volumes.getVolume(id, run.call(`get:${volume.id}`)),
  );
  if (observed === undefined) return;
  if (observed === 'missing' || observed.state === 'deleted') {
    for (const attachment of attachments) await settleDetached(run, attachment, volume);
    await finishVolume(run, volume);
    return;
  }
  const stray = await detachStray(run, volumes, volume, id, attachments, output(observed, 'attachedTo'));
  if (stray.error !== undefined) {
    await setVolume(run, volume, settled('error', stray.error));
    return;
  }
  for (const attachment of attachments)
    await convergeAttachment(run, volumes, volume, id, attachment, stray.on, true);
  if (run.inFlight || run.backoff || run.again) {
    await setVolume(run, volume, settled('deleting'));
    return;
  }
  const remaining = await run.sql.transaction(async (tx) => (await liveAttachments(tx, [volume.id])).length);
  // A detach failed (its attachment says why): the volume waits for the periodic pass.
  if (remaining > 0) return;
  const deleted = await run.attempt(`delete ${volume.id}`, () =>
    volumes.deleteVolume(id, run.call(`delete:${volume.id}`)),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finishVolume(run, volume);
    return;
  }
  if (deleted.state === 'error') {
    await setVolume(run, volume, settled('error', deleted.message));
    return;
  }
  run.inFlight = true;
  await setVolume(run, volume, settled('deleting'));
}

// --- Snapshots ---------------------------------------------------------------------------------

async function reconcileSnapshot(run: Run, snapshotId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const snapshot = await readSnapshot(tx, snapshotId);
    if (!snapshot) return undefined;
    const volume = (
      await tx.query<{ external_id: string | null; state: string }>(
        `SELECT external_id, state FROM provider_volumes WHERE id = $1`,
        [snapshot.volume_id],
      )
    ).rows[0];
    return { snapshot, volume, account: await readAccount(tx, snapshot.provider_account_id) };
  });
  if (!loaded || loaded.snapshot.state === 'deleted') return;
  const { snapshot, volume } = loaded;
  const set = async (fields: Fields & { state: ProviderResourceStatus }) => {
    const becameReady = fields.state === 'ready' && snapshot.state !== 'ready';
    const becameError =
      fields.state === 'error' && (snapshot.state !== 'error' || snapshot.message !== fields.message);
    await run.write(
      'provider_snapshots',
      snapshot,
      { ...fields, ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
      async (tx) => {
        if (becameReady || becameError)
          await publish(run.deps, tx, 'providerVolume.snapshot', snapshot, becameReady ? 'ready' : 'error', {
            volumeId: snapshot.volume_id,
            ...(becameError ? { message: String(fields.message ?? '') } : {}),
          });
      },
    );
  };
  const finish = () =>
    run.write('provider_snapshots', snapshot, { state: 'deleted', message: null }, async (tx) => {
      await run.deps.authz.remove(tx, { type: 'provider-snapshot', id: snapshot.id });
      await publish(run.deps, tx, 'providerVolume.snapshot', snapshot, 'deleted', {
        volumeId: snapshot.volume_id,
      });
    });
  const volumes = await run.client(loaded.account, snapshot.provider_account_id, 'volumes');
  if (typeof volumes === 'string') {
    await set(settled('error', volumes));
    return;
  }
  const name = providerResourceName(snapshot.id);
  const volumeExternal = volume?.external_id ?? undefined;
  let externalId = snapshot.external_id;
  // A snapshot to take, or one being deleted whose take was sent with its answer lost (taking it again by name finds
  // what it made, so it is deleted rather than leaked).
  if (snapshot.desired_state === 'present' || (!externalId && snapshot.ensure_requested)) {
    if (!volumeExternal || (snapshot.desired_state === 'deleted' && volume?.state === 'deleted')) {
      if (snapshot.desired_state === 'deleted') {
        // Its volume never reached the provider (so neither did the snapshot), or is gone with it.
        await finish();
        return;
      }
      if (!volume || volume.state === 'deleted' || volume.state === 'error')
        await set(settled('error', `Volume ${snapshot.volume_id} is not at the provider`));
      else run.inFlight = true;
      return;
    }
    if (!snapshot.ensure_requested) {
      if (!(await run.write('provider_snapshots', snapshot, { ensure_requested: true }))) return;
    }
    const taken = await run.attempt(`snapshot ${snapshot.id}`, () =>
      volumes.snapshotVolume(volumeExternal, name, run.call(`snapshot:${snapshot.id}`)),
    );
    if (taken === undefined) return;
    if (taken === 'missing' || taken.state === 'error' || !taken.id) {
      await set(
        settled(
          'error',
          taken === 'missing' ? 'The provider did not answer' : (taken.message ?? 'No snapshot id'),
        ),
      );
      return;
    }
    externalId = taken.id;
    if (snapshot.desired_state === 'present') {
      const size = outputGiB(taken);
      if (taken.state !== 'ready') run.inFlight = true;
      await set({
        external_id: externalId,
        ...(size !== undefined ? { size_gib: size } : {}),
        ...settled(taken.state === 'ready' ? 'ready' : 'pending'),
      });
      return;
    }
    if (!(await run.write('provider_snapshots', snapshot, { external_id: externalId }))) return;
  }
  if (!externalId) {
    await finish();
    return;
  }
  const id = externalId;
  const deleted = await run.attempt(`delete ${snapshot.id}`, () =>
    volumes.deleteSnapshot(id, run.call(`delete:${snapshot.id}`)),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finish();
    return;
  }
  if (deleted.state === 'error') {
    await set(settled('error', deleted.message));
    return;
  }
  run.inFlight = true;
  await set(settled('deleting'));
}

// --- Addresses ---------------------------------------------------------------------------------

async function reconcileAddress(run: Run, addressId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const address = await readAddress(tx, addressId);
    if (!address) return undefined;
    const instance = address.instance_id
      ? (
          await tx.query<{ external_id: string | null; state: string }>(
            `SELECT external_id, state FROM instances WHERE id = $1`,
            [address.instance_id],
          )
        ).rows[0]
      : undefined;
    return { address, instance, account: await readAccount(tx, address.provider_account_id) };
  });
  if (!loaded || loaded.address.state === 'deleted') return;
  const { address, instance } = loaded;
  const set = async (fields: Fields, before?: (tx: SqlTx) => Promise<void>) => {
    const state = fields.state as ProviderResourceStatus | undefined;
    const becameReady = state === 'ready' && address.state !== 'ready';
    const becameError =
      state === 'error' && (address.state !== 'error' || address.message !== fields.message);
    const assigned =
      fields.assignment_state === 'ready' && address.assignment_state !== 'ready';
    const unassigned =
      fields.assignment_state === 'none' && address.assigned_machine !== null;
    await run.write(
      'provider_addresses',
      address,
      { ...fields, ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
      async (tx) => {
        if (becameReady)
          await publish(run.deps, tx, 'providerAddress', address, 'ready', {
            ...(typeof fields.address === 'string' ? { address: fields.address } : {}),
          });
        if (assigned)
          await publish(run.deps, tx, 'providerAddress', address, 'assigned', {
            instanceId: address.instance_id ?? '',
          });
        if (unassigned) await publish(run.deps, tx, 'providerAddress', address, 'unassigned');
        if (becameError)
          await publish(run.deps, tx, 'providerAddress', address, 'error', {
            message: String(fields.message ?? ''),
          });
      },
      before,
    );
  };
  if (address.lost) {
    // The reservation is gone: no provider call, ever. A delete finishes the row; anything else keeps it in error.
    if (address.desired_state === 'deleted') await finishAddress(run, address);
    else await set(settled('error', addressLostMessage));
    return;
  }
  const addresses = await run.client(loaded.account, address.provider_account_id, 'addresses');
  if (typeof addresses === 'string') {
    await set(settled('error', addresses));
    return;
  }
  if (address.desired_state === 'deleted') await teardownAddress(run, addresses, address, set);
  else await convergeAddress(run, addresses, address, instance, set);
}

/** The message of an address whose reservation is gone (`lost`). */
const addressLostMessage =
  'The reserved address was released at the provider outside better-compute, or its IP handed to another reservation; it is never re-adopted, assigned or released. Delete this address';

/** What a row that lost its reservation keeps: no provider id, no assignment, never another provider call. */
const lostFields = (): Fields => ({
  lost: true,
  external_id: null,
  instance_id: null,
  assigned_machine: null,
  assignment_state: 'none',
  assignment_message: null,
  ...settled('error', addressLostMessage),
});

/** Marks the address lost (its reservation is gone), publishing `providerAddress.error` once. */
async function loseAddress(run: Run, address: AddressRow): Promise<void> {
  run.deps.log.warn('providerResources: the reservation of this address is gone; it is never re-adopted', {
    addressId: address.id,
    providerAccountId: address.provider_account_id,
  });
  await run.write('provider_addresses', address, lostFields(), (tx) =>
    publish(run.deps, tx, 'providerAddress', address, 'error', { message: addressLostMessage }),
  );
}

/**
 * Before a fresh reserve's id is recorded: any other live row that still records it lost its reservation (the
 * provider hands out only an address no reservation holds, so that one was released outside better-compute). Each
 * is marked lost, so it never assigns or releases the new reservation, and woken to settle.
 */
async function claimAddress(run: Run, tx: SqlTx, address: AddressRow, externalId: string): Promise<void> {
  const lost = lostFields();
  const set = assignments(lost);
  const { rows } = await tx.query<AddressRow>(
    `UPDATE provider_addresses SET ${set.sql}, version = version + 1
      WHERE provider_account_id = $1 AND external_id = $2 AND id <> $${set.params.length + 3}
        AND state <> 'deleted'
      RETURNING ${addressColumns}`,
    [address.provider_account_id, externalId, ...set.params, address.id],
  );
  for (const row of rows) {
    run.deps.log.warn('providerResources: a reserve was handed the address another row recorded; that row is lost', {
      addressId: row.id,
      newAddressId: address.id,
      providerAccountId: address.provider_account_id,
    });
    await publish(run.deps, tx, 'providerAddress', row, 'error', { message: addressLostMessage });
    await run.deps.work.enqueue(tx, providerResourcesWork, row.id);
  }
}

async function finishAddress(run: Run, address: AddressRow): Promise<boolean> {
  return run.write(
    'provider_addresses',
    address,
    { state: 'deleted', message: null, charged: 0 },
    async (tx) => {
      if (Number(address.charged) > 0)
        await refundQuota(tx, address.tenant_id, address.pool_id, {
          [addressQuotaResource]: Number(address.charged),
        });
      await run.deps.authz.remove(tx, { type: 'provider-address', id: address.id });
      await publish(run.deps, tx, 'providerAddress', address, 'deleted');
    },
  );
}

async function convergeAddress(
  run: Run,
  addresses: ProviderAddresses,
  address: AddressRow,
  instance: { external_id: string | null; state: string } | undefined,
  set: (fields: Fields, before?: (tx: SqlTx) => Promise<void>) => Promise<void>,
): Promise<void> {
  if (!address.external_id && address.ensure_requested) {
    // A reserve whose answer was lost may have reserved an address no id names (a provider whose addresses carry no
    // name or tag cannot find it again): not retried, which could reserve a second one. An operator checks the
    // account and deletes this address.
    await set(
      settled(
        'error',
        "The provider's answer to the reserve was lost; it may hold an unassigned address. Delete this address and check the account",
      ),
    );
    return;
  }
  if (!address.external_id) {
    if (!(await run.write('provider_addresses', address, { ensure_requested: true }))) return;
  }
  const spec = {
    name: providerResourceName(address.id),
    region: address.region,
    family: address.family,
    ...(address.external_id ? { id: address.external_id } : {}),
    ...(address.external_id && address.fingerprint ? { fingerprint: address.fingerprint } : {}),
  };
  const ensured = await run.attempt(`ensure ${address.id}`, () =>
    addresses.ensureAddress(spec, run.call(`ensure:${address.id}`)),
  );
  if (ensured === undefined) {
    // Rate limited before anything was reserved, or not sent at all (the run's budget was spent): the next run may
    // reserve again.
    if (
      !address.external_id &&
      (run.skipped || (run.lastCode !== undefined && !ambiguousCodes.includes(run.lastCode)))
    )
      await run.write('provider_addresses', address, { ensure_requested: false });
    return;
  }
  if (
    address.external_id &&
    ensured !== 'missing' &&
    ensured.state === 'error' &&
    (run.lastCode === 'NOT_FOUND' ||
      (run.lastCode === 'INVALID_STATE' && (run.lastReason === 'notManaged' || run.lastReason === 'region')))
  ) {
    // The reservation is gone (released outside better-compute), or the address at its id is another one: lost for
    // good, never re-adopted later when the provider hands the IP out again.
    await loseAddress(run, address);
    return;
  }
  if (ensured === 'missing' || ensured.state === 'error' || !ensured.id) {
    // A refusal reserved nothing: the next run may reserve again.
    await set({
      ...settled(
        'error',
        ensured === 'missing' ? 'The provider did not answer' : (ensured.message ?? 'No address id'),
      ),
      ...(address.external_id ? {} : { ensure_requested: false }),
    });
    return;
  }
  const externalId = ensured.id;
  // A fresh reserve: another live row recording this id lost its reservation, and is marked so first.
  const claim = address.external_id
    ? undefined
    : (tx: SqlTx) => claimAddress(run, tx, address, externalId);
  const fields: Fields = {
    external_id: externalId,
    ...(output(ensured, 'address') ? { address: output(ensured, 'address')! } : {}),
    // Recorded once, from the reserve's answer: what later reads are held to.
    ...(!address.fingerprint && output(ensured, 'fingerprint')
      ? { fingerprint: output(ensured, 'fingerprint')! }
      : {}),
  };
  if (ensured.state !== 'ready') {
    run.inFlight = true;
    await set({ ...fields, ...settled('pending') }, claim);
    return;
  }
  const assignedTo = output(ensured, 'assignedTo');
  const wanted =
    address.instance_id !== null && instance && instance.state !== 'deleted'
      ? (instance.external_id ?? undefined)
      : undefined;
  let assignment: Fields = {};
  if (address.instance_id !== null && instance?.state !== 'deleted') {
    if (!wanted || ['deleting', 'lost', 'error'].includes(instance?.state ?? '')) {
      run.inFlight = true;
      assignment = { assignment_state: 'pending' };
    } else if (assignedTo === wanted) {
      assignment = { assignment_state: 'ready', assigned_machine: wanted, assignment_message: null };
    } else {
      assignment = await moveAddress(run, addresses, address, externalId, assignedTo, wanted);
    }
  } else if (assignedTo !== undefined) {
    // Wanted on nothing (or its instance is gone): released from the machine the provider reports.
    const released = await unassign(run, addresses, address, externalId);
    assignment = released;
    if (address.instance_id !== null && released.assignment_state === 'none')
      assignment = { ...released, instance_id: null };
  } else {
    assignment = {
      assignment_state: 'none',
      assigned_machine: null,
      assignment_message: null,
      ...(address.instance_id !== null ? { instance_id: null } : {}),
    };
  }
  await set({ ...fields, ...assignment, ...settled('ready') }, claim);
}

async function unassign(
  run: Run,
  addresses: ProviderAddresses,
  address: AddressRow,
  externalId: string,
): Promise<Fields> {
  const result = await run.attempt(`unassign ${address.id}`, () =>
    addresses.unassignAddress(externalId, run.call(`unassign:${address.id}`)),
  );
  if (result === undefined) return { assignment_state: 'deleting' };
  if (result === 'missing' || result.state === 'deleted')
    return { assignment_state: 'none', assigned_machine: null, assignment_message: null };
  if (result.state === 'error')
    return { assignment_state: 'error', assignment_message: (result.message ?? '').slice(0, 500) };
  run.inFlight = true;
  return { assignment_state: 'deleting' };
}

/** Puts the address on `machine`: released first from another machine the provider reports it on. */
async function moveAddress(
  run: Run,
  addresses: ProviderAddresses,
  address: AddressRow,
  externalId: string,
  assignedTo: string | undefined,
  machine: string,
): Promise<Fields> {
  if (assignedTo !== undefined) {
    // Only a machine this address was put on by us is released; a stranger's is never taken over.
    if (address.assigned_machine !== assignedTo)
      return {
        assignment_state: 'error',
        assignment_message: `The provider reports the address on machine ${assignedTo}, which better-compute did not assign it to`,
      };
    const released = await unassign(run, addresses, address, externalId);
    if (released.assignment_state !== 'none') return released;
  }
  const result = await run.attempt(`assign ${address.id}`, () =>
    addresses.assignAddress(
      externalId,
      machine,
      run.call(`assign:${address.id}:${machine}`),
      address.instance_id ?? undefined,
    ),
  );
  if (result === undefined) return { assignment_state: 'pending' };
  if (result === 'missing' || result.state === 'error')
    return {
      assignment_state: 'error',
      assignment_message:
        result === 'missing' ? 'The provider did not answer' : (result.message ?? '').slice(0, 500),
    };
  if (result.state === 'ready')
    return { assignment_state: 'ready', assigned_machine: machine, assignment_message: null };
  run.inFlight = true;
  return { assignment_state: 'pending', assigned_machine: machine };
}

async function teardownAddress(
  run: Run,
  addresses: ProviderAddresses,
  address: AddressRow,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  const finish = () => finishAddress(run, address);
  const externalId = address.external_id;
  if (!externalId) {
    // Never reserved: nothing to release. A reserve whose answer was lost cannot be found again by vps: the row is
    // deleted with a warning, and the account's own listing is where an operator finds the address.
    if (address.ensure_requested)
      run.deps.log.warn('providerResources: deleting an address whose reserve answer was lost', {
        addressId: address.id,
        providerAccountId: address.provider_account_id,
      });
    await finish();
    return;
  }
  const observed = await run.attempt(`get ${address.id}`, () =>
    addresses.getAddress(externalId, run.call(`get:${address.id}`)),
  );
  if (observed === undefined) return;
  if (observed === 'missing' || observed.state === 'deleted') {
    await finish();
    return;
  }
  // Another reservation at our address (ours was released out of band, and the provider handed the IP out again):
  // ours is gone, and the other one is never unassigned or released.
  const stranger = () => {
    run.deps.log.warn('providerResources: the address at this id is another reservation; not released', {
      addressId: address.id,
      providerAccountId: address.provider_account_id,
    });
    return finish();
  };
  const observedFingerprint = output(observed, 'fingerprint');
  if (
    (address.fingerprint && observedFingerprint !== address.fingerprint) ||
    (output(observed, 'region') !== undefined && output(observed, 'region') !== address.region)
  ) {
    await stranger();
    return;
  }
  if (output(observed, 'assignedTo') !== undefined) {
    const released = await unassign(run, addresses, address, externalId);
    if (released.assignment_state !== 'none') {
      await set({ ...released, ...settled('deleting') });
      return;
    }
  }
  const deleted = await run.attempt(`delete ${address.id}`, () =>
    addresses.deleteAddress(externalId, run.call(`delete:${address.id}`), {
      region: address.region,
      ...(address.fingerprint ? { fingerprint: address.fingerprint } : {}),
    }),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finish();
    return;
  }
  if (deleted.state === 'error' && run.lastCode === 'INVALID_STATE' && run.lastReason === 'notManaged') {
    await stranger();
    return;
  }
  if (deleted.state === 'error') {
    await set(settled('error', deleted.message));
    return;
  }
  run.inFlight = true;
  await set(settled('deleting'));
}

// --- Instance delete ---------------------------------------------------------------------------

/**
 * The provider ids of the volumes an instance's machine delete may take with it (`ProviderDeleteOptions.volumes`,
 * DO's selective destroy): wanted on it, created with `deleteWithInstance`, and at the provider. The provider itself
 * names only those it finds ours and attached there; one it leaves is deleted after the machine (onInstanceDeleted).
 */
export async function volumesDeletedWith(tx: SqlTx, instanceId: string): Promise<string[]> {
  const { rows } = await tx.query<{ external_id: string }>(
    `SELECT v.external_id FROM provider_volume_attachments a JOIN provider_volumes v ON v.id = a.volume_id
      WHERE a.instance_id = $1 AND a.state <> 'deleted' AND a.desired_state = 'present'
        AND v.delete_with_instance AND v.desired_state = 'present' AND v.external_id IS NOT NULL
      ORDER BY v.id`,
    [instanceId],
  );
  return rows.map((row) => row.external_id);
}

/**
 * Called in the transaction that finishes an instance's deletion. Its attachments are no longer wanted; when its
 * machine was deleted (not left running by a detach), its `deleteWithInstance` volumes are deleted too. Every volume
 * and address it had is woken: the reconciler settles the detach (the provider detached them with the machine),
 * deletes what is to go (already gone after a selective destroy) and unassigns its addresses, which are kept.
 */
export async function onInstanceDeleted(
  deps: Pick<ProviderResourceDeps, 'events' | 'work'>,
  tx: SqlTx,
  instanceId: string,
  options: { machineDeleted: boolean },
): Promise<void> {
  const attached = await tx.query<{ volume_id: string; desired_state: string }>(
    `SELECT volume_id, desired_state FROM provider_volume_attachments
      WHERE instance_id = $1 AND state <> 'deleted' ORDER BY volume_id FOR UPDATE`,
    [instanceId],
  );
  await tx.query(
    `UPDATE provider_volume_attachments SET desired_state = 'deleted' WHERE instance_id = $1 AND state <> 'deleted'`,
    [instanceId],
  );
  const volumeIds = [...new Set(attached.rows.map((row) => row.volume_id))];
  // Only a volume still wanted on it goes with it: one detached before the delete was asked is kept.
  const wanted = attached.rows.filter((row) => row.desired_state === 'present').map((row) => row.volume_id);
  if (options.machineDeleted && wanted.length > 0) {
    const doomed = await tx.query<VolumeRow>(
      `UPDATE provider_volumes SET desired_state = 'deleted', state = 'deleting', message = NULL,
              version = version + 1
        WHERE id = ANY($1::text[]) AND delete_with_instance AND desired_state = 'present' AND state <> 'deleted'
        RETURNING *`,
      [wanted],
    );
    for (const row of doomed.rows)
      await publish(deps, tx, 'providerVolume', row, 'deleting', { instanceId });
  }
  const addresses = await tx.query<{ id: string }>(
    `SELECT id FROM provider_addresses WHERE instance_id = $1 AND state <> 'deleted' ORDER BY id`,
    [instanceId],
  );
  for (const id of [...volumeIds, ...addresses.rows.map((row) => row.id)])
    await deps.work.enqueue(tx, providerResourcesWork, id);
}

// --- Entry points ------------------------------------------------------------------------------

/**
 * One step of one provider volume, snapshot or address (by id prefix). Provider calls run outside any transaction;
 * each result is written in its own short one, guarded by the version it was decided on. Returns the next wake-up,
 * or undefined when settled (an `error` waits for the periodic pass or the next change).
 */
export async function reconcileProviderResource(
  deps: ProviderResourceDeps,
  sql: SqlExecutor,
  resourceId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const run = new Run(deps, sql, signal);
  if (resourceId.startsWith('pvol_')) await reconcileVolume(run, resourceId);
  else if (resourceId.startsWith('psnap_')) await reconcileSnapshot(run, resourceId);
  else if (resourceId.startsWith('paddr_')) await reconcileAddress(run, resourceId);
  else return undefined;
  return run.next();
}

/** How often every settled row is read once at the provider for drift, its reads spread across the interval. */
export const providerResourceDriftMs = 3_600_000;

/**
 * Live rows that are not settled: anything not `ready` (pending, updating, deleting, error), a volume with an
 * attachment not yet where it is wanted, an address whose assignment is not yet what is wanted.
 */
const unsettledIds = `
  SELECT v.id FROM provider_volumes v
   WHERE v.state <> 'deleted'
     AND (v.state <> 'ready' OR v.desired_state <> 'present'
          OR EXISTS (SELECT 1 FROM provider_volume_attachments a
                      WHERE a.volume_id = v.id AND a.state <> 'deleted'
                        AND NOT (a.desired_state = 'present' AND a.state = 'ready')))
  UNION ALL SELECT id FROM provider_snapshots
   WHERE state <> 'deleted' AND (state <> 'ready' OR desired_state <> 'present')
  UNION ALL SELECT id FROM provider_addresses
   WHERE state <> 'deleted'
     AND (state <> 'ready' OR desired_state <> 'present'
          OR (instance_id IS NULL AND assignment_state <> 'none')
          OR (instance_id IS NOT NULL AND assignment_state <> 'ready'))`;

/** Live rows that are settled (the complement of `unsettledIds`). */
const settledSql = `
  SELECT id FROM (SELECT id FROM provider_volumes WHERE state <> 'deleted'
                  UNION ALL SELECT id FROM provider_snapshots WHERE state <> 'deleted'
                  UNION ALL SELECT id FROM provider_addresses WHERE state <> 'deleted') live
  EXCEPT SELECT id FROM (${unsettledIds}) unsettled
  ORDER BY id`;

/**
 * The `vps.provider-resources` reconciler, then each row converges by id. Two periodic passes keep the provider's
 * request budget for what needs it (Review Focus 3): `all` (every 5 minutes) wakes the rows that are not settled, and
 * `drift` (hourly) wakes every settled row once, spread across the hour, to notice what changed at the provider.
 */
export function providerResourcesReconciler(
  depsOf: (context: ModuleContext) => ProviderResourceDeps,
): Reconciler {
  return {
    name: providerResourcesWork,
    shardBy: 'none',
    periodic: [
      { key: 'all', every: '5m' },
      { key: 'drift', every: '1h' },
    ],
    async run(context, key) {
      if (key === 'all') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(`${unsettledIds} ORDER BY id`);
          for (const row of rows) await context.work.enqueue(tx, providerResourcesWork, row.id);
        });
        return 'DONE';
      }
      if (key === 'drift') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(settledSql);
          const now = context.clock.now();
          const step = rows.length > 0 ? providerResourceDriftMs / rows.length : 0;
          for (const [index, row] of rows.entries())
            await context.work.enqueue(tx, providerResourcesWork, row.id, {
              notBefore: now + Math.floor(index * step),
            });
        });
        return 'DONE';
      }
      const next = await reconcileProviderResource(depsOf(context), context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, providerResourcesWork, key, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
