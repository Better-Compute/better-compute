import {
  ComputeError,
  draftId,
  newId,
  parseDuration,
  type AdmissionContext,
  type AdmissionPlan,
  type AuthzAttributes,
  type Finding,
  type InstanceState,
  type Json,
  type MethodContext,
  type Migration,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readFlavorByName, type FlavorRecord } from './flavors.js';
import {
  canonical,
  fail,
  id,
  int,
  key,
  name,
  object,
  optional,
  sha256Hex,
  tenant,
} from './input.js';
import {
  hostedRuntime,
  instanceAttributes,
  isSecretRef,
  moveInstance,
  publishInstance,
  readInstance,
  runtimeTable,
  scheduleHosted,
  sealUserData,
  shapeOf,
  updateInstance,
  visibleVpsPool,
  wake,
  type InstanceDeps,
  type InstanceRestore,
  type InstanceRow,
  type VpsImage,
} from './instances.js';
import {
  dropSnapshots,
  purgeSettledSnapshots,
  purgeSnapshots,
  restoreSource,
  sandboxSnapshots,
  settleSnapshots,
  type DroppedSnapshot,
  type SandboxSnapshot,
  type SnapshotStore,
} from './snapshots.js';

// Sandboxes (PLAN.md §3.7, D24): a sandbox is a hosted VPS instance with a template, a lifetime and a
// fast start. It has no placement or tenancy path of its own: the instance it drives is admitted,
// placed, charged, addressed and deleted exactly as `instances.create` would, and instance item
// methods refuse it (`instances.sandbox_id`). Templates are per tenant. Expiry is an ordinary
// instance delete. Warm pools keep stopped instances per template, claimed by `sandboxes.create`
// only after its own admission decision.

/** The work-queue kind of the sandbox reconciler (expiry, ready/deleted events, warm pools). */
export const sandboxWork = 'vps.sandboxes';

const second = 1000;
/** TTL bounds every template lives within: 1 minute to 30 days. */
export const minTtlSeconds = 60;
export const maxTtlSeconds = 30 * 24 * 3600;
/** Warm instances a template may keep, and those one reconciler pass creates per template. */
export const maxWarm = 64;
export const warmRefillPerPass = 4;

export const vpsSandboxesMigration: Migration = {
  name: 'vps/0004_sandboxes',
  sql: `
-- §3.7: instances.desiredState gains 'paused' (warm pools on runtimes that can pause).
ALTER TABLE instances DROP CONSTRAINT instances_desired_state_check;
ALTER TABLE instances ADD CONSTRAINT instances_desired_state_check
  CHECK (desired_state IN ('running', 'stopped', 'paused', 'deleted'));
-- The sandbox an instance runs, or the template whose warm pool holds it (never both).
ALTER TABLE instances ADD COLUMN sandbox_id text;
ALTER TABLE instances ADD COLUMN warm_template_id text;
ALTER TABLE instances ADD CONSTRAINT instances_sandbox_or_warm
  CHECK (sandbox_id IS NULL OR warm_template_id IS NULL);
CREATE INDEX instances_warm ON instances (warm_template_id, created_at) WHERE warm_template_id IS NOT NULL;

CREATE TABLE sandbox_templates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  pool_id text NOT NULL REFERENCES pools,
  flavor text NOT NULL,
  image_id text NOT NULL,
  -- The pool's runtime, checked once when the template is written.
  runtime text NOT NULL,
  user_data text,
  default_ttl_seconds int NOT NULL CHECK (default_ttl_seconds > 0),
  max_ttl_seconds int NOT NULL CHECK (max_ttl_seconds >= default_ttl_seconds),
  warm_min int NOT NULL DEFAULT 0 CHECK (warm_min >= 0),
  warm_max int NOT NULL DEFAULT 0 CHECK (warm_max >= warm_min),
  -- Warm instances are created as this identity (the template's author) until a sandbox claims one.
  created_by text NOT NULL,
  deleted bool NOT NULL DEFAULT false,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now()
);
CREATE UNIQUE INDEX sandbox_templates_name ON sandbox_templates (tenant_id, name) WHERE NOT deleted;

CREATE TABLE sandboxes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  template_id text NOT NULL REFERENCES sandbox_templates,
  pool_id text NOT NULL REFERENCES pools,
  -- The instance it drives: created for it, or claimed from the template's warm pool.
  instance_id text NOT NULL,
  -- Admission drafts are invisible to reads until the handler admits them.
  draft bool NOT NULL DEFAULT true,
  ttl_seconds int NOT NULL CHECK (ttl_seconds > 0),
  -- Set on admission (the TTL starts when the sandbox exists, warm or cold).
  expires_at timestamptz,
  warm bool NOT NULL DEFAULT false,
  ready_at timestamptz,
  expired_at timestamptz,
  -- Deletion asked (by delete or expiry), and finished (instance deleted, sandbox.deleted sent).
  deleting_at timestamptz,
  deleted_at timestamptz,
  owner_identity_id text NOT NULL,
  agent_id text,
  delegation_id text,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key)
);
CREATE INDEX sandboxes_expiry ON sandboxes (expires_at) WHERE NOT draft AND deleting_at IS NULL;
CREATE INDEX sandboxes_open ON sandboxes (tenant_id, created_at) WHERE NOT draft AND deleted_at IS NULL;
`,
};

/** Template environment (§3.7): variable name → `secret://` ref of the template's tenant. */
export const vpsTemplateEnvMigration: Migration = {
  name: 'vps/0007_template_env',
  sql: `ALTER TABLE sandbox_templates ADD COLUMN env jsonb NOT NULL DEFAULT '{}';`,
};

/**
 * Template network (§3.7) and warm freshness: `network` is `egress` (default), `private` (the pool's
 * subnet and the host) or `none` (the host only; tunnels still work), carried to the instance as
 * `network_policy` (NULL: egress) and enforced by the host. A warm instance records the template
 * `instance_version` it was made from; one from an older version is never claimed and is drained.
 */
export const vpsTemplateNetworkMigration: Migration = {
  name: 'vps/0008_template_network',
  sql: `
ALTER TABLE sandbox_templates ADD COLUMN network text NOT NULL DEFAULT 'egress'
  CHECK (network IN ('egress', 'private', 'none'));
ALTER TABLE instances ADD COLUMN network_policy text CHECK (network_policy IN ('private', 'none'));
ALTER TABLE instances ADD COLUMN warm_template_version bigint;
-- Bumped only by changes that shape instances (flavor, image, user data, env, network).
ALTER TABLE sandbox_templates ADD COLUMN instance_version bigint NOT NULL DEFAULT 1;
`,
};

/** When a sandbox claimed a warm instance: its warm capacity metering ends there (`vps.sandbox.warm`). */
export const vpsWarmClaimsMigration: Migration = {
  name: 'vps/0006_warm_claims',
  sql: `ALTER TABLE instances ADD COLUMN claimed_at timestamptz;`,
};

// --- Templates ---------------------------------------------------------------------------------

export interface SandboxTemplate {
  id: string;
  tenantId: string;
  name: string;
  poolId: string;
  flavor: string;
  imageId: string;
  runtime: string;
  userData?: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  warm: { min: number; max: number };
  /** Environment for every sandbox: variable name → `secret://<tenantId>/<id>` of this tenant. */
  env: Record<string, string>;
  /** What sandboxes may reach: `egress` (default), `private` (pool subnet + host) or `none` (host only). */
  network: SandboxNetwork;
  version: number;
}

export type SandboxNetwork = 'egress' | 'private' | 'none';
const networks: readonly SandboxNetwork[] = ['egress', 'private', 'none'];

function network(value: unknown): SandboxNetwork {
  if (!networks.includes(value as SandboxNetwork)) fail('network must be egress, private or none');
  return value as SandboxNetwork;
}

export interface TemplateInput {
  tenantId: string;
  name: string;
  poolId: string;
  flavor: string;
  imageId: string;
  /** Must be the pool's runtime; checked when the template is written. */
  runtime?: string;
  userData?: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  warm?: { min: number; max?: number };
  env?: Record<string, string>;
  network?: SandboxNetwork;
}

export interface TemplateUpdate {
  tenantId: string;
  templateId: string;
  flavor?: string;
  imageId?: string;
  /** `null` removes it. */
  userData?: string | null;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  warm?: { min: number; max?: number };
  /** Replaces the whole map (`{}` removes every variable). */
  env?: Record<string, string>;
  network?: SandboxNetwork;
}

export type TemplateRef = { tenantId: string; templateId: string };

const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$/;
const uriLike = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function imageId(value: unknown): string {
  if (typeof value !== 'string' || !imagePattern.test(value)) fail('imageId is invalid');
  return value;
}

function userData(value: unknown, tenantId: string): string {
  if (typeof value !== 'string' || value.length > 32_768)
    fail('userData must be a string of at most 32 KiB');
  if (uriLike.test(value) && !(isSecretRef(value) && value.startsWith(`secret://${tenantId}/`)))
    fail(`userData as a reference must be secret://${tenantId}/<id>, a secret of this tenant`);
  return value;
}

const ttl = (value: unknown, what: string) => int(value, what, minTtlSeconds, maxTtlSeconds);

/** Variables a template may set, and how many. */
export const maxTemplateEnv = 64;
const envNamePattern = /^[A-Z_][A-Z0-9_]{0,63}$/;

function env(value: unknown, tenantId: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('env must map variable names to secret references');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxTemplateEnv) fail(`env takes at most ${maxTemplateEnv} variables`);
  const result: Record<string, string> = {};
  for (const [name, ref] of entries) {
    if (!envNamePattern.test(name)) fail(`env: ${name} is not a variable name (A-Z, 0-9, _)`);
    // Values are always references: the secret broker resolves them for this tenant only.
    if (typeof ref !== 'string' || !isSecretRef(ref) || !ref.startsWith(`secret://${tenantId}/`))
      fail(`env.${name} must be secret://${tenantId}/<id>, a secret of this tenant`);
    result[name] = ref;
  }
  return result;
}

function warm(value: unknown): { min: number; max: number } {
  const input = object(value, ['min', 'max']);
  const min = int(input.min, 'warm.min', 0, maxWarm);
  const max = optional(input.max, (entry) => int(entry, 'warm.max', 0, maxWarm)) ?? min;
  if (max < min) fail('warm.max must be at least warm.min');
  return { min, max };
}

export function parseTemplateInput(raw: unknown): TemplateInput {
  const input = object(raw, [
    'tenantId',
    'name',
    'poolId',
    'flavor',
    'imageId',
    'runtime',
    'userData',
    'defaultTtlSeconds',
    'maxTtlSeconds',
    'warm',
    'env',
    'network',
  ]);
  const tenantId = tenant(input.tenantId);
  const result: TemplateInput = {
    tenantId,
    name: name(input.name, 'name'),
    poolId: id(input.poolId, 'pool', 'poolId'),
    flavor: name(input.flavor, 'flavor'),
    imageId: imageId(input.imageId),
  };
  if (input.runtime !== undefined) {
    if (typeof input.runtime !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.runtime))
      fail('runtime must be a runtime driver id');
    result.runtime = input.runtime;
  }
  if (input.userData !== undefined) result.userData = userData(input.userData, tenantId);
  const defaultTtl = optional(input.defaultTtlSeconds, (value) => ttl(value, 'defaultTtlSeconds'));
  if (defaultTtl !== undefined) result.defaultTtlSeconds = defaultTtl;
  const maxTtl = optional(input.maxTtlSeconds, (value) => ttl(value, 'maxTtlSeconds'));
  if (maxTtl !== undefined) result.maxTtlSeconds = maxTtl;
  if (input.warm !== undefined) result.warm = warm(input.warm);
  if (input.env !== undefined) result.env = env(input.env, tenantId);
  if (input.network !== undefined) result.network = network(input.network);
  return result;
}

export function parseTemplateUpdate(raw: unknown): TemplateUpdate {
  const input = object(raw, [
    'tenantId',
    'templateId',
    'flavor',
    'imageId',
    'userData',
    'defaultTtlSeconds',
    'maxTtlSeconds',
    'warm',
    'env',
    'network',
  ]);
  const tenantId = tenant(input.tenantId);
  const result: TemplateUpdate = {
    tenantId,
    templateId: id(input.templateId, 'sbxt', 'templateId'),
  };
  if (input.flavor !== undefined) result.flavor = name(input.flavor, 'flavor');
  if (input.imageId !== undefined) result.imageId = imageId(input.imageId);
  if (input.userData !== undefined)
    result.userData = input.userData === null ? null : userData(input.userData, tenantId);
  const defaultTtl = optional(input.defaultTtlSeconds, (value) => ttl(value, 'defaultTtlSeconds'));
  if (defaultTtl !== undefined) result.defaultTtlSeconds = defaultTtl;
  const maxTtl = optional(input.maxTtlSeconds, (value) => ttl(value, 'maxTtlSeconds'));
  if (maxTtl !== undefined) result.maxTtlSeconds = maxTtl;
  if (input.warm !== undefined) result.warm = warm(input.warm);
  if (input.env !== undefined) result.env = env(input.env, tenantId);
  if (input.network !== undefined) result.network = network(input.network);
  return result;
}

export function parseTemplateRef(raw: unknown): TemplateRef {
  const input = object(raw, ['tenantId', 'templateId']);
  return {
    tenantId: tenant(input.tenantId),
    templateId: id(input.templateId, 'sbxt', 'templateId'),
  };
}

interface RawTemplate {
  id: string;
  tenant_id: string;
  name: string;
  pool_id: string;
  flavor: string;
  image_id: string;
  runtime: string;
  user_data: string | null;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  warm_min: number;
  warm_max: number;
  env: Record<string, string> | string;
  network: SandboxNetwork;
  instance_version: string | number;
  created_by: string;
  deleted: boolean;
  version: string | number;
}

const templateColumnsOf = (alias: string) =>
  [
    'id',
    'tenant_id',
    'name',
    'pool_id',
    'flavor',
    'image_id',
    'runtime',
    'user_data',
    'default_ttl_seconds',
    'max_ttl_seconds',
    'warm_min',
    'warm_max',
    'env',
    'network',
    'instance_version',
    'created_by',
    'deleted',
    'version',
  ]
    .map((column) => `${alias}${column}`)
    .join(', ');
const templateColumns = templateColumnsOf('');

type TemplateRow = SandboxTemplate & {
  createdBy: string;
  deleted: boolean;
  /** Bumped by changes that shape instances: warm instances of an older one are stale. */
  instanceVersion: number;
};

function toTemplate(raw: RawTemplate): TemplateRow {
  const template: TemplateRow = {
    id: raw.id,
    tenantId: raw.tenant_id,
    name: raw.name,
    poolId: raw.pool_id,
    flavor: raw.flavor,
    imageId: raw.image_id,
    runtime: raw.runtime,
    defaultTtlSeconds: Number(raw.default_ttl_seconds),
    maxTtlSeconds: Number(raw.max_ttl_seconds),
    warm: { min: Number(raw.warm_min), max: Number(raw.warm_max) },
    env: typeof raw.env === 'string' ? JSON.parse(raw.env) : { ...(raw.env ?? {}) },
    network: raw.network ?? 'egress',
    instanceVersion: Number(raw.instance_version ?? 1),
    version: Number(raw.version),
    createdBy: raw.created_by,
    deleted: raw.deleted,
  };
  if (raw.user_data !== null) template.userData = raw.user_data;
  return template;
}

/** The public view of a template. */
export function templateView(row: TemplateRow): SandboxTemplate {
  const { createdBy: _by, deleted: _deleted, instanceVersion: _instances, ...view } = row;
  return { ...view, warm: { ...view.warm }, env: { ...view.env } };
}

async function readTemplate(
  tx: SqlTx,
  tenantId: string,
  templateId: string,
  options: { lock?: boolean; deleted?: boolean } = {},
): Promise<TemplateRow | undefined> {
  const { rows } = await tx.query<RawTemplate>(
    `SELECT ${templateColumns} FROM sandbox_templates
      WHERE id = $1 AND tenant_id = $2${options.deleted ? '' : ' AND NOT deleted'}${options.lock ? ' FOR UPDATE' : ''}`,
    [templateId, tenantId],
  );
  return rows[0] ? toTemplate(rows[0]) : undefined;
}

/** What instances of a template are made of, checked against its pool (visibility, flavor, image, runtime). */
interface TemplateShape {
  flavor: FlavorRecord;
  image: VpsImage;
  runtime: string;
}

async function resolveTemplate(
  deps: Pick<InstanceDeps, 'images' | 'runtime' | 'runtimes'>,
  tx: SqlTx,
  template: Pick<TemplateInput, 'tenantId' | 'poolId' | 'flavor' | 'imageId' | 'runtime'>,
): Promise<TemplateShape> {
  const pool = await visibleVpsPool(tx, template.tenantId, template.poolId);
  if (pool.class !== 'vps-host')
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${pool.id} is a provider pool; sandboxes run on hosted pools`,
    );
  const flavor = await readFlavorByName(tx, template.poolId, template.flavor);
  if (!flavor || flavor.archived)
    throw new ComputeError(
      'NOT_FOUND',
      `Flavor ${template.flavor} not found in pool ${template.poolId}`,
    );
  if (!deps.images)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Hosted VPS pools need vps({ images }) to resolve images',
    );
  const image = await deps.images.resolve(tx, template.tenantId, template.imageId);
  if (!image) throw new ComputeError('NOT_FOUND', `Image ${template.imageId} not found`);
  const runtime = await hostedRuntime(deps, tx, pool, {
    tenantId: template.tenantId,
    gpus: flavor.gpus,
    imageFormat: image.format,
  });
  if (template.runtime !== undefined && template.runtime !== runtime)
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${pool.id} runs ${runtime}, not ${template.runtime}; pick a pool that runs it`,
    );
  return { flavor, image, runtime };
}

const defaultTtlSeconds = 3600;
const defaultMaxTtlSeconds = 24 * 3600;

function ttlBounds(
  defaultTtl: number | undefined,
  maxTtl: number | undefined,
  current?: { defaultTtlSeconds: number; maxTtlSeconds: number },
): { defaultTtl: number; maxTtl: number } {
  const bounds = {
    defaultTtl: defaultTtl ?? current?.defaultTtlSeconds ?? defaultTtlSeconds,
    maxTtl: maxTtl ?? current?.maxTtlSeconds ?? Math.max(defaultMaxTtlSeconds, defaultTtl ?? 0),
  };
  if (bounds.defaultTtl > bounds.maxTtl) fail('defaultTtlSeconds must not exceed maxTtlSeconds');
  return bounds;
}

/** `sandboxTemplates.create`: checks the pool, flavor, image and runtime once, then stores the template. */
/**
 * Secrets reach the guest inside sealed user data only (§6 "Secrets"): template env, and a template's
 * `secret://` user data once vps renders it into a multipart (exec trust or env). Without the broker
 * they would sit in `instances.user_data` and travel inline in the NodeSpec.
 */
function assertEnvDeliverable(
  deps: Pick<InstanceDeps, 'broker' | 'sandboxExec'>,
  env: Readonly<Record<string, string>> | undefined,
  userData?: string | null,
): void {
  if (deps.broker) return;
  const hasEnv = env !== undefined && Object.keys(env).length > 0;
  if (hasEnv)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Template env needs the secret broker, which seals sandbox user data',
    );
  if (deps.sandboxExec && isSecretRef(userData ?? undefined))
    throw new ComputeError(
      'INVALID_CONFIG',
      'A secret:// user data with sandbox exec needs the secret broker, which seals sandbox user data',
    );
}

export async function createTemplate(
  deps: Pick<InstanceDeps, 'images' | 'runtime' | 'runtimes' | 'authz' | 'broker' | 'sandboxExec'>,
  context: MethodContext,
  input: TemplateInput,
): Promise<SandboxTemplate> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  assertEnvDeliverable(deps, input.env, input.userData);
  const { runtime } = await resolveTemplate(deps, tx, input);
  await assertNetworkDeliverable(tx, input.poolId, input.network);
  await assertTenantSecrets(tx, input.tenantId, templateSecretRefs(input));
  const { defaultTtl, maxTtl } = ttlBounds(input.defaultTtlSeconds, input.maxTtlSeconds);
  const taken = await tx.query(
    `SELECT 1 FROM sandbox_templates WHERE tenant_id = $1 AND name = $2 AND NOT deleted`,
    [input.tenantId, input.name],
  );
  if (taken.rows.length > 0)
    throw new ComputeError('CONFLICT', `Sandbox template ${input.name} already exists`);
  const templateId = newId('sbxt');
  const { rows } = await tx.query<RawTemplate>(
    `INSERT INTO sandbox_templates (id, tenant_id, name, pool_id, flavor, image_id, runtime, user_data,
                                    default_ttl_seconds, max_ttl_seconds, warm_min, warm_max, created_by, env, network, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 1)
     RETURNING ${templateColumns}`,
    [
      templateId,
      input.tenantId,
      input.name,
      input.poolId,
      input.flavor,
      input.imageId,
      runtime,
      input.userData ?? null,
      defaultTtl,
      maxTtl,
      input.warm?.min ?? 0,
      input.warm?.max ?? input.warm?.min ?? 0,
      caller.identityId,
      JSON.stringify(input.env ?? {}),
      input.network ?? 'egress',
    ],
  );
  await deps.authz.upsert(tx, {
    type: 'sandbox-template',
    id: templateId,
    tenantId: input.tenantId,
    attributes: {},
    ownerId: caller.identityId,
  });
  return templateView(toTemplate(rows[0]!));
}

/** The `secret://` refs a template write names (env values, and user data given as a ref). */
export function templateSecretRefs(input: {
  env?: Readonly<Record<string, string>>;
  userData?: string | null;
}): string[] {
  const refs = Object.values(input.env ?? {});
  if (isSecretRef(input.userData ?? undefined)) refs.push(input.userData!);
  return [...new Set(refs)];
}

/**
 * Secrets a template may use: ones the tenant wrote through `secrets.put` (`secret_refs`), never
 * platform-minted ones (join tokens, BMC credentials, sealed user data), which live in the same store
 * under the root tenant. Secrets are write-only (§6): a sandbox that gets one in its env or user data
 * reads it, so `sandboxTemplates.create/update` also decide `compute:secrets:manage` for them.
 */
async function assertTenantSecrets(tx: SqlTx, tenantId: string, refs: readonly string[]) {
  if (refs.length === 0) return;
  const present = await tx.query<{ found: string | null }>(
    `SELECT to_regclass('secret_refs')::text AS found`,
  );
  const known = present.rows[0]?.found
    ? (
        await tx.query<{ ref: string }>(
          `SELECT ref FROM secret_refs WHERE tenant_id = $1 AND ref = ANY($2::text[])`,
          [tenantId, [...refs]],
        )
      ).rows.map((row) => row.ref)
    : [];
  const unknown = refs.filter((ref) => !known.includes(ref));
  if (unknown.length > 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `${unknown[0]} is not a secret this tenant put (secrets.put); templates use only those`,
    );
}

/**
 * `private` and `none` are enforced on the instance's NIC addresses (bcd fails closed without
 * them), and `none` is reachable only from the host on that subnet: both need the pool's IP range.
 */
async function assertNetworkDeliverable(
  tx: SqlTx,
  poolId: string,
  network: SandboxNetwork | undefined,
): Promise<void> {
  if (network === undefined || network === 'egress') return;
  const { rows } = await tx.query(`SELECT 1 FROM ip_pools WHERE pool_id = $1`, [poolId]);
  if (rows.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      `network '${network}' needs an IP range on pool ${poolId} (setIpPool): the host enforces it on the instance's addresses`,
    );
}

/** Whether an update changes what the template's instances are made of. */
function shapes(
  current: TemplateRow,
  next: { flavor: string; imageId: string; userData: string | null; input: TemplateUpdate },
): boolean {
  return (
    next.flavor !== current.flavor ||
    next.imageId !== current.imageId ||
    next.userData !== (current.userData ?? null) ||
    (next.input.env !== undefined &&
      JSON.stringify(Object.entries(next.input.env).sort()) !==
        JSON.stringify(Object.entries(current.env).sort())) ||
    (next.input.network !== undefined && next.input.network !== current.network)
  );
}

/** `sandboxTemplates.update`: a new flavor or image is checked against the pool as on create. */
export async function updateTemplate(
  deps: Pick<InstanceDeps, 'images' | 'runtime' | 'runtimes' | 'broker' | 'sandboxExec'>,
  tx: SqlTx,
  input: TemplateUpdate,
): Promise<SandboxTemplate> {
  assertEnvDeliverable(deps, input.env, input.userData);
  const current = await readTemplate(tx, input.tenantId, input.templateId, { lock: true });
  if (!current)
    throw new ComputeError('NOT_FOUND', `Sandbox template ${input.templateId} not found`);
  const flavor = input.flavor ?? current.flavor;
  const image = input.imageId ?? current.imageId;
  const { runtime } =
    input.flavor !== undefined || input.imageId !== undefined
      ? await resolveTemplate(deps, tx, {
          tenantId: current.tenantId,
          poolId: current.poolId,
          flavor,
          imageId: image,
          runtime: current.runtime,
        })
      : current;
  await assertNetworkDeliverable(tx, current.poolId, input.network);
  await assertTenantSecrets(tx, current.tenantId, templateSecretRefs(input));
  const { defaultTtl, maxTtl } = ttlBounds(input.defaultTtlSeconds, input.maxTtlSeconds, current);
  const warmPool = input.warm
    ? { min: input.warm.min, max: input.warm.max ?? input.warm.min }
    : current.warm;
  const userDataValue = input.userData === undefined ? (current.userData ?? null) : input.userData;
  const { rows } = await tx.query<RawTemplate>(
    `UPDATE sandbox_templates
        SET flavor = $2, image_id = $3, runtime = $4, user_data = $5, default_ttl_seconds = $6,
            max_ttl_seconds = $7, warm_min = $8, warm_max = $9, env = $10::jsonb,
            network = $11, instance_version = instance_version + $12, version = version + 1
      WHERE id = $1
      RETURNING ${templateColumns}`,
    [
      current.id,
      flavor,
      image,
      runtime,
      userDataValue,
      defaultTtl,
      maxTtl,
      warmPool.min,
      warmPool.max,
      JSON.stringify(input.env ?? current.env),
      input.network ?? current.network,
      shapes(current, { flavor, imageId: image, userData: userDataValue, input }) ? 1 : 0,
    ],
  );
  return templateView(toTemplate(rows[0]!));
}

/**
 * `sandboxTemplates.delete`: the template disappears from reads and creates; its sandboxes live on
 * until they end, and the reconciler drains its warm pool.
 */
export async function deleteTemplate(
  deps: Pick<InstanceDeps, 'authz'>,
  tx: SqlTx,
  input: TemplateRef,
): Promise<{ deleted: true }> {
  const current = await readTemplate(tx, input.tenantId, input.templateId, { lock: true });
  if (!current)
    throw new ComputeError('NOT_FOUND', `Sandbox template ${input.templateId} not found`);
  await tx.query(
    `UPDATE sandbox_templates SET deleted = true, version = version + 1 WHERE id = $1`,
    [current.id],
  );
  await deps.authz.remove(tx, {
    type: 'sandbox-template',
    id: current.id,
    tenantId: current.tenantId,
  });
  return { deleted: true };
}

export async function getTemplate(tx: SqlTx, input: TemplateRef): Promise<SandboxTemplate> {
  const row = await readTemplate(tx, input.tenantId, input.templateId);
  if (!row) throw new ComputeError('NOT_FOUND', `Sandbox template ${input.templateId} not found`);
  return templateView(row);
}

export async function listTemplates(
  tx: SqlTx,
  tenantId: string,
): Promise<{ items: SandboxTemplate[] }> {
  const { rows } = await tx.query<RawTemplate>(
    `SELECT ${templateColumns} FROM sandbox_templates
      WHERE tenant_id = $1 AND NOT deleted ORDER BY name`,
    [tenantId],
  );
  return { items: rows.map((row) => templateView(toTemplate(row))) };
}

// --- Sandboxes ---------------------------------------------------------------------------------

/**
 * A sandbox's state, derived from its instance: `starting` until the instance runs, `ready` while it
 * does, `failed` when it errored or its host was lost, `deleting` once deletion was asked (by
 * `delete` or expiry), `deleted` when the instance is gone.
 */
export type SandboxState = 'starting' | 'ready' | 'failed' | 'deleting' | 'deleted';

export interface Sandbox {
  id: string;
  tenantId: string;
  templateId: string;
  poolId: string;
  instanceId: string;
  state: SandboxState;
  instanceState: InstanceState;
  addresses: string[];
  nodeId?: string;
  ttlSeconds: number;
  /** Epoch ms; the sandbox is deleted then unless extended. */
  expiresAt: number;
  /** It was claimed from its template's warm pool. */
  warm: boolean;
  ownerIdentityId: string;
  idempotencyKey: string;
  createdAt: number;
  readyAt?: number;
  /** Set when the sandbox ended by reaching `expiresAt`. */
  expiredAt?: number;
  /** The snapshot it was restored from. */
  fromSnapshot?: string;
  /** Its snapshots, newest first (`sandboxes.get` only). */
  snapshots?: SandboxSnapshot[];
}

export interface CreateSandboxInput {
  tenantId: string;
  templateId: string;
  /** Default: the template's `defaultTtlSeconds`; at most its `maxTtlSeconds`. */
  ttlSeconds?: number;
  /** Restore this snapshot (the tenant's own, same runtime) instead of booting the image. */
  fromSnapshot?: string;
  idempotencyKey: string;
  /** §9.1 async-with-wait: hold the answer up to `timeoutMs` (≤ 30 s) until the sandbox leaves `starting`. */
  wait?: { timeoutMs: number };
}

export type SandboxRef = { tenantId: string; sandboxId: string };

export interface ExtendSandboxInput extends SandboxRef {
  /** The new expiry (epoch ms), or */
  until?: number;
  /** a duration added to the current expiry (`30m`, `2h`, or milliseconds). */
  by?: number;
}

export interface ListSandboxesInput {
  tenantId: string;
  scope: 'mine' | 'all';
  /** Include deleted sandboxes (default: open ones only). */
  deleted?: boolean;
  templateId?: string;
  limit?: number;
  cursor?: string;
}

export function parseCreateSandbox(raw: unknown): CreateSandboxInput {
  const input = object(raw, [
    'tenantId',
    'templateId',
    'ttlSeconds',
    'fromSnapshot',
    'idempotencyKey',
    'wait',
  ]);
  const result: CreateSandboxInput = {
    tenantId: tenant(input.tenantId),
    templateId: id(input.templateId, 'sbxt', 'templateId'),
    idempotencyKey: key(input.idempotencyKey),
  };
  const ttlSeconds = optional(input.ttlSeconds, (value) => ttl(value, 'ttlSeconds'));
  if (ttlSeconds !== undefined) result.ttlSeconds = ttlSeconds;
  const fromSnapshot = optional(input.fromSnapshot, (value) => id(value, 'snap', 'fromSnapshot'));
  if (fromSnapshot !== undefined) result.fromSnapshot = fromSnapshot;
  if (input.wait !== undefined) {
    const wait = object(input.wait, ['timeoutMs']);
    result.wait = { timeoutMs: int(wait.timeoutMs, 'wait.timeoutMs', 0, 30_000) };
  }
  return result;
}

export function parseSandboxRef(raw: unknown): SandboxRef {
  const input = object(raw, ['tenantId', 'sandboxId']);
  return { tenantId: tenant(input.tenantId), sandboxId: id(input.sandboxId, 'sbx', 'sandboxId') };
}

export function parseExtendSandbox(raw: unknown): ExtendSandboxInput {
  const input = object(raw, ['tenantId', 'sandboxId', 'until', 'by']);
  const result: ExtendSandboxInput = {
    tenantId: tenant(input.tenantId),
    sandboxId: id(input.sandboxId, 'sbx', 'sandboxId'),
  };
  if ((input.until === undefined) === (input.by === undefined))
    fail('Give exactly one of until or by');
  if (input.until !== undefined) result.until = int(input.until, 'until', 0, 2 ** 47);
  if (input.by !== undefined) {
    let by: number;
    try {
      by = parseDuration(input.by as string | number);
    } catch {
      fail('by must look like 30m, 8h or 7d');
    }
    if (!(by > 0 && by <= maxTtlSeconds * second)) fail('by must be between 1ms and 30d');
    result.by = by;
  }
  return result;
}

export function parseListSandboxes(raw: unknown): ListSandboxesInput {
  const input = object(raw, ['tenantId', 'scope', 'deleted', 'templateId', 'limit', 'cursor']);
  if (input.scope !== undefined && input.scope !== 'mine' && input.scope !== 'all')
    fail('scope must be mine or all');
  if (input.deleted !== undefined && typeof input.deleted !== 'boolean')
    fail('deleted must be a boolean');
  const result: ListSandboxesInput = {
    tenantId: tenant(input.tenantId),
    scope: (input.scope as 'mine' | 'all' | undefined) ?? 'mine',
  };
  if (input.deleted === true) result.deleted = true;
  const templateId = optional(input.templateId, (value) => id(value, 'sbxt', 'templateId'));
  if (templateId !== undefined) result.templateId = templateId;
  const limit = optional(input.limit, (value) => int(value, 'limit', 1, 200));
  if (limit !== undefined) result.limit = limit;
  const cursor = optional(input.cursor, (value) => id(value, 'sbx', 'cursor'));
  if (cursor !== undefined) result.cursor = cursor;
  return result;
}

interface RawSandbox {
  id: string;
  tenant_id: string;
  template_id: string;
  pool_id: string;
  instance_id: string;
  draft: boolean;
  ttl_seconds: number;
  expires_ms: number | null;
  warm: boolean;
  ready_ms: number | null;
  expired_ms: number | null;
  deleting_ms: number | null;
  deleted_ms: number | null;
  owner_identity_id: string;
  idempotency_key: string;
  request_hash: string;
  version: string | number;
  created_ms: number;
  instance_state: InstanceState | null;
  addresses: string[] | null;
  node_id: string | null;
  from_snapshot: string | null;
  agent_id: string | null;
  delegation_id: string | null;
}

const ms = (column: string) => `(extract(epoch FROM ${column}) * 1000)::float8`;
const sandboxColumns = `s.id, s.tenant_id, s.template_id, s.pool_id, s.instance_id, s.draft, s.ttl_seconds,
  ${ms('s.expires_at')} AS expires_ms, s.warm, ${ms('s.ready_at')} AS ready_ms,
  ${ms('s.expired_at')} AS expired_ms, ${ms('s.deleting_at')} AS deleting_ms,
  ${ms('s.deleted_at')} AS deleted_ms, s.owner_identity_id, s.idempotency_key,
  encode(s.request_hash, 'hex') AS request_hash, s.version, ${ms('s.created_at')} AS created_ms,
  i.state AS instance_state, i.addresses, i.node_id, s.from_snapshot, s.agent_id, s.delegation_id`;
const sandboxFrom = `sandboxes s LEFT JOIN instances i ON i.id = s.instance_id`;

async function readSandbox(
  tx: SqlTx,
  sandboxId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<RawSandbox | undefined> {
  const { rows } = await tx.query<RawSandbox>(
    `SELECT ${sandboxColumns} FROM ${sandboxFrom}
      WHERE s.id = $1 AND ($2::text IS NULL OR s.tenant_id = $2)${options.lock ? ' FOR UPDATE OF s' : ''}`,
    [sandboxId, options.tenantId ?? null],
  );
  return rows[0];
}

function sandboxState(raw: RawSandbox): SandboxState {
  const instance = raw.instance_state;
  if (raw.deleted_ms !== null || instance === 'deleted' || instance === null) return 'deleted';
  if (raw.deleting_ms !== null || instance === 'deleting') return 'deleting';
  if (instance === 'running') return 'ready';
  if (instance === 'error' || instance === 'lost') return 'failed';
  return 'starting';
}

/** The public view of a sandbox. */
export function sandboxView(raw: RawSandbox): Sandbox {
  const view: Sandbox = {
    id: raw.id,
    tenantId: raw.tenant_id,
    templateId: raw.template_id,
    poolId: raw.pool_id,
    instanceId: raw.instance_id,
    state: sandboxState(raw),
    instanceState: raw.instance_state ?? 'deleted',
    addresses: [...(raw.addresses ?? [])],
    ttlSeconds: Number(raw.ttl_seconds),
    expiresAt: Number(raw.expires_ms ?? 0),
    warm: raw.warm,
    ownerIdentityId: raw.owner_identity_id,
    idempotencyKey: raw.idempotency_key,
    createdAt: Number(raw.created_ms),
  };
  if (raw.node_id !== null) view.nodeId = raw.node_id;
  if (raw.ready_ms !== null) view.readyAt = Number(raw.ready_ms);
  if (raw.expired_ms !== null) view.expiredAt = Number(raw.expired_ms);
  if (raw.from_snapshot !== null) view.fromSnapshot = raw.from_snapshot;
  return view;
}

/** Sandbox states a `sandboxes.create` wait holds on. */
export const sandboxSettled = (sandbox: Sandbox): boolean => sandbox.state !== 'starting';

async function publishSandbox(
  deps: Pick<InstanceDeps, 'events'>,
  tx: SqlTx,
  raw: Pick<RawSandbox, 'id' | 'tenant_id' | 'template_id' | 'instance_id' | 'pool_id'>,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: raw.tenant_id,
    subject: `sandbox/${raw.id}`,
    data: {
      templateId: raw.template_id,
      instanceId: raw.instance_id,
      poolId: raw.pool_id,
      ...data,
    },
  });
}

/**
 * Marks the sandbox an instance runs `ready` the moment the instance reaches `running` (the instance
 * reconciler calls it in its transaction), so `readyAt` and `sandbox.ready` never trail the view's
 * state by a reconciler pass. The sandbox pass stays the fallback.
 */
export async function markSandboxReady(
  deps: Pick<InstanceDeps, 'events' | 'clock'>,
  tx: SqlTx,
  instanceId: string,
): Promise<void> {
  const { rows } = await tx.query<
    Pick<RawSandbox, 'id' | 'tenant_id' | 'template_id' | 'instance_id' | 'pool_id' | 'warm'>
  >(
    `UPDATE sandboxes SET ready_at = $2::timestamptz, version = version + 1
      WHERE instance_id = $1 AND NOT draft AND ready_at IS NULL AND deleting_at IS NULL
      RETURNING id, tenant_id, template_id, instance_id, pool_id, warm`,
    [instanceId, new Date(deps.clock.now()).toISOString()],
  );
  for (const raw of rows) await publishSandbox(deps, tx, raw, 'sandbox.ready', { warm: raw.warm });
}

/** The attributes IAM policies read on a sandbox (§9.2). */
export function sandboxAttributes(
  template: Pick<SandboxTemplate, 'id' | 'warm'>,
  flavor: Pick<FlavorRecord, 'vcpu' | 'memoryGiB' | 'gpus'>,
  ttlSeconds: number,
  fromSnapshot?: string,
): AuthzAttributes {
  const attributes: AuthzAttributes = {
    templateId: template.id,
    vcpu: flavor.vcpu,
    memoryGiB: flavor.memoryGiB,
    gpus: flavor.gpus,
    ttlSeconds,
    // A restore never claims a warm instance.
    warm: template.warm.min > 0 && fromSnapshot === undefined,
  };
  if (fromSnapshot !== undefined) attributes.fromSnapshot = fromSnapshot;
  return attributes;
}

const sandboxIdOf = (context: MethodContext, input: CreateSandboxInput) =>
  draftId('sbx', input.tenantId, context.caller!.identityId, input.idempotencyKey);
/** The instance a sandbox creates when no warm one is claimed: derived from the sandbox id. */
const instanceIdOf = (tenantId: string, sandboxId: string) =>
  draftId('inst', tenantId, sandboxId, 'sandbox');

/**
 * `sandboxes.create` transaction 1: the idempotency lookup, the template and its TTL bound, the
 * draft row and its authz row. The decision is on `compute-sandbox/{draftId}`.
 */
export async function prepareCreateSandbox(
  deps: Pick<InstanceDeps, 'authz'>,
  context: MethodContext,
  input: CreateSandboxInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Sandbox>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const { idempotencyKey: _key, wait: _wait, ...request } = input;
  const hash = await sha256Hex(canonical(request));
  const sandboxId = await sandboxIdOf(context, input);
  const existing = await readSandbox(tx, sandboxId, { tenantId: input.tenantId, lock: true });
  if (existing && existing.request_hash !== hash)
    throw new ComputeError(
      'CONFLICT',
      'This idempotency key was used for a different request',
      undefined,
      { sandboxId },
    );
  if (existing && !existing.draft) return { status: 'replay', result: sandboxView(existing) };

  const template = await readTemplate(tx, input.tenantId, input.templateId);
  if (!template)
    throw new ComputeError('NOT_FOUND', `Sandbox template ${input.templateId} not found`);
  const ttlSeconds = input.ttlSeconds ?? template.defaultTtlSeconds;
  if (ttlSeconds > template.maxTtlSeconds)
    throw new ComputeError(
      'INVALID_INPUT',
      `ttlSeconds exceeds the template's maxTtlSeconds (${template.maxTtlSeconds})`,
    );
  const flavor = await readFlavorByName(tx, template.poolId, template.flavor);
  if (!flavor || flavor.archived)
    throw new ComputeError(
      'INVALID_STATE',
      `Sandbox template ${template.name} names flavor ${template.flavor}, which is gone`,
    );
  if (input.fromSnapshot !== undefined) {
    // The tenant's own ready snapshot (another tenant's is NOT_FOUND), written by this runtime.
    const source = await restoreSource(tx, input.tenantId, input.fromSnapshot, caller.identityId);
    if (source.runtime !== template.runtime)
      throw new ComputeError(
        'INVALID_INPUT',
        `Snapshot ${source.snapshotId} was taken on ${source.runtime}; template ${template.name} runs ${template.runtime}`,
      );
  }
  if (!existing)
    await tx.query(
      `INSERT INTO sandboxes (id, tenant_id, template_id, pool_id, instance_id, ttl_seconds, from_snapshot,
                              owner_identity_id, agent_id, delegation_id, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $12, $7, $8, $9, $10, decode($11, 'hex'), 1)`,
      [
        sandboxId,
        input.tenantId,
        template.id,
        template.poolId,
        await instanceIdOf(input.tenantId, sandboxId),
        ttlSeconds,
        caller.identityId,
        caller.agentId ?? null,
        caller.delegationId ?? null,
        input.idempotencyKey,
        hash,
        input.fromSnapshot ?? null,
      ],
    );
  await deps.authz.upsert(tx, {
    type: 'sandbox',
    id: sandboxId,
    tenantId: input.tenantId,
    attributes: sandboxAttributes(template, flavor, ttlSeconds, input.fromSnapshot),
    parentType: 'pool',
    parentId: template.poolId,
    ownerId: caller.identityId,
  });
  return { status: 'decide', resource: { type: 'sandbox', id: sandboxId } };
}

/** `sandboxes.create` after a refusal: the draft disappears. */
export async function denyCreateSandbox(
  deps: Pick<InstanceDeps, 'authz'>,
  context: MethodContext,
  input: CreateSandboxInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const sandboxId = await sandboxIdOf(context, input);
  const { rowCount } = await tx.query(`DELETE FROM sandboxes WHERE id = $1 AND draft`, [sandboxId]);
  if (rowCount > 0)
    await deps.authz.remove(tx, { type: 'sandbox', id: sandboxId, tenantId: input.tenantId });
}

/** The pool a create's template names (for the budget check, which runs outside a transaction). */
export async function templatePool(
  sql: SqlExecutor,
  input: { tenantId: string; templateId: string },
): Promise<string | undefined> {
  const { rows } = await sql.query<{ pool_id: string }>(
    `SELECT pool_id FROM sandbox_templates WHERE id = $1 AND tenant_id = $2`,
    [input.templateId, input.tenantId],
  );
  return rows[0]?.pool_id;
}

/** One instance for a sandbox or a warm pool, written admitted (no draft) and scheduled at once. */
interface ManagedInstance {
  instanceId: string;
  template: TemplateRow;
  ownerIdentityId: string;
  agentId?: string;
  delegationId?: string;
  /** `warm`: paused when the runtime can pause (memory resident), else stopped. */
  desiredState: 'running' | 'warm';
  sandboxId?: string;
  warmTemplateId?: string;
  admission?: AdmissionContext;
  /** Boot from this snapshot (a restore) instead of the template's image. */
  restoreFrom?: InstanceRestore;
}

async function createManagedInstance(
  deps: InstanceDeps,
  tx: SqlTx,
  spec: ManagedInstance,
): Promise<InstanceRow> {
  const template = spec.template;
  if (spec.warmTemplateId) {
    // The pass read the template earlier: a teardown or a reshaping since then stops this refill.
    const current = await tx.query(
      `SELECT 1 FROM sandbox_templates WHERE id = $1 AND NOT deleted AND instance_version = $2 FOR SHARE`,
      [template.id, template.instanceVersion],
    );
    if (current.rows.length === 0)
      throw new ComputeError(
        'INVALID_STATE',
        `Sandbox template ${template.id} changed; refill skipped`,
      );
  }
  const { flavor, image, runtime } = await resolveTemplate(deps, tx, template);
  // The range may have gone since the template was written; never start an instance bcd must stop.
  await assertNetworkDeliverable(tx, template.poolId, template.network);
  // Rendered, then sealed, before the row exists: resolved secrets never touch the table (§6).
  const rendered = await instanceUserData(deps, template, spec.instanceId);
  const sealed = rendered !== null && deps.broker !== undefined && !isSecretRef(rendered);
  const userData = sealed ? await deps.broker!.put(template.tenantId, rendered!) : rendered;
  const desiredState =
    spec.desiredState === 'running'
      ? 'running'
      : runtimeTable(deps).get(runtime)?.pause
        ? 'paused'
        : 'stopped';
  const shape = shapeOf(flavor);
  const idempotencyKey = spec.sandboxId ? `sandbox:${spec.sandboxId}` : `warm:${spec.instanceId}`;
  const hash = await sha256Hex(
    canonical({ template: template.id, version: template.version, instance: spec.instanceId }),
  );
  await tx.query(
    `INSERT INTO instances (id, tenant_id, pool_id, flavor_id, flavor, image_id, image, ssh_keys, user_data,
                            runtime, draft, state, desired_state, owner_identity_id, agent_id, delegation_id,
                            idempotency_key, request_hash, sandbox_id, warm_template_id, restore_from, network_policy,
                            warm_template_version, user_data_sealed, version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, '{}', $8, $9, false, 'pending', $10, $11, $12, $13,
             $14, decode($15, 'hex'), $16, $17, $18::jsonb, $19, $20, $21, 1)`,
    [
      spec.instanceId,
      template.tenantId,
      template.poolId,
      flavor.id,
      JSON.stringify(shape),
      template.imageId,
      JSON.stringify(image),
      userData,
      runtime,
      desiredState,
      spec.ownerIdentityId,
      spec.agentId ?? null,
      spec.delegationId ?? null,
      idempotencyKey,
      hash,
      spec.sandboxId ?? null,
      spec.warmTemplateId ?? null,
      spec.restoreFrom ? JSON.stringify(spec.restoreFrom) : null,
      template.network === 'egress' ? null : template.network,
      spec.warmTemplateId ? template.instanceVersion : null,
      sealed,
    ],
  );
  let row = (await readInstance(tx, spec.instanceId, { lock: true }))!;
  await deps.authz.upsert(tx, {
    type: 'instance',
    id: row.id,
    tenantId: row.tenantId,
    attributes: instanceAttributes(shape, template.imageId, image.verified),
    parentType: 'pool',
    parentId: row.poolId,
    ownerId: spec.ownerIdentityId,
  });
  row = await moveInstance(tx, row, 'schedule', 'scheduling');
  row = await sealUserData(deps, tx, row);
  row = await scheduleHosted(deps, tx, row, spec.admission);
  await publishInstance(deps, tx, row, 'instance.created', {
    ...(spec.sandboxId ? { sandboxId: spec.sandboxId } : {}),
    ...(spec.warmTemplateId ? { warmTemplateId: spec.warmTemplateId } : {}),
  });
  return row;
}

/** The certificate principal `sandboxes.exec` signs for an instance: bound to it, never bare. */
export const sandboxPrincipal = (account: string, instanceId: string): string =>
  `${account}@${instanceId}`;

const cloudConfigTypes: readonly [string, string][] = [
  ['#cloud-config', 'text/cloud-config'],
  ['#!', 'text/x-shellscript'],
  ['#cloud-boothook', 'text/cloud-boothook'],
  ['#include', 'text/x-include-url'],
];

/**
 * A sandbox instance's user data (§3.7): a MIME multipart whose first part is vps's cloud-config and
 * whose second is the template's own user data, if any. vps's part:
 * - with `exec`: creates `account` and makes sshd trust the sandbox CA for the instance's own
 *   principal only (`<account>@<instanceId>`), so a certificate for one sandbox opens no other;
 * - with `env`: writes the resolved variables to `/etc/sandbox/env` (root, 0600) as shell
 *   assignments.
 */
export function sandboxUserData(
  own: string | undefined,
  instanceId: string,
  parts: {
    exec?: { caPublicKey: string; account: string };
    env?: Readonly<Record<string, string>>;
  },
): string {
  const text = (value: string) => JSON.stringify(value);
  const exec = parts.exec;
  const env = Object.entries(parts.env ?? {});
  const lines = ['#cloud-config'];
  if (exec)
    lines.push(
      'users:',
      '  - default',
      `  - name: ${text(exec.account)}`,
      '    shell: "/bin/bash"',
      '    lock_passwd: true',
    );
  lines.push('write_files:');
  if (exec)
    lines.push(
      '  - path: "/etc/ssh/bc_sandbox_ca.pub"',
      '    permissions: "0644"',
      `    content: ${text(`${exec.caPublicKey}\n`)}`,
      `  - path: ${text(`/etc/ssh/bc_sandbox_principals/${exec.account}`)}`,
      '    permissions: "0644"',
      `    content: ${text(`${sandboxPrincipal(exec.account, instanceId)}\n`)}`,
      '  - path: "/etc/ssh/sshd_config.d/10-bc-sandbox.conf"',
      '    permissions: "0644"',
      `    content: ${text('TrustedUserCAKeys /etc/ssh/bc_sandbox_ca.pub\nAuthorizedPrincipalsFile /etc/ssh/bc_sandbox_principals/%u\n')}`,
    );
  if (env.length > 0)
    lines.push(
      `  - path: ${text(sandboxEnvPath)}`,
      '    permissions: "0600"',
      '    owner: "root:root"',
      `    content: ${text(env.map(([name, value]) => `${name}=${shellQuote(value)}\n`).join(''))}`,
    );
  if (exec)
    lines.push(
      'runcmd:',
      '  - ["sh", "-c", "systemctl reload-or-restart ssh || systemctl reload-or-restart sshd"]',
    );
  lines.push('');
  const boundary = `bc-sandbox-${instanceId}`;
  const part = (type: string, body: string) =>
    `--${boundary}\nContent-Type: ${type}; charset="utf-8"\nMIME-Version: 1.0\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
  const all = [part('text/cloud-config', lines.join('\n'))];
  if (own !== undefined && own.length > 0) {
    const type = cloudConfigTypes.find(([prefix]) => own.startsWith(prefix))?.[1] ?? 'text/plain';
    all.push(part(type, own));
  }
  return `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n${all.join('')}--${boundary}--\n`;
}

/**
 * A sandbox instance's user data: the template's own as it is, unless vps has something to add (the
 * exec CA trust, the env file). Then it is a multipart whose vps part comes first. Env values are
 * resolved here, for the template's tenant, and reach the host sealed by the broker only.
 */
async function instanceUserData(
  deps: InstanceDeps,
  template: TemplateRow,
  instanceId: string,
): Promise<string | null> {
  const names = Object.keys(template.env);
  if (!deps.sandboxExec && names.length === 0) return template.userData ?? null;
  assertEnvDeliverable(deps, template.env, template.userData);
  const env: Record<string, string> = {};
  for (const name of names.sort()) {
    const ref = template.env[name]!;
    // Checked to be this tenant's own when the template was written.
    if (!isSecretRef(ref))
      throw new ComputeError('INVALID_STATE', `env.${name} is not a secret ref`);
    env[name] = await deps.secrets.resolve(ref);
  }
  const own = isSecretRef(template.userData)
    ? await deps.secrets.resolve(template.userData)
    : template.userData;
  return sandboxUserData(own, instanceId, {
    ...(deps.sandboxExec ? { exec: deps.sandboxExec } : {}),
    env,
  });
}

/** Where a sandbox's template env lands in the guest (root-only). */
export const sandboxEnvPath = '/etc/sandbox/env';

/** A POSIX shell single-quoted word. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Warm instance states a claim takes: settled and not on their way out. */
const claimable = ['stopped', 'paused'];

/**
 * Claims the oldest settled warm instance of a template for a sandbox (§3.7), or nothing. Rows
 * another claim holds are skipped, so concurrent creates never wait on each other. The instance
 * changes owner, starts running and is refused by instance item methods from now on.
 */
async function claimWarm(
  deps: InstanceDeps,
  tx: SqlTx,
  template: TemplateRow,
  sandbox: RawSandbox,
): Promise<InstanceRow | undefined> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM instances
      WHERE warm_template_id = $1 AND tenant_id = $2 AND NOT draft AND desired_state <> 'deleted'
        AND state = ANY($3::text[]) AND warm_template_version = $4
      ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [template.id, template.tenantId, claimable, template.instanceVersion],
  );
  if (!rows[0]) return undefined;
  await tx.query(
    `UPDATE instances
        SET warm_template_id = NULL, sandbox_id = $2, owner_identity_id = $3, desired_state = 'running',
            claimed_at = $4::timestamptz, agent_id = $5, delegation_id = $6, version = version + 1
      WHERE id = $1`,
    [
      rows[0].id,
      sandbox.id,
      sandbox.owner_identity_id,
      new Date(deps.clock.now()).toISOString(),
      sandbox.agent_id,
      sandbox.delegation_id,
    ],
  );
  const row = (await readInstance(tx, rows[0].id, { lock: true }))!;
  await deps.authz.upsert(tx, {
    type: 'instance',
    id: row.id,
    tenantId: row.tenantId,
    attributes: instanceAttributes(row.shape, row.imageId, row.image?.verified ?? false),
    parentType: 'pool',
    parentId: row.poolId,
    ownerId: sandbox.owner_identity_id,
  });
  await wake(deps, tx, row);
  await publishInstance(deps, tx, row, 'instance.starting', { sandboxId: sandbox.id });
  return row;
}

/**
 * `sandboxes.create` transaction 2 (allowed): claims a warm instance of the template, or creates and
 * schedules one (`QUOTA_EXCEEDED` refuses the request and leaves the draft, as for instances), then
 * starts the TTL.
 */
export async function completeCreateSandbox(
  deps: InstanceDeps,
  context: MethodContext,
  input: CreateSandboxInput,
): Promise<Sandbox> {
  const tx = context.sql;
  const sandboxId = await sandboxIdOf(context, input);
  const raw = await readSandbox(tx, sandboxId, { tenantId: input.tenantId, lock: true });
  if (!raw) throw new ComputeError('NOT_FOUND', `Sandbox ${sandboxId} not found`);
  if (!raw.draft) return sandboxView(raw);
  const template = await readTemplate(tx, raw.tenant_id, raw.template_id);
  if (!template)
    throw new ComputeError('NOT_FOUND', `Sandbox template ${raw.template_id} not found`);
  // A restore boots its snapshot, so it never claims a warm instance.
  const source =
    raw.from_snapshot === null
      ? undefined
      : await restoreSource(tx, raw.tenant_id, raw.from_snapshot, raw.owner_identity_id);
  const claimed = source ? undefined : await claimWarm(deps, tx, template, raw);
  const instance =
    claimed ??
    (await createManagedInstance(deps, tx, {
      instanceId: raw.instance_id,
      template,
      ownerIdentityId: raw.owner_identity_id,
      ...(context.caller?.agentId ? { agentId: context.caller.agentId } : {}),
      ...(context.caller?.delegationId ? { delegationId: context.caller.delegationId } : {}),
      desiredState: 'running',
      sandboxId: raw.id,
      ...(context.admission ? { admission: context.admission } : {}),
      ...(source
        ? {
            restoreFrom: {
              snapshotId: source.snapshotId,
              url: source.url,
              sha256: source.sha256,
              includeMemory: source.includeMemory,
              ...(source.cpuModel ? { cpuModel: source.cpuModel } : {}),
              ...(source.principalInstanceId
                ? { principalInstanceId: source.principalInstanceId }
                : {}),
            },
          }
        : {}),
    }));
  const now = deps.clock.now();
  await tx.query(
    `UPDATE sandboxes SET draft = false, instance_id = $2, warm = $3, expires_at = $4::timestamptz,
                          version = version + 1
      WHERE id = $1`,
    [
      raw.id,
      instance.id,
      claimed !== undefined,
      new Date(now + raw.ttl_seconds * second).toISOString(),
    ],
  );
  const created = (await readSandbox(tx, raw.id))!;
  await publishSandbox(deps, tx, created, 'sandbox.created', {
    warm: claimed !== undefined,
    expiresAt: Number(created.expires_ms),
  });
  return sandboxView(created);
}

async function lockOpenSandbox(tx: SqlTx, ref: SandboxRef): Promise<RawSandbox> {
  const raw = await readSandbox(tx, ref.sandboxId, { tenantId: ref.tenantId, lock: true });
  if (!raw || raw.draft) throw new ComputeError('NOT_FOUND', `Sandbox ${ref.sandboxId} not found`);
  return raw;
}

/** One sandbox with its snapshots. */
export async function getSandbox(tx: SqlTx, ref: SandboxRef): Promise<Sandbox> {
  const raw = await readSandbox(tx, ref.sandboxId, { tenantId: ref.tenantId });
  if (!raw || raw.draft) throw new ComputeError('NOT_FOUND', `Sandbox ${ref.sandboxId} not found`);
  return { ...sandboxView(raw), snapshots: await sandboxSnapshots(tx, raw.id) };
}

/** A tenant's sandboxes, newest first; `scope: 'mine'` (the default) filters to the caller's own. */
export async function listSandboxes(
  tx: SqlTx,
  input: ListSandboxesInput,
  callerIdentityId: string | undefined,
): Promise<{ items: Sandbox[]; cursor?: string }> {
  const limit = input.limit ?? 50;
  const owner = input.scope === 'mine' ? (callerIdentityId ?? '') : null;
  const { rows } = await tx.query<RawSandbox>(
    `SELECT ${sandboxColumns} FROM ${sandboxFrom}
      WHERE s.tenant_id = $1 AND NOT s.draft
        AND ($2::text IS NULL OR s.owner_identity_id = $2)
        AND ($3::bool OR s.deleted_at IS NULL) AND ($4::text IS NULL OR s.template_id = $4)
        AND ($5::text IS NULL OR (s.created_at, s.id) <
             (SELECT created_at, id FROM sandboxes WHERE id = $5 AND tenant_id = $1))
      ORDER BY s.created_at DESC, s.id DESC LIMIT $6`,
    [
      input.tenantId,
      owner,
      input.deleted === true,
      input.templateId ?? null,
      input.cursor ?? null,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit);
  const result: { items: Sandbox[]; cursor?: string } = { items: page.map(sandboxView) };
  if (rows.length > limit) result.cursor = page[page.length - 1]!.id;
  return result;
}

/** Asks the sandbox's instance to go away (idempotent); the sandbox reconciler finishes the rest. */
async function deleteSandboxInstance(
  deps: InstanceDeps,
  tx: SqlTx,
  raw: RawSandbox,
): Promise<void> {
  let row = await readInstance(tx, raw.instance_id, { lock: true });
  if (!row || row.state === 'deleted') return;
  if (row.desiredState !== 'deleted')
    row = await updateInstance(tx, row, { desiredState: 'deleted' });
  await wake(deps, tx, row);
  await publishInstance(deps, tx, row, 'instance.deleting', { sandboxId: raw.id });
}

/** `sandboxes.delete`: deletes the instance through its lifecycle; idempotent. */
export async function deleteSandbox(
  deps: InstanceDeps,
  tx: SqlTx,
  ref: SandboxRef,
): Promise<Sandbox> {
  const raw = await lockOpenSandbox(tx, ref);
  if (raw.deleting_ms === null)
    await tx.query(
      `UPDATE sandboxes SET deleting_at = $2::timestamptz, version = version + 1 WHERE id = $1`,
      [raw.id, new Date(deps.clock.now()).toISOString()],
    );
  await deleteSandboxInstance(deps, tx, raw);
  await deps.work.enqueue(tx, sandboxWork, 'all');
  return sandboxView((await readSandbox(tx, raw.id))!);
}

function extendedExpiry(raw: RawSandbox, input: ExtendSandboxInput): number {
  return input.until ?? Number(raw.expires_ms) + input.by!;
}

/**
 * `sandboxes.extend` transaction 1: the new lifetime goes into the authz projection (`ttlSeconds`,
 * from creation to the new expiry) so policies bound it, as reservation `extend` does. An expiry
 * already reached replays without a decision.
 */
export async function prepareExtendSandbox(
  context: MethodContext,
  input: ExtendSandboxInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Sandbox>> {
  const raw = await lockOpenSandbox(tx, input);
  if (raw.deleting_ms !== null)
    throw new ComputeError('INVALID_STATE', `Sandbox ${raw.id} is being deleted`);
  const expires = extendedExpiry(raw, input);
  if (input.until !== undefined && expires <= Number(raw.expires_ms))
    return { status: 'replay', result: sandboxView(raw) };
  // The handler applies this absolute expiry, not "current + by" again: two concurrent extends
  // decided on the same lifetime must not add up to one no decision covered.
  input.until = expires;
  delete input.by;
  await context.authz.setPending(
    tx,
    { type: 'sandbox', id: raw.id, tenantId: raw.tenant_id },
    { ttlSeconds: Math.ceil((expires - Number(raw.created_ms)) / second) },
  );
  return { status: 'decide', resource: { type: 'sandbox', id: raw.id } };
}

export async function denyExtendSandbox(
  context: MethodContext,
  input: SandboxRef,
  tx: SqlTx,
): Promise<void> {
  await context.authz.setPending(
    tx,
    { type: 'sandbox', id: input.sandboxId, tenantId: input.tenantId },
    null,
  );
}

/** `sandboxes.extend` transaction 2 (allowed): moves `expiresAt` within the template's `maxTtlSeconds`. */
export async function extendSandbox(
  deps: InstanceDeps,
  context: MethodContext,
  input: ExtendSandboxInput,
): Promise<Sandbox> {
  const tx = context.sql;
  const raw = await lockOpenSandbox(tx, input);
  if (raw.deleting_ms !== null)
    throw new ComputeError('INVALID_STATE', `Sandbox ${raw.id} is being deleted`);
  const template = await readTemplate(tx, raw.tenant_id, raw.template_id, { deleted: true });
  const expires = extendedExpiry(raw, input);
  const lifetime = Math.ceil((expires - Number(raw.created_ms)) / second);
  if (template && lifetime > template.maxTtlSeconds)
    throw new ComputeError(
      'INVALID_INPUT',
      `A sandbox of template ${template.name} lives at most ${template.maxTtlSeconds}s`,
    );
  await context.authz.setPending(
    tx,
    { type: 'sandbox', id: raw.id, tenantId: raw.tenant_id },
    null,
  );
  if (expires <= Number(raw.expires_ms)) return sandboxView(raw);
  await tx.query(
    `UPDATE sandboxes SET expires_at = $2::timestamptz, ttl_seconds = $3, version = version + 1
      WHERE id = $1`,
    [raw.id, new Date(expires).toISOString(), lifetime],
  );
  const extended = (await readSandbox(tx, raw.id))!;
  if (template) {
    const flavor = await readFlavorByName(tx, template.poolId, template.flavor);
    if (flavor)
      await deps.authz.upsert(tx, {
        type: 'sandbox',
        id: raw.id,
        tenantId: raw.tenant_id,
        attributes: sandboxAttributes(template, flavor, lifetime, raw.from_snapshot ?? undefined),
        parentType: 'pool',
        parentId: raw.pool_id,
        ownerId: raw.owner_identity_id,
      });
  }
  await publishSandbox(deps, tx, extended, 'sandbox.extended', {
    expiresAt: Number(extended.expires_ms),
  });
  return sandboxView(extended);
}

// --- The sandbox reconciler ----------------------------------------------------------------------

/** What one reconciler pass did. */
export interface SandboxPass {
  expired: number;
  ready: number;
  deleted: number;
  warmCreated: number;
  warmDrained: number;
  snapshotsSettled: number;
}

/**
 * One pass of the `vps.sandboxes` reconciler:
 * - expiry: sandboxes past `expiresAt` get `sandbox.expired` and an ordinary instance delete;
 * - events: `sandbox.ready` once the instance first runs, `sandbox.deleted` once it is gone;
 * - warm pools: each live template keeps `warm.min` warm instances (stopped until claimed),
 *   creating at most `warmRefillPerPass` per template per pass, each in its own transaction, and
 *   drains those beyond `warm.max` and all of deleted templates.
 */
export async function reconcileSandboxes(
  deps: InstanceDeps,
  sql: SqlExecutor,
  options: { batch?: number; store?: SnapshotStore } = {},
): Promise<SandboxPass> {
  const batch = options.batch ?? 100;
  const now = deps.clock.now();
  const at = new Date(now).toISOString();
  const pass: SandboxPass = {
    expired: 0,
    ready: 0,
    deleted: 0,
    warmCreated: 0,
    warmDrained: 0,
    snapshotsSettled: await settleSnapshots(deps, sql, { batch }),
  };
  const dropped: DroppedSnapshot[] = [];

  await sql.transaction(async (tx) => {
    const expired = await tx.query<RawSandbox>(
      `SELECT ${sandboxColumns} FROM ${sandboxFrom}
        WHERE NOT s.draft AND s.deleting_at IS NULL AND s.expires_at <= $1::timestamptz
        ORDER BY s.expires_at, s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [at, batch],
    );
    for (const raw of expired.rows) {
      await tx.query(
        `UPDATE sandboxes SET expired_at = $2::timestamptz, deleting_at = $2::timestamptz,
                              version = version + 1
          WHERE id = $1`,
        [raw.id, at],
      );
      await publishSandbox(deps, tx, raw, 'sandbox.expired', { expiresAt: Number(raw.expires_ms) });
      await deleteSandboxInstance(deps, tx, raw);
      pass.expired++;
    }

    const ready = await tx.query<RawSandbox>(
      `SELECT ${sandboxColumns} FROM ${sandboxFrom}
        WHERE NOT s.draft AND s.ready_at IS NULL AND s.deleting_at IS NULL AND i.state = 'running'
        ORDER BY s.id LIMIT $1 FOR UPDATE OF s SKIP LOCKED`,
      [batch],
    );
    for (const raw of ready.rows) {
      await tx.query(
        `UPDATE sandboxes SET ready_at = $2::timestamptz, version = version + 1 WHERE id = $1`,
        [raw.id, at],
      );
      await publishSandbox(deps, tx, raw, 'sandbox.ready', { warm: raw.warm });
      pass.ready++;
    }

    const gone = await tx.query<RawSandbox>(
      `SELECT ${sandboxColumns} FROM ${sandboxFrom}
        WHERE NOT s.draft AND s.deleted_at IS NULL AND (i.id IS NULL OR i.state = 'deleted')
        ORDER BY s.id LIMIT $1 FOR UPDATE OF s SKIP LOCKED`,
      [batch],
    );
    for (const raw of gone.rows) {
      await tx.query(
        `UPDATE sandboxes SET deleting_at = coalesce(deleting_at, $2::timestamptz),
                              deleted_at = $2::timestamptz, version = version + 1
          WHERE id = $1`,
        [raw.id, at],
      );
      await deps.authz.remove(tx, { type: 'sandbox', id: raw.id, tenantId: raw.tenant_id });
      // Snapshots hold memory: they go with the sandbox unless kept.
      dropped.push(...(await dropSnapshots(tx, { sandboxId: raw.id }, deps.authz)));
      await publishSandbox(deps, tx, raw, 'sandbox.deleted', {
        expired: raw.expired_ms !== null,
      });
      pass.deleted++;
    }
  });
  dropped.push(...(await purgeSettledSnapshots(sql, { batch })));
  await purgeSnapshots(options.store, deps.log, dropped);

  // Warm pools: what each template holds, then one transaction per change.
  // Only instances of the template's current version count; older ones are drained.
  const { rows: pools } = await sql.query<
    RawTemplate & { live: string | number; stale: string | number }
  >(
    `SELECT ${templateColumnsOf('t.')},
            count(i.id) FILTER (WHERE i.desired_state <> 'deleted' AND i.state NOT IN ('deleting', 'deleted')
                                  AND i.state NOT IN ('error', 'lost')
                                  AND i.warm_template_version = t.instance_version) AS live,
            count(i.id) FILTER (WHERE i.desired_state <> 'deleted' AND i.state NOT IN ('deleting', 'deleted')
                                  AND (i.warm_template_version IS DISTINCT FROM t.instance_version
                                       OR i.state IN ('error', 'lost'))) AS stale
       FROM sandbox_templates t
       LEFT JOIN instances i ON i.warm_template_id = t.id
      WHERE (NOT t.deleted AND t.warm_min > 0) OR i.id IS NOT NULL
      GROUP BY t.id`,
  );
  for (const raw of pools) {
    const template = toTemplate(raw);
    const live = Number(raw.live);
    const keep = template.deleted ? 0 : template.warm.max;
    if (Number(raw.stale) > 0)
      pass.warmDrained += await drainWarm(deps, sql, template, Number(raw.stale), true);
    if (live > keep) pass.warmDrained += await drainWarm(deps, sql, template, live - keep, false);
    const want = template.deleted ? 0 : Math.min(template.warm.min - live, warmRefillPerPass);
    for (let index = 0; index < want; index++) {
      try {
        await sql.transaction((tx) =>
          createManagedInstance(deps, tx, {
            instanceId: newId('inst'),
            template,
            ownerIdentityId: template.createdBy,
            desiredState: 'warm',
            warmTemplateId: template.id,
          }),
        );
        pass.warmCreated++;
      } catch (error) {
        // A warm pool is best effort: quota, a vanished flavor or image, or no fit stop this refill.
        deps.log.warn('vps: warm sandbox instance not created', {
          templateId: template.id,
          error: String((error as Error)?.message ?? error),
        });
        break;
      }
    }
  }
  return pass;
}

/**
 * `selfCheck` (doctor) for sandboxes:
 * - `vps.sandboxes.expiry`: sandboxes more than two passes (30 s) past `expiresAt` and not yet
 *   deleting (the `vps.sandboxes` reconciler is not running, or failing);
 * - `vps.sandboxes.deleting`: sandboxes deleting for more than 10 minutes (their instance is stuck);
 * - `vps.sandboxes.warm`: templates below `warm.min` settled instances for over 10 minutes with no
 *   refill in that time (quota, capacity, or a vanished flavor or image), or warm instances that have
 *   not settled within 10 minutes.
 */
export async function sandboxSelfCheck(sql: SqlExecutor): Promise<Finding[]> {
  const findings: Finding[] = [];
  const present = await sql.query<{ found: string | null }>(
    `SELECT to_regclass('sandboxes')::text AS found`,
  );
  if (!present.rows[0]?.found) return findings;
  const { rows } = await sql.query<{
    expired: string | number;
    deleting: string | number;
    stuck_templates: string[] | null;
    unsettled: string | number;
  }>(
    `SELECT
       (SELECT count(*) FROM sandboxes WHERE NOT draft AND deleting_at IS NULL
          AND expires_at < compute_now() - interval '30 seconds') AS expired,
       (SELECT count(*) FROM sandboxes WHERE deleting_at < compute_now() - interval '10 minutes'
          AND deleted_at IS NULL) AS deleting,
       (SELECT array_agg(t.id ORDER BY t.id) FROM sandbox_templates t
         WHERE NOT t.deleted AND t.warm_min > 0 AND t.created_at < compute_now() - interval '10 minutes'
           AND (SELECT count(*) FROM instances i WHERE i.warm_template_id = t.id
                  AND i.warm_template_version = t.instance_version AND i.desired_state <> 'deleted'
                  AND i.state IN ('paused', 'stopped')) < t.warm_min
           AND NOT EXISTS (SELECT 1 FROM instances i WHERE i.warm_template_id = t.id
                  AND i.created_at >= compute_now() - interval '10 minutes')) AS stuck_templates,
       (SELECT count(*) FROM instances WHERE warm_template_id IS NOT NULL AND desired_state <> 'deleted'
          AND state NOT IN ('paused', 'stopped', 'deleting', 'deleted')
          AND created_at < compute_now() - interval '10 minutes') AS unsettled`,
  );
  const row = rows[0]!;
  const expired = Number(row.expired);
  if (expired > 0)
    findings.push({
      check: 'vps.sandboxes.expiry',
      severity: 'error',
      message: `${expired} sandbox(es) are past their expiry and still running`,
      fix: 'Check that a worker runs the vps.sandboxes reconciler and that it is not failing',
      count: expired,
    });
  const deleting = Number(row.deleting);
  if (deleting > 0)
    findings.push({
      check: 'vps.sandboxes.deleting',
      severity: 'warning',
      message: `${deleting} sandbox(es) have been deleting for over 10 minutes`,
      fix: "Check their instances' hosts (a host must report the instance gone, or be declared lost)",
      count: deleting,
    });
  const stuck = row.stuck_templates ?? [];
  const unsettled = Number(row.unsettled);
  if (stuck.length > 0 || unsettled > 0)
    findings.push({
      check: 'vps.sandboxes.warm',
      severity: 'warning',
      message: [
        stuck.length > 0
          ? `${stuck.length} template(s) stay below warm.min with no refill in 10 minutes: ${stuck.slice(0, 5).join(', ')}`
          : '',
        unsettled > 0 ? `${unsettled} warm instance(s) have not settled within 10 minutes` : '',
      ]
        .filter(Boolean)
        .join('; '),
      fix: "Check the tenant's quota on the template's pool, host capacity, and that the template's flavor and image still exist",
      count: stuck.length + unsettled,
    });
  return findings;
}

/**
 * Deletes up to `count` of a template's warm instances: those made from an older template version
 * (`stale`), or else current ones newest first (the oldest are claimed first).
 */
async function drainWarm(
  deps: InstanceDeps,
  sql: SqlExecutor,
  template: TemplateRow,
  count: number,
  stale: boolean,
): Promise<number> {
  return sql.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM instances
        WHERE warm_template_id = $1 AND desired_state <> 'deleted' AND state NOT IN ('deleting', 'deleted')
          AND (warm_template_version IS DISTINCT FROM $3 OR state IN ('error', 'lost')) = $4
        ORDER BY created_at DESC, id DESC LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [template.id, count, template.instanceVersion, stale],
    );
    for (const { id: instanceId } of rows) {
      const row = (await readInstance(tx, instanceId, { lock: true }))!;
      const next = await updateInstance(tx, row, { desiredState: 'deleted' });
      await wake(deps, tx, next);
      await publishInstance(deps, tx, next, 'instance.deleting', { warmTemplateId: template.id });
    }
    return rows.length;
  });
}
