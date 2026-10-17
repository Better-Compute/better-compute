import { createHash } from 'node:crypto';
import {
  ComputeError,
  draftId,
  newId,
  strictObject,
  type AdmissionPlan,
  type Clock,
  type EventPublisher,
  type InputSchema,
  type Json,
  type Logger,
  type MethodContext,
  type Migration,
  type ModuleContext,
  type ProviderImpl,
  type SecretResolver,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderClients } from './accounts.js';
import { visibleVpsPool } from './instances.js';
import { canonical, fail, id, key, object, optional, sha256Hex, tenant } from './input.js';

// Tenant networks (v1.0): a VPC on a provider account, its subnets and its firewall rules. The API
// records what the tenant wants (`desired_state`); the `vps.networks` reconciler (below) converges
// the provider through `ProviderImpl.networks` and writes back `state`. Provider calls never run in
// a transaction.

/** The work kind (key: network id, or `all` for the periodic sweep) of the networks reconciler. */
export const networksWork = 'vps.networks';

/** At most this many firewall rules (not deleted) per network. */
export const maxRulesPerNetwork = 100;

export const vpsNetworksMigration: Migration = {
  name: 'vps/0026_networks',
  sql: `
CREATE TABLE networks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  description text,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX networks_live ON networks (state) WHERE state <> 'deleted';

CREATE TABLE network_subnets (
  id text PRIMARY KEY,
  network_id text NOT NULL REFERENCES networks,
  name text NOT NULL,
  region text NOT NULL,
  cidr cidr NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  UNIQUE (network_id, name),
  -- The database refuses overlapping subnets in one network.
  EXCLUDE USING gist (network_id WITH =, cidr inet_ops WITH &&) WHERE (desired_state = 'present')
);

CREATE TABLE network_firewall_rules (
  id text PRIMARY KEY,
  network_id text NOT NULL REFERENCES networks,
  name text NOT NULL,
  spec jsonb NOT NULL,
  enabled bool NOT NULL DEFAULT true,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  version bigint NOT NULL,
  UNIQUE (network_id, name)
);

ALTER TABLE instances ADD COLUMN network_id text REFERENCES networks;
ALTER TABLE instances ADD COLUMN subnet_id text REFERENCES network_subnets;
CREATE INDEX instances_network ON instances (network_id) WHERE network_id IS NOT NULL AND state <> 'deleted';
`,
};

// --- Provider names ----------------------------------------------------------------------------

/**
 * The network tag a machine carries (`bc-` and 16 hex digits of the sha256 of its instance id): a
 * firewall rule that targets an instance targets this tag. Tags are lower-case `[a-z0-9-]`, at most
 * 63 characters, so a GCE tag is valid as is.
 */
export function networkTag(instanceId: string): string {
  return `bc-${createHash('sha256').update(instanceId).digest('hex').slice(0, 16)}`;
}

/**
 * The provider-side name of a network, subnet or firewall rule: `bc-` and the id, lower-cased with
 * anything outside `[a-z0-9-]` replaced by `-`, at most 63 characters. Ids are unique, so names are.
 */
export function providerResourceName(resourceId: string): string {
  return `bc-${resourceId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 60)}`;
}

// --- Views and input ---------------------------------------------------------------------------

export type NetworkState = 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';

export interface NetworkView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  name: string;
  description?: string;
  state: NetworkState;
  message?: string;
  subnets: { id: string; name: string; region: string; cidr: string; state: NetworkState }[];
  version: number;
  createdAt: number;
}

export interface FirewallRuleView {
  id: string;
  networkId: string;
  name: string;
  direction: 'ingress' | 'egress';
  action: 'allow' | 'deny';
  /** 0..65535; lower wins. Default 1000. */
  priority: number;
  /** `ports` like "22" or "8000-8100"; only for tcp and udp. */
  rules: { protocol: 'tcp' | 'udp' | 'icmp' | 'all'; ports?: string[] }[];
  /** CIDRs. An ingress rule names its sources; an egress rule without destinations covers every one. */
  sources?: string[];
  destinations?: string[];
  /** Empty: every instance on the network. */
  targets: { instanceIds?: string[] };
  enabled: boolean;
  state: NetworkState;
  message?: string;
  version: number;
}

export interface CreateNetworkInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  description?: string;
  idempotencyKey: string;
}
export type NetworkRef = { tenantId: string; networkId: string };
export interface ListNetworksInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}
export interface UpdateNetworkInput extends NetworkRef {
  description?: string;
}
export interface AddSubnetInput extends NetworkRef {
  name: string;
  region: string;
  cidr: string;
}
export interface RemoveSubnetInput extends NetworkRef {
  subnetId: string;
}

type RuleFields = Pick<
  FirewallRuleView,
  'direction' | 'action' | 'priority' | 'rules' | 'sources' | 'destinations' | 'targets' | 'enabled'
>;
export interface CreateRuleInput extends NetworkRef, RuleFields {
  name: string;
}
export interface UpdateRuleInput extends NetworkRef, Partial<RuleFields> {
  ruleId: string;
}
export interface RuleRef extends NetworkRef {
  ruleId: string;
}

const resourceName = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
const regionName = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const protocols = ['tcp', 'udp', 'icmp', 'all'] as const;
const maxTargets = 64;
const maxRuleEntries = 20;
const maxPortsPerEntry = 50;
const maxRanges = 256;

function networkName(value: unknown, what = 'name'): string {
  if (typeof value !== 'string' || !resourceName.test(value))
    fail(
      `${what} must be 1-42 lower-case letters, digits or '-', start with a letter and not end with '-'`,
    );
  return value;
}

/** `a.b.c.d/n` as a number and a prefix; the host bits must be zero. */
function ipv4Cidr(value: unknown, what: string): { address: number; prefix: number } {
  const match =
    typeof value === 'string'
      ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value)
      : null;
  if (!match) return fail(`${what} must be an IPv4 CIDR such as 10.0.0.0/24`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32)
    return fail(`${what} must be an IPv4 CIDR such as 10.0.0.0/24`);
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  if ((address & ~mask) >>> 0 !== 0)
    return fail(`${what} has host bits set: write it as its network address`);
  return { address, prefix };
}

const privateBlocks = [
  { address: (10 << 24) >>> 0, prefix: 8 },
  { address: ((172 << 24) | (16 << 16)) >>> 0, prefix: 12 },
  { address: ((192 << 24) | (168 << 16)) >>> 0, prefix: 16 },
];

/** A subnet range: inside 10/8, 172.16/12 or 192.168/16 (RFC 1918), from /8 to /29. */
export function subnetCidr(value: unknown): string {
  const { address, prefix } = ipv4Cidr(value, 'cidr');
  if (prefix < 8 || prefix > 29) fail('cidr must have a prefix from /8 to /29');
  const private1918 = privateBlocks.some(
    (block) =>
      prefix >= block.prefix &&
      (address & ((~0 << (32 - block.prefix)) >>> 0)) >>> 0 === block.address,
  );
  if (!private1918)
    fail('cidr must be a private (RFC 1918) range: 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16');
  return value as string;
}

function rangeList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > maxRanges)
    return fail(`${what} must list at most ${maxRanges} CIDRs`);
  return value.map((entry, index) => {
    ipv4Cidr(entry, `${what}[${index}]`);
    return entry as string;
  });
}

function portList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > maxPortsPerEntry)
    return fail(`${what} must list at most ${maxPortsPerEntry} ports or ranges`);
  return value.map((entry, index) => {
    const match = typeof entry === 'string' ? /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(entry) : null;
    if (!match) return fail(`${what}[${index}] must be a port ("22") or a range ("8000-8100")`);
    const low = Number(match[1]);
    const high = match[2] === undefined ? low : Number(match[2]);
    if (low > 65_535 || high > 65_535 || low > high)
      return fail(`${what}[${index}] is not a valid port range`);
    return entry as string;
  });
}

function ruleEntries(value: unknown): RuleFields['rules'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRuleEntries)
    return fail(`rules must list 1 to ${maxRuleEntries} protocols`);
  return value.map((entry, index) => {
    const item = object(entry, ['protocol', 'ports']);
    if (
      typeof item.protocol !== 'string' ||
      !(protocols as readonly string[]).includes(item.protocol)
    )
      return fail(`rules[${index}].protocol must be one of ${protocols.join(', ')}`);
    const out: RuleFields['rules'][number] = {
      protocol: item.protocol as RuleFields['rules'][number]['protocol'],
    };
    if (item.ports !== undefined) {
      if (out.protocol !== 'tcp' && out.protocol !== 'udp')
        return fail(`rules[${index}].ports apply to tcp and udp only`);
      const ports = portList(item.ports, `rules[${index}].ports`);
      if (ports.length > 0) out.ports = ports;
    }
    return out;
  });
}

function targetList(value: unknown): RuleFields['targets'] {
  const item = object(value, ['instanceIds']);
  if (item.instanceIds === undefined) return {};
  if (!Array.isArray(item.instanceIds) || item.instanceIds.length > maxTargets)
    return fail(`targets.instanceIds must list at most ${maxTargets} instances`);
  const ids = [
    ...new Set(
      item.instanceIds.map((entry, index) => id(entry, 'inst', `targets.instanceIds[${index}]`)),
    ),
  ];
  return ids.length > 0 ? { instanceIds: ids } : {};
}

export function parseCreateNetwork(raw: unknown): CreateNetworkInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'description',
    'idempotencyKey',
  ]);
  const out: CreateNetworkInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: networkName(input.name),
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  const description = optional(input.description, description_);
  if (description !== undefined) out.description = description;
  return out;
}

function description_(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value))
    return fail('description must be text of at most 256 characters');
  return value;
}

export function parseNetworkRef(raw: unknown): NetworkRef {
  const input = object(raw, ['tenantId', 'networkId']);
  return { tenantId: tenant(input.tenantId), networkId: id(input.networkId, 'net', 'networkId') };
}

export function parseListNetworks(raw: unknown): ListNetworksInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListNetworksInput = { tenantId: tenant(input.tenantId) };
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) out.poolId = poolId;
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.includeDeleted !== undefined) {
    if (typeof input.includeDeleted !== 'boolean') fail('includeDeleted must be true or false');
    out.includeDeleted = input.includeDeleted as boolean;
  }
  return out;
}

export function parseUpdateNetwork(raw: unknown): UpdateNetworkInput {
  const input = object(raw, ['tenantId', 'networkId', 'description']);
  const out: UpdateNetworkInput = {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
  };
  if (input.description !== undefined) out.description = description_(input.description);
  else fail('Name what to change: description');
  return out;
}

export function parseAddSubnet(raw: unknown): AddSubnetInput {
  const input = object(raw, ['tenantId', 'networkId', 'name', 'region', 'cidr']);
  if (typeof input.region !== 'string' || !regionName.test(input.region)) fail('region is invalid');
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    name: networkName(input.name),
    region: input.region as string,
    cidr: subnetCidr(input.cidr),
  };
}

export function parseRemoveSubnet(raw: unknown): RemoveSubnetInput {
  const input = object(raw, ['tenantId', 'networkId', 'subnetId']);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    subnetId: id(input.subnetId, 'snet', 'subnetId'),
  };
}

const ruleFieldNames = [
  'direction',
  'action',
  'priority',
  'rules',
  'sources',
  'destinations',
  'targets',
  'enabled',
];

/** The rule fields present in `input`, parsed; the cross-field rules are checked by `finishRule`. */
function ruleFields(input: Record<string, unknown>): Partial<RuleFields> {
  const out: Partial<RuleFields> = {};
  if (input.direction !== undefined) {
    if (input.direction !== 'ingress' && input.direction !== 'egress')
      fail('direction must be ingress or egress');
    out.direction = input.direction;
  }
  if (input.action !== undefined) {
    if (input.action !== 'allow' && input.action !== 'deny') fail('action must be allow or deny');
    out.action = input.action;
  }
  if (input.priority !== undefined) {
    if (
      typeof input.priority !== 'number' ||
      !Number.isSafeInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 65_535
    )
      fail('priority must be an integer from 0 to 65535');
    out.priority = input.priority;
  }
  if (input.rules !== undefined) out.rules = ruleEntries(input.rules);
  if (input.sources !== undefined) out.sources = rangeList(input.sources, 'sources');
  if (input.destinations !== undefined)
    out.destinations = rangeList(input.destinations, 'destinations');
  if (input.targets !== undefined) out.targets = targetList(input.targets);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') fail('enabled must be true or false');
    out.enabled = input.enabled as boolean;
  }
  return out;
}

/**
 * Completes and checks a rule: defaults (`allow`, priority 1000, enabled), empty range lists dropped,
 * and the cross-field rules. An ingress rule must name its `sources` (nothing is defaulted to the whole
 * internet) and takes no `destinations`; an egress rule takes no `sources`.
 */
function finishRule(fields: Partial<RuleFields>): RuleFields {
  if (fields.direction === undefined) fail('direction is required');
  if (fields.rules === undefined) fail('rules is required');
  const rule: RuleFields = {
    direction: fields.direction!,
    action: fields.action ?? 'allow',
    priority: fields.priority ?? 1000,
    rules: fields.rules!,
    targets: fields.targets ?? {},
    enabled: fields.enabled ?? true,
  };
  const sources = fields.sources ?? [];
  const destinations = fields.destinations ?? [];
  if (rule.direction === 'ingress') {
    if (destinations.length > 0) fail('An ingress rule takes sources, not destinations');
    if (sources.length === 0)
      fail('An ingress rule must name its sources (use 0.0.0.0/0 for everywhere)');
    rule.sources = sources;
  } else {
    if (sources.length > 0) fail('An egress rule takes destinations, not sources');
    if (destinations.length > 0) rule.destinations = destinations;
  }
  return rule;
}

export function parseCreateRule(raw: unknown): CreateRuleInput {
  const input = object(raw, ['tenantId', 'networkId', 'name', ...ruleFieldNames]);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    name: networkName(input.name),
    ...finishRule(ruleFields(input)),
  };
}

export function parseUpdateRule(raw: unknown): UpdateRuleInput {
  const input = object(raw, ['tenantId', 'networkId', 'ruleId', ...ruleFieldNames]);
  const fields = ruleFields(input);
  if (Object.keys(fields).length === 0) fail(`Name what to change: ${ruleFieldNames.join(', ')}`);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    ruleId: id(input.ruleId, 'fwr', 'ruleId'),
    ...fields,
  };
}

export function parseRuleRef(raw: unknown): RuleRef {
  const input = object(raw, ['tenantId', 'networkId', 'ruleId']);
  return {
    tenantId: tenant(input.tenantId),
    networkId: id(input.networkId, 'net', 'networkId'),
    ruleId: id(input.ruleId, 'fwr', 'ruleId'),
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
const networkIdSchema = idOf('net', 'The network');
const nameSchema = (description: string): InputSchema => ({
  type: 'string',
  pattern: resourceName.source,
  maxLength: 42,
  description,
});
const cidrList = (description: string): InputSchema => ({
  type: 'array',
  maxItems: maxRanges,
  items: { type: 'string', description: 'An IPv4 CIDR, e.g. 10.0.0.0/24' },
  description,
});
const ruleProperties: Record<string, InputSchema> = {
  direction: { enum: ['ingress', 'egress'], description: 'The traffic the rule covers' },
  action: { enum: ['allow', 'deny'], default: 'allow', description: 'Allow or deny the traffic' },
  priority: {
    type: 'integer',
    minimum: 0,
    maximum: 65_535,
    default: 1000,
    description: 'Lower numbers win',
  },
  rules: {
    type: 'array',
    minItems: 1,
    maxItems: maxRuleEntries,
    description: 'The protocols (and for tcp and udp the ports) the rule covers',
    items: strictObject(
      {
        protocol: { enum: [...protocols], description: 'The protocol' },
        ports: {
          type: 'array',
          maxItems: maxPortsPerEntry,
          items: { type: 'string', description: 'A port ("22") or a range ("8000-8100")' },
          description: 'Ports, for tcp and udp; absent: every port',
        },
      },
      ['protocol'],
    ),
  },
  sources: cidrList('Ingress: the CIDRs the traffic comes from (required for ingress)'),
  destinations: cidrList('Egress: the CIDRs the traffic goes to (absent: everywhere)'),
  targets: strictObject(
    {
      instanceIds: {
        type: 'array',
        maxItems: maxTargets,
        items: idOf('inst', 'An instance on the network'),
        description: 'The instances the rule applies to; empty: every instance on the network',
      },
    },
    [],
  ),
  enabled: {
    type: 'boolean',
    default: true,
    description: 'A disabled rule exists but matches nothing',
  },
};

export const networkSchemas = {
  tenant: strictObject({ tenantId: tenantIdSchema }, ['tenantId']),
  createNetwork: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the network belongs to'),
      poolId: idOf(
        'pool',
        'A provider pool offered to the tenant, whose account provides networks',
      ),
      name: nameSchema('The network name, unique in the tenant, e.g. training'),
      description: { type: 'string', maxLength: 256, description: 'What the network is for' },
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
      },
    },
    ['tenantId', 'poolId', 'name', 'idempotencyKey'],
  ),
  listNetworks: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf('pool', 'Only this pool’s networks'),
      projectId: idOf('prj', 'Only this project’s networks'),
      includeDeleted: { type: 'boolean', default: false, description: 'Include deleted networks' },
    },
    ['tenantId'],
  ),
  network: strictObject({ tenantId: tenantIdSchema, networkId: networkIdSchema }, [
    'tenantId',
    'networkId',
  ]),
  updateNetwork: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      description: { type: 'string', maxLength: 256, description: 'The new description' },
    },
    ['tenantId', 'networkId', 'description'],
  ),
  addSubnet: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      name: nameSchema('The subnet name, unique in the network'),
      region: {
        type: 'string',
        pattern: regionName.source,
        description: 'A region of the account’s configured zones',
      },
      cidr: {
        type: 'string',
        description:
          'A private (RFC 1918) IPv4 range from /8 to /29 that overlaps no other subnet of the network',
      },
    },
    ['tenantId', 'networkId', 'name', 'region', 'cidr'],
  ),
  removeSubnet: strictObject(
    { tenantId: tenantIdSchema, networkId: networkIdSchema, subnetId: idOf('snet', 'The subnet') },
    ['tenantId', 'networkId', 'subnetId'],
  ),
  createRule: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      name: nameSchema('The rule name, unique in the network'),
      ...ruleProperties,
    },
    ['tenantId', 'networkId', 'name', 'direction', 'rules'],
  ),
  rule: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      ruleId: idOf('fwr', 'The firewall rule'),
    },
    ['tenantId', 'networkId', 'ruleId'],
  ),
  updateRule: strictObject(
    {
      tenantId: tenantIdSchema,
      networkId: networkIdSchema,
      ruleId: idOf('fwr', 'The firewall rule'),
      ...ruleProperties,
    },
    ['tenantId', 'networkId', 'ruleId'],
  ),
} satisfies Record<string, InputSchema>;

// --- Rows --------------------------------------------------------------------------------------

interface NetworkRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  name: string;
  description: string | null;
  state: NetworkState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  request_hash: string;
  version: string | number;
  created_at: Date | string;
}
interface SubnetRow {
  id: string;
  network_id: string;
  name: string;
  region: string;
  cidr: string;
  state: NetworkState;
  desired_state: 'present' | 'deleted';
  message: string | null;
}
interface RuleRow {
  id: string;
  network_id: string;
  name: string;
  spec: RuleSpec | string;
  enabled: boolean;
  state: NetworkState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  version: string | number;
}
/** What is stored in `network_firewall_rules.spec`. */
type RuleSpec = Omit<RuleFields, 'enabled'>;

const networkColumns = `id, tenant_id, project_id, pool_id, provider_account_id, name, description, state,
  desired_state, message, encode(request_hash, 'hex') AS request_hash, version, created_at`;
const subnetColumns = `id, network_id, name, region, cidr::text AS cidr, state, desired_state, message`;
const ruleColumns = `id, network_id, name, spec, enabled, state, desired_state, message, version`;

export function networkView(row: NetworkRow, subnets: readonly SubnetRow[]): NetworkView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    subnets: subnets
      .filter((subnet) => subnet.state !== 'deleted')
      .map((subnet) => ({
        id: subnet.id,
        name: subnet.name,
        region: subnet.region,
        cidr: subnet.cidr,
        state: subnet.state,
      })),
    version: Number(row.version),
    createdAt: new Date(row.created_at).getTime(),
  };
}

const specOf = (row: RuleRow): RuleSpec =>
  typeof row.spec === 'string' ? (JSON.parse(row.spec) as RuleSpec) : row.spec;

export function ruleView(row: RuleRow): FirewallRuleView {
  const spec = specOf(row);
  return {
    id: row.id,
    networkId: row.network_id,
    name: row.name,
    direction: spec.direction,
    action: spec.action,
    priority: spec.priority,
    rules: spec.rules,
    ...(spec.sources ? { sources: spec.sources } : {}),
    ...(spec.destinations ? { destinations: spec.destinations } : {}),
    targets: spec.targets ?? {},
    enabled: row.enabled,
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    version: Number(row.version),
  };
}

async function readNetwork(
  tx: SqlTx,
  ref: { networkId: string; tenantId?: string },
  options: { lock?: boolean } = {},
): Promise<NetworkRow | undefined> {
  const { rows } = await tx.query<NetworkRow>(
    `SELECT ${networkColumns} FROM networks WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [ref.networkId, ref.tenantId ?? null],
  );
  return rows[0];
}

async function requireNetwork(
  tx: SqlTx,
  ref: NetworkRef,
  options: { lock?: boolean } = {},
): Promise<NetworkRow> {
  const row = await readNetwork(tx, ref, options);
  if (!row) throw new ComputeError('NOT_FOUND', `Network ${ref.networkId} not found`);
  return row;
}

async function readSubnets(tx: SqlTx, networkIds: readonly string[]): Promise<SubnetRow[]> {
  if (networkIds.length === 0) return [];
  const { rows } = await tx.query<SubnetRow>(
    `SELECT ${subnetColumns} FROM network_subnets WHERE network_id = ANY($1::text[]) ORDER BY network_id, name`,
    [networkIds],
  );
  return rows;
}

async function viewOf(tx: SqlTx, networkId: string): Promise<NetworkView> {
  const row = (await readNetwork(tx, { networkId }))!;
  return networkView(row, await readSubnets(tx, [networkId]));
}

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
const uniqueViolation = (error: unknown) => code(error) === '23505';
const exclusionViolation = (error: unknown) => code(error) === '23P01';

// --- Dependencies ------------------------------------------------------------------------------

/** What the network handlers and the reconciler need beyond a transaction. */
export interface NetworkDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  authz: ModuleContext['authz'];
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
}

async function publish(
  deps: Pick<NetworkDeps, 'events'>,
  tx: SqlTx,
  row: { id: string; tenant_id: string },
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenant_id,
    subject: `network/${row.id}`,
    data: { networkId: row.id, ...data },
  });
}

/** The pool's account and its client when the provider implements `networks`; otherwise UNSUPPORTED. */
async function networkProvider(
  deps: NetworkDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<{ accountId: string; zones: string[]; client: ProviderImpl }> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  if (pool.class !== 'provider' || pool.providerAccountId === undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `Pool ${poolId} is not a provider pool; networks live on provider accounts`,
    );
  const account = await readAccount(tx, pool.providerAccountId);
  if (!account) throw new ComputeError('UNSUPPORTED', `Pool ${poolId} has no provider account`);
  const client = await deps.clients.client(account, deps);
  if (typeof client.networks !== 'object' || client.networks === null)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} does not provide tenant networks`,
    );
  const zones = Array.isArray(account.config.zones)
    ? account.config.zones.filter((zone): zone is string => typeof zone === 'string')
    : [];
  return { accountId: account.id, zones, client };
}

/** A GCE zone's region: `us-central1-a` is in `us-central1`. */
export function zoneRegion(zone: string): string {
  return zone.replace(/-[a-z]$/, '');
}

const requestHash = (input: CreateNetworkInput) =>
  sha256Hex(
    canonical({
      poolId: input.poolId,
      projectId: input.projectId,
      name: input.name,
      description: input.description,
    }),
  );

// --- API ---------------------------------------------------------------------------------------

/**
 * `networks.create` transaction 1: the idempotency lookup, the pool and provider checks, and the
 * authz projection row the decision reads. The decision is on the network itself, `network/<id>`
 * (the id derives from tenant, caller and key). A key already used replays.
 */
export async function prepareCreateNetwork(
  deps: NetworkDeps,
  context: MethodContext,
  input: CreateNetworkInput,
  tx: SqlTx,
): Promise<AdmissionPlan<NetworkView>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const networkId = await draftId('net', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readNetwork(tx, { networkId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== (await requestHash(input)))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return { status: 'replay', result: await viewOf(tx, networkId) };
  }
  // Refusals come before anything is staged, so a refused request leaves no projection row behind.
  const { accountId } = await networkProvider(deps, tx, input.tenantId, input.poolId);
  await assertNameFree(tx, input.tenantId, input.name);
  await context.authz.upsert(tx, {
    type: 'network',
    id: networkId,
    tenantId: input.tenantId,
    attributes: {
      providerAccountId: accountId,
      poolId: input.poolId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    },
    parentType: 'tenant',
    parentId: input.tenantId,
    ownerId: caller.identityId,
  });
  return { status: 'decide', resource: { type: 'network', id: networkId } };
}

async function assertNameFree(tx: SqlTx, tenantId: string, name: string): Promise<void> {
  const taken = await tx.query(`SELECT 1 FROM networks WHERE tenant_id = $1 AND name = $2`, [
    tenantId,
    name,
  ]);
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `Network ${name} already exists`);
}

/** `networks.create` refused or abandoned: the projection row staged for a network never created goes. */
export async function clearStagedNetwork(
  context: MethodContext,
  input: CreateNetworkInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const networkId = await draftId(
    'net',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readNetwork(tx, { networkId })))
    await context.authz.remove(tx, { type: 'network', id: networkId, tenantId: input.tenantId });
}

/**
 * `networks.create` (in the method's transaction): records the network `pending` and wakes the
 * reconciler. A retry with the same key returns the network; another request under the key is CONFLICT.
 */
export async function createNetwork(
  deps: NetworkDeps,
  context: MethodContext,
  input: CreateNetworkInput,
): Promise<NetworkView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const networkId = await draftId('net', input.tenantId, caller.identityId, input.idempotencyKey);
  const hash = await requestHash(input);
  const existing = await readNetwork(tx, { networkId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return viewOf(tx, networkId);
  }
  const { accountId } = await networkProvider(deps, tx, input.tenantId, input.poolId);
  await assertNameFree(tx, input.tenantId, input.name);
  try {
    await tx.query(
      `INSERT INTO networks (id, tenant_id, project_id, pool_id, provider_account_id, name, description,
                             state, desired_state, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'present', $8, decode($9, 'hex'), 1)`,
      [
        networkId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        accountId,
        input.name,
        input.description ?? null,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Network ${input.name} already exists`);
    throw error;
  }
  await deps.authz.upsert(tx, {
    type: 'network',
    id: networkId,
    tenantId: input.tenantId,
    attributes: {
      providerAccountId: accountId,
      poolId: input.poolId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    },
    parentType: 'tenant',
    parentId: input.tenantId,
    ownerId: caller.identityId,
  });
  await deps.work.enqueue(tx, networksWork, networkId);
  await publish(deps, tx, { id: networkId, tenant_id: input.tenantId }, 'network.created', {
    poolId: input.poolId,
    providerAccountId: accountId,
    name: input.name,
  });
  return viewOf(tx, networkId);
}

export async function getNetwork(tx: SqlTx, ref: NetworkRef): Promise<NetworkView> {
  const row = await requireNetwork(tx, ref);
  return networkView(row, await readSubnets(tx, [row.id]));
}

export async function listNetworks(
  tx: SqlTx,
  input: ListNetworksInput,
): Promise<{ items: NetworkView[] }> {
  const { rows } = await tx.query<NetworkRow>(
    `SELECT ${networkColumns} FROM networks
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 500`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  const subnets = await readSubnets(
    tx,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) =>
      networkView(
        row,
        subnets.filter((subnet) => subnet.network_id === row.id),
      ),
    ),
  };
}

/** `networks.update`: the description (names and placement never change; the provider cannot rename). */
export async function updateNetwork(tx: SqlTx, input: UpdateNetworkInput): Promise<NetworkView> {
  const row = await requireNetwork(tx, input, { lock: true });
  if (row.desired_state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Network ${row.id} is being deleted`);
  await tx.query(`UPDATE networks SET description = $2, version = version + 1 WHERE id = $1`, [
    row.id,
    input.description ?? null,
  ]);
  return viewOf(tx, row.id);
}

/** A live network accepting changes: locked, and not being deleted. */
async function openNetwork(tx: SqlTx, ref: NetworkRef): Promise<NetworkRow> {
  const row = await requireNetwork(tx, ref, { lock: true });
  if (row.desired_state === 'deleted' || row.state === 'deleting' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Network ${row.id} is being deleted`);
  return row;
}

/** A network that was ready and changes again converges (and announces `network.ready`) again. */
async function reopen(
  tx: SqlTx,
  deps: Pick<NetworkDeps, 'work'>,
  networkId: string,
): Promise<void> {
  await tx.query(
    `UPDATE networks SET version = version + 1, state = CASE WHEN state IN ('ready', 'error') THEN 'pending' ELSE state END,
            message = CASE WHEN state IN ('ready', 'error') THEN NULL ELSE message END
      WHERE id = $1`,
    [networkId],
  );
  await deps.work.enqueue(tx, networksWork, networkId);
}

/**
 * `networks.addSubnet`: the range must be private (RFC 1918, /8 to /29), in a region of the account's
 * zones, and overlap no other subnet of the network (CONFLICT: also enforced by the database).
 */
export async function addSubnet(
  deps: NetworkDeps,
  tx: SqlTx,
  input: AddSubnetInput,
): Promise<NetworkView> {
  const network = await openNetwork(tx, input);
  const { zones } = await networkProvider(deps, tx, network.tenant_id, network.pool_id);
  const regions = [...new Set(zones.map(zoneRegion))];
  if (regions.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${network.provider_account_id} configures no zones, so no subnet region is allowed`,
    );
  if (!regions.includes(input.region))
    throw new ComputeError(
      'INVALID_INPUT',
      `region ${input.region} is not one of the account's regions`,
      undefined,
      { regions },
    );
  const overlap = await tx.query<{ name: string; cidr: string }>(
    `SELECT name, cidr::text AS cidr FROM network_subnets
      WHERE network_id = $1 AND desired_state = 'present' AND cidr && $2::cidr`,
    [network.id, input.cidr],
  );
  if (overlap.rows[0])
    throw new ComputeError(
      'CONFLICT',
      `cidr ${input.cidr} overlaps subnet ${overlap.rows[0].name} (${overlap.rows[0].cidr})`,
    );
  const same = await tx.query<SubnetRow>(
    `SELECT ${subnetColumns} FROM network_subnets WHERE network_id = $1 AND name = $2`,
    [network.id, input.name],
  );
  const previous = same.rows[0];
  if (previous && previous.state !== 'deleted')
    throw new ComputeError('CONFLICT', `Subnet ${input.name} already exists`);
  try {
    if (previous)
      // A deleted subnet's name is free again: the row is revived (its provider resource is gone).
      await tx.query(
        `UPDATE network_subnets SET region = $2, cidr = $3::cidr, state = 'pending', desired_state = 'present', message = NULL
          WHERE id = $1`,
        [previous.id, input.region, input.cidr],
      );
    else
      await tx.query(
        `INSERT INTO network_subnets (id, network_id, name, region, cidr, state, desired_state)
         VALUES ($1, $2, $3, $4, $5::cidr, 'pending', 'present')`,
        [newId('snet'), network.id, input.name, input.region, input.cidr],
      );
  } catch (error) {
    if (exclusionViolation(error))
      throw new ComputeError(
        'CONFLICT',
        `cidr ${input.cidr} overlaps another subnet of the network`,
      );
    throw error;
  }
  await reopen(tx, deps, network.id);
  return viewOf(tx, network.id);
}

/** Live instances (drafts included) on a network, or on one subnet of it. */
async function instancesOn(
  tx: SqlTx,
  column: 'network_id' | 'subnet_id',
  value: string,
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM instances WHERE ${column} = $1 AND state <> 'deleted' ORDER BY id LIMIT 50`,
    [value],
  );
  return rows.map((row) => row.id);
}

/** `networks.removeSubnet`: refused while instances use the subnet (INVALID_STATE, `details.instanceIds`). */
export async function removeSubnet(
  deps: NetworkDeps,
  tx: SqlTx,
  input: RemoveSubnetInput,
): Promise<NetworkView> {
  const network = await openNetwork(tx, input);
  const { rows } = await tx.query<SubnetRow>(
    `SELECT ${subnetColumns} FROM network_subnets WHERE id = $1 AND network_id = $2 FOR UPDATE`,
    [input.subnetId, network.id],
  );
  const subnet = rows[0];
  if (!subnet || subnet.state === 'deleted')
    throw new ComputeError('NOT_FOUND', `Subnet ${input.subnetId} not found`);
  if (subnet.desired_state === 'deleted') return viewOf(tx, network.id);
  const instanceIds = await instancesOn(tx, 'subnet_id', subnet.id);
  if (instanceIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Subnet ${subnet.name} is used by ${instanceIds.length} instance(s)`,
      undefined,
      { instanceIds },
    );
  await tx.query(
    `UPDATE network_subnets SET desired_state = 'deleted', state = 'deleting', message = NULL WHERE id = $1`,
    [subnet.id],
  );
  await reopen(tx, deps, network.id);
  return viewOf(tx, network.id);
}

/**
 * `networks.delete`: refused while live instances are on the network (INVALID_STATE,
 * `details.instanceIds`). Otherwise the network, its subnets and its rules are marked for deletion
 * and the reconciler removes the rules, then the subnets, then the network. Idempotent.
 */
export async function deleteNetwork(
  deps: NetworkDeps,
  tx: SqlTx,
  ref: NetworkRef,
): Promise<NetworkView> {
  const row = await requireNetwork(tx, ref, { lock: true });
  if (row.desired_state === 'deleted') return viewOf(tx, row.id);
  const instanceIds = await instancesOn(tx, 'network_id', row.id);
  if (instanceIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Network ${row.name} has ${instanceIds.length} instance(s) on it`,
      undefined,
      { instanceIds },
    );
  await tx.query(
    `UPDATE network_firewall_rules SET desired_state = 'deleted', state = CASE WHEN state = 'deleted' THEN state ELSE 'deleting' END,
            version = version + 1 WHERE network_id = $1`,
    [row.id],
  );
  await tx.query(
    `UPDATE network_subnets SET desired_state = 'deleted', state = CASE WHEN state = 'deleted' THEN state ELSE 'deleting' END
      WHERE network_id = $1`,
    [row.id],
  );
  await tx.query(
    `UPDATE networks SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1 WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, networksWork, row.id);
  await publish(deps, tx, row, 'network.deleting');
  return viewOf(tx, row.id);
}

// Firewall rules

async function readRules(
  tx: SqlTx,
  networkId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<RuleRow[]> {
  const { rows } = await tx.query<RuleRow>(
    `SELECT ${ruleColumns} FROM network_firewall_rules WHERE network_id = $1 AND ($2 OR state <> 'deleted') ORDER BY name`,
    [networkId, options.includeDeleted === true],
  );
  return rows;
}

/** Target instances must belong to the tenant and be on the network. */
async function assertTargets(
  tx: SqlTx,
  network: NetworkRow,
  targets: RuleFields['targets'],
): Promise<void> {
  const wanted = targets.instanceIds ?? [];
  if (wanted.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM instances WHERE tenant_id = $1 AND network_id = $2 AND id = ANY($3::text[]) AND state <> 'deleted'`,
    [network.tenant_id, network.id, wanted],
  );
  const found = new Set(rows.map((row) => row.id));
  const missing = wanted.filter((instanceId) => !found.has(instanceId));
  if (missing.length > 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `Instances ${missing.join(', ')} are not on network ${network.id}`,
      undefined,
      { instanceIds: missing },
    );
}

const ruleSpecOf = (fields: RuleFields): RuleSpec => ({
  direction: fields.direction,
  action: fields.action,
  priority: fields.priority,
  rules: fields.rules,
  ...(fields.sources ? { sources: fields.sources } : {}),
  ...(fields.destinations ? { destinations: fields.destinations } : {}),
  targets: fields.targets,
});

export async function createRule(
  deps: NetworkDeps,
  tx: SqlTx,
  input: CreateRuleInput,
): Promise<FirewallRuleView> {
  const network = await openNetwork(tx, input);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM network_firewall_rules WHERE network_id = $1 AND state <> 'deleted'`,
    [network.id],
  );
  if (Number(live.rows[0]!.count) >= maxRulesPerNetwork)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A network has at most ${maxRulesPerNetwork} firewall rules`,
      undefined,
      { limit: maxRulesPerNetwork },
    );
  await assertTargets(tx, network, input.targets);
  const spec = JSON.stringify(ruleSpecOf(input));
  const previous = (
    await tx.query<RuleRow>(
      `SELECT ${ruleColumns} FROM network_firewall_rules WHERE network_id = $1 AND name = $2 FOR UPDATE`,
      [network.id, input.name],
    )
  ).rows[0];
  if (previous && previous.state !== 'deleted')
    throw new ComputeError('CONFLICT', `Firewall rule ${input.name} already exists`);
  let ruleId: string;
  if (previous) {
    // A deleted rule's name is free again: the row is revived (its provider resource is gone).
    ruleId = previous.id;
    await tx.query(
      `UPDATE network_firewall_rules SET spec = $2::jsonb, enabled = $3, state = 'pending', desired_state = 'present',
              message = NULL, version = version + 1 WHERE id = $1`,
      [ruleId, spec, input.enabled],
    );
  } else {
    ruleId = newId('fwr');
    await tx.query(
      `INSERT INTO network_firewall_rules (id, network_id, name, spec, enabled, state, desired_state, version)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', 'present', 1)`,
      [ruleId, network.id, input.name, spec, input.enabled],
    );
  }
  await deps.work.enqueue(tx, networksWork, network.id);
  return ruleView((await readRule(tx, network.id, ruleId))!);
}

async function readRule(
  tx: SqlTx,
  networkId: string,
  ruleId: string,
  options: { lock?: boolean } = {},
): Promise<RuleRow | undefined> {
  const { rows } = await tx.query<RuleRow>(
    `SELECT ${ruleColumns} FROM network_firewall_rules WHERE id = $1 AND network_id = $2${options.lock ? ' FOR UPDATE' : ''}`,
    [ruleId, networkId],
  );
  return rows[0];
}

export async function listRules(
  tx: SqlTx,
  ref: NetworkRef,
): Promise<{ items: FirewallRuleView[] }> {
  const network = await requireNetwork(tx, ref);
  return { items: (await readRules(tx, network.id)).map(ruleView) };
}

/** `firewallRules.update`: merges the given fields into the rule, re-checks it, bumps `version`, wakes the reconciler. */
export async function updateRule(
  deps: NetworkDeps,
  tx: SqlTx,
  input: UpdateRuleInput,
): Promise<FirewallRuleView> {
  const network = await openNetwork(tx, input);
  const row = await readRule(tx, network.id, input.ruleId, { lock: true });
  if (!row || row.state === 'deleted' || row.desired_state === 'deleted')
    throw new ComputeError('NOT_FOUND', `Firewall rule ${input.ruleId} not found`);
  const current = ruleView(row);
  const { tenantId: _tenant, networkId: _network, ruleId: _rule, ...patch } = input;
  const patched = { ...patch };
  // An empty range list clears the field; the cross-field rules then apply to the result.
  let merged: RuleFields;
  try {
    merged = finishRule({
      direction: patched.direction ?? current.direction,
      action: patched.action ?? current.action,
      priority: patched.priority ?? current.priority,
      rules: patched.rules ?? current.rules,
      sources: patched.sources ?? current.sources,
      destinations: patched.destinations ?? current.destinations,
      targets: patched.targets ?? current.targets,
      enabled: patched.enabled ?? current.enabled,
    });
  } catch (error) {
    // A direction change must not carry the old direction's ranges over.
    if (
      patched.direction !== undefined &&
      patched.direction !== current.direction &&
      error instanceof ComputeError
    )
      throw new ComputeError(
        'INVALID_INPUT',
        `${error.message} (a rule that changes direction names its ${patched.direction === 'ingress' ? 'sources' : 'destinations'} again)`,
      );
    throw error;
  }
  if (patched.targets !== undefined) await assertTargets(tx, network, merged.targets);
  await tx.query(
    `UPDATE network_firewall_rules SET spec = $2::jsonb, enabled = $3, state = 'pending', message = NULL, version = version + 1
      WHERE id = $1`,
    [row.id, JSON.stringify(ruleSpecOf(merged)), merged.enabled],
  );
  await deps.work.enqueue(tx, networksWork, network.id);
  return ruleView((await readRule(tx, network.id, row.id))!);
}

/** `firewallRules.delete`: marks the rule for deletion (idempotent), bumps `version`, wakes the reconciler. */
export async function deleteRule(
  deps: NetworkDeps,
  tx: SqlTx,
  ref: RuleRef,
): Promise<FirewallRuleView> {
  const network = await requireNetwork(tx, ref, { lock: true });
  const row = await readRule(tx, network.id, ref.ruleId, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Firewall rule ${ref.ruleId} not found`);
  if (row.desired_state === 'deleted') return ruleView(row);
  await tx.query(
    `UPDATE network_firewall_rules SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1 WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, networksWork, network.id);
  return ruleView((await readRule(tx, network.id, row.id))!);
}
