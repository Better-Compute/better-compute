import { createHash } from 'node:crypto';
import {
  ComputeError,
  draftId,
  isComputeError,
  newId,
  strictObject,
  type AdmissionPlan,
  type CallContext,
  type Clock,
  type EventPublisher,
  type InputSchema,
  type Json,
  type Logger,
  type MethodContext,
  type Migration,
  type ModuleContext,
  type ProviderFirewallSpec,
  type ProviderImpl,
  type ProviderNetworkState,
  type ProviderNetworks,
  type ProviderResourceState,
  type Reconciler,
  type SecretResolver,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  readAccount,
  type ClientDeps,
  type ProviderAccount,
  type ProviderClients,
  liveKubernetesClusters,
} from './accounts.js';
import {
  attachConflictCondition,
  duplicateMachineCondition,
  ownershipLostCondition,
  platformCaller,
  visibleVpsPool,
} from './instances.js';
import { canonical, fail, id, key, object, optional, sha256Hex, tenant } from './input.js';
import {
  edgeColumns,
  edgeViews,
  hopOf,
  hostOf,
  maxPeeringsPerNetwork,
  outputsOf,
  readEdges,
  type EdgeRow,
  type NetworkNatGatewayView,
  type NetworkPeeringView,
  type NetworkRouteView,
  type PeerNetworkInput,
  type SetNatGatewayInput,
  type SetRoutesInput,
} from './network-edge.js';

// Tenant networks (v1.0): a VPC on a provider account, its subnets and its firewall rules. The API
// records what the tenant wants (`desired_state`); the `vps.networks` reconciler (below) converges
// the provider through `ProviderImpl.networks` and writes back `state`. Provider calls never run in
// a transaction.

/** The work kind (key: network id, or `all` for the periodic sweep) of the networks reconciler. */
export const networksWork = 'vps.networks';

/** At most this many firewall rules (not deleted) per network. */
export const maxRulesPerNetwork = 100;

/**
 * At most this many networks (not deleted) per tenant, and subnets (not removed) per network
 * (ruling F2). Every tenant's VPCs, subnets and firewalls live in the provider account's one
 * project, whose quotas (VPC networks, subnetworks, firewall rules) all tenants on the account
 * share: the caps keep one tenant from taking all of them.
 */
export const maxNetworksPerTenant = 10;
export const maxSubnetsPerNetwork = 16;

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
  -- Set the first time the network reaches 'ready' and never cleared: instances can be put on a
  -- network that went back to 'pending' because a subnet or rule was added.
  provisioned_at timestamptz,
  -- The caller identity: idempotency keys are scoped to (tenant, caller), as the id derives from them.
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
-- A deleted network's name is free again.
CREATE UNIQUE INDEX networks_name ON networks (tenant_id, name) WHERE state <> 'deleted';
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
-- The machine the networks reconciler last settled this instance's tags on, and when: a pass skips
-- what is current, so tagging many machines resumes across runs instead of starting over (I7).
ALTER TABLE instances ADD COLUMN network_tagged_machine text;
ALTER TABLE instances ADD COLUMN network_tagged_at timestamptz;
CREATE INDEX instances_network ON instances (network_id) WHERE network_id IS NOT NULL AND state <> 'deleted';
`,
};

/**
 * (networks.adopt) A network adopted from the provider: `external_name` is the VPC's provider-side
 * name, which better-compute neither creates nor deletes; its firewall rules always target instance
 * tags. `shared_tag_scoped` records that the VPC is shared with machines that are not the tenant's
 * (the project's `default`), so only tag-scoped rules may touch it, and other tenants may adopt it
 * too; any other VPC is adopted by one live network at a time.
 */
export const vpsNetworkAdoptMigration: Migration = {
  name: 'vps/0044_network_adopt',
  sql: `
ALTER TABLE networks ADD COLUMN external_name text;
ALTER TABLE networks ADD COLUMN shared_tag_scoped bool NOT NULL DEFAULT false;
CREATE UNIQUE INDEX networks_adopted ON networks (provider_account_id, external_name)
  WHERE external_name IS NOT NULL AND NOT shared_tag_scoped AND state <> 'deleted';
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
 * An adopted network (`networks.adopt`) passes its `external_name`, which is used as it is.
 */
export function providerResourceName(resourceId: string, externalName?: string | null): string {
  if (externalName) return externalName;
  return `bc-${resourceId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 60)}`;
}

/**
 * The provider-side name of a load balancer or certificate: `bc-`, the id's prefix, `-` and the first 40
 * characters of its body (`bc-plb-…`, 47 characters; `bc-pcert-…`, 49). Their ids are draft ids (a 52-character
 * base32 SHA-256), and a provider such as DigitalOcean appends its own deployment suffix to a name of at most 51
 * characters, so `providerResourceName` (up to 63) does not fit. 40 base32 characters keep 200 bits of the hash:
 * names stay unique per id. Lower-case `[a-z0-9-]`, deterministic, so a create whose answer was lost is found again.
 */
export function edgeResourceName(resourceId: string): string {
  const at = resourceId.indexOf('_');
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = at > 0 ? clean(resourceId.slice(0, at)).slice(0, 6) : '';
  const body = clean(at > 0 ? resourceId.slice(at + 1) : resourceId).slice(0, 40);
  return prefix ? `bc-${prefix}-${body}` : `bc-${body}`;
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
  /** Adopted (`networks.adopt`): the provider VPC's own name, which better-compute never deletes. */
  externalNetwork?: string;
  /** Adopted with `sharedTagScoped`: a VPC shared with other machines (`default`). */
  sharedTagScoped?: true;
  /** (edge) The subnets' NAT gateways (`networks.natGateway`); absent when there are none. */
  natGateways?: NetworkNatGatewayView[];
  /** (edge) The peerings this network's subnets take part in (`networks.peer`), from either side. */
  peerings?: NetworkPeeringView[];
  /** (edge) The subnets' static routes (`networks.routes`). */
  routes?: NetworkRouteView[];
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

/** `networks.adopt` (root only): an existing provider VPC as a tenant network. */
export interface AdoptNetworkInput {
  tenantId: string;
  /** A provider pool owned by or offered to the tenant; the VPC is in its provider account. */
  poolId: string;
  /** The VPC's provider-side name (`legacy-vpc`, or `default` with `sharedTagScoped`). */
  externalNetwork: string;
  /** The tenant network's name, unique in the tenant. */
  name: string;
  /** Required to adopt `default`: the VPC is shared, and only tag-scoped rules may touch it. */
  sharedTagScoped?: boolean;
  description?: string;
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
/** A GCE network name (RFC 1035, at most 63 characters). */
const externalNetworkName = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** The VPC every GCE project starts with: shared with every VM not put elsewhere. */
export const defaultNetworkName = 'default';
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

export function parseAdoptNetwork(raw: unknown): AdoptNetworkInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'externalNetwork',
    'name',
    'sharedTagScoped',
    'description',
  ]);
  if (typeof input.externalNetwork !== 'string' || !externalNetworkName.test(input.externalNetwork))
    fail('externalNetwork must be a provider network name (lower-case letters, digits and -)');
  // A name better-compute gives its own networks is never someone else's VPC.
  if (input.externalNetwork.startsWith('bc-'))
    fail(
      'externalNetwork names a network better-compute made (bc-…); networks.create manages those',
    );
  if (input.sharedTagScoped !== undefined && typeof input.sharedTagScoped !== 'boolean')
    fail('sharedTagScoped must be true or false');
  const out: AdoptNetworkInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    externalNetwork: input.externalNetwork,
    name: networkName(input.name),
  };
  if (input.sharedTagScoped === true) out.sharedTagScoped = true;
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
  adoptNetwork: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf(
        'pool',
        'A provider pool owned by or offered to the tenant, whose account holds the VPC',
      ),
      externalNetwork: {
        type: 'string',
        pattern: externalNetworkName.source,
        maxLength: 63,
        description:
          'The existing VPC’s provider-side name (not a bc- network); default needs sharedTagScoped',
      },
      name: nameSchema('The tenant network name, unique in the tenant'),
      sharedTagScoped: {
        type: 'boolean',
        default: false,
        description:
          'The VPC is shared with machines that are not the tenant’s: required to adopt default, recorded on the network',
      },
      description: { type: 'string', maxLength: 256, description: 'What the network is for' },
    },
    ['tenantId', 'poolId', 'externalNetwork', 'name'],
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
  provisioned_at: Date | string | null;
  external_name: string | null;
  shared_tag_scoped: boolean;
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
  desired_state, message, encode(request_hash, 'hex') AS request_hash, version, created_at,
  provisioned_at, external_name, shared_tag_scoped`;
const subnetColumns = `id, network_id, name, region, cidr::text AS cidr, state, desired_state, message`;
const ruleColumns = `id, network_id, name, spec, enabled, state, desired_state, message, version`;

export function networkView(
  row: NetworkRow,
  subnets: readonly SubnetRow[],
  edges: readonly EdgeRow[] = [],
): NetworkView {
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
    ...(row.external_name !== null ? { externalNetwork: row.external_name } : {}),
    ...(row.shared_tag_scoped === true ? { sharedTagScoped: true as const } : {}),
    ...edgeViews(row.id, edges),
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
  return networkView(row, await readSubnets(tx, [networkId]), await readEdges(tx, [networkId]));
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
  /** The IAM root tenant: its provider accounts are the platform's (ruling F1). */
  rootTenantId?: string;
  /** The host's workload issuer: provider accounts' identity (`ClientDeps.workload`). */
  workload?: ClientDeps['workload'];
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
): Promise<{ accountId: string; zones: string[]; regions: string[]; client: ProviderImpl }> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  if (pool.class !== 'provider' || pool.providerAccountId === undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `Pool ${poolId} is not a provider pool; networks live on provider accounts`,
    );
  // R1: only an account of the pool's owner tenant.
  const account = await readAccount(tx, pool.providerAccountId, pool.ownerTenantId);
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
  // Providers without zones (DigitalOcean) configure regions.
  const regions = Array.isArray(account.config.regions)
    ? account.config.regions.filter((region): region is string => typeof region === 'string')
    : [];
  return { accountId: account.id, zones, regions, client };
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
  await assertNetworkAllowance(tx, input.tenantId);
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

/** QUOTA_EXCEEDED when the tenant already has `maxNetworksPerTenant` networks that are not deleted. */
async function assertNetworkAllowance(tx: SqlTx, tenantId: string): Promise<void> {
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM networks WHERE tenant_id = $1 AND state <> 'deleted'`,
    [tenantId],
  );
  if (Number(live.rows[0]!.count) >= maxNetworksPerTenant)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A tenant has at most ${maxNetworksPerTenant} networks that are not deleted`,
      undefined,
      { limit: maxNetworksPerTenant },
    );
}

async function assertNameFree(tx: SqlTx, tenantId: string, name: string): Promise<void> {
  const taken = await tx.query(
    `SELECT 1 FROM networks WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [tenantId, name],
  );
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
  // Concurrent creates of one tenant count one after the other.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('better-compute:networks:' || $1))`, [
    input.tenantId,
  ]);
  await assertNetworkAllowance(tx, input.tenantId);
  try {
    await tx.query(
      `INSERT INTO networks (id, tenant_id, project_id, pool_id, provider_account_id, name, description,
                             state, desired_state, created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'present', $8, $9, decode($10, 'hex'), 1)`,
      [
        networkId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        accountId,
        input.name,
        input.description ?? null,
        caller.identityId,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      // The name index, or (a concurrent retry of the same request) the key.
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('name'))
        throw new ComputeError('CONFLICT', `Network ${input.name} already exists`);
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    }
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

const adoptHash = (input: AdoptNetworkInput) =>
  sha256Hex(
    canonical({
      adopt: true,
      poolId: input.poolId,
      externalNetwork: input.externalNetwork,
      name: input.name,
      sharedTagScoped: input.sharedTagScoped === true,
      description: input.description,
    }),
  );

/**
 * `networks.adopt` (root only, in the method's transaction): records a VPC that already exists in the
 * pool's provider account as a tenant network, so attached VMs whose NIC is on it are linked to it
 * (`networkOfMachine`) and get its firewall rules. better-compute never creates, changes or deletes
 * the VPC itself (deleting the network removes only its own subnets and rules), and every firewall
 * rule on it targets instance tags. `default` is shared with every VM of the project, so it is
 * adopted only with `sharedTagScoped`, which other tenants' adoptions of it must also set; any other
 * VPC is adopted by one live network. The same adoption again returns the network; another one of
 * the VPC in the tenant is CONFLICT.
 */
export async function adoptNetwork(
  deps: NetworkDeps,
  context: MethodContext,
  input: AdoptNetworkInput,
): Promise<NetworkView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  if (!platformCaller(caller, input.tenantId, deps.rootTenantId))
    throw new ComputeError('ACCESS_DENIED', 'Only the platform adopts provider networks');
  if (input.externalNetwork === defaultNetworkName && input.sharedTagScoped !== true)
    throw new ComputeError(
      'INVALID_INPUT',
      `${defaultNetworkName} is shared with every VM of the project; adopt it with sharedTagScoped: true`,
      undefined,
      { field: 'sharedTagScoped', hint: 'set sharedTagScoped: true' },
    );
  const { accountId } = await networkProvider(deps, tx, input.tenantId, input.poolId);
  const hash = await adoptHash(input);
  // Adoptions of one VPC count one after the other, across tenants.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('better-compute:networks:adopt:' || $1))`, [
    `${accountId}/${input.externalNetwork}`,
  ]);
  const { rows: adopted } = await tx.query<NetworkRow>(
    `SELECT ${networkColumns} FROM networks
      WHERE provider_account_id = $1 AND external_name = $2 AND state <> 'deleted' ORDER BY id`,
    [accountId, input.externalNetwork],
  );
  const mine = adopted.find((row) => row.tenant_id === input.tenantId);
  if (mine) {
    if (mine.request_hash === hash) return viewOf(tx, mine.id);
    throw new ComputeError(
      'CONFLICT',
      `${input.externalNetwork} is already adopted as network ${mine.id}`,
      undefined,
      { networkId: mine.id },
    );
  }
  if (
    adopted.length > 0 &&
    (input.sharedTagScoped !== true || adopted.some((row) => !row.shared_tag_scoped))
  )
    throw new ComputeError(
      'CONFLICT',
      `${input.externalNetwork} is adopted by another tenant; only sharedTagScoped adoptions share a network`,
    );
  await assertNameFree(tx, input.tenantId, input.name);
  // Concurrent creates and adoptions of one tenant count one after the other.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('better-compute:networks:' || $1))`, [
    input.tenantId,
  ]);
  await assertNetworkAllowance(tx, input.tenantId);
  const networkId = newId('net');
  try {
    await tx.query(
      `INSERT INTO networks (id, tenant_id, pool_id, provider_account_id, name, description, state,
                             desired_state, created_by, idempotency_key, request_hash, version,
                             external_name, shared_tag_scoped)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'present', $7, $8, decode($9, 'hex'), 1, $10, $11)`,
      [
        networkId,
        input.tenantId,
        input.poolId,
        accountId,
        input.name,
        input.description ?? null,
        caller.identityId,
        `adopt:${networkId}`,
        hash,
        input.externalNetwork,
        input.sharedTagScoped === true,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('adopted'))
        throw new ComputeError('CONFLICT', `${input.externalNetwork} is already adopted`);
      throw new ComputeError('CONFLICT', `Network ${input.name} already exists`);
    }
    throw error;
  }
  await deps.authz.upsert(tx, {
    type: 'network',
    id: networkId,
    tenantId: input.tenantId,
    attributes: { providerAccountId: accountId, poolId: input.poolId },
    parentType: 'tenant',
    parentId: input.tenantId,
    ownerId: caller.identityId,
  });
  await deps.work.enqueue(tx, networksWork, networkId);
  await publish(deps, tx, { id: networkId, tenant_id: input.tenantId }, 'network.adopted', {
    poolId: input.poolId,
    providerAccountId: accountId,
    name: input.name,
    externalNetwork: input.externalNetwork,
    sharedTagScoped: input.sharedTagScoped === true,
  });
  return viewOf(tx, networkId);
}

/** An adopted network's rules must name the instances they apply to: never the whole VPC. */
function assertTagScoped(network: NetworkRow, targets: RuleFields['targets']): void {
  if (network.external_name === null || (targets.instanceIds?.length ?? 0) > 0) return;
  throw new ComputeError(
    'INVALID_INPUT',
    `Network ${network.id} is adopted (${network.external_name}): its firewall rules must name targets.instanceIds`,
    undefined,
    { field: 'targets.instanceIds', hint: 'rules on an adopted network target instances' },
  );
}

export async function getNetwork(tx: SqlTx, ref: NetworkRef): Promise<NetworkView> {
  const row = await requireNetwork(tx, ref);
  return networkView(row, await readSubnets(tx, [row.id]), await readEdges(tx, [row.id]));
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
  const edges = await readEdges(
    tx,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) =>
      networkView(
        row,
        subnets.filter((subnet) => subnet.network_id === row.id),
        edges,
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
 * zones or regions, and overlap no other subnet of the network (CONFLICT: also enforced by the
 * database).
 */
export async function addSubnet(
  deps: NetworkDeps,
  tx: SqlTx,
  input: AddSubnetInput,
): Promise<NetworkView> {
  const network = await openNetwork(tx, input);
  const provider = await networkProvider(deps, tx, network.tenant_id, network.pool_id);
  const regions = [...new Set([...provider.zones.map(zoneRegion), ...provider.regions])];
  if (regions.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${network.provider_account_id} configures no zones or regions, so no subnet region is allowed`,
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
  // The network row is locked (openNetwork): concurrent adds count one after the other.
  const present = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM network_subnets WHERE network_id = $1 AND desired_state = 'present'`,
    [network.id],
  );
  if (Number(present.rows[0]!.count) >= maxSubnetsPerNetwork)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A network has at most ${maxSubnetsPerNetwork} subnets`,
      undefined,
      { limit: maxSubnetsPerNetwork },
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
  const loadBalancerIds = await loadBalancersOn(tx, 'subnet_id', subnet.id);
  if (loadBalancerIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Subnet ${subnet.name} holds ${loadBalancerIds.length} load balancer(s); delete them first`,
      undefined,
      { loadBalancerIds },
    );
  await tx.query(
    `UPDATE network_subnets SET desired_state = 'deleted', state = 'deleting', message = NULL WHERE id = $1`,
    [subnet.id],
  );
  // Its gateway, routes and peerings go first (the reconciler deletes the subnet after them).
  await releaseEdges(tx, deps, 'subnet', subnet.id, network.id);
  await reopen(tx, deps, network.id);
  return viewOf(tx, network.id);
}

// --- Edge: NAT gateways, peerings and routes (DO P4) ----------------------------------------------

/**
 * The load balancers on a subnet or network (DO P4: a regional load balancer lives in its subnet's VPC), until the
 * provider deleted them: the subnet cannot go before them.
 */
async function loadBalancersOn(
  tx: SqlTx,
  column: 'subnet_id' | 'network_id',
  value: string,
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM provider_load_balancers WHERE ${column} = $1 AND state <> 'deleted' ORDER BY id LIMIT 50`,
    [value],
  );
  return rows.map((row) => row.id);
}

/**
 * Marks for deletion every live edge row on a subnet (its gateway, its routes, the peerings it takes part in) or of
 * a network (its own rows, and the peerings other networks hold with it), and wakes the networks that hold them.
 */
async function releaseEdges(
  tx: SqlTx,
  deps: Pick<NetworkDeps, 'work'>,
  scope: 'subnet' | 'network',
  scopeId: string,
  networkId: string,
): Promise<void> {
  const where =
    scope === 'subnet'
      ? `(subnet_id = $1 OR peer_subnet_id = $1)`
      : `(network_id = $1 OR peer_network_id = $1)`;
  const { rows } = await tx.query<{ network_id: string }>(
    `UPDATE network_edges SET desired_state = 'deleted', version = version + 1,
            state = CASE WHEN state = 'deleted' THEN state ELSE 'deleting' END, message = NULL
      WHERE ${where} AND desired_state = 'present'
      RETURNING network_id`,
    [scopeId],
  );
  for (const holder of new Set(rows.map((row) => row.network_id)))
    if (holder !== networkId) await reopen(tx, deps, holder);
}

/** A subnet of the network that is not being removed (locked). */
async function liveSubnet(tx: SqlTx, networkId: string, subnetId: string): Promise<SubnetRow> {
  const { rows } = await tx.query<SubnetRow>(
    `SELECT ${subnetColumns} FROM network_subnets WHERE id = $1 AND network_id = $2 FOR UPDATE`,
    [subnetId, networkId],
  );
  const subnet = rows[0];
  if (!subnet || subnet.state === 'deleted')
    throw new ComputeError('NOT_FOUND', `Subnet ${subnetId} not found`);
  if (subnet.desired_state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Subnet ${subnet.name} is being removed`);
  return subnet;
}

const edgeFeatures = {
  ensureNatGateway: 'NAT gateways',
  ensurePeering: 'network peerings',
  ensureRoute: 'static routes',
} as const;

/** UNSUPPORTED unless the network's provider implements `method` (checked before anything is recorded). */
async function requireEdgeFeature(
  deps: NetworkDeps,
  tx: SqlTx,
  network: NetworkRow,
  method: keyof typeof edgeFeatures,
): Promise<void> {
  const { client } = await networkProvider(deps, tx, network.tenant_id, network.pool_id);
  if (typeof client.networks?.[method] !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `The provider of network ${network.name} does not provide ${edgeFeatures[method]}`,
    );
}

async function insertEdge(
  tx: SqlTx,
  fields: {
    networkId: string;
    kind: EdgeRow['kind'];
    subnetId: string;
    name?: string;
    peerNetworkId?: string;
    peerSubnetId?: string;
    destination?: string;
    nextHop?: Json;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO network_edges (id, network_id, kind, subnet_id, name, peer_network_id, peer_subnet_id, destination,
                                next_hop, state, desired_state, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::cidr, $9::jsonb, 'pending', 'present', 1)`,
    [
      newId('nedge'),
      fields.networkId,
      fields.kind,
      fields.subnetId,
      fields.name ?? null,
      fields.peerNetworkId ?? null,
      fields.peerSubnetId ?? null,
      fields.destination ?? null,
      fields.nextHop === undefined ? null : JSON.stringify(fields.nextHop),
    ],
  );
}

async function liveGateway(tx: SqlTx, subnetId: string): Promise<EdgeRow | undefined> {
  const { rows } = await tx.query<EdgeRow>(
    `SELECT ${edgeColumns} FROM network_edges
      WHERE subnet_id = $1 AND kind = 'nat-gateway' AND desired_state = 'present' FOR UPDATE`,
    [subnetId],
  );
  return rows[0];
}

/**
 * `networks.natGateway`: `enabled: true` gives the subnet a NAT gateway (one per subnet; asking again returns the
 * network unchanged), `enabled: false` removes it, refused (INVALID_STATE, `details.routes`) while a route of the
 * subnet sends traffic to it.
 */
export async function setNatGateway(
  deps: NetworkDeps,
  tx: SqlTx,
  input: SetNatGatewayInput,
): Promise<NetworkView> {
  const network = await openNetwork(tx, input);
  const subnet = await liveSubnet(tx, network.id, input.subnetId);
  const existing = await liveGateway(tx, subnet.id);
  if (input.enabled) {
    if (existing) return viewOf(tx, network.id);
    await requireEdgeFeature(deps, tx, network, 'ensureNatGateway');
    await insertEdge(tx, { networkId: network.id, kind: 'nat-gateway', subnetId: subnet.id });
  } else {
    if (!existing) return viewOf(tx, network.id);
    const { rows } = await tx.query<{ name: string }>(
      `SELECT name FROM network_edges
        WHERE subnet_id = $1 AND kind = 'route' AND desired_state = 'present' AND next_hop ? 'natGateway'
        ORDER BY name`,
      [subnet.id],
    );
    if (rows.length > 0)
      throw new ComputeError(
        'INVALID_STATE',
        `Routes of subnet ${subnet.name} send traffic to its NAT gateway: change them first`,
        undefined,
        { routes: rows.map((row) => row.name) },
      );
    await tx.query(
      `UPDATE network_edges SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1
        WHERE id = $1`,
      [existing.id],
    );
  }
  await reopen(tx, deps, network.id);
  return viewOf(tx, network.id);
}

/**
 * `networks.peer`: peers a subnet of the network with a subnet of another network of the tenant (or another subnet
 * of the same network) on the same provider account; `enabled: false` removes the peering, from either side. The
 * same pair asked again, from either side, is the same peering. A network of another tenant is NOT_FOUND.
 */
export async function peerNetwork(
  deps: NetworkDeps,
  tx: SqlTx,
  input: PeerNetworkInput,
): Promise<NetworkView> {
  // Both networks are locked, in id order, so two calls on one pair never deadlock.
  const ids = [...new Set([input.networkId, input.peerNetworkId])].sort();
  const locked = new Map<string, NetworkRow>();
  for (const networkId of ids)
    locked.set(
      networkId,
      await requireNetwork(tx, { tenantId: input.tenantId, networkId }, { lock: true }),
    );
  const network = locked.get(input.networkId)!;
  const peer = locked.get(input.peerNetworkId)!;
  // The pair's peering, only between the two networks named (both the tenant's, checked above): subnets of other
  // networks never select a row, so no caller reaches a peering of networks that are not theirs.
  const { rows } = await tx.query<EdgeRow>(
    `SELECT ${edgeColumns} FROM network_edges
      WHERE kind = 'peering' AND desired_state = 'present'
        AND ((network_id = $3 AND subnet_id = $1 AND peer_network_id = $4 AND peer_subnet_id = $2)
          OR (network_id = $4 AND subnet_id = $2 AND peer_network_id = $3 AND peer_subnet_id = $1))
      FOR UPDATE`,
    [input.subnetId, input.peerSubnetId, network.id, peer.id],
  );
  const existing = rows[0];
  if (!input.enabled) {
    if (existing) {
      await tx.query(
        `UPDATE network_edges SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1
          WHERE id = $1`,
        [existing.id],
      );
      await reopen(tx, deps, existing.network_id);
    }
    return viewOf(tx, network.id);
  }
  for (const row of locked.values())
    if (row.desired_state === 'deleted' || row.state === 'deleting' || row.state === 'deleted')
      throw new ComputeError('INVALID_STATE', `Network ${row.id} is being deleted`);
  if (peer.provider_account_id !== network.provider_account_id)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${peer.id} is on another provider account; only networks of one account are peered`,
    );
  await liveSubnet(tx, network.id, input.subnetId);
  await liveSubnet(tx, peer.id, input.peerSubnetId);
  if (existing) return viewOf(tx, network.id);
  await requireEdgeFeature(deps, tx, network, 'ensurePeering');
  for (const row of locked.values()) {
    const count = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM network_edges
        WHERE kind = 'peering' AND desired_state = 'present' AND (network_id = $1 OR peer_network_id = $1)`,
      [row.id],
    );
    if (Number(count.rows[0]!.count) >= maxPeeringsPerNetwork)
      throw new ComputeError(
        'QUOTA_EXCEEDED',
        `A network takes part in at most ${maxPeeringsPerNetwork} peerings`,
        undefined,
        { limit: maxPeeringsPerNetwork, networkId: row.id },
      );
  }
  await insertEdge(tx, {
    networkId: network.id,
    kind: 'peering',
    subnetId: input.subnetId,
    peerNetworkId: peer.id,
    peerSubnetId: input.peerSubnetId,
  });
  await reopen(tx, deps, network.id);
  return viewOf(tx, network.id);
}

/**
 * `networks.routes`: replaces the static routes of a subnet. A route kept as it is stays; a changed one is replaced
 * (the provider route is deleted, then made anew); one left out is deleted. Next hops: the subnet's NAT gateway
 * (INVALID_STATE without one), an instance of the tenant on the subnet, or a host address inside the subnet.
 */
export async function setRoutes(
  deps: NetworkDeps,
  tx: SqlTx,
  input: SetRoutesInput,
): Promise<NetworkView> {
  const network = await openNetwork(tx, input);
  const subnet = await liveSubnet(tx, network.id, input.subnetId);
  for (const route of input.routes) {
    const hop = route.nextHop;
    if ('natGateway' in hop && !(await liveGateway(tx, subnet.id)))
      throw new ComputeError(
        'INVALID_STATE',
        `Subnet ${subnet.name} has no NAT gateway: enable one with networks.natGateway first`,
      );
    if ('address' in hop && !hostOf(subnet.cidr, hop.address))
      throw new ComputeError(
        'INVALID_INPUT',
        `Route ${route.name}: ${hop.address} is not a host address of subnet ${subnet.name} (${subnet.cidr})`,
      );
    if ('instanceId' in hop) {
      const { rows } = await tx.query<{ subnet_id: string | null }>(
        `SELECT subnet_id FROM instances WHERE id = $1 AND tenant_id = $2 AND NOT draft AND state <> 'deleted'`,
        [hop.instanceId, network.tenant_id],
      );
      if (!rows[0]) throw new ComputeError('NOT_FOUND', `Instance ${hop.instanceId} not found`);
      if (rows[0].subnet_id !== subnet.id)
        throw new ComputeError(
          'INVALID_INPUT',
          `Route ${route.name}: instance ${hop.instanceId} is not on subnet ${subnet.name}`,
        );
    }
  }
  const { rows: current } = await tx.query<EdgeRow>(
    `SELECT ${edgeColumns} FROM network_edges
      WHERE subnet_id = $1 AND kind = 'route' AND desired_state = 'present' FOR UPDATE`,
    [subnet.id],
  );
  const same = (row: EdgeRow, route: SetRoutesInput['routes'][number]) =>
    row.name === route.name &&
    row.destination === route.destination &&
    canonical(hopOf(row)) === canonical(route.nextHop);
  const kept = current.filter((row) => input.routes.some((route) => same(row, route)));
  const dropped = current.filter((row) => !kept.includes(row));
  const added = input.routes.filter((route) => !kept.some((row) => same(row, route)));
  if (dropped.length === 0 && added.length === 0) return viewOf(tx, network.id);
  if (added.length > 0) await requireEdgeFeature(deps, tx, network, 'ensureRoute');
  if (dropped.length > 0)
    await tx.query(
      `UPDATE network_edges SET desired_state = 'deleted', state = CASE WHEN state = 'deleted' THEN state ELSE 'deleting' END,
              message = NULL, version = version + 1
        WHERE id = ANY($1::text[])`,
      [dropped.map((row) => row.id)],
    );
  for (const route of added)
    await insertEdge(tx, {
      networkId: network.id,
      kind: 'route',
      subnetId: subnet.id,
      name: route.name,
      destination: route.destination,
      nextHop: route.nextHop as Json,
    });
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
  const loadBalancerIds = await loadBalancersOn(tx, 'network_id', row.id);
  if (loadBalancerIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Network ${row.name} holds ${loadBalancerIds.length} load balancer(s); delete them first`,
      undefined,
      { loadBalancerIds },
    );
  const clusterIds = await liveKubernetesClusters(tx, 'network_id', row.id);
  if (clusterIds.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Network ${row.name} has ${clusterIds.length} Kubernetes cluster(s) on it`,
      undefined,
      { clusterIds },
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
  // Its gateways, routes and peerings, and the peerings other networks hold with it: those networks delete them.
  await releaseEdges(tx, deps, 'network', row.id, row.id);
  await tx.query(
    `UPDATE networks SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1 WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, networksWork, row.id);
  await publish(deps, tx, row, 'network.deleting');
  return viewOf(tx, row.id);
}

// Instances on networks (v1.0)

/**
 * The region an offer's machine lands in, when the offer id says (`us-central1-a/n2-standard-4` is
 * in `us-central1`: the provider's offer ids lead with the zone); `undefined` for other shapes.
 */
function offerRegion(offerId: string | undefined): string | undefined {
  const zone = offerId?.includes('/') ? offerId.slice(0, offerId.indexOf('/')) : undefined;
  return zone ? zoneRegion(zone) : undefined;
}

interface LockedNetwork {
  row: NetworkRow;
  subnets: SubnetRow[];
}

/**
 * What an instance needs of a network when it is put on it:
 * - `provisioned`: it has been `ready` once (`provisioned_at`) and is not being deleted. A network
 *   that goes back to `pending` because a subnet or rule is added still takes instances.
 * - `live`: it exists and is not being deleted (attach: whatever else the network is doing, e.g.
 *   `pending` while a subnet is added, a machine on it is linked).
 */
type NetworkNeed = 'provisioned' | 'live';

/**
 * A network of this tenant on this provider account, and its live subnets, both locked `FOR SHARE`:
 * `networks.delete` and `networks.removeSubnet` (which lock them `FOR UPDATE`) wait for the
 * transaction that is putting an instance on them, and then see that instance. A network that is
 * not the tenant's, is on another account, or does not exist is INVALID_INPUT; one that is not in
 * the state `need` asks for is INVALID_STATE (a transient condition: retry).
 */
async function lockNetwork(
  tx: SqlTx,
  input: { tenantId: string; accountId: string; networkId: string },
  need: NetworkNeed,
): Promise<LockedNetwork> {
  const { rows } = await tx.query<NetworkRow>(
    `SELECT ${networkColumns} FROM networks WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
    [input.networkId, input.tenantId],
  );
  const row = rows[0];
  if (!row || row.state === 'deleted')
    throw new ComputeError('INVALID_INPUT', `Network ${input.networkId} not found in this tenant`);
  if (row.provider_account_id !== input.accountId)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${row.id} is on provider account ${row.provider_account_id}, not the pool's ${input.accountId}`,
    );
  if (row.desired_state !== 'present' || row.state === 'deleting')
    throw new ComputeError('INVALID_STATE', `Network ${row.id} is being deleted`, undefined, {
      networkId: row.id,
    });
  if (need === 'provisioned' && row.provisioned_at === null)
    throw new ComputeError(
      'INVALID_STATE',
      `Network ${row.id} is ${row.state} and has not been provisioned yet; retry once it is ready`,
      undefined,
      { networkId: row.id, hint: 'retry once the network is ready' },
    );
  const subnets = await tx.query<SubnetRow>(
    `SELECT ${subnetColumns} FROM network_subnets
      WHERE network_id = $1 AND state <> 'deleted' ORDER BY name FOR SHARE`,
    [row.id],
  );
  return { row, subnets: subnets.rows };
}

const subnetNotReady = (subnet: SubnetRow) =>
  new ComputeError(
    'INVALID_STATE',
    `Subnet ${subnet.id} is ${subnet.desired_state === 'present' ? subnet.state : 'being deleted'}; retry once it is ready`,
    undefined,
    { subnetId: subnet.id, hint: 'retry once the subnet is ready' },
  );

/**
 * `instances.create` with a `networkId`: the network and subnet the VM is placed on. The network must
 * be the tenant's, on the pool's provider account, provisioned (it was `ready` once) and not being
 * deleted; the subnet must be on it, in the offer's region and `ready` (INVALID_STATE with a retry
 * hint while it is not). Without a `subnetId` the network's only subnet in the offer's region is
 * used (none, or several: INVALID_INPUT naming them). Locks both until the transaction ends.
 */
export async function placeOnNetwork(
  tx: SqlTx,
  input: {
    tenantId: string;
    accountId: string;
    networkId: string;
    subnetId?: string;
    offerId?: string;
  },
): Promise<{ networkId: string; subnetId: string }> {
  const { row, subnets } = await lockNetwork(tx, input, 'provisioned');
  const region = offerRegion(input.offerId);
  if (input.subnetId !== undefined) {
    const subnet = subnets.find((entry) => entry.id === input.subnetId);
    if (!subnet)
      throw new ComputeError(
        'INVALID_INPUT',
        `Subnet ${input.subnetId} is not a subnet of network ${row.id}`,
      );
    if (region !== undefined && subnet.region !== region)
      throw new ComputeError(
        'INVALID_INPUT',
        `Subnet ${subnet.id} is in ${subnet.region}, but the flavor's offer is in ${region}`,
      );
    if (subnet.state !== 'ready' || subnet.desired_state !== 'present')
      throw subnetNotReady(subnet);
    return { networkId: row.id, subnetId: subnet.id };
  }
  const candidates = subnets.filter(
    (subnet) =>
      subnet.desired_state === 'present' && (region === undefined || subnet.region === region),
  );
  const where = region === undefined ? '' : ` in ${region}`;
  if (candidates.length === 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${row.id} has no subnet${where}; add one (networks.addSubnet) or name another network`,
      undefined,
      { networkId: row.id, ...(region !== undefined ? { region } : {}) },
    );
  if (candidates.length > 1)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${row.id} has ${candidates.length} subnets${where} (${candidates
        .map((subnet) => subnet.id)
        .join(', ')}); name one with subnetId`,
      undefined,
      { networkId: row.id, subnetIds: candidates.map((subnet) => subnet.id) },
    );
  const only = candidates[0]!;
  if (only.state !== 'ready') throw subnetNotReady(only);
  return { networkId: row.id, subnetId: only.id };
}

/** The part after the last `/` of a provider resource reference (`global/networks/x` is `x`). */
const shortName = (reference: string): string => reference.slice(reference.lastIndexOf('/') + 1);

/**
 * `instances.attach`: the tenant network (and subnet) a discovered machine's NIC is on. A machine is
 * on a network when one of its NICs names the network's provider name. With `networkId` the machine
 * must be on that network, else INVALID_STATE ("attached VMs keep their existing network": GCE
 * cannot move a NIC to another VPC without a stop); that network must exist and not be deleting.
 * Without it, a machine on any of the tenant's networks of the same provider account that is not
 * deleted is linked, whatever state the network is in (it flips to `pending` whenever a subnet or
 * rule is added): an unlinked VM would not be tagged, and its network could be deleted from under it.
 */
export async function networkOfMachine(
  tx: SqlTx,
  input: {
    tenantId: string;
    accountId: string;
    externalId: string;
    nics: readonly { network: string; subnet?: string }[];
    networkId?: string;
  },
): Promise<{ networkId?: string; subnetId?: string }> {
  // The tenant's networks on the account (or the one asked for), by provider-side name: an adopted
  // one (networks.adopt) by its VPC's own name. One of another tenant or account is never named.
  const { rows: candidates } = await tx.query<{ id: string; external_name: string | null }>(
    `SELECT id, external_name FROM networks
      WHERE tenant_id = $1 AND provider_account_id = $2 AND state <> 'deleted'
        AND ($3::text IS NULL OR id = $3)
      ORDER BY id`,
    [input.tenantId, input.accountId, input.networkId ?? null],
  );
  for (const nic of input.nics) {
    const found = candidates.find(
      (candidate) =>
        providerResourceName(candidate.id, candidate.external_name) === shortName(nic.network),
    )?.id;
    if (found === undefined) continue;
    const locked = await lockNetwork(
      tx,
      { tenantId: input.tenantId, accountId: input.accountId, networkId: found },
      'live',
    );
    const subnet =
      nic.subnet === undefined
        ? undefined
        : locked.subnets.find((entry) => providerResourceName(entry.id) === shortName(nic.subnet!));
    return { networkId: locked.row.id, ...(subnet ? { subnetId: subnet.id } : {}) };
  }
  if (input.networkId !== undefined) {
    // Say why a network that does not qualify is refused, before saying where the machine is.
    await lockNetwork(
      tx,
      { tenantId: input.tenantId, accountId: input.accountId, networkId: input.networkId },
      'live',
    );
    throw new ComputeError(
      'INVALID_STATE',
      `Machine ${input.externalId} is not on network ${input.networkId}; attached VMs keep their existing network`,
      undefined,
      { hint: 'attached VMs keep their existing network', networkId: input.networkId },
    );
  }
  return {};
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
  assertTagScoped(network, input.targets);
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
  assertTagScoped(network, merged.targets);
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

// --- The reconciler ----------------------------------------------------------------------------

/** How soon a pending provider operation is looked at again. */
export const networkPollMs = 5_000;
/** How soon a rate-limited or unavailable provider is tried again. */
const networkRetryMs = 30_000;
/** A run stops starting provider calls after this long (the lease is 60 s); the rest waits for the next run. */
const runBudgetMs = 40_000;
/**
 * A machine's tags, once set, are taken as current for this long: passes skip it meanwhile, so a
 * network of many machines is tagged across runs; after it, a pass sets them again (drift).
 */
export const networkTagRefreshMs = 60 * 60_000;

/** The event family of an edge kind: `network.natGateway.ready`, `network.peering.error`, ... */
const edgeEvent = { 'nat-gateway': 'natGateway', peering: 'peering', route: 'route' } as const;

function edgeLabel(edge: EdgeRow): string {
  if (edge.kind === 'route') return `route ${edge.name ?? edge.id}`;
  return edge.kind === 'peering' ? `peering ${edge.id}` : `NAT gateway ${edge.id}`;
}

/** What converging one resource at the provider came to. */
type Outcome = { state: NetworkState; message?: string };

interface Snapshot {
  network: NetworkRow;
  account: ProviderAccount | undefined;
  subnets: SubnetRow[];
  rules: RuleRow[];
  instances: TaggedInstance[];
  /** (edge) The network's own gateways, peerings and routes that are not gone, with what converging them needs. */
  edges: EdgeWork[];
  /** (edge) This network's subnets that a peering held by another network still joins: they wait for it. */
  peeredByOthers: Set<string>;
}

/** An edge row with its subnet, its peer subnet (a peering) and its next-hop instance (a route). */
interface EdgeWork extends EdgeRow {
  subnet_region: string;
  subnet_state: NetworkState;
  peer_region: string | null;
  peer_subnet_state: NetworkState | null;
  peer_subnet_desired: 'present' | 'deleted' | null;
  peer_external_name: string | null;
  hop_external_id: string | null;
  hop_state: string | null;
  hop_subnet_id: string | null;
}

interface TaggedInstance {
  id: string;
  external_id: string;
  network_tagged_machine: string | null;
  tagged_ms: number | null;
}

async function loadSnapshot(tx: SqlTx, networkId: string): Promise<Snapshot | undefined> {
  const network = await readNetwork(tx, { networkId });
  if (!network) return undefined;
  const subnets = (await readSubnets(tx, [networkId])).filter(
    (subnet) => subnet.state !== 'deleted' || subnet.desired_state === 'present',
  );
  const rules = await readRules(tx, networkId, { includeDeleted: true });
  // Only instances that own their machine are tagged (I3): live (not deleting, lost or failed), and
  // an attached one only once claimed and while nothing says it lost the machine (B2, B5).
  // Never tagged first, then the longest ago: a run that runs out of time leaves the rest for the next.
  const instances = await tx.query<TaggedInstance>(
    `SELECT id, external_id, network_tagged_machine,
            (extract(epoch FROM network_tagged_at) * 1000)::float8 AS tagged_ms
       FROM instances
      WHERE network_id = $1 AND external_id IS NOT NULL
        AND state NOT IN ('deleted', 'deleting', 'lost', 'error')
        AND (origin <> 'attached' OR provider_claimed_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(conditions) AS c
           WHERE c->>'status' = 'true' AND c->>'type' = ANY($2::text[]))
      ORDER BY network_tagged_at NULLS FIRST, id`,
    [networkId, [attachConflictCondition, ownershipLostCondition, duplicateMachineCondition]],
  );
  const edges = await tx.query<EdgeWork>(
    `SELECT e.id, e.network_id, e.kind, e.subnet_id, e.name, e.peer_network_id, e.peer_subnet_id,
            e.destination::text AS destination, e.next_hop, e.external_id, e.outputs, e.state, e.desired_state,
            e.message, e.version, s.region AS subnet_region, s.state AS subnet_state,
            ps.region AS peer_region, ps.state AS peer_subnet_state, ps.desired_state AS peer_subnet_desired,
            pn.external_name AS peer_external_name,
            i.external_id AS hop_external_id, i.state AS hop_state, i.subnet_id AS hop_subnet_id
       FROM network_edges e
       JOIN network_subnets s ON s.id = e.subnet_id
       LEFT JOIN network_subnets ps ON ps.id = e.peer_subnet_id
       LEFT JOIN networks pn ON pn.id = e.peer_network_id
       LEFT JOIN instances i ON e.kind = 'route' AND i.id = e.next_hop->>'instanceId'
      WHERE e.network_id = $1 AND (e.state <> 'deleted' OR e.desired_state = 'present')
      ORDER BY e.created_at, e.id`,
    [networkId],
  );
  const inbound = await tx.query<{ peer_subnet_id: string }>(
    `SELECT peer_subnet_id FROM network_edges
      WHERE peer_network_id = $1 AND network_id <> $1 AND kind = 'peering' AND state <> 'deleted'`,
    [networkId],
  );
  return {
    network,
    account: await readAccount(tx, network.provider_account_id),
    subnets,
    rules,
    instances: instances.rows,
    edges: edges.rows,
    peeredByOthers: new Set(inbound.rows.map((row) => row.peer_subnet_id)),
  };
}

/**
 * The provider firewall a rule compiles to: a rule that names instances targets their network tags.
 * On an adopted network (`tagScoped`) a rule without targets would cover the whole VPC, machines that
 * are not the tenant's included: it is refused (INVALID_STATE) instead of compiled.
 */
export function compileFirewall(
  networkName: string,
  rule: RuleRow,
  options: { tagScoped?: boolean } = {},
): ProviderFirewallSpec {
  const spec = specOf(rule);
  const instanceIds = spec.targets?.instanceIds ?? [];
  if (options.tagScoped === true && instanceIds.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Rule ${rule.name} is on an adopted network and names no instances; it is never applied network-wide`,
    );
  return {
    network: networkName,
    name: providerResourceName(rule.id),
    direction: spec.direction,
    action: spec.action,
    priority: spec.priority,
    rules: spec.rules,
    ...(spec.sources ? { sources: spec.sources } : {}),
    ...(spec.destinations ? { destinations: spec.destinations } : {}),
    ...(instanceIds.length > 0 ? { targetTags: instanceIds.map(networkTag) } : {}),
    ...(rule.enabled ? {} : { disabled: true }),
  };
}

/** Whether two IPv4 CIDRs share addresses. */
function cidrsOverlap(a: string, b: string): boolean {
  const range = (cidr: string) => {
    const [address = '', prefix = '32'] = cidr.split('/');
    const octets = address.split('.').map(Number);
    const start = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
    return [start, start + 2 ** (32 - Number(prefix)) - 1] as const;
  };
  const [aStart, aEnd] = range(a);
  const [bStart, bEnd] = range(b);
  return aStart <= bEnd && bStart <= aEnd;
}

const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);
const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];

/**
 * One step of one network: provider calls run outside any transaction, and each result is written in
 * its own short one, guarded by the version it was decided on (a change made meanwhile wakes the
 * reconciler again instead of being overwritten). Returns the next wake-up, or undefined when settled
 * (an `error` waits for the periodic pass or the next change).
 */
export async function reconcileNetwork(
  deps: NetworkDeps,
  sql: SqlExecutor,
  networkId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const snapshot = await sql.transaction((tx) => loadSnapshot(tx, networkId));
  if (!snapshot || snapshot.network.state === 'deleted') return undefined;
  const worker = new NetworkWorker(deps, sql, snapshot, signal);
  const providerNetworks = await worker.providerNetworks();
  if (!providerNetworks) return undefined;
  return snapshot.network.desired_state === 'deleted'
    ? worker.teardown(providerNetworks)
    : worker.converge(providerNetworks);
}

class NetworkWorker {
  /** Something is still in flight at the provider: look again soon. */
  #inFlight = false;
  /** The provider asked us to slow down. */
  #backoff = false;
  /** The run ran out of time, or the network changed meanwhile: continue at once. */
  #again = false;
  readonly #networkName: string;
  readonly #started: number;

  constructor(
    private readonly deps: NetworkDeps,
    private readonly sql: SqlExecutor,
    private readonly snapshot: Snapshot,
    private readonly signal: AbortSignal,
  ) {
    this.#networkName = providerResourceName(snapshot.network.id, snapshot.network.external_name);
    this.#started = deps.clock.now();
  }

  get #network() {
    return this.snapshot.network;
  }

  #next(): number | undefined {
    const now = this.deps.clock.now();
    if (this.#backoff) return now + networkRetryMs;
    if (this.#again) return now;
    return this.#inFlight ? now + networkPollMs : undefined;
  }

  #call(idempotencyKey: string): CallContext {
    return {
      idempotencyKey,
      signal: this.signal,
      clock: this.deps.clock,
      secrets: this.deps.secrets,
      log: this.deps.log,
    };
  }

  /** The account's client when its provider still provides networks; otherwise the network is in error. */
  async providerNetworks(): Promise<ProviderNetworks | undefined> {
    const { account } = this.snapshot;
    try {
      if (!account)
        throw new ComputeError(
          'NOT_FOUND',
          `Provider account ${this.#network.provider_account_id} not found`,
        );
      const client = await this.deps.clients.client(account, this.deps);
      if (!client.networks)
        throw new ComputeError(
          'UNSUPPORTED',
          `Provider ${account.provider} does not provide tenant networks`,
        );
      return client.networks;
    } catch (error) {
      await this.#setNetwork('error', text(error));
      return undefined;
    }
  }

  /** Runs a provider call; a throw is an `error` outcome unless the provider is only busy (then: later). */
  async #attempt(op: () => Promise<ProviderNetworkState>): Promise<Outcome | undefined> {
    if (this.deps.clock.now() - this.#started > runBudgetMs) {
      this.#again = true;
      return undefined;
    }
    try {
      const result = await op();
      return {
        state: result.state,
        ...(result.message ? { message: result.message.slice(0, 500) } : {}),
      };
    } catch (error) {
      if (this.signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
        this.deps.log.warn('networks: provider busy, retrying', {
          networkId: this.#network.id,
          error: text(error),
        });
        this.#backoff = true;
        return undefined;
      }
      return { state: 'error', message: text(error) };
    }
  }

  /** Writes the network's state (guarded by its version) and publishes what changed. */
  async #setNetwork(state: NetworkState, message?: string): Promise<void> {
    const network = this.#network;
    const written = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE networks SET state = $3, message = $4,
                provisioned_at = CASE WHEN $3 = 'ready' THEN coalesce(provisioned_at, compute_now()) ELSE provisioned_at END
          WHERE id = $1 AND version = $2 AND (state IS DISTINCT FROM $3 OR message IS DISTINCT FROM $4)
          RETURNING id`,
        [network.id, network.version, state, message ?? null],
      );
      if (rows.length === 0) return false;
      if (state === 'ready' && network.state !== 'ready')
        await publish(this.deps, tx, network, 'network.ready');
      else if (state === 'error')
        await publish(this.deps, tx, network, 'network.error', { message: message ?? '' });
      return true;
    });
    if (written) {
      network.state = state;
      return;
    }
    // Unchanged, or changed through the API meanwhile (its version is newer): then converge again at once.
    const { rows } = await this.sql.transaction((tx) =>
      tx.query<{ version: string | number }>(`SELECT version FROM networks WHERE id = $1`, [
        network.id,
      ]),
    );
    if (rows[0] && Number(rows[0].version) !== Number(network.version)) this.#again = true;
  }

  async #setSubnet(subnet: SubnetRow, state: NetworkState, message?: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE network_subnets SET state = $5, message = $6
          WHERE id = $1 AND desired_state = $2 AND region = $3 AND cidr = $4::cidr
            AND (state IS DISTINCT FROM $5 OR message IS DISTINCT FROM $6)
          RETURNING id`,
        [subnet.id, subnet.desired_state, subnet.region, subnet.cidr, state, message ?? null],
      );
      if (rows.length === 0) return;
      if (state === 'ready' && subnet.state !== 'ready')
        await publish(this.deps, tx, this.#network, 'network.subnet.ready', {
          subnetId: subnet.id,
          name: subnet.name,
        });
      subnet.state = state;
    });
  }

  async #setRule(rule: RuleRow, state: NetworkState, message?: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      // Guarded by the version this run read: a rule changed through the API since was queued again then.
      const { rows } = await tx.query(
        `UPDATE network_firewall_rules SET state = $3, message = $4
          WHERE id = $1 AND version = $2 AND (state IS DISTINCT FROM $3 OR message IS DISTINCT FROM $4)
          RETURNING id`,
        [rule.id, rule.version, state, message ?? null],
      );
      if (rows.length === 0) return;
      if (state === 'ready' && rule.state !== 'ready')
        await publish(this.deps, tx, this.#network, 'network.rule.ready', {
          ruleId: rule.id,
          name: rule.name,
        });
      if (state === 'error')
        await publish(this.deps, tx, this.#network, 'network.rule.error', {
          ruleId: rule.id,
          name: rule.name,
          message: message ?? '',
        });
      rule.state = state;
    });
  }

  /**
   * Records that this pass settled the instance's tags on its machine (tagged, or refused as not
   * its own): later passes skip it until `networkTagRefreshMs` has passed or the machine changed.
   */
  async #tagged(instance: TaggedInstance): Promise<void> {
    const now = this.deps.clock.now();
    await this.sql.transaction((tx) =>
      tx.query(
        `UPDATE instances SET network_tagged_machine = $2, network_tagged_at = to_timestamp($3::float8 / 1000)
          WHERE id = $1 AND external_id = $2`,
        [instance.id, instance.external_id, now],
      ),
    );
  }

  /** What the provider answered for a thing being created or updated, as the state we store. */
  #presentState(outcome: Outcome): Outcome {
    if (outcome.state === 'ready' || outcome.state === 'error') return outcome;
    this.#inFlight = true;
    return { state: 'pending' };
  }

  // --- Edge (DO P4): NAT gateways, peerings and routes ------------------------------------------

  /** Like `#attempt`, keeping the provider's id and outputs of what it answered. */
  async #attemptEdge(
    op: () => Promise<ProviderResourceState>,
  ): Promise<(Outcome & { id?: string; outputs?: Readonly<Record<string, string>> }) | undefined> {
    const seen: { answer?: ProviderResourceState } = {};
    const outcome = await this.#attempt(async () => {
      const answer = await op();
      seen.answer = answer;
      return {
        id: answer.id,
        state: answer.state === 'updating' ? 'pending' : answer.state,
        ...(answer.message ? { message: answer.message } : {}),
      };
    });
    const answer = seen.answer;
    if (!outcome || !answer || outcome.state === 'error') return outcome;
    return { ...outcome, id: answer.id, ...(answer.outputs ? { outputs: answer.outputs } : {}) };
  }

  /** Writes an edge row's state (guarded by the version this run read) and publishes what changed. */
  async #setEdge(
    edge: EdgeWork,
    state: NetworkState,
    message?: string,
    found?: { id?: string; outputs?: Readonly<Record<string, string>> },
  ): Promise<void> {
    const outputs = found?.outputs ? JSON.stringify(found.outputs) : null;
    const written = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE network_edges SET state = $3, message = $4, external_id = coalesce($5::text, external_id),
                outputs = coalesce($6::jsonb, outputs)
          WHERE id = $1 AND version = $2
            AND (state IS DISTINCT FROM $3 OR message IS DISTINCT FROM $4
                 OR ($5::text IS NOT NULL AND external_id IS DISTINCT FROM $5::text)
                 OR ($6::jsonb IS NOT NULL AND outputs IS DISTINCT FROM $6::jsonb))
          RETURNING id`,
        [edge.id, edge.version, state, message ?? null, found?.id ?? null, outputs],
      );
      if (rows.length === 0) return false;
      const event = `network.${edgeEvent[edge.kind]}`;
      const data = { edgeId: edge.id, subnetId: edge.subnet_id };
      if (state === 'ready' && edge.state !== 'ready')
        await publish(this.deps, tx, this.#network, `${event}.ready`, data);
      if (state === 'error' && edge.state !== 'error')
        await publish(this.deps, tx, this.#network, `${event}.error`, {
          ...data,
          message: message ?? '',
        });
      return true;
    });
    if (!written) return;
    edge.state = state;
    if (found?.id) edge.external_id = found.id;
  }

  /** The provider id of the subnet's NAT gateway, once it is ready. */
  #gatewayOf(subnetId: string): string | undefined {
    return (
      this.snapshot.edges.find(
        (edge) =>
          edge.kind === 'nat-gateway' &&
          edge.subnet_id === subnetId &&
          edge.desired_state === 'present' &&
          edge.state === 'ready' &&
          edge.external_id !== null,
      )?.external_id ?? undefined
    );
  }

  /** Whether an edge resource (ours, or a peering another network holds) still uses the subnet. */
  #edgesOn(subnetId: string): boolean {
    return (
      this.snapshot.peeredByOthers.has(subnetId) ||
      this.snapshot.edges.some(
        (edge) =>
          edge.state !== 'deleted' &&
          (edge.subnet_id === subnetId || edge.peer_subnet_id === subnetId),
      )
    );
  }

  /** A subnet's state changed in this run: the edges on it see it at once. */
  #subnetSettled(subnetId: string, state: NetworkState): void {
    for (const edge of this.snapshot.edges) {
      if (edge.subnet_id === subnetId) edge.subnet_state = state;
      if (edge.peer_subnet_id === subnetId) edge.peer_subnet_state = state;
    }
  }

  /** What an edge waits for before the provider is asked (or why it cannot be made); undefined: ask now. */
  #edgeBlocker(edge: EdgeWork): { message: string; error?: true } | undefined {
    if (edge.subnet_state !== 'ready') return { message: 'Waiting for its subnet' };
    if (
      edge.kind === 'peering' &&
      (edge.peer_subnet_state !== 'ready' || edge.peer_subnet_desired !== 'present')
    )
      return { message: 'Waiting for the peer subnet' };
    if (edge.kind !== 'route') return undefined;
    const hop = hopOf(edge);
    if ('natGateway' in hop && this.#gatewayOf(edge.subnet_id) === undefined)
      return { message: "Waiting for the subnet's NAT gateway" };
    if ('instanceId' in hop) {
      if (
        edge.hop_state === null ||
        edge.hop_state === 'deleted' ||
        edge.hop_subnet_id !== edge.subnet_id
      )
        return {
          message: `Next hop instance ${hop.instanceId} is gone or not on the subnet`,
          error: true,
        };
      if (edge.hop_external_id === null)
        return { message: `Waiting for instance ${hop.instanceId} to have a machine` };
    }
    return undefined;
  }

  #ensureCall(networks: ProviderNetworks, edge: EdgeWork): Promise<ProviderResourceState> {
    const name = providerResourceName(edge.id);
    const subnet = providerResourceName(edge.subnet_id);
    const call = this.#call(edge.id);
    const unsupported = (what: string) =>
      Promise.reject(new ComputeError('UNSUPPORTED', `The provider does not provide ${what}`));
    if (edge.kind === 'nat-gateway')
      return networks.ensureNatGateway
        ? networks.ensureNatGateway(
            { name, network: this.#networkName, subnet, region: edge.subnet_region },
            call,
          )
        : unsupported('NAT gateways');
    if (edge.kind === 'peering')
      return networks.ensurePeering
        ? networks.ensurePeering(
            {
              name,
              network: this.#networkName,
              subnet,
              region: edge.subnet_region,
              peer: {
                network: providerResourceName(edge.peer_network_id!, edge.peer_external_name),
                subnet: providerResourceName(edge.peer_subnet_id!),
                region: edge.peer_region!,
              },
            },
            call,
          )
        : unsupported('network peerings');
    const hop = hopOf(edge);
    const nextHop =
      'natGateway' in hop
        ? { kind: 'natGateway' as const, id: this.#gatewayOf(edge.subnet_id)! }
        : 'instanceId' in hop
          ? { kind: 'machine' as const, id: edge.hop_external_id! }
          : { kind: 'address' as const, id: hop.address };
    return networks.ensureRoute
      ? networks.ensureRoute(
          {
            name,
            network: this.#networkName,
            subnet,
            region: edge.subnet_region,
            destination: edge.destination!,
            nextHop,
          },
          call,
        )
      : unsupported('static routes');
  }

  /** Makes (or re-applies) the wanted edges: gateways, then peerings, then routes (a route may need a gateway's id). */
  async #ensureEdges(networks: ProviderNetworks, problems: string[]): Promise<boolean> {
    let waiting = false;
    const wanted = this.snapshot.edges.filter((edge) => edge.desired_state === 'present');
    for (const kind of ['nat-gateway', 'peering', 'route'] as const)
      for (const edge of wanted.filter((entry) => entry.kind === kind)) {
        const blocked = this.#edgeBlocker(edge);
        if (blocked?.error) {
          await this.#setEdge(edge, 'error', blocked.message);
          problems.push(`${edgeLabel(edge)}: ${blocked.message}`);
          continue;
        }
        if (blocked) {
          this.#inFlight = true;
          waiting = true;
          await this.#setEdge(edge, 'pending', blocked.message);
          continue;
        }
        const outcome = await this.#attemptEdge(() => this.#ensureCall(networks, edge));
        if (!outcome) {
          waiting = true;
          continue;
        }
        const state = this.#presentState(outcome);
        await this.#setEdge(edge, state.state, state.message, outcome);
        if (state.state === 'error')
          problems.push(`${edgeLabel(edge)}: ${state.message ?? 'the provider refused it'}`);
        else if (state.state !== 'ready') waiting = true;
      }
    return waiting;
  }

  async #deleteEdge(networks: ProviderNetworks, edge: EdgeWork): Promise<Outcome | undefined> {
    const name = providerResourceName(edge.id);
    const call = this.#call(edge.id);
    const op =
      edge.kind === 'nat-gateway'
        ? networks.deleteNatGateway &&
          (() => networks.deleteNatGateway!(edge.subnet_region, name, call))
        : edge.kind === 'peering'
          ? networks.deletePeering && (() => networks.deletePeering!(name, call))
          : networks.deleteRoute &&
            (() =>
              networks.deleteRoute!(
                {
                  name,
                  network: this.#networkName,
                  subnet: providerResourceName(edge.subnet_id),
                  region: edge.subnet_region,
                },
                call,
              ));
    // A provider without the call made nothing, unless it once answered with an id (then it cannot be undone here).
    const gone: Outcome | undefined = op
      ? await this.#attemptEdge(op)
      : edge.external_id === null
        ? { state: 'deleted' }
        : { state: 'error', message: 'The provider no longer deletes it' };
    if (!gone) return undefined;
    if (gone.state === 'deleted') await this.#setEdge(edge, 'deleted');
    else if (gone.state === 'error') await this.#setEdge(edge, 'error', gone.message);
    else {
      this.#inFlight = true;
      await this.#setEdge(edge, 'deleting');
    }
    return gone;
  }

  /**
   * Deletes the edges marked for deletion: routes first, then peerings, then gateways (one goes once no route of
   * ours sends traffic to it). True when none of them is left.
   */
  async #deleteEdges(networks: ProviderNetworks, problems: string[]): Promise<boolean> {
    let left = false;
    const doomed = this.snapshot.edges.filter(
      (edge) => edge.desired_state === 'deleted' && edge.state !== 'deleted',
    );
    for (const kind of ['route', 'peering', 'nat-gateway'] as const)
      for (const edge of doomed.filter((entry) => entry.kind === kind)) {
        const routed =
          kind === 'nat-gateway' &&
          this.snapshot.edges.some(
            (other) =>
              other.kind === 'route' &&
              other.subnet_id === edge.subnet_id &&
              other.state !== 'deleted' &&
              'natGateway' in hopOf(other),
          );
        if (routed) {
          left = true;
          this.#inFlight = true;
          continue;
        }
        const gone = await this.#deleteEdge(networks, edge);
        if (gone?.state === 'deleted') continue;
        left = true;
        if (gone?.state === 'error')
          problems.push(
            `${edgeLabel(edge)}: ${gone.message ?? 'the provider refused to delete it'}`,
          );
      }
    return !left;
  }

  async converge(networks: ProviderNetworks): Promise<number | undefined> {
    const { snapshot } = this;
    const network = this.#network;
    // An adopted VPC is the provider's: it is never created or changed here, only used.
    const ensured =
      network.external_name !== null
        ? ({ state: 'ready' } as const)
        : await this.#attempt(() =>
            networks.ensureNetwork(
              {
                name: this.#networkName,
                ...(network.description !== null ? { description: network.description } : {}),
              },
              this.#call(network.id),
            ),
          );
    if (!ensured) return this.#next();
    const vpc = this.#presentState(ensured);
    if (vpc.state === 'error') {
      await this.#setNetwork('error', vpc.message ?? 'The provider refused the network');
      return undefined;
    }
    if (vpc.state !== 'ready') {
      // The network is not there yet (or is being recreated): subnets and rules need it.
      await this.#setNetwork('pending');
      return this.#next();
    }

    const problems: string[] = [];
    let waiting = false;
    // Edges marked for deletion go before anything else: a subnet goes only after its gateway, routes and peerings.
    if (!(await this.#deleteEdges(networks, problems))) waiting = true;
    // Deletions first: a range freed by `removeSubnet` is reused by a new subnet only once the old one is gone.
    for (const subnet of snapshot.subnets) {
      const name = providerResourceName(subnet.id);
      if (subnet.desired_state === 'deleted') {
        if (subnet.state === 'deleted') continue;
        if (this.#edgesOn(subnet.id)) {
          this.#inFlight = true;
          waiting = true;
          await this.#setSubnet(
            subnet,
            'deleting',
            'Waiting for its NAT gateway, routes and peerings to be deleted',
          );
          continue;
        }
        const gone = await this.#attempt(() =>
          networks.deleteSubnet(subnet.region, name, this.#call(subnet.id)),
        );
        if (!gone) continue;
        if (gone.state === 'deleted') await this.#setSubnet(subnet, 'deleted');
        else if (gone.state === 'error') await this.#setSubnet(subnet, 'error', gone.message);
        else {
          this.#inFlight = true;
          await this.#setSubnet(subnet, 'deleting');
        }
      }
    }
    for (const subnet of snapshot.subnets) {
      if (subnet.desired_state === 'deleted') continue;
      const name = providerResourceName(subnet.id);
      const blocking = snapshot.subnets.find(
        (other) =>
          other.desired_state === 'deleted' &&
          other.state !== 'deleted' &&
          cidrsOverlap(other.cidr, subnet.cidr),
      );
      if (blocking) {
        // The provider refuses overlapping subnets: wait until the old one is gone.
        this.#inFlight = true;
        waiting = true;
        await this.#setSubnet(
          subnet,
          'pending',
          `Waiting for subnet ${blocking.name} to be deleted`,
        );
        continue;
      }
      const result = await this.#attempt(() =>
        networks.ensureSubnet(
          { network: this.#networkName, name, region: subnet.region, cidr: subnet.cidr },
          this.#call(subnet.id),
        ),
      );
      if (!result) {
        waiting = true;
        continue;
      }
      const state = this.#presentState(result);
      await this.#setSubnet(subnet, state.state, state.message);
      this.#subnetSettled(subnet.id, state.state);
      if (state.state === 'error')
        problems.push(`subnet ${subnet.name}: ${state.message ?? 'the provider refused it'}`);
      else if (state.state !== 'ready') waiting = true;
    }

    // Edges once their subnets are there: gateways, peerings, then routes.
    if (await this.#ensureEdges(networks, problems)) waiting = true;

    for (const rule of snapshot.rules) {
      const name = providerResourceName(rule.id);
      if (rule.desired_state === 'deleted') {
        if (rule.state === 'deleted') continue;
        const gone = await this.#attempt(() => networks.deleteFirewall(name, this.#call(rule.id)));
        if (!gone) continue;
        if (gone.state === 'deleted') await this.#setRule(rule, 'deleted');
        else if (gone.state === 'error') await this.#setRule(rule, 'error', gone.message);
        else {
          this.#inFlight = true;
          await this.#setRule(rule, 'deleting');
        }
        continue;
      }
      const result = await this.#attempt(() =>
        networks.ensureFirewall(
          compileFirewall(this.#networkName, rule, { tagScoped: network.external_name !== null }),
          this.#call(rule.id),
        ),
      );
      if (!result) continue;
      const state = this.#presentState(result);
      await this.#setRule(rule, state.state, state.message);
    }

    // Rules before tags: a rule targets tags, so a tag set later still matches, and a network of
    // many machines gets its rules in the first run. Tags resume across runs (I7): a machine whose
    // tags are current is skipped, so a run out of time continues with the rest next time.
    for (const instance of snapshot.instances) {
      if (
        instance.network_tagged_machine === instance.external_id &&
        instance.tagged_ms !== null &&
        this.deps.clock.now() - instance.tagged_ms < networkTagRefreshMs
      )
        continue;
      const done = await this.#attempt(async () => {
        try {
          await networks.setTags(
            instance.external_id,
            [networkTag(instance.id)],
            this.#call(instance.id),
            instance.id,
          );
        } catch (error) {
          // Not this instance's machine (any more), or not taggable yet: skipped, not an error;
          // the instance reconciler settles ownership.
          if (isComputeError(error, 'INVALID_STATE')) {
            this.deps.log.warn('networks: instance not tagged', {
              networkId: this.#network.id,
              instanceId: instance.id,
              error: text(error),
            });
            return { id: instance.external_id, state: 'pending' };
          }
          throw error;
        }
        return { id: instance.external_id, state: 'ready' };
      });
      if (done && done.state !== 'error') await this.#tagged(instance);
      // A machine the provider no longer has is the instance reconciler's to settle, not an error here.
      if (done?.state === 'error' && !/not.?found/i.test(done.message ?? ''))
        problems.push(`instance ${instance.id}: ${done.message ?? 'could not be tagged'}`);
    }

    if (problems.length > 0) await this.#setNetwork('error', problems.join('; ').slice(0, 500));
    else if (waiting || this.#backoff || this.#again) await this.#setNetwork('pending');
    else await this.#setNetwork('ready');
    return this.#next();
  }

  /** Rules first, then subnets, then the network; each step waits for the one before it. */
  async teardown(networks: ProviderNetworks): Promise<number | undefined> {
    const { snapshot } = this;
    const network = this.#network;
    const problems: string[] = [];

    // Edges first (routes, peerings, then gateways): the subnets they use go after them.
    if (!(await this.#deleteEdges(networks, problems))) return this.#waitOnTeardown(problems);

    let rulesLeft = false;
    for (const rule of snapshot.rules) {
      if (rule.state === 'deleted') continue;
      const gone = await this.#attempt(() =>
        networks.deleteFirewall(providerResourceName(rule.id), this.#call(rule.id)),
      );
      if (gone?.state === 'deleted') {
        await this.#setRule(rule, 'deleted');
        continue;
      }
      rulesLeft = true;
      if (!gone) continue;
      if (gone.state === 'error') {
        await this.#setRule(rule, 'error', gone.message);
        problems.push(`rule ${rule.name}: ${gone.message ?? 'the provider refused it'}`);
      } else {
        this.#inFlight = true;
        await this.#setRule(rule, 'deleting');
      }
    }
    if (rulesLeft) return this.#waitOnTeardown(problems);

    let subnetsLeft = false;
    for (const subnet of snapshot.subnets) {
      if (subnet.state === 'deleted') continue;
      // A peering another network holds still joins it: that network deletes the peering first.
      if (this.#edgesOn(subnet.id)) {
        subnetsLeft = true;
        this.#inFlight = true;
        continue;
      }
      const gone = await this.#attempt(() =>
        networks.deleteSubnet(
          subnet.region,
          providerResourceName(subnet.id),
          this.#call(subnet.id),
        ),
      );
      if (gone?.state === 'deleted') {
        await this.#setSubnet(subnet, 'deleted');
        continue;
      }
      subnetsLeft = true;
      if (!gone) continue;
      if (gone.state === 'error') {
        await this.#setSubnet(subnet, 'error', gone.message);
        problems.push(`subnet ${subnet.name}: ${gone.message ?? 'the provider refused it'}`);
      } else {
        this.#inFlight = true;
        await this.#setSubnet(subnet, 'deleting');
      }
    }
    if (subnetsLeft) return this.#waitOnTeardown(problems);

    // An adopted VPC stays: only what better-compute made in it (subnets, rules) is removed.
    const gone =
      network.external_name !== null
        ? ({ state: 'deleted' } as const)
        : await this.#attempt(() =>
            networks.deleteNetwork(this.#networkName, this.#call(network.id)),
          );
    if (!gone) return this.#waitOnTeardown(problems);
    if (gone.state === 'error') {
      await this.#setNetwork('error', gone.message ?? 'The provider refused to delete the network');
      return undefined;
    }
    if (gone.state !== 'deleted') {
      this.#inFlight = true;
      await this.#setNetwork('deleting');
      return this.#next();
    }
    await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE networks SET state = 'deleted', message = NULL
          WHERE id = $1 AND version = $2 AND state <> 'deleted' RETURNING id`,
        [network.id, network.version],
      );
      if (rows.length === 0) return;
      await tx.query(
        `UPDATE network_firewall_rules SET state = 'deleted', message = NULL WHERE network_id = $1`,
        [network.id],
      );
      await tx.query(
        `UPDATE network_edges SET state = 'deleted', message = NULL WHERE network_id = $1`,
        [network.id],
      );
      await tx.query(
        `UPDATE network_subnets SET state = 'deleted', message = NULL WHERE network_id = $1`,
        [network.id],
      );
      await this.deps.authz.remove(tx, {
        type: 'network',
        id: network.id,
        tenantId: network.tenant_id,
      });
      await publish(this.deps, tx, network, 'network.deleted');
    });
    return undefined;
  }

  async #waitOnTeardown(problems: string[]): Promise<number | undefined> {
    if (problems.length > 0) await this.#setNetwork('error', problems.join('; ').slice(0, 500));
    else await this.#setNetwork('deleting');
    return problems.length > 0 && !this.#inFlight ? undefined : this.#next();
  }
}

/**
 * The `vps.networks` reconciler (key: a network id). `all` is the periodic pass: it queues every
 * network that is not deleted, so networks still converging or in error are retried and ready ones
 * are re-applied, which puts back what drifted at the provider (a firewall deleted by hand).
 */
export function networksReconciler(depsOf: (context: ModuleContext) => NetworkDeps): Reconciler {
  return {
    name: networksWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: '5m' }],
    async run(context, key) {
      const deps = depsOf(context);
      if (key === 'all') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM networks WHERE state <> 'deleted' ORDER BY id`,
          );
          for (const row of rows) await context.work.enqueue(tx, networksWork, row.id);
        });
        return 'DONE';
      }
      const next = await reconcileNetwork(deps, context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, networksWork, key, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
