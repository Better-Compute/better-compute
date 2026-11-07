import {
  ComputeError,
  draftId,
  strictObject,
  type AdmissionPlan,
  type CallContext,
  type InputSchema,
  type MethodContext,
  type Migration,
  type ProviderCertificates,
  type ProviderCertificateSpec,
  type SecretRef,
  type SqlTx,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import { canonical, fail, id, key, object, optional, sha256Hex, tenant } from './input.js';
import { edgeResourceName } from './networks.js';
import {
  assertNameFree,
  caller,
  columns,
  idOf,
  keySchema,
  listSchema,
  lockTenant,
  nameOf,
  nameSchema,
  output,
  publish,
  resourceProvider,
  Run,
  sameRequest,
  settled,
  tenantIdSchema,
  uniqueViolation,
  type Fields,
  type ProviderResourceDeps,
  type ProviderResourceStatus,
} from './provider-resource-kit.js';

// Certificates (DigitalOcean P4, edge): TLS certificates on a provider account that a tenant's load balancers
// terminate TLS with. `managed`: the provider issues and renews one for the names given. `custom`: PEMs the tenant
// keeps in its own secrets; the row holds only their SecretRefs (`secret://<tenant>/<id>`, never another tenant's or
// the platform's), and they are resolved only in the call that uploads them, by a resolver that refuses any other
// ref. A certificate is immutable (replace it); one a live load balancer of the tenant uses is not deleted.

/** At most this many live certificates per tenant (they book no quota; the provider caps them per account). */
export const maxCertificatesPerTenant = 100;
/** At most this many names on one managed certificate. */
export const maxCertificateDomains = 100;

/** (DO P4) TLS certificates on a provider account, as SecretRefs only. */
export const providerCertificatesMigration: Migration = {
  name: 'vps/0102_provider_certificates',
  sql: `
CREATE TABLE provider_certificates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('managed', 'custom')),
  -- managed: the names it covers; custom: what the provider reported once uploaded.
  domains text[] NOT NULL DEFAULT '{}',
  -- custom only: SecretRefs of the tenant's own secrets, never secret values.
  certificate_ref text,
  private_key_ref text,
  chain_ref text,
  external_id text,
  fingerprint text,
  not_after timestamptz,${columns},
  CHECK ((kind = 'custom') = (certificate_ref IS NOT NULL AND private_key_ref IS NOT NULL)),
  CHECK (kind = 'custom' OR (chain_ref IS NULL AND cardinality(domains) > 0))
);
CREATE UNIQUE INDEX provider_certificates_name ON provider_certificates (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX provider_certificates_live ON provider_certificates (state) WHERE state <> 'deleted';
CREATE TRIGGER provider_certificates_stamp_deleted BEFORE UPDATE ON provider_certificates
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();
`,
};

// --- Views and input ---------------------------------------------------------------------------

type Desired = 'present' | 'deleted';

export interface ProviderCertificateView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  name: string;
  kind: 'managed' | 'custom';
  /** The names it covers (a custom one's, once the provider read them from the PEM). */
  domains: string[];
  /** When it expires (ISO 8601), once issued or uploaded. */
  notAfter?: string;
  /** Its SHA-1 fingerprint (hex), once issued or uploaded. */
  fingerprint?: string;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  version: number;
  createdAt: string;
}

export interface CreateProviderCertificateInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  kind: 'managed' | 'custom';
  domains?: string[];
  certificate?: string;
  privateKey?: string;
  chain?: string;
  idempotencyKey: string;
}
export type ProviderCertificateRef = { tenantId: string; certificateId: string };
export interface ListProviderCertificatesInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}

/** A host name (`example.com`), or a wildcard one (`*.example.com`): lower case, without a final dot. */
const hostName =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function domainOf(value: unknown, what = 'domain'): string {
  if (typeof value !== 'string' || value.length > 253 || !hostName.test(value))
    fail(`${what} must be a lower-case host name such as example.com or *.example.com`);
  return value;
}
const secretRefPattern = /^secret:\/\/([A-Za-z0-9._:-]{1,128})\/[A-Za-z0-9._-]{1,128}$/;
/** A SecretRef of the tenant's own secrets: `secret://<tenantId>/<id>`; any other scheme or tenant is refused. */
function ownSecretOf(value: unknown, tenantId: string, what: string): string {
  const match = typeof value === 'string' ? secretRefPattern.exec(value) : null;
  if (!match || match[1] !== tenantId)
    fail(`${what} must be a reference to one of the tenant's own secrets: secret://${tenantId}/<id>`);
  return value as string;
}

export function parseCreateProviderCertificate(raw: unknown): CreateProviderCertificateInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'kind',
    'domains',
    'certificate',
    'privateKey',
    'chain',
    'idempotencyKey',
  ]);
  const tenantId = tenant(input.tenantId);
  if (input.kind !== 'managed' && input.kind !== 'custom') fail('kind must be managed or custom');
  const out: CreateProviderCertificateInput = {
    tenantId,
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: nameOf(input.name),
    kind: input.kind,
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.kind === 'managed') {
    if (input.certificate !== undefined || input.privateKey !== undefined || input.chain !== undefined)
      fail('a managed certificate takes domains, not certificate, privateKey or chain');
    if (
      !Array.isArray(input.domains) ||
      input.domains.length === 0 ||
      input.domains.length > maxCertificateDomains
    )
      fail(`domains must list 1-${maxCertificateDomains} host names`);
    const domains = input.domains.map((value) => domainOf(value));
    if (new Set(domains).size !== domains.length) fail('domains must not repeat a name');
    out.domains = domains;
  } else {
    if (input.domains !== undefined)
      fail('a custom certificate takes its names from the certificate itself, not domains');
    out.certificate = ownSecretOf(input.certificate, tenantId, 'certificate');
    out.privateKey = ownSecretOf(input.privateKey, tenantId, 'privateKey');
    const chain = optional(input.chain, (value) => ownSecretOf(value, tenantId, 'chain'));
    if (chain !== undefined) out.chain = chain;
  }
  return out;
}
const certificateIdOf = (value: unknown) => id(value, 'pcert', 'certificateId');
export function parseProviderCertificateRef(raw: unknown): ProviderCertificateRef {
  const input = object(raw, ['tenantId', 'certificateId']);
  return { tenantId: tenant(input.tenantId), certificateId: certificateIdOf(input.certificateId) };
}
export function parseListProviderCertificates(raw: unknown): ListProviderCertificatesInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListProviderCertificatesInput = { tenantId: tenant(input.tenantId) };
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) out.poolId = poolId;
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.includeDeleted !== undefined) {
    if (typeof input.includeDeleted !== 'boolean') fail('includeDeleted must be true or false');
    out.includeDeleted = input.includeDeleted;
  }
  return out;
}

const secretSchema = (description: string): InputSchema => ({
  type: 'string',
  pattern: secretRefPattern.source,
  maxLength: 270,
  description,
});
const certificateIdSchema = idOf('pcert', 'The certificate');
export const providerCertificateSchemas = {
  create: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the certificate belongs to'),
      poolId: idOf(
        'pool',
        'A provider pool offered to the tenant, whose account provides certificates',
      ),
      name: nameSchema('The certificate name, unique in the tenant, e.g. www'),
      kind: {
        enum: ['managed', 'custom'],
        description:
          'managed: the provider issues and renews it for domains; custom: PEMs from the tenant’s secrets',
      },
      domains: {
        type: 'array',
        items: { type: 'string', maxLength: 253, pattern: hostName.source },
        minItems: 1,
        maxItems: maxCertificateDomains,
        description: 'managed: the names it covers, e.g. example.com and *.example.com',
      },
      certificate: secretSchema('custom: the leaf certificate (PEM), as secret://<tenantId>/<id>'),
      privateKey: secretSchema('custom: its private key (PEM), as secret://<tenantId>/<id>'),
      chain: secretSchema('custom: the intermediate chain (PEM), as secret://<tenantId>/<id>'),
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'name', 'kind', 'idempotencyKey'],
  ),
  certificate: strictObject({ tenantId: tenantIdSchema, certificateId: certificateIdSchema }, [
    'tenantId',
    'certificateId',
  ]),
  list: listSchema,
};

// --- Rows --------------------------------------------------------------------------------------

export interface CertificateRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  name: string;
  kind: 'managed' | 'custom';
  domains: string[];
  certificate_ref: string | null;
  private_key_ref: string | null;
  chain_ref: string | null;
  external_id: string | null;
  fingerprint: string | null;
  not_after: Date | string | null;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

const certificateColumns = `id, tenant_id, project_id, pool_id, provider_account_id, name, kind, domains,
  certificate_ref, private_key_ref, chain_ref, external_id, fingerprint, not_after, state, desired_state, message,
  ensure_requested, encode(request_hash, 'hex') AS request_hash, version, created_at`;
const iso = (value: Date | string) => new Date(value).toISOString();

export function providerCertificateView(row: CertificateRow): ProviderCertificateView {
  const view: ProviderCertificateView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    kind: row.kind,
    domains: [...(row.domains ?? [])],
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.not_after) view.notAfter = iso(row.not_after);
  if (row.fingerprint) view.fingerprint = row.fingerprint;
  if (row.message) view.message = row.message;
  return view;
}

export async function readCertificate(
  tx: SqlTx,
  certificateId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<CertificateRow | undefined> {
  const { rows } = await tx.query<CertificateRow>(
    `SELECT ${certificateColumns} FROM provider_certificates
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [certificateId, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireCertificate(
  tx: SqlTx,
  ref: ProviderCertificateRef,
  lock = false,
): Promise<CertificateRow> {
  const row = await readCertificate(tx, ref.certificateId, { tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `Certificate ${ref.certificateId} not found`);
  return row;
}

function certificateAuthz(
  row: { id: string; tenantId: string; accountId: string; poolId: string; projectId?: string },
  kind: string,
  ownerId: string,
) {
  return {
    type: 'provider-certificate',
    id: row.id,
    tenantId: row.tenantId,
    attributes: {
      providerAccountId: row.accountId,
      poolId: row.poolId,
      kind,
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    },
    parentType: 'tenant',
    parentId: row.tenantId,
    ownerId,
  };
}

// --- API ---------------------------------------------------------------------------------------

const certificateHash = (input: CreateProviderCertificateInput) =>
  sha256Hex(
    canonical({
      poolId: input.poolId,
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      domains: input.domains,
      certificate: input.certificate,
      privateKey: input.privateKey,
      chain: input.chain,
    }),
  );

/** `certificates.create` transaction 1 (admission): decided on `provider-certificate/<id>`. */
export async function prepareCreateProviderCertificate(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderCertificateInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ProviderCertificateView>> {
  const identity = caller(context);
  const certificateId = await draftId('pcert', input.tenantId, identity, input.idempotencyKey);
  const existing = await readCertificate(tx, certificateId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, await certificateHash(input));
    return { status: 'replay', result: providerCertificateView(existing) };
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'certificates');
  await assertNameFree(tx, 'provider_certificates', input.tenantId, input.name);
  await context.authz.upsert(
    tx,
    certificateAuthz(
      {
        id: certificateId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      input.kind,
      identity,
    ),
  );
  return { status: 'decide', resource: { type: 'provider-certificate', id: certificateId } };
}

export async function clearStagedProviderCertificate(
  context: MethodContext,
  input: CreateProviderCertificateInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const certificateId = await draftId(
    'pcert',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readCertificate(tx, certificateId)))
    await context.authz.remove(tx, {
      type: 'provider-certificate',
      id: certificateId,
      tenantId: input.tenantId,
    });
}

/** `certificates.create`: records the certificate `pending` and wakes the reconciler, which issues or uploads it. */
export async function createProviderCertificate(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderCertificateInput,
): Promise<ProviderCertificateView> {
  const tx = context.sql;
  const identity = caller(context);
  const certificateId = await draftId('pcert', input.tenantId, identity, input.idempotencyKey);
  const hash = await certificateHash(input);
  const existing = await readCertificate(tx, certificateId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return providerCertificateView(existing);
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'certificates');
  await lockTenant(tx, input.tenantId);
  await assertNameFree(tx, 'provider_certificates', input.tenantId, input.name);
  if (input.kind === 'managed')
    await assertOwnDomains(tx, input.tenantId, provider.accountId, input.domains ?? []);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_certificates WHERE tenant_id = $1 AND state <> 'deleted'`,
    [input.tenantId],
  );
  if (Number(live.rows[0]?.count ?? 0) >= maxCertificatesPerTenant)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A tenant has at most ${maxCertificatesPerTenant} certificates`,
    );
  try {
    await tx.query(
      `INSERT INTO provider_certificates (id, tenant_id, project_id, pool_id, provider_account_id, name, kind, domains,
                                          certificate_ref, private_key_ref, chain_ref, state, desired_state,
                                          created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, 'pending', 'present', $12, $13,
               decode($14, 'hex'), 1)`,
      [
        certificateId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        provider.accountId,
        input.name,
        input.kind,
        input.domains ?? [],
        input.certificate ?? null,
        input.privateKey ?? null,
        input.chain ?? null,
        identity,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Certificate ${input.name} already exists`);
    throw error;
  }
  await deps.authz.upsert(
    tx,
    certificateAuthz(
      {
        id: certificateId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      input.kind,
      identity,
    ),
  );
  await deps.work.enqueue(tx, providerResourcesWorkKind, certificateId);
  await publish(deps, tx, 'providerCertificate', { id: certificateId, tenant_id: input.tenantId }, 'created', {
    poolId: input.poolId,
    providerAccountId: provider.accountId,
    name: input.name,
    kind: input.kind,
  });
  return providerCertificateView((await readCertificate(tx, certificateId))!);
}

/**
 * A managed certificate covers only names in the tenant's own DNS zones on the same provider account (DigitalOcean
 * issues one for any domain the account hosts, which may be another tenant's): INVALID_INPUT before anything is
 * written, naming the first name that is not.
 */
async function assertOwnDomains(
  tx: SqlTx,
  tenantId: string,
  accountId: string,
  domains: readonly string[],
): Promise<void> {
  const { rows } = await tx.query<{ zone: string }>(
    `SELECT zone FROM provider_dns_zones
      WHERE tenant_id = $1 AND provider_account_id = $2 AND desired_state = 'present' AND state <> 'deleted'`,
    [tenantId, accountId],
  );
  const zones = rows.map((row) => row.zone);
  for (const domain of domains) {
    const name = domain.startsWith('*.') ? domain.slice(2) : domain;
    if (!zones.some((zone) => name === zone || name.endsWith(`.${zone}`)))
      throw new ComputeError(
        'INVALID_INPUT',
        `${domain} is not in a DNS zone of the tenant on this provider account (dnsZones.create)`,
        undefined,
        { reason: 'domainNotOwned' },
      );
  }
}

/** The reconciler's work kind (as `providerResourcesWork`; repeated here so this file needs no import cycle). */
const providerResourcesWorkKind = 'vps.provider-resources';

export async function getProviderCertificate(
  tx: SqlTx,
  ref: ProviderCertificateRef,
): Promise<ProviderCertificateView> {
  return providerCertificateView(await requireCertificate(tx, ref));
}

export async function listProviderCertificates(
  tx: SqlTx,
  input: ListProviderCertificatesInput,
): Promise<{ items: ProviderCertificateView[] }> {
  const { rows } = await tx.query<CertificateRow>(
    `SELECT ${certificateColumns} FROM provider_certificates
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  return { items: rows.map(providerCertificateView) };
}

/**
 * `certificates.delete`: INVALID_STATE while a load balancer of the tenant that is not deleted uses it (change or
 * delete that load balancer first); the reconciler deletes it at the provider.
 */
export async function deleteProviderCertificate(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderCertificateRef,
): Promise<ProviderCertificateView> {
  const row = await requireCertificate(tx, input, true);
  if (row.desired_state === 'deleted') return providerCertificateView(row);
  const users = await tx.query<{ id: string }>(
    `SELECT id FROM provider_load_balancers
      WHERE $1 = ANY(certificate_ids) AND state <> 'deleted' ORDER BY id LIMIT 5`,
    [row.id],
  );
  if (users.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Certificate ${row.id} is used by load balancer ${users.rows.map((user) => user.id).join(', ')}`,
      undefined,
      { reason: 'inUse' },
    );
  await tx.query(
    `UPDATE provider_certificates SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, providerResourcesWorkKind, row.id);
  await publish(deps, tx, 'providerCertificate', row, 'deleting');
  return providerCertificateView((await readCertificate(tx, row.id))!);
}

// --- The reconciler ----------------------------------------------------------------------------

/**
 * The secrets a certificate's upload may resolve: only the refs its row names, all of them the tenant's own. The
 * account's resolver would also resolve the platform's refs for a root-tenant account; this one never does.
 */
function certificateSecrets(run: Run, row: CertificateRow): CallContext['secrets'] {
  const allowed = new Set(
    [row.certificate_ref, row.private_key_ref, row.chain_ref].filter(
      (ref): ref is string => ref !== null && secretRefPattern.exec(ref)?.[1] === row.tenant_id,
    ),
  );
  return {
    resolve: async (ref: SecretRef, context) => {
      if (!allowed.has(ref))
        throw new ComputeError('ACCESS_DENIED', 'This certificate may not resolve that secret reference');
      return run.deps.secrets.resolve(ref, context);
    },
  };
}

export async function reconcileCertificate(run: Run, certificateId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const certificate = await readCertificate(tx, certificateId);
    if (!certificate) return undefined;
    return { certificate, account: await readAccount(tx, certificate.provider_account_id) };
  });
  if (!loaded || loaded.certificate.state === 'deleted') return;
  const { certificate } = loaded;
  const set = async (fields: Fields) => {
    const state = fields.state as ProviderResourceStatus | undefined;
    const becameReady = state === 'ready' && certificate.state !== 'ready';
    const becameError =
      state === 'error' &&
      (certificate.state !== 'error' || certificate.message !== fields.message);
    await run.write(
      'provider_certificates',
      certificate,
      {
        ...fields,
        ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}),
      },
      async (tx) => {
        if (becameReady) await publish(run.deps, tx, 'providerCertificate', certificate, 'ready');
        if (becameError)
          await publish(run.deps, tx, 'providerCertificate', certificate, 'error', {
            message: String(fields.message ?? ''),
          });
      },
    );
  };
  const certificates = await run.client(
    loaded.account,
    certificate.provider_account_id,
    'certificates',
  );
  if (typeof certificates === 'string') {
    await set(settled('error', certificates));
    return;
  }
  if (certificate.desired_state === 'deleted')
    await teardownCertificate(run, certificates, certificate, set);
  else await convergeCertificate(run, certificates, certificate, set);
}

async function convergeCertificate(
  run: Run,
  certificates: ProviderCertificates,
  certificate: CertificateRow,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  // Certificates are found again by name (unique per account), so a create whose answer was lost is safe to retry.
  if (!certificate.external_id && !certificate.ensure_requested) {
    if (!(await run.write('provider_certificates', certificate, { ensure_requested: true }))) return;
  }
  const spec: ProviderCertificateSpec = {
    name: edgeResourceName(certificate.id),
    kind: certificate.kind,
    ...(certificate.kind === 'managed' ? { domains: certificate.domains } : {}),
    ...(certificate.certificate_ref ? { certificate: certificate.certificate_ref as SecretRef } : {}),
    ...(certificate.private_key_ref ? { privateKey: certificate.private_key_ref as SecretRef } : {}),
    ...(certificate.chain_ref ? { chain: certificate.chain_ref as SecretRef } : {}),
  };
  const context = { ...run.call(`ensure:${certificate.id}`), secrets: certificateSecrets(run, certificate) };
  const ensured = await run.attempt(`ensure ${certificate.id}`, () =>
    certificates.ensureCertificate(spec, context),
  );
  if (ensured === undefined) return;
  if (ensured === 'missing' || ensured.state === 'error' || !ensured.id) {
    await set(
      settled(
        'error',
        ensured === 'missing' ? 'The provider did not answer' : (ensured.message ?? 'No certificate id'),
      ),
    );
    return;
  }
  const notAfter = output(ensured, 'notAfter');
  const domains = output(ensured, 'domains');
  const fields: Fields = {
    external_id: ensured.id,
    ...(output(ensured, 'fingerprint') ? { fingerprint: output(ensured, 'fingerprint')! } : {}),
    ...(notAfter && !Number.isNaN(Date.parse(notAfter)) ? { not_after: new Date(notAfter).toISOString() } : {}),
  };
  if (ensured.state !== 'ready') {
    run.inFlight = true;
    await set({ ...fields, ...settled('pending') });
    return;
  }
  await set({ ...fields, ...settled('ready') });
  // A custom certificate's names are the PEM's: recorded once the provider read them.
  if (certificate.kind === 'custom' && domains && certificate.domains.length === 0)
    await run.sql.query(
      `UPDATE provider_certificates SET domains = $2::text[] WHERE id = $1 AND kind = 'custom'`,
      [certificate.id, domains.split(',').filter((name) => name !== '').slice(0, maxCertificateDomains)],
    );
}

async function teardownCertificate(
  run: Run,
  certificates: ProviderCertificates,
  certificate: CertificateRow,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  const finish = () =>
    run.write('provider_certificates', certificate, { state: 'deleted', message: null }, async (tx) => {
      await run.deps.authz.remove(tx, { type: 'provider-certificate', id: certificate.id });
      await publish(run.deps, tx, 'providerCertificate', certificate, 'deleted');
    });
  const externalId = certificate.external_id;
  if (!externalId && certificate.ensure_requested) {
    // A create whose answer was lost and was not retried before the delete: vps has no id to delete. The row is
    // deleted with a warning; the provider-side name (edgeResourceName) is how an operator finds the certificate.
    run.deps.log.warn('providerResources: deleting a certificate whose create answer was lost', {
      certificateId: certificate.id,
      providerAccountId: certificate.provider_account_id,
    });
  }
  if (!externalId) {
    await finish();
    return;
  }
  const deleted = await run.attempt(`delete ${certificate.id}`, () =>
    certificates.deleteCertificate(externalId, run.call(`delete:${certificate.id}`)),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finish();
    return;
  }
  if (deleted.state === 'error' && run.lastCode === 'INVALID_STATE' && run.lastReason === 'notManaged') {
    run.deps.log.warn('providerResources: the certificate at this id is not ours; not deleted', {
      certificateId: certificate.id,
      providerAccountId: certificate.provider_account_id,
    });
    await finish();
    return;
  }
  if (deleted.state === 'error' && run.lastCode === 'CONFLICT') {
    // Still on a load balancer at the provider (one being changed or deleted): tried again later.
    run.backoff = true;
    await set(settled('deleting', deleted.message));
    return;
  }
  if (deleted.state === 'error') {
    await set(settled('error', deleted.message));
    return;
  }
  run.inFlight = true;
  await set(settled('deleting'));
}

/** Live certificates that are not settled (the periodic pass wakes them). */
export const unsettledCertificatesSql = `
  SELECT id FROM provider_certificates WHERE state <> 'deleted' AND (state <> 'ready' OR desired_state <> 'present')`;
export const liveCertificatesSql = `SELECT id FROM provider_certificates WHERE state <> 'deleted'`;
