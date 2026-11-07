import { isIP } from 'node:net';
import {
  ComputeError,
  draftId,
  strictObject,
  type AdmissionPlan,
  type InputSchema,
  type MethodContext,
  type Migration,
  type ProviderDns,
  type ProviderDnsRecordSpec,
  type SqlTx,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import { canonical, fail, id, int, key, object, optional, sha256Hex, tenant } from './input.js';
import { domainOf } from './provider-certificates.js';
import {
  caller,
  columns,
  idOf,
  keySchema,
  listSchema,
  lockTenant,
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

// DNS (DigitalOcean P4, edge): a tenant's DNS zones on a provider account and the records in them. A zone is one
// domain per provider account (two tenants never share one); `adopt` takes over a zone the account already holds and
// is open only to the account's owner tenant (any other tenant could otherwise take over the operator's domains). An
// adopted zone is never deleted at the provider. Records are the tenant's; the provider's own marker and apex NS/SOA
// records are never touched (the provider refuses them too). A record may follow an instance of the tenant
// (`instanceId` instead of `data`): its A or AAAA data is the instance's public address, kept current by the
// reconciler, and the record is deleted with the instance.

const workKind = 'vps.provider-resources';
/** At most this many live zones per tenant, and records per zone (zones and records book no quota). */
export const maxDnsZonesPerTenant = 50;
export const maxDnsRecordsPerZone = 500;
const recordTypes = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'NS'] as const;
type RecordType = (typeof recordTypes)[number];

/** (DO P4) DNS zones and records on a provider account: part of vps/0104_provider_edge (migrations.ts). */
export const providerDnsSql = `
CREATE TABLE provider_dns_zones (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  -- The domain, lower case, without a final dot.
  zone text NOT NULL,
  -- Taken over from the account (its owner tenant only): never deleted at the provider.
  adopt bool NOT NULL DEFAULT false,
  name_servers text,
  external_id text,${columns}
);
-- One live zone per domain per provider account: two tenants never share one.
CREATE UNIQUE INDEX provider_dns_zones_zone ON provider_dns_zones (provider_account_id, zone) WHERE state <> 'deleted';
CREATE INDEX provider_dns_zones_live ON provider_dns_zones (state) WHERE state <> 'deleted';
CREATE TRIGGER provider_dns_zones_stamp_deleted BEFORE UPDATE ON provider_dns_zones
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();

CREATE TABLE provider_dns_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  zone_id text NOT NULL REFERENCES provider_dns_zones,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'NS')),
  -- What the record says; for one that follows an instance, its address once known.
  data text,
  -- The instance whose public address an A/AAAA record follows (deleted with it).
  instance_id text REFERENCES instances,
  ttl_seconds int,
  priority int,
  port int,
  weight int,
  flags int,
  tag text,
  external_id text,${columns},
  CHECK (instance_id IS NULL OR type IN ('A', 'AAAA')),
  CHECK (instance_id IS NOT NULL OR data IS NOT NULL)
);
CREATE UNIQUE INDEX provider_dns_records_same ON provider_dns_records (zone_id, name, type, coalesce(instance_id, data))
  WHERE state <> 'deleted';
CREATE INDEX provider_dns_records_live ON provider_dns_records (state) WHERE state <> 'deleted';
CREATE INDEX provider_dns_records_zone ON provider_dns_records (zone_id) WHERE state <> 'deleted';
CREATE INDEX provider_dns_records_instance ON provider_dns_records (instance_id) WHERE instance_id IS NOT NULL;
CREATE TRIGGER provider_dns_records_stamp_deleted BEFORE UPDATE ON provider_dns_records
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();
`;

// --- Views and input ---------------------------------------------------------------------------

type Desired = 'present' | 'deleted';

export interface ProviderDnsZoneView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  zone: string;
  adopt: boolean;
  /** Where the domain's registrar must delegate to, once the provider reported them. */
  nameServers?: string[];
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  version: number;
  createdAt: string;
}

export interface DnsRecordFields {
  data?: string;
  ttlSeconds?: number;
  priority?: number;
  port?: number;
  weight?: number;
  flags?: number;
  tag?: string;
}
export interface ProviderDnsRecordView extends DnsRecordFields {
  id: string;
  tenantId: string;
  zoneId: string;
  name: string;
  type: RecordType;
  /** The full name (`www.example.com`). */
  fqdn: string;
  instanceId?: string;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  version: number;
  createdAt: string;
}

export interface CreateProviderDnsZoneInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  zone: string;
  adopt?: boolean;
  idempotencyKey: string;
}
export type ProviderDnsZoneRef = { tenantId: string; zoneId: string };
export interface ListProviderDnsZonesInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}
export interface CreateProviderDnsRecordInput extends ProviderDnsZoneRef, DnsRecordFields {
  name: string;
  type: RecordType;
  instanceId?: string;
  idempotencyKey: string;
}
export interface ProviderDnsRecordRef extends ProviderDnsZoneRef {
  recordId: string;
}
export interface UpdateProviderDnsRecordInput extends ProviderDnsRecordRef, DnsRecordFields {}
export interface ListProviderDnsRecordsInput extends ProviderDnsZoneRef {
  includeDeleted?: boolean;
}

const zoneIdOf = (value: unknown) => id(value, 'pdz', 'zoneId');
const recordIdOf = (value: unknown) => id(value, 'pdr', 'recordId');
/** `@` (the apex) or labels relative to the zone; `*` only as the first label. `_better-compute` is reserved. */
const recordName = /^(@|(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*|\*)$/;
function recordNameOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !recordName.test(value))
    fail('name must be @ (the apex) or a lower-case name relative to the zone, such as www');
  if (value === '_better-compute' || value.endsWith('._better-compute') || value.startsWith('_better-compute.'))
    fail('_better-compute is reserved for the provider’s ownership marker');
  return value;
}
const hostData = /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+$/;

/** Checks `data` and the type's own fields; returns the fields to store. */
function recordFieldsOf(type: RecordType, input: Record<string, unknown>, needData: boolean): DnsRecordFields {
  const out: DnsRecordFields = {};
  if (input.data !== undefined || needData) {
    const data = input.data;
    if (typeof data !== 'string' || data.length === 0 || data.length > 512 || /[\u0000-\u001f]/.test(data))
      fail('data must be text of at most 512 characters');
    if (type === 'A' && isIP(data) !== 4) fail('an A record holds an IPv4 address');
    if (type === 'AAAA' && isIP(data) !== 6) fail('an AAAA record holds an IPv6 address');
    if (['CNAME', 'MX', 'SRV', 'NS'].includes(type) && (data.length > 254 || !hostData.test(data)))
      fail(`a ${type} record holds an absolute host name with a final dot, such as host.example.com.`);
    out.data = data;
  }
  if (input.ttlSeconds !== undefined) out.ttlSeconds = int(input.ttlSeconds, 'ttlSeconds', 30, 86_400);
  const only = (field: 'priority' | 'port' | 'weight' | 'flags' | 'tag', types: RecordType[]) => {
    if (input[field] !== undefined && !types.includes(type)) fail(`${field} is only for ${types.join(' and ')} records`);
  };
  only('priority', ['MX', 'SRV']);
  only('port', ['SRV']);
  only('weight', ['SRV']);
  only('flags', ['CAA']);
  only('tag', ['CAA']);
  if (input.priority !== undefined) out.priority = int(input.priority, 'priority', 0, 65_535);
  if (input.port !== undefined) out.port = int(input.port, 'port', 1, 65_535);
  if (input.weight !== undefined) out.weight = int(input.weight, 'weight', 0, 65_535);
  if (input.flags !== undefined) out.flags = int(input.flags, 'flags', 0, 255);
  if (input.tag !== undefined) {
    if (!['issue', 'issuewild', 'iodef'].includes(input.tag as string)) fail('tag must be issue, issuewild or iodef');
    out.tag = input.tag as string;
  }
  return out;
}

export function parseCreateProviderDnsZone(raw: unknown): CreateProviderDnsZoneInput {
  const input = object(raw, ['tenantId', 'projectId', 'poolId', 'zone', 'adopt', 'idempotencyKey']);
  const zone = domainOf(input.zone, 'zone');
  if (zone.startsWith('*.')) fail('zone must be a domain, not a wildcard name');
  const out: CreateProviderDnsZoneInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    zone,
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.adopt !== undefined) {
    if (typeof input.adopt !== 'boolean') fail('adopt must be true or false');
    if (input.adopt) out.adopt = true;
  }
  return out;
}
export function parseProviderDnsZoneRef(raw: unknown): ProviderDnsZoneRef {
  const input = object(raw, ['tenantId', 'zoneId']);
  return { tenantId: tenant(input.tenantId), zoneId: zoneIdOf(input.zoneId) };
}
export function parseListProviderDnsZones(raw: unknown): ListProviderDnsZonesInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListProviderDnsZonesInput = { tenantId: tenant(input.tenantId) };
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
const recordFieldNames = ['data', 'ttlSeconds', 'priority', 'port', 'weight', 'flags', 'tag'] as const;
export function parseCreateProviderDnsRecord(raw: unknown): CreateProviderDnsRecordInput {
  const input = object(raw, ['tenantId', 'zoneId', 'name', 'type', 'instanceId', ...recordFieldNames, 'idempotencyKey']);
  if (input.type !== undefined && !recordTypes.includes(input.type as RecordType))
    fail(`type must be one of ${recordTypes.join(', ')}`);
  const type = (input.type as RecordType | undefined) ?? 'A';
  const name = recordNameOf(input.name);
  if (name === '@' && (type === 'NS' || type === 'CNAME')) fail(`an apex ${type} record is not allowed`);
  const instanceId = optional(input.instanceId, (value) => id(value, 'inst', 'instanceId'));
  if (instanceId !== undefined) {
    if (type !== 'A' && type !== 'AAAA') fail('a record that follows an instance is an A or AAAA record');
    if (input.data !== undefined) fail('a record that follows an instance takes its data from the instance');
  }
  return {
    tenantId: tenant(input.tenantId),
    zoneId: zoneIdOf(input.zoneId),
    name,
    type,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...recordFieldsOf(type, input, instanceId === undefined),
    idempotencyKey: key(input.idempotencyKey),
  };
}
export function parseProviderDnsRecordRef(raw: unknown): ProviderDnsRecordRef {
  const input = object(raw, ['tenantId', 'zoneId', 'recordId']);
  return { tenantId: tenant(input.tenantId), zoneId: zoneIdOf(input.zoneId), recordId: recordIdOf(input.recordId) };
}
export function parseUpdateProviderDnsRecord(raw: unknown): UpdateProviderDnsRecordInput {
  const input = object(raw, ['tenantId', 'zoneId', 'recordId', ...recordFieldNames]);
  if (recordFieldNames.every((field) => input[field] === undefined))
    fail('update changes at least one of data, ttlSeconds, priority, port, weight, flags and tag');
  const out: UpdateProviderDnsRecordInput = {
    tenantId: tenant(input.tenantId),
    zoneId: zoneIdOf(input.zoneId),
    recordId: recordIdOf(input.recordId),
  };
  // The type's own checks run in the handler, once the record's type is known.
  for (const field of recordFieldNames) if (input[field] !== undefined) (out as unknown as Record<string, unknown>)[field] = input[field];
  return out;
}
export function parseListProviderDnsRecords(raw: unknown): ListProviderDnsRecordsInput {
  const input = object(raw, ['tenantId', 'zoneId', 'includeDeleted']);
  const out: ListProviderDnsRecordsInput = { tenantId: tenant(input.tenantId), zoneId: zoneIdOf(input.zoneId) };
  if (input.includeDeleted !== undefined) {
    if (typeof input.includeDeleted !== 'boolean') fail('includeDeleted must be true or false');
    out.includeDeleted = input.includeDeleted;
  }
  return out;
}

// JSON Schema.
const zoneIdSchema = idOf('pdz', 'The DNS zone');
const recordIdSchema = idOf('pdr', 'The DNS record');
const recordFieldSchemas: Record<string, InputSchema> = {
  data: {
    type: 'string',
    maxLength: 512,
    description: 'An address (A/AAAA), an absolute host name with a final dot (CNAME/MX/SRV/NS), or text (TXT/CAA)',
  },
  ttlSeconds: { type: 'integer', minimum: 30, maximum: 86_400, description: 'How long resolvers cache it' },
  priority: { type: 'integer', minimum: 0, maximum: 65_535, description: 'MX and SRV' },
  port: { type: 'integer', minimum: 1, maximum: 65_535, description: 'SRV' },
  weight: { type: 'integer', minimum: 0, maximum: 65_535, description: 'SRV' },
  flags: { type: 'integer', minimum: 0, maximum: 255, description: 'CAA' },
  tag: { enum: ['issue', 'issuewild', 'iodef'], description: 'CAA' },
};
export const providerDnsSchemas = {
  createZone: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the zone belongs to'),
      poolId: idOf('pool', 'A provider pool offered to the tenant, whose account provides DNS'),
      zone: { type: 'string', maxLength: 253, description: 'The domain, e.g. example.com' },
      adopt: {
        type: 'boolean',
        default: false,
        description: "The account's owner tenant only: take over a zone the account already holds (never deleted)",
      },
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'zone', 'idempotencyKey'],
  ),
  zone: strictObject({ tenantId: tenantIdSchema, zoneId: zoneIdSchema }, ['tenantId', 'zoneId']),
  listZones: listSchema,
  createRecord: strictObject(
    {
      tenantId: tenantIdSchema,
      zoneId: zoneIdSchema,
      name: { type: 'string', maxLength: 200, description: '@ (the apex) or a name relative to the zone, e.g. www' },
      type: { enum: [...recordTypes], default: 'A', description: 'The record type' },
      instanceId: idOf('inst', 'A/AAAA: follow this instance’s public address instead of data'),
      ...recordFieldSchemas,
      idempotencyKey: keySchema,
    },
    ['tenantId', 'zoneId', 'name', 'idempotencyKey'],
  ),
  record: strictObject({ tenantId: tenantIdSchema, zoneId: zoneIdSchema, recordId: recordIdSchema }, [
    'tenantId',
    'zoneId',
    'recordId',
  ]),
  updateRecord: strictObject(
    { tenantId: tenantIdSchema, zoneId: zoneIdSchema, recordId: recordIdSchema, ...recordFieldSchemas },
    ['tenantId', 'zoneId', 'recordId'],
  ),
  listRecords: strictObject(
    {
      tenantId: tenantIdSchema,
      zoneId: zoneIdSchema,
      includeDeleted: { type: 'boolean', default: false, description: 'Include deleted ones' },
    },
    ['tenantId', 'zoneId'],
  ),
};

// --- Rows --------------------------------------------------------------------------------------

export interface ZoneRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  zone: string;
  adopt: boolean;
  name_servers: string | null;
  external_id: string | null;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}
export interface RecordRow {
  id: string;
  tenant_id: string;
  zone_id: string;
  name: string;
  type: RecordType;
  data: string | null;
  instance_id: string | null;
  ttl_seconds: number | null;
  priority: number | null;
  port: number | null;
  weight: number | null;
  flags: number | null;
  tag: string | null;
  external_id: string | null;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

const common = `state, desired_state, message, ensure_requested, encode(request_hash, 'hex') AS request_hash, version,
  created_at`;
const zoneColumns = `id, tenant_id, project_id, pool_id, provider_account_id, zone, adopt, name_servers, external_id,
  ${common}`;
const recordColumns = `id, tenant_id, zone_id, name, type, data, instance_id, ttl_seconds, priority, port, weight, flags,
  tag, external_id, ${common}`;
const iso = (value: Date | string) => new Date(value).toISOString();

export function providerDnsZoneView(row: ZoneRow): ProviderDnsZoneView {
  const view: ProviderDnsZoneView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    zone: row.zone,
    adopt: row.adopt,
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.name_servers) view.nameServers = row.name_servers.split(',').filter((entry) => entry !== '');
  if (row.message) view.message = row.message;
  return view;
}
export function providerDnsRecordView(row: RecordRow, zone: string): ProviderDnsRecordView {
  const view: ProviderDnsRecordView = {
    id: row.id,
    tenantId: row.tenant_id,
    zoneId: row.zone_id,
    name: row.name,
    type: row.type,
    fqdn: row.name === '@' ? zone : `${row.name}.${zone}`,
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.data !== null) view.data = row.data;
  if (row.instance_id) view.instanceId = row.instance_id;
  if (row.ttl_seconds !== null) view.ttlSeconds = Number(row.ttl_seconds);
  if (row.priority !== null) view.priority = Number(row.priority);
  if (row.port !== null) view.port = Number(row.port);
  if (row.weight !== null) view.weight = Number(row.weight);
  if (row.flags !== null) view.flags = Number(row.flags);
  if (row.tag !== null) view.tag = row.tag;
  if (row.message) view.message = row.message;
  return view;
}

export async function readZone(
  tx: SqlTx,
  zoneId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<ZoneRow | undefined> {
  const { rows } = await tx.query<ZoneRow>(
    `SELECT ${zoneColumns} FROM provider_dns_zones
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [zoneId, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireZone(tx: SqlTx, ref: ProviderDnsZoneRef, lock = false): Promise<ZoneRow> {
  const row = await readZone(tx, ref.zoneId, { tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `DNS zone ${ref.zoneId} not found`);
  return row;
}
export async function readRecord(
  tx: SqlTx,
  recordId: string,
  options: { zoneId?: string; tenantId?: string; lock?: boolean } = {},
): Promise<RecordRow | undefined> {
  const { rows } = await tx.query<RecordRow>(
    `SELECT ${recordColumns} FROM provider_dns_records
      WHERE id = $1 AND ($2::text IS NULL OR zone_id = $2) AND ($3::text IS NULL OR tenant_id = $3)${
        options.lock ? ' FOR UPDATE' : ''
      }`,
    [recordId, options.zoneId ?? null, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireRecord(tx: SqlTx, ref: ProviderDnsRecordRef, lock = false): Promise<RecordRow> {
  const row = await readRecord(tx, ref.recordId, { zoneId: ref.zoneId, tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `DNS record ${ref.recordId} not found`);
  return row;
}

function zoneAuthz(
  row: { id: string; tenantId: string; accountId: string; poolId: string; zone: string; projectId?: string },
  ownerId: string,
) {
  return {
    type: 'provider-dns-zone',
    id: row.id,
    tenantId: row.tenantId,
    attributes: {
      providerAccountId: row.accountId,
      poolId: row.poolId,
      zone: row.zone,
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    },
    parentType: 'tenant',
    parentId: row.tenantId,
    ownerId,
  };
}

// --- Zones API ---------------------------------------------------------------------------------

const zoneHash = (input: CreateProviderDnsZoneInput) =>
  sha256Hex(canonical({ poolId: input.poolId, projectId: input.projectId, zone: input.zone, adopt: input.adopt === true }));

/** The pool's account; `adopt` only for the account's owner tenant (ACCESS_DENIED otherwise). */
async function zoneProvider(deps: ProviderResourceDeps, tx: SqlTx, input: CreateProviderDnsZoneInput) {
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'dns');
  if (input.adopt && provider.account.tenantId !== input.tenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Only the provider account's owner tenant may adopt a zone it already holds`,
      undefined,
      { reason: 'adoptNotOwner' },
    );
  return provider;
}

/** `dnsZones.create` transaction 1 (admission): decided on `provider-dns-zone/<id>`. */
export async function prepareCreateProviderDnsZone(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderDnsZoneInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ProviderDnsZoneView>> {
  const identity = caller(context);
  const zoneId = await draftId('pdz', input.tenantId, identity, input.idempotencyKey);
  const existing = await readZone(tx, zoneId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, await zoneHash(input));
    return { status: 'replay', result: providerDnsZoneView(existing) };
  }
  const provider = await zoneProvider(deps, tx, input);
  await context.authz.upsert(
    tx,
    zoneAuthz(
      {
        id: zoneId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        zone: input.zone,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      identity,
    ),
  );
  return { status: 'decide', resource: { type: 'provider-dns-zone', id: zoneId } };
}

export async function clearStagedProviderDnsZone(
  context: MethodContext,
  input: CreateProviderDnsZoneInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const zoneId = await draftId('pdz', input.tenantId, context.caller.identityId, input.idempotencyKey);
  if (!(await readZone(tx, zoneId)))
    await context.authz.remove(tx, { type: 'provider-dns-zone', id: zoneId, tenantId: input.tenantId });
}

/** `dnsZones.create`: records the zone `pending` (CONFLICT when the account already has it in vps) and wakes the reconciler. */
export async function createProviderDnsZone(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderDnsZoneInput,
): Promise<ProviderDnsZoneView> {
  const tx = context.sql;
  const identity = caller(context);
  const zoneId = await draftId('pdz', input.tenantId, identity, input.idempotencyKey);
  const hash = await zoneHash(input);
  const existing = await readZone(tx, zoneId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return providerDnsZoneView(existing);
  }
  const provider = await zoneProvider(deps, tx, input);
  await lockTenant(tx, input.tenantId);
  // A zone inside or above another tenant's on the same account could answer for that tenant's names (the provider's
  // name servers serve every zone of every account): refused, without saying whose it is.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('better-compute:dns-zones:' || $1))", [provider.accountId]);
  const nested = await tx.query(
    `SELECT 1 FROM provider_dns_zones
      WHERE provider_account_id = $1 AND tenant_id <> $2 AND state <> 'deleted'
        AND ($3 LIKE '%.' || zone OR zone LIKE '%.' || $3) LIMIT 1`,
    [provider.accountId, input.tenantId, input.zone],
  );
  if (nested.rows.length > 0)
    throw new ComputeError('CONFLICT', `Zone ${input.zone} overlaps a zone that already exists`);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_dns_zones WHERE tenant_id = $1 AND state <> 'deleted'`,
    [input.tenantId],
  );
  if (Number(live.rows[0]?.count ?? 0) >= maxDnsZonesPerTenant)
    throw new ComputeError('QUOTA_EXCEEDED', `A tenant has at most ${maxDnsZonesPerTenant} DNS zones`);
  try {
    await tx.query(
      `INSERT INTO provider_dns_zones (id, tenant_id, project_id, pool_id, provider_account_id, zone, adopt, state,
                                       desired_state, created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'present', $8, $9, decode($10, 'hex'), 1)`,
      [
        zoneId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        provider.accountId,
        input.zone,
        input.adopt === true,
        identity,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    // The zone is on this account already (this tenant's or another's): never shared, never confirmed whose.
    if (uniqueViolation(error)) throw new ComputeError('CONFLICT', `Zone ${input.zone} already exists`);
    throw error;
  }
  await deps.authz.upsert(
    tx,
    zoneAuthz(
      {
        id: zoneId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        zone: input.zone,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      identity,
    ),
  );
  await deps.work.enqueue(tx, workKind, zoneId);
  await publish(deps, tx, 'providerDnsZone', { id: zoneId, tenant_id: input.tenantId }, 'created', {
    poolId: input.poolId,
    providerAccountId: provider.accountId,
    zone: input.zone,
    adopt: input.adopt === true,
  });
  return providerDnsZoneView((await readZone(tx, zoneId))!);
}

export async function getProviderDnsZone(tx: SqlTx, ref: ProviderDnsZoneRef): Promise<ProviderDnsZoneView> {
  return providerDnsZoneView(await requireZone(tx, ref));
}

export async function listProviderDnsZones(
  tx: SqlTx,
  input: ListProviderDnsZonesInput,
): Promise<{ items: ProviderDnsZoneView[] }> {
  const { rows } = await tx.query<ZoneRow>(
    `SELECT ${zoneColumns} FROM provider_dns_zones
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  return { items: rows.map(providerDnsZoneView) };
}

/** `dnsZones.delete`: INVALID_STATE (reason zoneNotEmpty) while it holds records; an adopted zone is only forgotten. */
export async function deleteProviderDnsZone(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderDnsZoneRef,
): Promise<ProviderDnsZoneView> {
  const row = await requireZone(tx, input, true);
  if (row.desired_state === 'deleted') return providerDnsZoneView(row);
  const records = await tx.query(
    `SELECT 1 FROM provider_dns_records WHERE zone_id = $1 AND state <> 'deleted' LIMIT 1`,
    [row.id],
  );
  if (records.rows.length > 0)
    throw new ComputeError('INVALID_STATE', `Zone ${row.zone} still holds records; delete them first`, undefined, {
      reason: 'zoneNotEmpty',
    });
  await tx.query(
    `UPDATE provider_dns_zones SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, workKind, row.id);
  await publish(deps, tx, 'providerDnsZone', row, 'deleting');
  return providerDnsZoneView((await readZone(tx, row.id))!);
}

// --- Records API -------------------------------------------------------------------------------

const recordHash = (input: CreateProviderDnsRecordInput) =>
  sha256Hex(canonical({ ...input, tenantId: undefined, idempotencyKey: undefined }));

async function openZone(tx: SqlTx, ref: ProviderDnsZoneRef): Promise<ZoneRow> {
  const zone = await requireZone(tx, ref, true);
  if (zone.desired_state === 'deleted' || zone.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Zone ${zone.zone} is being deleted`);
  return zone;
}

/**
 * `dnsRecords.create` (decided on the zone): records the record `pending` and wakes the reconciler. One that follows
 * an instance must name an instance of the tenant that is not being deleted (also decided as
 * `compute:instances:update` on it); its data is the instance's public address once it has one.
 */
export async function createProviderDnsRecord(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderDnsRecordInput,
): Promise<ProviderDnsRecordView> {
  const tx = context.sql;
  const identity = caller(context);
  const recordId = await draftId('pdr', input.tenantId, identity, input.idempotencyKey);
  const hash = await recordHash(input);
  const existing = await readRecord(tx, recordId, { tenantId: input.tenantId });
  const zone = await requireZone(tx, input);
  if (existing) {
    sameRequest(existing, hash);
    return providerDnsRecordView(existing, zone.zone);
  }
  await openZone(tx, input);
  if (input.instanceId !== undefined) {
    const { rows } = await tx.query<{ tenant_id: string; state: string; desired_state: string }>(
      `SELECT tenant_id, state, desired_state FROM instances WHERE id = $1 AND NOT draft`,
      [input.instanceId],
    );
    const instance = rows[0];
    if (!instance) throw new ComputeError('NOT_FOUND', `Instance ${input.instanceId} not found`);
    if (instance.tenant_id !== input.tenantId)
      throw new ComputeError('ACCESS_DENIED', `Instance ${input.instanceId} belongs to another tenant`);
    if (instance.desired_state === 'deleted' || ['deleting', 'deleted'].includes(instance.state))
      throw new ComputeError('INVALID_STATE', `Instance ${input.instanceId} is being deleted`);
  }
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM provider_dns_records WHERE zone_id = $1 AND state <> 'deleted'`,
    [zone.id],
  );
  if (Number(live.rows[0]?.count ?? 0) >= maxDnsRecordsPerZone)
    throw new ComputeError('QUOTA_EXCEEDED', `A zone holds at most ${maxDnsRecordsPerZone} records`);
  try {
    await tx.query(
      `INSERT INTO provider_dns_records (id, tenant_id, zone_id, name, type, data, instance_id, ttl_seconds, priority,
                                         port, weight, flags, tag, state, desired_state, created_by, idempotency_key,
                                         request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', 'present', $14, $15,
               decode($16, 'hex'), 1)`,
      [
        recordId,
        input.tenantId,
        zone.id,
        input.name,
        input.type,
        input.data ?? null,
        input.instanceId ?? null,
        input.ttlSeconds ?? null,
        input.priority ?? null,
        input.port ?? null,
        input.weight ?? null,
        input.flags ?? null,
        input.tag ?? null,
        identity,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `The zone already has this ${input.type} record for ${input.name}`);
    throw error;
  }
  await deps.work.enqueue(tx, workKind, recordId);
  await publish(deps, tx, 'providerDnsRecord', { id: recordId, tenant_id: input.tenantId }, 'created', {
    zoneId: zone.id,
    name: input.name,
    type: input.type,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
  });
  return providerDnsRecordView((await readRecord(tx, recordId))!, zone.zone);
}

export async function getProviderDnsRecord(tx: SqlTx, ref: ProviderDnsRecordRef): Promise<ProviderDnsRecordView> {
  const zone = await requireZone(tx, ref);
  return providerDnsRecordView(await requireRecord(tx, ref), zone.zone);
}

export async function listProviderDnsRecords(
  tx: SqlTx,
  input: ListProviderDnsRecordsInput,
): Promise<{ items: ProviderDnsRecordView[] }> {
  const zone = await requireZone(tx, input);
  const { rows } = await tx.query<RecordRow>(
    `SELECT ${recordColumns} FROM provider_dns_records
      WHERE zone_id = $1 AND tenant_id = $2 AND ($3 OR state <> 'deleted') ORDER BY created_at, id LIMIT 1000`,
    [zone.id, input.tenantId, input.includeDeleted === true],
  );
  return { items: rows.map((row) => providerDnsRecordView(row, zone.zone)) };
}

/** `dnsRecords.update`: changes data, TTL and the type's own fields in place (name and type never change). */
export async function updateProviderDnsRecord(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: UpdateProviderDnsRecordInput,
): Promise<ProviderDnsRecordView> {
  const zone = await openZone(tx, input);
  const row = await requireRecord(tx, input, true);
  if (row.desired_state === 'deleted')
    throw new ComputeError('INVALID_STATE', `DNS record ${row.id} is being deleted`);
  if (row.instance_id !== null && input.data !== undefined)
    throw new ComputeError('INVALID_INPUT', 'A record that follows an instance takes its data from the instance');
  let fields: DnsRecordFields;
  try {
    fields = recordFieldsOf(row.type, input as unknown as Record<string, unknown>, false);
  } catch (error) {
    throw new ComputeError('INVALID_INPUT', (error as Error).message);
  }
  try {
    await tx.query(
      `UPDATE provider_dns_records
          SET data = coalesce($2, data), ttl_seconds = coalesce($3, ttl_seconds), priority = coalesce($4, priority),
              port = coalesce($5, port), weight = coalesce($6, weight), flags = coalesce($7, flags),
              tag = coalesce($8, tag), state = CASE WHEN state = 'pending' THEN 'pending' ELSE 'updating' END,
              message = NULL, version = version + 1
        WHERE id = $1`,
      [
        row.id,
        fields.data ?? null,
        fields.ttlSeconds ?? null,
        fields.priority ?? null,
        fields.port ?? null,
        fields.weight ?? null,
        fields.flags ?? null,
        fields.tag ?? null,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `The zone already has this ${row.type} record for ${row.name}`);
    throw error;
  }
  await deps.work.enqueue(tx, workKind, row.id);
  await publish(deps, tx, 'providerDnsRecord', row, 'updated', { changed: Object.keys(fields) });
  return providerDnsRecordView((await readRecord(tx, row.id))!, zone.zone);
}

export async function deleteProviderDnsRecord(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderDnsRecordRef,
): Promise<ProviderDnsRecordView> {
  const zone = await requireZone(tx, input);
  const row = await requireRecord(tx, input, true);
  if (row.desired_state === 'deleted') return providerDnsRecordView(row, zone.zone);
  await markRecordDeleted(deps, tx, row);
  return providerDnsRecordView((await readRecord(tx, row.id))!, zone.zone);
}

async function markRecordDeleted(
  deps: Pick<ProviderResourceDeps, 'events' | 'work'>,
  tx: SqlTx,
  row: RecordRow,
  data: Record<string, string> = {},
): Promise<void> {
  await tx.query(
    `UPDATE provider_dns_records SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, workKind, row.id);
  await publish(deps, tx, 'providerDnsRecord', row, 'deleting', data);
}

/** Called when an instance's deletion finishes: the records that follow it are deleted. */
export async function onDnsInstanceGone(
  deps: Pick<ProviderResourceDeps, 'events' | 'work'>,
  tx: SqlTx,
  instanceId: string,
): Promise<void> {
  const { rows } = await tx.query<RecordRow>(
    `SELECT ${recordColumns} FROM provider_dns_records
      WHERE instance_id = $1 AND desired_state = 'present' AND state <> 'deleted' ORDER BY id FOR UPDATE`,
    [instanceId],
  );
  for (const row of rows) await markRecordDeleted(deps, tx, row, { instanceId });
}

// --- The reconciler ----------------------------------------------------------------------------

export async function reconcileDnsZone(run: Run, zoneId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const zone = await readZone(tx, zoneId);
    if (!zone) return undefined;
    return { zone, account: await readAccount(tx, zone.provider_account_id) };
  });
  if (!loaded || loaded.zone.state === 'deleted') return;
  const { zone } = loaded;
  const set = (fields: Fields) => writeZone(run, zone, fields);
  const dns = await run.client(loaded.account, zone.provider_account_id, 'dns');
  if (typeof dns === 'string') {
    await set(settled('error', dns));
    return;
  }
  if (zone.desired_state === 'deleted') {
    await teardownZone(run, dns, zone, set);
    return;
  }
  const ensured = await run.attempt(`ensure ${zone.id}`, () =>
    dns.ensureZone({ name: zone.zone, ...(zone.adopt ? { adopt: true } : {}) }, run.call(`ensure:${zone.id}`)),
  );
  if (ensured === undefined) return;
  if (ensured === 'missing' || ensured.state === 'error') {
    await set(settled('error', ensured === 'missing' ? 'The provider did not answer' : ensured.message));
    return;
  }
  await set({
    external_id: ensured.id || zone.zone,
    ...(output(ensured, 'nameServers') ? { name_servers: output(ensured, 'nameServers')! } : {}),
    ...settled('ready'),
  });
}

async function writeZone(run: Run, zone: ZoneRow, fields: Fields): Promise<void> {
  const state = fields.state as ProviderResourceStatus | undefined;
  const becameReady = state === 'ready' && zone.state !== 'ready';
  const becameError = state === 'error' && (zone.state !== 'error' || zone.message !== fields.message);
  await run.write(
    'provider_dns_zones',
    zone,
    { ...fields, ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
    async (tx) => {
      if (becameReady) {
        await publish(run.deps, tx, 'providerDnsZone', zone, 'ready');
        // Records waiting for their zone go on now.
        const waiting = await tx.query<{ id: string }>(
          `SELECT id FROM provider_dns_records WHERE zone_id = $1 AND state <> 'deleted' ORDER BY id`,
          [zone.id],
        );
        for (const row of waiting.rows) await run.deps.work.enqueue(tx, workKind, row.id);
      }
      if (becameError)
        await publish(run.deps, tx, 'providerDnsZone', zone, 'error', { message: String(fields.message ?? '') });
    },
  );
}

async function teardownZone(
  run: Run,
  dns: ProviderDns,
  zone: ZoneRow,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  const finish = () =>
    run.write('provider_dns_zones', zone, { state: 'deleted', message: null }, async (tx) => {
      await run.deps.authz.remove(tx, { type: 'provider-dns-zone', id: zone.id });
      await publish(run.deps, tx, 'providerDnsZone', zone, 'deleted');
    });
  // An adopted zone was the account's before: forgotten, never deleted at the provider.
  if (zone.adopt || !zone.external_id) {
    await finish();
    return;
  }
  const deleted = await run.attempt(`delete ${zone.id}`, () =>
    dns.deleteZone(zone.zone, run.call(`delete:${zone.id}`)),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finish();
    return;
  }
  if (deleted.state === 'error' && run.lastCode === 'INVALID_STATE' && run.lastReason === 'notManaged') {
    run.deps.log.warn('providerResources: the zone is not ours at the provider; not deleted', {
      zoneId: zone.id,
      providerAccountId: zone.provider_account_id,
    });
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

const privateV4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
/** The instance's public address of `family`: a reserved address assigned to it first, then its own. */
export function publicAddress(addresses: readonly string[], family: 4 | 6): string | undefined {
  return addresses.find((address) => {
    if (isIP(address) !== family) return false;
    if (family === 4) return !privateV4.some((pattern) => pattern.test(address));
    const lower = address.toLowerCase();
    return !(lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower));
  });
}

export async function reconcileDnsRecord(run: Run, recordId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const record = await readRecord(tx, recordId);
    if (!record) return undefined;
    const zone = (await readZone(tx, record.zone_id))!;
    let address: string | undefined;
    if (record.instance_id !== null && record.desired_state === 'present') {
      const family = record.type === 'AAAA' ? 6 : 4;
      const reserved = await tx.query<{ address: string }>(
        `SELECT address FROM provider_addresses
          WHERE instance_id = $1 AND assignment_state = 'ready' AND address IS NOT NULL AND family = $2
          ORDER BY id LIMIT 1`,
        [record.instance_id, family === 6 ? 'ipv6' : 'ipv4'],
      );
      const instance = await tx.query<{ addresses: string[] | null; state: string }>(
        `SELECT addresses, state FROM instances WHERE id = $1`,
        [record.instance_id],
      );
      address = reserved.rows[0]?.address ?? publicAddress(instance.rows[0]?.addresses ?? [], family);
    }
    return { record, zone, address, account: await readAccount(tx, zone.provider_account_id) };
  });
  if (!loaded || loaded.record.state === 'deleted') return;
  const { record, zone } = loaded;
  const set = async (fields: Fields) => {
    const state = fields.state as ProviderResourceStatus | undefined;
    const becameReady = state === 'ready' && record.state !== 'ready';
    const becameError = state === 'error' && (record.state !== 'error' || record.message !== fields.message);
    await run.write(
      'provider_dns_records',
      record,
      { ...fields, ...(becameReady ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
      async (tx) => {
        if (becameReady) await publish(run.deps, tx, 'providerDnsRecord', record, 'ready');
        if (becameError)
          await publish(run.deps, tx, 'providerDnsRecord', record, 'error', { message: String(fields.message ?? '') });
      },
    );
  };
  const dns = await run.client(loaded.account, zone.provider_account_id, 'dns');
  if (typeof dns === 'string') {
    await set(settled('error', dns));
    return;
  }
  const expected = { name: record.name, type: record.type };
  if (record.desired_state === 'deleted') {
    const finish = () =>
      run.write('provider_dns_records', record, { state: 'deleted', message: null }, (tx) =>
        publish(run.deps, tx, 'providerDnsRecord', record, 'deleted'),
      );
    if (!record.external_id) {
      await finish();
      return;
    }
    const deleted = await run.attempt(`delete ${record.id}`, () =>
      dns.deleteRecord(zone.zone, record.external_id!, run.call(`delete:${record.id}`), expected),
    );
    if (deleted === undefined) return;
    if (deleted === 'missing' || deleted.state === 'deleted') await finish();
    else if (deleted.state === 'error' && run.lastCode === 'INVALID_STATE') {
      // The id now names another record (ours was removed out of band): that one is never deleted.
      run.deps.log.warn('providerResources: the DNS record at this id is not ours; not deleted', {
        recordId: record.id,
      });
      await finish();
    } else await set(settled('error', deleted.message));
    return;
  }
  if (zone.state !== 'ready' || zone.desired_state !== 'present') {
    // Its zone is not there yet (it wakes its records once ready) or is going away.
    await set(settled('pending', zone.state === 'error' ? 'The zone is in error' : 'Waiting for the zone'));
    return;
  }
  const data = record.instance_id !== null ? loaded.address : (record.data ?? undefined);
  if (data === undefined) {
    // An instance without a public address yet: the periodic pass looks again.
    await set(settled('pending', 'Waiting for the instance to have a public address'));
    return;
  }
  const spec: ProviderDnsRecordSpec = {
    name: record.name,
    type: record.type,
    data,
    ...(record.ttl_seconds !== null ? { ttlSeconds: Number(record.ttl_seconds) } : {}),
    ...(record.priority !== null ? { priority: Number(record.priority) } : {}),
    ...(record.port !== null ? { port: Number(record.port) } : {}),
    ...(record.weight !== null ? { weight: Number(record.weight) } : {}),
    ...(record.flags !== null ? { flags: Number(record.flags) } : {}),
    ...(record.tag !== null ? { tag: record.tag } : {}),
    ...(record.external_id ? { id: record.external_id } : {}),
  };
  const ensured = await run.attempt(`ensure ${record.id}`, () =>
    dns.ensureRecord(zone.zone, spec, run.call(`ensure:${record.id}:${record.version}`)),
  );
  if (ensured === undefined) return;
  if (ensured === 'missing' || ensured.state === 'error' || !ensured.id) {
    await set(settled('error', ensured === 'missing' ? 'The provider did not answer' : (ensured.message ?? 'No record id')));
    return;
  }
  await set({
    external_id: ensured.id,
    ...(record.instance_id !== null && data !== record.data ? { data } : {}),
    ...settled('ready'),
  });
}

/** Live zones and records that are not settled (a record that follows an instance is re-read by the drift pass). */
export const unsettledDnsSql = `
  SELECT id FROM provider_dns_zones WHERE state <> 'deleted' AND (state <> 'ready' OR desired_state <> 'present')
  UNION ALL SELECT id FROM provider_dns_records
   WHERE state <> 'deleted' AND (state <> 'ready' OR desired_state <> 'present')`;
export const liveDnsSql = `SELECT id FROM provider_dns_zones WHERE state <> 'deleted'
  UNION ALL SELECT id FROM provider_dns_records WHERE state <> 'deleted'`;
