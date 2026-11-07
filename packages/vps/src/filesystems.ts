import {
  ComputeError,
  draftId,
  isComputeError,
  strictObject,
  type CallContext,
  type InputSchema,
  type Json,
  type MethodContext,
  type Migration,
  type ModuleContext,
  type ProviderFilesystemSpec,
  type ProviderFilesystemState,
  type ProviderFilesystems,
  type ProviderMount,
  type Reconciler,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderAccount } from './accounts.js';
import { canonical, fail, id, key, object, sha256Hex, tenant } from './input.js';
import { providerResourceName, type NetworkDeps } from './networks.js';

// (AWS A10) Shared filesystems on a tenant network: an `nfs` filesystem (Amazon EFS) or a `lustre`
// one (Amazon FSx for Lustre) that the network's instances mount at boot. Like firewall rules they
// belong to a network and are decided on it. The API records what the tenant wants; the
// `vps.filesystems` reconciler converges the provider through `ProviderImpl.filesystems` and writes
// back `state` and, once ready, the `mount` machines perform. Provider calls never run in a
// transaction. Sub-plan: docs/superpowers/plans/2026-11-05-aws-a10-shared-filesystems.md (F8).

/** The work kind (key: filesystem id, or `all` for the periodic sweep) of the filesystems reconciler. */
export const filesystemsWork = 'vps.filesystems';

/** At most this many filesystems (not deleted) per network. */
export const maxFilesystemsPerNetwork = 8;

/** At most this many filesystems an instance mounts (provider-aws `maxMounts`). */
export const maxInstanceFilesystems = 16;

export const vpsFilesystemsMigration: Migration = {
  name: 'vps/0112_filesystems',
  sql: `
CREATE TABLE filesystems (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  network_id text NOT NULL REFERENCES networks,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('nfs', 'lustre')),
  size_gib integer,
  deployment text CHECK (deployment IN ('scratch', 'persistent')),
  zone text,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  -- How a machine mounts it ({ fstype, source, options }), once the provider made it: DNS names and
  -- mount names only, never a secret.
  mount jsonb,
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
-- A deleted filesystem's name is free again.
CREATE UNIQUE INDEX filesystems_name ON filesystems (network_id, name) WHERE state <> 'deleted';
CREATE INDEX filesystems_live ON filesystems (state) WHERE state <> 'deleted';

-- The filesystems an instance mounts, and where. A refused draft instance takes its rows with it.
CREATE TABLE instance_filesystems (
  instance_id text NOT NULL REFERENCES instances ON DELETE CASCADE,
  filesystem_id text NOT NULL REFERENCES filesystems,
  path text NOT NULL,
  PRIMARY KEY (instance_id, path)
);
CREATE INDEX instance_filesystems_filesystem ON instance_filesystems (filesystem_id);
`,
};

// --- Views and input ---------------------------------------------------------------------------

export type FilesystemState = 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';
export type FilesystemKind = ProviderFilesystemSpec['kind'];

export interface FilesystemView {
  id: string;
  tenantId: string;
  networkId: string;
  providerAccountId: string;
  name: string;
  kind: FilesystemKind;
  sizeGiB?: number;
  deployment?: 'scratch' | 'persistent';
  zone?: string;
  state: FilesystemState;
  message?: string;
  /** How a machine mounts it, once ready. */
  mount?: Omit<ProviderMount, 'path'>;
  version: number;
  createdAt: number;
}

export interface CreateFilesystemInput {
  tenantId: string;
  networkId: string;
  name: string;
  kind: FilesystemKind;
  sizeGiB?: number;
  deployment?: 'scratch' | 'persistent';
  zone?: string;
  idempotencyKey: string;
}
export interface FilesystemListInput {
  tenantId: string;
  networkId: string;
}
export interface FilesystemRef extends FilesystemListInput {
  filesystemId: string;
}

/** One filesystem an instance mounts (`instances.create({ filesystems })`). */
export interface InstanceFilesystemInput {
  filesystemId: string;
  path: string;
}

const resourceName = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
const zoneName = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const kinds: readonly FilesystemKind[] = ['nfs', 'lustre'];
const deployments = ['scratch', 'persistent'] as const;
/** Top-level directories a filesystem never mounts over (provider-aws checks the same). */
const reservedRoots: ReadonlySet<string> = new Set([
  'bin',
  'boot',
  'dev',
  'etc',
  'lib',
  'lib32',
  'lib64',
  'proc',
  'root',
  'run',
  'sbin',
  'snap',
  'sys',
  'tmp',
  'usr',
  'var',
]);

export function parseCreateFilesystem(raw: unknown): CreateFilesystemInput {
  const input = object(raw, [
    'tenantId',
    'networkId',
    'name',
    'kind',
    'sizeGiB',
    'deployment',
    'zone',
    'idempotencyKey',
  ]);
  if (typeof input.name !== 'string' || !resourceName.test(input.name))
    fail('name must be a lower-case letter, then up to 41 lower-case letters, digits or -');
  if (!kinds.includes(input.kind as FilesystemKind)) fail('kind is nfs or lustre');
  const result: CreateFilesystemInput = {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    name: input.name,
    kind: input.kind as FilesystemKind,
    idempotencyKey: key(input.idempotencyKey),
  };
  if (input.sizeGiB !== undefined) {
    if (
      typeof input.sizeGiB !== 'number' ||
      !Number.isSafeInteger(input.sizeGiB) ||
      input.sizeGiB < 1 ||
      input.sizeGiB > 1_000_000
    )
      fail('sizeGiB must be an integer from 1 to 1000000');
    result.sizeGiB = input.sizeGiB;
  }
  if (input.deployment !== undefined) {
    if (!deployments.includes(input.deployment as (typeof deployments)[number]))
      fail('deployment is scratch or persistent');
    result.deployment = input.deployment as (typeof deployments)[number];
  }
  if (input.zone !== undefined) {
    if (typeof input.zone !== 'string' || !zoneName.test(input.zone)) fail('zone is invalid');
    result.zone = input.zone;
  }
  return result;
}

export function parseFilesystemList(raw: unknown): FilesystemListInput {
  const input = object(raw, ['tenantId', 'networkId']);
  return { tenantId: tenant(input.tenantId), networkId: id(input.networkId, 'net', 'networkId') };
}

export function parseFilesystemRef(raw: unknown): FilesystemRef {
  const input = object(raw, ['tenantId', 'networkId', 'filesystemId']);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    filesystemId: id(input.filesystemId, 'fs', 'filesystemId'),
  };
}

/** A mount path: absolute, plain segments, no `.` or `..`, outside the system directories. */
function mountPath(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^(?:\/[A-Za-z0-9._-]+)+$/.test(value) ||
    value.split('/').some((segment) => segment === '.' || segment === '..') ||
    reservedRoots.has(value.split('/')[1]!)
  )
    fail(`${what} must be an absolute path of plain segments, outside the system directories`);
  return value;
}

/** `instances.create({ filesystems })`: at most 16, each `{ filesystem, path }`, every path once. */
export function parseInstanceFilesystems(raw: unknown): InstanceFilesystemInput[] {
  if (!Array.isArray(raw) || raw.length > maxInstanceFilesystems)
    fail(`filesystems must list at most ${maxInstanceFilesystems} mounts`);
  const paths = new Set<string>();
  return raw.map((entry, index) => {
    const input = object(entry, ['filesystem', 'path']);
    const path = mountPath(input.path, `filesystems[${index}].path`);
    if (paths.has(path)) fail(`filesystems mount ${path} twice`);
    paths.add(path);
    return { filesystemId: id(input.filesystem, 'fs', `filesystems[${index}].filesystem`), path };
  });
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
const networkIdSchema = idOf('net', 'The network the filesystem belongs to');
const filesystemIdSchema = idOf('fs', 'The filesystem');

export const filesystemSchemas = {
  create: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      name: {
        type: 'string',
        pattern: resourceName.source,
        maxLength: 42,
        description: 'The filesystem name, unique in the network, e.g. datasets',
      },
      kind: {
        enum: ['nfs', 'lustre'],
        description:
          'nfs: an elastic NFS filesystem across every zone of the network (Amazon EFS); lustre: a Lustre filesystem in one zone (Amazon FSx for Lustre)',
      },
      sizeGiB: {
        type: 'integer',
        minimum: 1,
        maximum: 1_000_000,
        description:
          'lustre: the capacity (AWS: 1200 or a multiple of 2400, default 1200); nfs is elastic and takes none',
      },
      deployment: {
        enum: ['scratch', 'persistent'],
        description: 'lustre: scratch (default) or persistent storage',
      },
      zone: {
        type: 'string',
        maxLength: 64,
        description: "lustre: the zone it lives in (default: the account's first)",
      },
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
      },
    },
    ['tenantId', 'networkId', 'name', 'kind', 'idempotencyKey'],
  ),
  list: strictObject({ tenantId: tenantIdSchema, networkId: networkIdSchema }, [
    'tenantId',
    'networkId',
  ]),
  filesystem: strictObject(
    { tenantId: tenantIdSchema, networkId: networkIdSchema, filesystemId: filesystemIdSchema },
    ['tenantId', 'networkId', 'filesystemId'],
  ),
};

// --- Rows --------------------------------------------------------------------------------------

interface FilesystemRow {
  id: string;
  tenant_id: string;
  network_id: string;
  provider_account_id: string;
  name: string;
  kind: FilesystemKind;
  size_gib: number | null;
  deployment: 'scratch' | 'persistent' | null;
  zone: string | null;
  state: FilesystemState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  mount: Omit<ProviderMount, 'path'> | string | null;
  request_hash: string;
  version: string | number;
  created_at: string | Date;
}

const columns = `id, tenant_id, network_id, provider_account_id, name, kind, size_gib, deployment, zone,
  state, desired_state, message, mount, encode(request_hash, 'hex') AS request_hash, version, created_at`;

const mountOf = (row: FilesystemRow): Omit<ProviderMount, 'path'> | undefined =>
  row.mount === null
    ? undefined
    : typeof row.mount === 'string'
      ? (JSON.parse(row.mount) as Omit<ProviderMount, 'path'>)
      : row.mount;

export function filesystemView(row: FilesystemRow): FilesystemView {
  const mount = mountOf(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    networkId: row.network_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    kind: row.kind,
    ...(row.size_gib !== null ? { sizeGiB: Number(row.size_gib) } : {}),
    ...(row.deployment !== null ? { deployment: row.deployment } : {}),
    ...(row.zone !== null ? { zone: row.zone } : {}),
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    ...(mount !== undefined && row.state !== 'deleted' ? { mount } : {}),
    version: Number(row.version),
    createdAt: new Date(row.created_at).getTime(),
  };
}

async function readFilesystem(
  tx: SqlTx,
  filesystemId: string,
  options: { tenantId?: string; networkId?: string; lock?: 'update' | 'share' } = {},
): Promise<FilesystemRow | undefined> {
  const { rows } = await tx.query<FilesystemRow>(
    `SELECT ${columns} FROM filesystems
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2) AND ($3::text IS NULL OR network_id = $3)
      ${options.lock === 'update' ? 'FOR UPDATE' : options.lock === 'share' ? 'FOR SHARE' : ''}`,
    [filesystemId, options.tenantId ?? null, options.networkId ?? null],
  );
  return rows[0];
}

interface NetworkOfFilesystem {
  id: string;
  tenant_id: string;
  provider_account_id: string;
  pool_id: string;
  state: string;
  desired_state: string;
  external_name: string | null;
  provisioned: boolean;
}

async function readNetwork(
  tx: SqlTx,
  networkId: string,
  tenantId?: string,
  lock = false,
): Promise<NetworkOfFilesystem | undefined> {
  const { rows } = await tx.query<NetworkOfFilesystem>(
    `SELECT id, tenant_id, provider_account_id, pool_id, state, desired_state, external_name,
            provisioned_at IS NOT NULL AS provisioned
       FROM networks WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${lock ? ' FOR UPDATE' : ''}`,
    [networkId, tenantId ?? null],
  );
  return rows[0];
}

async function requireNetwork(
  tx: SqlTx,
  ref: FilesystemListInput,
  lock = false,
): Promise<NetworkOfFilesystem> {
  const network = await readNetwork(tx, ref.networkId, ref.tenantId, lock);
  if (!network) throw new ComputeError('NOT_FOUND', `Network ${ref.networkId} not found`);
  return network;
}

async function publish(
  deps: Pick<NetworkDeps, 'events'>,
  tx: SqlTx,
  row: { id: string; tenant_id: string; network_id: string },
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  // Filesystems belong to a network: their events are `network.filesystem.*` on the network.
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenant_id,
    subject: `network/${row.network_id}`,
    data: { networkId: row.network_id, filesystemId: row.id, ...data },
  });
}

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);
const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];

/** The account's `ProviderFilesystems`, or UNSUPPORTED. */
async function providerFilesystems(
  deps: NetworkDeps,
  account: ProviderAccount | undefined,
  accountId: string,
): Promise<ProviderFilesystems> {
  if (!account) throw new ComputeError('NOT_FOUND', `Provider account ${accountId} not found`);
  const client = await deps.clients.client(account, deps);
  if (typeof client.filesystems !== 'object' || client.filesystems === null)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} does not provide shared filesystems`,
    );
  return client.filesystems;
}

/** The provider-side spec of a filesystem row on its network. */
function specOf(row: FilesystemRow, networkName: string): ProviderFilesystemSpec {
  return {
    name: providerResourceName(row.id),
    kind: row.kind,
    network: networkName,
    ...(row.zone !== null ? { zone: row.zone } : {}),
    ...(row.size_gib !== null ? { sizeGiB: Number(row.size_gib) } : {}),
    ...(row.deployment !== null ? { deployment: row.deployment } : {}),
  };
}

const requestHash = (input: CreateFilesystemInput) =>
  sha256Hex(
    canonical({
      networkId: input.networkId,
      name: input.name,
      kind: input.kind,
      sizeGiB: input.sizeGiB,
      deployment: input.deployment,
      zone: input.zone,
    }),
  );

// --- API ---------------------------------------------------------------------------------------

/**
 * `filesystems.create` (decided as `compute:networks:update` on the network): records the
 * filesystem `pending` and wakes the reconciler. The provider checks the spec first (`validate`), so
 * a size or zone it can never make is INVALID_INPUT with nothing recorded. A retry with the same key
 * returns the filesystem; another request under the key is CONFLICT.
 */
export async function createFilesystem(
  deps: NetworkDeps,
  context: MethodContext,
  input: CreateFilesystemInput,
): Promise<FilesystemView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const filesystemId = await draftId('fs', input.tenantId, caller.identityId, input.idempotencyKey);
  const hash = await requestHash(input);
  const existing = await readFilesystem(tx, filesystemId, { tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return filesystemView(existing);
  }
  // The network is locked: networks.delete waits for this transaction and then sees the filesystem.
  const network = await requireNetwork(tx, input, true);
  if (
    network.desired_state === 'deleted' ||
    network.state === 'deleting' ||
    network.state === 'deleted'
  )
    throw new ComputeError('INVALID_STATE', `Network ${network.id} is being deleted`);
  if (network.external_name !== null)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${network.id} is adopted; filesystems need a network better-compute made`,
    );
  const filesystems = await providerFilesystems(
    deps,
    await readAccount(tx, network.provider_account_id),
    network.provider_account_id,
  );
  if (!filesystems.kinds.includes(input.kind))
    throw new ComputeError(
      'INVALID_INPUT',
      `This provider makes ${filesystems.kinds.join(' and ') || 'no'} filesystems, not ${input.kind}`,
    );
  filesystems.validate?.(
    specOf(
      {
        id: filesystemId,
        kind: input.kind,
        zone: input.zone ?? null,
        size_gib: input.sizeGiB ?? null,
        deployment: input.deployment ?? null,
      } as FilesystemRow,
      providerResourceName(network.id),
    ),
  );
  const taken = await tx.query(
    `SELECT 1 FROM filesystems WHERE network_id = $1 AND name = $2 AND state <> 'deleted'`,
    [network.id, input.name],
  );
  if (taken.rows.length > 0)
    throw new ComputeError('CONFLICT', `Filesystem ${input.name} already exists in the network`);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM filesystems WHERE network_id = $1 AND state <> 'deleted'`,
    [network.id],
  );
  if (Number(live.rows[0]!.count) >= maxFilesystemsPerNetwork)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A network has at most ${maxFilesystemsPerNetwork} filesystems that are not deleted`,
      undefined,
      { limit: maxFilesystemsPerNetwork },
    );
  try {
    await tx.query(
      `INSERT INTO filesystems (id, tenant_id, network_id, provider_account_id, name, kind, size_gib,
                                deployment, zone, state, desired_state, created_by, idempotency_key,
                                request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'present', $10, $11, decode($12, 'hex'), 1)`,
      [
        filesystemId,
        input.tenantId,
        network.id,
        network.provider_account_id,
        input.name,
        input.kind,
        input.sizeGiB ?? null,
        input.deployment ?? null,
        input.zone ?? null,
        caller.identityId,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (code(error) === '23505') {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('name'))
        throw new ComputeError(
          'CONFLICT',
          `Filesystem ${input.name} already exists in the network`,
        );
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    }
    throw error;
  }
  const row = (await readFilesystem(tx, filesystemId))!;
  await deps.work.enqueue(tx, filesystemsWork, filesystemId);
  await publish(deps, tx, row, 'network.filesystem.created', {
    name: input.name,
    kind: input.kind,
  });
  return filesystemView(row);
}

export async function getFilesystem(tx: SqlTx, ref: FilesystemRef): Promise<FilesystemView> {
  await requireNetwork(tx, ref);
  const row = await readFilesystem(tx, ref.filesystemId, {
    tenantId: ref.tenantId,
    networkId: ref.networkId,
  });
  if (!row) throw new ComputeError('NOT_FOUND', `Filesystem ${ref.filesystemId} not found`);
  return filesystemView(row);
}

export async function listFilesystems(
  tx: SqlTx,
  ref: FilesystemListInput,
): Promise<{ items: FilesystemView[] }> {
  const network = await requireNetwork(tx, ref);
  const { rows } = await tx.query<FilesystemRow>(
    `SELECT ${columns} FROM filesystems WHERE network_id = $1 AND state <> 'deleted'
      ORDER BY name, id`,
    [network.id],
  );
  return { items: rows.map(filesystemView) };
}

/** Instances (not deleted) that mount a filesystem. */
async function mountedBy(tx: SqlTx, filesystemId: string): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT i.id FROM instance_filesystems x JOIN instances i ON i.id = x.instance_id
      WHERE x.filesystem_id = $1 AND i.state <> 'deleted' ORDER BY i.id LIMIT 100`,
    [filesystemId],
  );
  return rows.map((row) => row.id);
}

/**
 * `filesystems.delete`: marks the filesystem for deletion and returns it `deleting`; the reconciler
 * removes it at the provider. An instance (not deleted) that mounts it is INVALID_STATE with
 * `details.instanceIds`. Deleting one that is being deleted returns it unchanged.
 */
export async function deleteFilesystem(
  deps: NetworkDeps,
  tx: SqlTx,
  ref: FilesystemRef,
): Promise<FilesystemView> {
  await requireNetwork(tx, ref);
  const row = await readFilesystem(tx, ref.filesystemId, {
    tenantId: ref.tenantId,
    networkId: ref.networkId,
    lock: 'update',
  });
  if (!row) throw new ComputeError('NOT_FOUND', `Filesystem ${ref.filesystemId} not found`);
  if (row.desired_state === 'deleted') return filesystemView(row);
  const instanceIds = await mountedBy(tx, row.id);
  if (instanceIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Filesystem ${row.name} is mounted by ${instanceIds.length} instance(s)`,
      undefined,
      { instanceIds },
    );
  await tx.query(
    `UPDATE filesystems SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1 WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, filesystemsWork, row.id);
  await publish(deps, tx, row, 'network.filesystem.deleting');
  return filesystemView((await readFilesystem(tx, row.id))!);
}

/**
 * `instances.create({ filesystems })` (in its admission transaction): every filesystem is the
 * tenant's, on the instance's network, and ready (INVALID_INPUT, NOT_FOUND or INVALID_STATE
 * otherwise). The rows are locked (share), so a concurrent `filesystems.delete` waits and then sees
 * the instance (`recordInstanceFilesystems` writes its rows once it exists).
 */
export async function checkInstanceFilesystems(
  tx: SqlTx,
  instance: { tenantId: string; networkId: string },
  mounts: readonly InstanceFilesystemInput[],
): Promise<void> {
  for (const mount of mounts) {
    const row = await readFilesystem(tx, mount.filesystemId, {
      tenantId: instance.tenantId,
      lock: 'share',
    });
    if (!row || row.state === 'deleted')
      throw new ComputeError('NOT_FOUND', `Filesystem ${mount.filesystemId} not found`);
    if (row.network_id !== instance.networkId)
      throw new ComputeError(
        'INVALID_INPUT',
        `Filesystem ${row.id} is on network ${row.network_id}; an instance mounts filesystems of its own network only`,
      );
    if (row.desired_state !== 'present' || row.state !== 'ready' || mountOf(row) === undefined)
      throw new ComputeError('INVALID_STATE', `Filesystem ${row.id} is ${row.state}, not ready`);
  }
}

/** The filesystems a new instance mounts (after `checkInstanceFilesystems`, same transaction). */
export async function recordInstanceFilesystems(
  tx: SqlTx,
  instanceId: string,
  mounts: readonly InstanceFilesystemInput[],
): Promise<void> {
  for (const mount of mounts)
    await tx.query(
      `INSERT INTO instance_filesystems (instance_id, filesystem_id, path) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [instanceId, mount.filesystemId, mount.path],
    );
}

/** One mount of an instance row (instances.ts reads them with the instance). */
export interface InstanceMountRow {
  filesystemId: string;
  path: string;
  mount: Omit<ProviderMount, 'path'> | null;
}

/** The `ProviderMount`s of an instance's mounts; INVALID_STATE when one has no mount (never ready). */
export function providerMounts(rows: readonly InstanceMountRow[]): ProviderMount[] {
  return rows.map((row) => {
    if (!row.mount)
      throw new ComputeError('INVALID_STATE', `Filesystem ${row.filesystemId} is not ready`);
    return {
      fstype: row.mount.fstype,
      source: row.mount.source,
      options: row.mount.options,
      path: row.path,
    };
  });
}

// --- Reconciler --------------------------------------------------------------------------------

/** How soon a filesystem the provider is still making (or deleting) is looked at again. */
export const filesystemPollMs = 15_000;
/** How soon a rate-limited or unavailable provider is tried again. */
const filesystemRetryMs = 30_000;

/**
 * Converges one filesystem: `ensureFilesystem` while it should exist (once its network has been
 * ready), `deleteFilesystem` once deleted; writes `state`, `message` and `mount` back, guarded by the
 * row's version. Returns when to look again, or `undefined` when settled.
 */
export async function reconcileFilesystem(
  deps: NetworkDeps,
  sql: SqlExecutor,
  filesystemId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const snapshot = await sql.transaction(async (tx) => {
    const row = await readFilesystem(tx, filesystemId);
    if (!row || row.state === 'deleted') return undefined;
    const network = (await readNetwork(tx, row.network_id))!;
    return { row, network, account: await readAccount(tx, row.provider_account_id) };
  });
  if (!snapshot) return undefined;
  const { row, network, account } = snapshot;
  const now = deps.clock.now();
  const deleting = row.desired_state === 'deleted';
  // The network's VPC and group come first; a filesystem waits for them.
  if (!deleting && !network.provisioned) return now + filesystemPollMs;
  let outcome: ProviderFilesystemState;
  try {
    const filesystems = await providerFilesystems(deps, account, row.provider_account_id);
    const call: CallContext = {
      idempotencyKey: row.id,
      signal,
      clock: deps.clock,
      secrets: deps.secrets,
      log: deps.log,
    };
    outcome = deleting
      ? await filesystems.deleteFilesystem(providerResourceName(row.id), call)
      : await filesystems.ensureFilesystem(
          specOf(row, providerResourceName(network.id, network.external_name)),
          call,
        );
  } catch (error) {
    if (signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
      deps.log.warn('filesystems: provider busy, retrying', {
        filesystemId: row.id,
        error: text(error),
      });
      return now + filesystemRetryMs;
    }
    outcome = { id: row.id, state: 'error', message: text(error) };
  }
  const state: FilesystemState = deleting
    ? outcome.state === 'deleted'
      ? 'deleted'
      : outcome.state === 'error'
        ? 'error'
        : 'deleting'
    : outcome.state === 'ready'
      ? 'ready'
      : outcome.state === 'error'
        ? 'error'
        : 'pending';
  const message =
    state === 'ready' || state === 'deleted' ? null : (outcome.message?.slice(0, 500) ?? null);
  const mount =
    state === 'ready' && outcome.mount ? outcome.mount : state === 'deleted' ? null : undefined;
  if (state === 'ready' && !outcome.mount) {
    // A ready filesystem always says how to mount it; one that does not is not ready.
    return writeBack(deps, sql, row, 'error', 'The provider gave no mount for a ready filesystem');
  }
  return writeBack(deps, sql, row, state, message, mount);
}

async function writeBack(
  deps: NetworkDeps,
  sql: SqlExecutor,
  row: FilesystemRow,
  state: FilesystemState,
  message: string | null,
  mount?: Omit<ProviderMount, 'path'> | null,
): Promise<number | undefined> {
  const now = deps.clock.now();
  const written = await sql.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE filesystems SET state = $3, message = $4,
              mount = CASE WHEN $5::boolean THEN $6::jsonb ELSE mount END
        WHERE id = $1 AND version = $2
          AND (state IS DISTINCT FROM $3 OR message IS DISTINCT FROM $4
               OR ($5::boolean AND mount IS DISTINCT FROM $6::jsonb))
        RETURNING id`,
      [
        row.id,
        row.version,
        state,
        message,
        mount !== undefined,
        mount
          ? JSON.stringify({ fstype: mount.fstype, source: mount.source, options: mount.options })
          : null,
      ],
    );
    if (rows.length === 0) return false;
    if (state === 'ready' && row.state !== 'ready')
      await publish(deps, tx, row, 'network.filesystem.ready', { kind: row.kind });
    else if (state === 'error' && row.state !== 'error')
      await publish(deps, tx, row, 'network.filesystem.error', { message: message ?? '' });
    else if (state === 'deleted') await publish(deps, tx, row, 'network.filesystem.deleted');
    return true;
  });
  if (!written) {
    // Unchanged, or changed through the API meanwhile (its version is newer): then look again at once.
    const { rows } = await sql.transaction((tx) =>
      tx.query<{ version: string | number }>(`SELECT version FROM filesystems WHERE id = $1`, [
        row.id,
      ]),
    );
    if (rows[0] && Number(rows[0].version) !== Number(row.version)) return now;
  }
  return state === 'pending' || state === 'deleting' ? now + filesystemPollMs : undefined;
}

export function filesystemsReconciler(depsOf: (context: ModuleContext) => NetworkDeps): Reconciler {
  return {
    name: filesystemsWork,
    shardBy: 'none',
    // Errors and drift are retried by the periodic pass.
    periodic: [{ key: 'all', every: '5m' }],
    async run(context, key) {
      if (key === 'all') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM filesystems WHERE state <> 'deleted' ORDER BY id`,
          );
          for (const row of rows) await context.work.enqueue(tx, filesystemsWork, row.id);
        });
        return 'DONE';
      }
      const next = await reconcileFilesystem(depsOf(context), context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, filesystemsWork, key, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
