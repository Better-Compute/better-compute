import { chargeQuota, refundQuota } from '@better-compute/capacity';
import {
  ComputeError,
  draftId,
  strictObject,
  type AdmissionPlan,
  type InputSchema,
  type MethodContext,
  type Migration,
  type ProviderLoadBalancerRule,
  type ProviderLoadBalancers,
  type ProviderLoadBalancerSpec,
  type SqlTx,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import { canonical, fail, id, int, key, object, optional, sha256Hex, tenant } from './input.js';
import { edgeResourceName, providerResourceName, zoneRegion } from './networks.js';
import { domainOf } from './provider-certificates.js';
import {
  assertNameFree,
  assertRegion,
  caller,
  columns,
  descriptionOf,
  descriptionSchema,
  idOf,
  keySchema,
  listSchema,
  lockTenant,
  nameOf,
  nameSchema,
  output,
  publish,
  regionOf,
  regionSchema,
  resourceProvider,
  Run,
  sameRequest,
  settled,
  targetInstance,
  tenantIdSchema,
  uniqueViolation,
  type Fields,
  type ProviderResourceDeps,
  type ProviderResourceStatus,
} from './provider-resource-kit.js';

// Load balancers (DigitalOcean P4, edge): a tenant's load balancers on a provider account. A `regional` one is in
// front of machines in its region: the tenant's instances in the load balancer's pool (`targets: { pool: true }`)
// or named instances of the tenant (`targets: { instanceIds }`), on the same account and in the same region. A
// `global` one is in front of the tenant's regional load balancers (`targets: { loadBalancerIds }`). TLS terminates
// with the tenant's certificates (`certificates.*`), named by their vps ids.
//
// Targets are explicit machine ids sent to the provider, never a tag: what a load balancer reaches is computed
// here, from the tenant's own rows (`provider_load_balancer_targets`), so it never reaches another tenant's machine.
// A regional load balancer is in one VPC and the provider balances only to machines in it (DigitalOcean: a subnet is
// a VPC, DO-D9). So it lives on one subnet of a tenant network (`subnetId`, or the one its named instances share) or,
// without one, on the account's default network, and reaches only the instances placed there: the target set below
// filters on the instance's subnet, and named instances on another subnet are refused (INVALID_INPUT).
//
// The provider is re-ensured when that set changes: an instance of the pool is deleted (`onLoadBalancedInstanceGone`)
// or reaches a machine, which the periodic pass notices (`applied_targets` differs from the set).
//
// Quota: one `loadBalancers` on (tenant, pool), fail closed (a missing quota row grants none), refunded once the
// provider deleted it.

export const loadBalancerQuotaResource = 'loadBalancers';
const maxRules = 15;
const maxTargets = 100;
const maxRanges = 50;
const maxDomains = 20;

/**
 * (DO P4) Load balancers, and `provider_load_balancer_targets(lb)`: the provider ids of what one reaches now. Instances
 * count once they have a machine and until they are being deleted; a regional load balancer's region is the instance's
 * offer region (`nyc3/...`), and an instance without an offer is never a target (its region is unknown).
 */
export const providerLoadBalancersMigration: Migration = {
  name: 'vps/0119_provider_load_balancers',
  sql: `
CREATE TABLE provider_load_balancers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts,
  name text NOT NULL,
  description text,
  scope text NOT NULL CHECK (scope IN ('regional', 'global')),
  region text,
  -- forwarding, healthCheck, stickySessions, sourceRanges, redirectHttpToHttps, domains (certificates by vps id).
  spec jsonb NOT NULL,
  target_mode text NOT NULL CHECK (target_mode IN ('pool', 'instances', 'loadBalancers')),
  -- instances: instance ids; loadBalancers: provider_load_balancers ids.
  target_ids text[] NOT NULL DEFAULT '{}',
  -- The certificates spec names (a certificate is not deleted while a live load balancer names it).
  certificate_ids text[] NOT NULL DEFAULT '{}',
  -- What the provider was last given: its targets (comma-separated provider ids) and the row version ensured.
  applied_targets text,
  applied_version bigint,
  -- regional: the tenant network subnet it is on (its VPC); NULL: the account's default network.
  network_id text REFERENCES networks,
  subnet_id text REFERENCES network_subnets,
  external_id text,
  address text,
  address_v6 text,
  charged int NOT NULL DEFAULT 0 CHECK (charged >= 0),${columns},
  CHECK ((scope = 'regional') = (region IS NOT NULL)),
  CHECK ((network_id IS NULL) = (subnet_id IS NULL)),
  CHECK (scope = 'regional' OR subnet_id IS NULL),
  CHECK ((scope = 'global') = (target_mode = 'loadBalancers'))
);
CREATE UNIQUE INDEX provider_load_balancers_name ON provider_load_balancers (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX provider_load_balancers_live ON provider_load_balancers (state) WHERE state <> 'deleted';
CREATE INDEX provider_load_balancers_pool ON provider_load_balancers (pool_id) WHERE state <> 'deleted';
CREATE INDEX provider_load_balancers_subnet ON provider_load_balancers (subnet_id) WHERE subnet_id IS NOT NULL AND state <> 'deleted';
CREATE TRIGGER provider_load_balancers_stamp_deleted BEFORE UPDATE ON provider_load_balancers
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();

CREATE FUNCTION provider_load_balancer_targets(lb provider_load_balancers) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(t.external_id ORDER BY t.external_id), '{}')
    FROM (SELECT DISTINCT i.external_id
            FROM instances i JOIN flavors f ON f.id = i.flavor_id
           WHERE lb.target_mode IN ('pool', 'instances')
             AND i.tenant_id = lb.tenant_id AND NOT i.draft
             AND i.provider_account_id = lb.provider_account_id
             AND i.external_id IS NOT NULL
             AND i.desired_state <> 'deleted'
             AND i.state NOT IN ('provisioning', 'deleting', 'deleted', 'error', 'lost')
             AND (split_part(f.offer_id, '/', 1) = lb.region OR split_part(f.offer_id, '/', 1) LIKE lb.region || '-%')
             -- The provider balances only to machines in the load balancer's VPC: its subnet, or no tenant network.
             AND i.subnet_id IS NOT DISTINCT FROM lb.subnet_id
             AND ((lb.target_mode = 'pool' AND i.pool_id = lb.pool_id)
                  OR (lb.target_mode = 'instances' AND i.id = ANY(lb.target_ids)))
          UNION
          SELECT DISTINCT r.external_id
            FROM provider_load_balancers r
           WHERE lb.target_mode = 'loadBalancers' AND r.id = ANY(lb.target_ids)
             AND r.tenant_id = lb.tenant_id AND r.provider_account_id = lb.provider_account_id
             AND r.scope = 'regional' AND r.external_id IS NOT NULL
             AND r.desired_state = 'present' AND r.state <> 'deleted') t
$$;
`,
};

// --- Views and input ---------------------------------------------------------------------------

type Desired = 'present' | 'deleted';
type Protocol = ProviderLoadBalancerRule['entryProtocol'];
const protocols: readonly Protocol[] = ['http', 'https', 'http2', 'tcp', 'udp'];

export interface LoadBalancerRuleInput {
  entryProtocol: Protocol;
  entryPort: number;
  targetProtocol: Protocol;
  targetPort: number;
  /** `https`/`http2` entries: the tenant's certificate (`pcert_…`) TLS terminates with. */
  certificateId?: string;
  tlsPassthrough?: boolean;
}
export interface LoadBalancerHealthCheckInput {
  protocol: 'http' | 'https' | 'tcp';
  port: number;
  path?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  healthyThreshold?: number;
  unhealthyThreshold?: number;
}
export interface LoadBalancerTargetsInput {
  pool?: true;
  instanceIds?: string[];
  loadBalancerIds?: string[];
}
/** What a load balancer does (create takes all of it; update replaces each part given). */
export interface LoadBalancerSettings {
  forwarding: LoadBalancerRuleInput[];
  healthCheck?: LoadBalancerHealthCheckInput;
  stickySessions?: { cookieName: string; ttlSeconds: number };
  sourceRanges?: { allow?: string[]; deny?: string[] };
  redirectHttpToHttps?: boolean;
  domains?: { name: string; certificateId?: string }[];
}

export interface ProviderLoadBalancerView extends LoadBalancerSettings {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  name: string;
  description?: string;
  scope: 'regional' | 'global';
  region?: string;
  /** regional: the tenant network and subnet it is on (absent: the account's default network). */
  networkId?: string;
  subnetId?: string;
  targets: LoadBalancerTargetsInput;
  /** Its public (or internal) IPv4 address, once the provider assigned it. */
  address?: string;
  addressV6?: string;
  state: ProviderResourceStatus;
  desiredState: Desired;
  message?: string;
  version: number;
  createdAt: string;
}

export interface CreateProviderLoadBalancerInput extends LoadBalancerSettings {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  description?: string;
  scope: 'regional' | 'global';
  region?: string;
  /**
   * regional: the subnet of a tenant network it is on; it reaches only instances on that subnet. Absent: the subnet
   * its named instances share, else the account's default network (instances on no tenant network).
   */
  subnetId?: string;
  targets: LoadBalancerTargetsInput;
  idempotencyKey: string;
}
export type ProviderLoadBalancerRef = { tenantId: string; loadBalancerId: string };
export interface UpdateProviderLoadBalancerInput
  extends ProviderLoadBalancerRef, Partial<LoadBalancerSettings> {
  targets?: LoadBalancerTargetsInput;
}
export interface ListProviderLoadBalancersInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}

const port = (value: unknown, what: string) => int(value, what, 1, 65_535);
const protocolOf = (value: unknown, what: string): Protocol => {
  if (!protocols.includes(value as Protocol)) fail(`${what} must be one of ${protocols.join(', ')}`);
  return value as Protocol;
};
const certificateIdOf = (value: unknown) => id(value, 'pcert', 'certificateId');
const loadBalancerIdOf = (value: unknown) => id(value, 'plb', 'loadBalancerId');

function ruleOf(raw: unknown): LoadBalancerRuleInput {
  const input = object(raw, [
    'entryProtocol',
    'entryPort',
    'targetProtocol',
    'targetPort',
    'certificateId',
    'tlsPassthrough',
  ]);
  const rule: LoadBalancerRuleInput = {
    entryProtocol: protocolOf(input.entryProtocol, 'entryProtocol'),
    entryPort: port(input.entryPort, 'entryPort'),
    targetProtocol: protocolOf(input.targetProtocol, 'targetProtocol'),
    targetPort: port(input.targetPort, 'targetPort'),
  };
  const certificateId = optional(input.certificateId, certificateIdOf);
  if (input.tlsPassthrough !== undefined && typeof input.tlsPassthrough !== 'boolean')
    fail('tlsPassthrough must be true or false');
  const tls = rule.entryProtocol === 'https' || rule.entryProtocol === 'http2';
  if (certificateId !== undefined && !tls)
    fail('certificateId is only for https and http2 entries');
  if (input.tlsPassthrough === true && rule.entryProtocol !== 'https')
    fail('tlsPassthrough is only for https entries');
  if (input.tlsPassthrough === true && certificateId !== undefined)
    fail('a tlsPassthrough entry takes no certificateId');
  if (tls && certificateId === undefined && input.tlsPassthrough !== true)
    fail('an https or http2 entry needs a certificateId (or tlsPassthrough for https)');
  if (certificateId !== undefined) rule.certificateId = certificateId;
  if (input.tlsPassthrough === true) rule.tlsPassthrough = true;
  return rule;
}

function healthCheckOf(raw: unknown): LoadBalancerHealthCheckInput {
  const input = object(raw, [
    'protocol',
    'port',
    'path',
    'intervalSeconds',
    'timeoutSeconds',
    'healthyThreshold',
    'unhealthyThreshold',
  ]);
  if (!['http', 'https', 'tcp'].includes(input.protocol as string))
    fail('healthCheck.protocol must be http, https or tcp');
  const check: LoadBalancerHealthCheckInput = {
    protocol: input.protocol as 'http' | 'https' | 'tcp',
    port: port(input.port, 'healthCheck.port'),
  };
  if (input.path !== undefined) {
    if (check.protocol === 'tcp') fail('healthCheck.path is only for http and https checks');
    if (typeof input.path !== 'string' || !/^\/[\x21-\x7e]{0,254}$/.test(input.path))
      fail('healthCheck.path must start with / and hold at most 255 printable characters');
    check.path = input.path;
  }
  const seconds = (field: 'intervalSeconds' | 'timeoutSeconds', min: number, max: number) => {
    if (input[field] !== undefined) check[field] = int(input[field], `healthCheck.${field}`, min, max);
  };
  seconds('intervalSeconds', 3, 300);
  seconds('timeoutSeconds', 3, 300);
  if (input.healthyThreshold !== undefined)
    check.healthyThreshold = int(input.healthyThreshold, 'healthCheck.healthyThreshold', 2, 10);
  if (input.unhealthyThreshold !== undefined)
    check.unhealthyThreshold = int(input.unhealthyThreshold, 'healthCheck.unhealthyThreshold', 2, 10);
  return check;
}

const ipv4Cidr = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\/(3[0-2]|[12]?\d)$/;
const ipv6Cidr = /^[0-9a-f:]{2,39}\/(12[0-8]|1[01]\d|[1-9]?\d)$/;
function rangesOf(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw) || raw.length > maxRanges)
    fail(`${what} must list at most ${maxRanges} CIDR ranges`);
  return raw.map((value) => {
    if (typeof value !== 'string' || !(ipv4Cidr.test(value) || (ipv6Cidr.test(value) && value.includes(':'))))
      fail(`${what} must list CIDR ranges such as 203.0.113.0/24`);
    return value;
  });
}

function idsOf(raw: unknown, what: string, parse: (value: unknown) => string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxTargets)
    fail(`${what} must list 1-${maxTargets} ids`);
  const ids = raw.map(parse);
  if (new Set(ids).size !== ids.length) fail(`${what} must not repeat an id`);
  return ids;
}

function targetsOf(raw: unknown): LoadBalancerTargetsInput {
  const input = object(raw, ['pool', 'instanceIds', 'loadBalancerIds']);
  const given = ['pool', 'instanceIds', 'loadBalancerIds'].filter((field) => input[field] !== undefined);
  if (given.length !== 1)
    fail('targets must be exactly one of { pool: true }, { instanceIds } or { loadBalancerIds }');
  if (input.pool !== undefined) {
    if (input.pool !== true) fail('targets.pool must be true');
    return { pool: true };
  }
  if (input.instanceIds !== undefined)
    return {
      instanceIds: idsOf(input.instanceIds, 'targets.instanceIds', (value) =>
        id(value, 'inst', 'instanceId'),
      ),
    };
  return {
    loadBalancerIds: idsOf(input.loadBalancerIds, 'targets.loadBalancerIds', loadBalancerIdOf),
  };
}

/** Parses the settings fields present in `input` (all optional here; create checks what it needs). */
function settingsOf(input: Record<string, unknown>): Partial<LoadBalancerSettings> {
  const out: Partial<LoadBalancerSettings> = {};
  if (input.forwarding !== undefined) {
    if (!Array.isArray(input.forwarding) || input.forwarding.length === 0 || input.forwarding.length > maxRules)
      fail(`forwarding must list 1-${maxRules} rules`);
    out.forwarding = input.forwarding.map(ruleOf);
    const entries = out.forwarding.map((rule) => `${rule.entryProtocol === 'udp' ? 'udp' : 'tcp'}/${rule.entryPort}`);
    if (new Set(entries).size !== entries.length) fail('forwarding must not repeat an entry port');
  }
  if (input.healthCheck !== undefined) out.healthCheck = healthCheckOf(input.healthCheck);
  if (input.stickySessions !== undefined) {
    const sticky = object(input.stickySessions, ['cookieName', 'ttlSeconds']);
    if (typeof sticky.cookieName !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(sticky.cookieName))
      fail('stickySessions.cookieName must be 1-40 letters, digits, _ or -');
    out.stickySessions = {
      cookieName: sticky.cookieName,
      ttlSeconds: int(sticky.ttlSeconds, 'stickySessions.ttlSeconds', 1, 604_800),
    };
  }
  if (input.sourceRanges !== undefined) {
    const ranges = object(input.sourceRanges, ['allow', 'deny']);
    out.sourceRanges = {};
    if (ranges.allow !== undefined) out.sourceRanges.allow = rangesOf(ranges.allow, 'sourceRanges.allow');
    if (ranges.deny !== undefined) out.sourceRanges.deny = rangesOf(ranges.deny, 'sourceRanges.deny');
  }
  if (input.redirectHttpToHttps !== undefined) {
    if (typeof input.redirectHttpToHttps !== 'boolean') fail('redirectHttpToHttps must be true or false');
    out.redirectHttpToHttps = input.redirectHttpToHttps;
  }
  if (input.domains !== undefined) {
    if (!Array.isArray(input.domains) || input.domains.length > maxDomains)
      fail(`domains must list at most ${maxDomains} host names`);
    out.domains = input.domains.map((raw) => {
      const domain = object(raw, ['name', 'certificateId']);
      const entry: { name: string; certificateId?: string } = { name: domainOf(domain.name, 'domains.name') };
      const certificateId = optional(domain.certificateId, certificateIdOf);
      if (certificateId !== undefined) entry.certificateId = certificateId;
      return entry;
    });
    if (new Set(out.domains.map((entry) => entry.name)).size !== out.domains.length)
      fail('domains must not repeat a name');
  }
  return out;
}

const settingFields = [
  'forwarding',
  'healthCheck',
  'stickySessions',
  'sourceRanges',
  'redirectHttpToHttps',
  'domains',
] as const;

/** What only one scope takes: a global one has no region or machine targets, a regional one no domains. */
function checkScope(scope: 'regional' | 'global', targets: LoadBalancerTargetsInput | undefined, domains: unknown) {
  if (scope === 'global') {
    if (targets && targets.loadBalancerIds === undefined)
      fail('a global load balancer targets regional load balancers: targets: { loadBalancerIds }');
  } else {
    if (targets && targets.loadBalancerIds !== undefined)
      fail('a regional load balancer targets instances: targets: { pool: true } or { instanceIds }');
    if (domains !== undefined) fail('domains are only for global load balancers');
  }
}

export function parseCreateProviderLoadBalancer(raw: unknown): CreateProviderLoadBalancerInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'description',
    'scope',
    'region',
    'subnetId',
    'targets',
    ...settingFields,
    'idempotencyKey',
  ]);
  if (input.scope !== undefined && input.scope !== 'regional' && input.scope !== 'global')
    fail('scope must be regional or global');
  const scope = (input.scope as 'regional' | 'global' | undefined) ?? 'regional';
  if (input.forwarding === undefined) fail('forwarding must list 1-15 rules');
  const targets = targetsOf(input.targets);
  checkScope(scope, targets, input.domains);
  const out: CreateProviderLoadBalancerInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: nameOf(input.name),
    scope,
    targets,
    ...(settingsOf(input) as LoadBalancerSettings),
    idempotencyKey: key(input.idempotencyKey),
  };
  if (scope === 'regional') out.region = regionOf(input.region);
  else if (input.region !== undefined) fail('a global load balancer has no region');
  const subnetId = optional(input.subnetId, (value) => id(value, 'snet', 'subnetId'));
  if (subnetId !== undefined) {
    if (scope !== 'regional') fail('a global load balancer is on no subnet');
    out.subnetId = subnetId;
  }
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  const description = optional(input.description, descriptionOf);
  if (description !== undefined) out.description = description;
  return out;
}
export function parseProviderLoadBalancerRef(raw: unknown): ProviderLoadBalancerRef {
  const input = object(raw, ['tenantId', 'loadBalancerId']);
  return { tenantId: tenant(input.tenantId), loadBalancerId: loadBalancerIdOf(input.loadBalancerId) };
}
export function parseUpdateProviderLoadBalancer(raw: unknown): UpdateProviderLoadBalancerInput {
  const input = object(raw, ['tenantId', 'loadBalancerId', 'targets', ...settingFields]);
  const out: UpdateProviderLoadBalancerInput = {
    tenantId: tenant(input.tenantId),
    loadBalancerId: loadBalancerIdOf(input.loadBalancerId),
    ...settingsOf(input),
  };
  if (input.targets !== undefined) out.targets = targetsOf(input.targets);
  if (Object.keys(out).length === 2) fail('update changes at least one of targets, forwarding and the rest');
  return out;
}
export function parseListProviderLoadBalancers(raw: unknown): ListProviderLoadBalancersInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListProviderLoadBalancersInput = { tenantId: tenant(input.tenantId) };
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

// JSON Schema.
const portSchema = (description: string): InputSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: 65_535,
  description,
});
const protocolSchema = (description: string): InputSchema => ({ enum: [...protocols], description });
const ruleSchema = strictObject(
  {
    entryProtocol: protocolSchema('The protocol clients connect with'),
    entryPort: portSchema('The port clients connect to'),
    targetProtocol: protocolSchema('The protocol the targets are reached with'),
    targetPort: portSchema('The port on the targets'),
    certificateId: idOf('pcert', 'https/http2 entries: the certificate TLS terminates with'),
    tlsPassthrough: { type: 'boolean', description: 'https entries: pass TLS through to the targets' },
  },
  ['entryProtocol', 'entryPort', 'targetProtocol', 'targetPort'],
);
const cidrList = (description: string): InputSchema => ({
  type: 'array',
  items: { type: 'string', maxLength: 43 },
  maxItems: maxRanges,
  description,
});
const settingsSchema: Record<string, InputSchema> = {
  forwarding: { type: 'array', items: ruleSchema, minItems: 1, maxItems: maxRules, description: 'Forwarding rules' },
  healthCheck: strictObject(
    {
      protocol: { enum: ['http', 'https', 'tcp'], description: 'How targets are checked' },
      port: portSchema('The port checked on each target'),
      path: { type: 'string', maxLength: 255, description: 'http/https: the path asked for (default /)' },
      intervalSeconds: { type: 'integer', minimum: 3, maximum: 300, description: 'Seconds between checks' },
      timeoutSeconds: { type: 'integer', minimum: 3, maximum: 300, description: 'Seconds a check may take' },
      healthyThreshold: { type: 'integer', minimum: 2, maximum: 10, description: 'Passes before healthy' },
      unhealthyThreshold: { type: 'integer', minimum: 2, maximum: 10, description: 'Failures before unhealthy' },
    },
    ['protocol', 'port'],
  ),
  stickySessions: strictObject(
    {
      cookieName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$', maxLength: 40, description: 'The cookie' },
      ttlSeconds: { type: 'integer', minimum: 1, maximum: 604_800, description: 'How long a client stays pinned' },
    },
    ['cookieName', 'ttlSeconds'],
  ),
  sourceRanges: strictObject(
    {
      allow: cidrList('Only these CIDR ranges connect'),
      deny: cidrList('These CIDR ranges never connect (deny wins)'),
    },
    [],
  ),
  redirectHttpToHttps: { type: 'boolean', description: 'Answer plain http with a redirect to https' },
  domains: {
    type: 'array',
    maxItems: maxDomains,
    items: strictObject(
      {
        name: { type: 'string', maxLength: 253, description: 'A host name the load balancer serves' },
        certificateId: idOf('pcert', 'The certificate TLS terminates with for this name'),
      },
      ['name'],
    ),
    description: 'global only: the host names it serves',
  },
};
const targetsSchema = strictObject(
  {
    pool: { const: true, description: "The tenant's instances in the load balancer's pool and region" },
    instanceIds: {
      type: 'array',
      items: idOf('inst', 'An instance of the tenant'),
      minItems: 1,
      maxItems: maxTargets,
      description: 'Instances of the tenant on the same provider account and in the same region',
    },
    loadBalancerIds: {
      type: 'array',
      items: idOf('plb', 'A regional load balancer of the tenant'),
      minItems: 1,
      maxItems: maxTargets,
      description: 'global only: regional load balancers of the tenant',
    },
  },
  [],
);
const loadBalancerIdSchema = idOf('plb', 'The load balancer');
export const providerLoadBalancerSchemas = {
  create: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the load balancer belongs to'),
      poolId: idOf('pool', 'A provider pool offered to the tenant, whose account provides load balancers'),
      name: nameSchema('The load balancer name, unique in the tenant, e.g. web'),
      description: descriptionSchema,
      scope: { enum: ['regional', 'global'], default: 'regional', description: 'regional or global (anycast)' },
      region: regionSchema,
      subnetId: idOf(
        'snet',
        'regional: a subnet of a tenant network; the load balancer reaches only instances on it (default: the subnet its named instances share, else the default network)',
      ),
      targets: targetsSchema,
      ...settingsSchema,
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'name', 'targets', 'forwarding', 'idempotencyKey'],
  ),
  update: strictObject(
    { tenantId: tenantIdSchema, loadBalancerId: loadBalancerIdSchema, targets: targetsSchema, ...settingsSchema },
    ['tenantId', 'loadBalancerId'],
  ),
  loadBalancer: strictObject({ tenantId: tenantIdSchema, loadBalancerId: loadBalancerIdSchema }, [
    'tenantId',
    'loadBalancerId',
  ]),
  list: listSchema,
};

// --- Rows --------------------------------------------------------------------------------------

export interface LoadBalancerRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  name: string;
  description: string | null;
  scope: 'regional' | 'global';
  region: string | null;
  spec: LoadBalancerSettings;
  target_mode: 'pool' | 'instances' | 'loadBalancers';
  target_ids: string[];
  certificate_ids: string[];
  network_id: string | null;
  subnet_id: string | null;
  applied_targets: string | null;
  applied_version: number | string | null;
  external_id: string | null;
  address: string | null;
  address_v6: string | null;
  charged: number;
  state: ProviderResourceStatus;
  desired_state: Desired;
  message: string | null;
  ensure_requested: boolean;
  request_hash: string;
  version: number | string;
  created_at: Date | string;
}

const loadBalancerColumns = `id, tenant_id, project_id, pool_id, provider_account_id, name, description, scope, region,
  spec, target_mode, target_ids, certificate_ids, network_id, subnet_id, applied_targets, applied_version, external_id, address, address_v6,
  charged, state, desired_state, message, ensure_requested, encode(request_hash, 'hex') AS request_hash, version,
  created_at`;
const iso = (value: Date | string) => new Date(value).toISOString();

function targetsView(row: LoadBalancerRow): LoadBalancerTargetsInput {
  if (row.target_mode === 'pool') return { pool: true };
  if (row.target_mode === 'instances') return { instanceIds: [...row.target_ids] };
  return { loadBalancerIds: [...row.target_ids] };
}

export function providerLoadBalancerView(row: LoadBalancerRow): ProviderLoadBalancerView {
  const view: ProviderLoadBalancerView = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    name: row.name,
    scope: row.scope,
    targets: targetsView(row),
    ...row.spec,
    state: row.state,
    desiredState: row.desired_state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
  };
  if (row.project_id) view.projectId = row.project_id;
  if (row.description) view.description = row.description;
  if (row.region) view.region = row.region;
  if (row.network_id) view.networkId = row.network_id;
  if (row.subnet_id) view.subnetId = row.subnet_id;
  if (row.address) view.address = row.address;
  if (row.address_v6) view.addressV6 = row.address_v6;
  if (row.message) view.message = row.message;
  return view;
}

export async function readLoadBalancer(
  tx: SqlTx,
  loadBalancerId: string,
  options: { tenantId?: string; lock?: boolean | 'share' } = {},
): Promise<LoadBalancerRow | undefined> {
  const lock = options.lock === 'share' ? ' FOR SHARE' : options.lock ? ' FOR UPDATE' : '';
  const { rows } = await tx.query<LoadBalancerRow>(
    `SELECT ${loadBalancerColumns} FROM provider_load_balancers
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${lock}`,
    [loadBalancerId, options.tenantId ?? null],
  );
  return rows[0];
}
async function requireLoadBalancer(
  tx: SqlTx,
  ref: ProviderLoadBalancerRef,
  lock = false,
): Promise<LoadBalancerRow> {
  const row = await readLoadBalancer(tx, ref.loadBalancerId, { tenantId: ref.tenantId, lock });
  if (!row) throw new ComputeError('NOT_FOUND', `Load balancer ${ref.loadBalancerId} not found`);
  return row;
}

function loadBalancerAuthz(
  row: {
    id: string;
    tenantId: string;
    accountId: string;
    poolId: string;
    scope: string;
    region?: string;
    projectId?: string;
  },
  ownerId: string,
) {
  return {
    type: 'provider-load-balancer',
    id: row.id,
    tenantId: row.tenantId,
    attributes: {
      providerAccountId: row.accountId,
      poolId: row.poolId,
      scope: row.scope,
      ...(row.region !== undefined ? { region: row.region } : {}),
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    },
    parentType: 'tenant',
    parentId: row.tenantId,
    ownerId,
  };
}

const workKind = 'vps.provider-resources';

/** The certificates `settings` names. */
function certificatesOf(settings: Partial<LoadBalancerSettings>): string[] {
  return [
    ...new Set([
      ...(settings.forwarding ?? []).flatMap((rule) => (rule.certificateId ? [rule.certificateId] : [])),
      ...(settings.domains ?? []).flatMap((domain) => (domain.certificateId ? [domain.certificateId] : [])),
    ]),
  ].sort();
}

/**
 * The certificates and targets a load balancer names must be the tenant's, on its provider account, and not being
 * deleted: another tenant's are NOT_FOUND (never confirmed to exist), others INVALID_INPUT or INVALID_STATE. Returns
 * the subnet each named instance is on (null: no tenant network). Certificates and target load balancers are read FOR
 * SHARE: their delete locks the row FOR UPDATE before it looks for users, so a delete and a create (or update) that
 * names the row run one after the other, and the second sees the first (a delete never misses a new user, a create
 * never names a row being deleted).
 */
async function checkReferences(
  tx: SqlTx,
  lb: { tenantId: string; accountId: string; region?: string; selfId?: string },
  certificateIds: readonly string[],
  targets: LoadBalancerTargetsInput | undefined,
): Promise<{ instanceSubnets: Map<string, string | null> }> {
  const instanceSubnets = new Map<string, string | null>();
  for (const certificateId of certificateIds) {
    const { rows } = await tx.query<{ provider_account_id: string; desired_state: string }>(
      `SELECT provider_account_id, desired_state FROM provider_certificates
        WHERE id = $1 AND tenant_id = $2 AND state <> 'deleted' FOR SHARE`,
      [certificateId, lb.tenantId],
    );
    const certificate = rows[0];
    if (!certificate) throw new ComputeError('NOT_FOUND', `Certificate ${certificateId} not found`);
    if (certificate.provider_account_id !== lb.accountId)
      throw new ComputeError(
        'INVALID_INPUT',
        `Certificate ${certificateId} is not on the provider account ${lb.accountId}`,
      );
    if (certificate.desired_state === 'deleted')
      throw new ComputeError('INVALID_STATE', `Certificate ${certificateId} is being deleted`);
  }
  for (const instanceId of targets?.instanceIds ?? []) {
    const instance = await targetInstance(tx, lb.tenantId, instanceId, {
      provider_account_id: lb.accountId,
      region: lb.region!,
    });
    instanceSubnets.set(instanceId, instance.subnet_id ?? null);
  }
  for (const loadBalancerId of targets?.loadBalancerIds ?? []) {
    const target = await readLoadBalancer(tx, loadBalancerId, { tenantId: lb.tenantId, lock: 'share' });
    if (!target || target.state === 'deleted')
      throw new ComputeError('NOT_FOUND', `Load balancer ${loadBalancerId} not found`);
    if (target.scope !== 'regional' || target.id === lb.selfId)
      throw new ComputeError('INVALID_INPUT', `Load balancer ${loadBalancerId} is not a regional load balancer`);
    if (target.provider_account_id !== lb.accountId)
      throw new ComputeError(
        'INVALID_INPUT',
        `Load balancer ${loadBalancerId} is not on the provider account ${lb.accountId}`,
      );
    if (target.desired_state === 'deleted')
      throw new ComputeError('INVALID_STATE', `Load balancer ${loadBalancerId} is being deleted`);
  }
  return { instanceSubnets };
}

/**
 * The subnet a regional load balancer is on: `subnetId`, else the one its named instances share, else none (the
 * account's default network). The provider balances only to machines in the load balancer's VPC, so named instances
 * on another subnet (or on none, for a load balancer on a subnet) are INVALID_INPUT. The subnet must be of a network
 * of the tenant's (another tenant's is NOT_FOUND), on the load balancer's account and region, and not being deleted;
 * its rows are held (FOR SHARE) until the transaction ends, so networks.delete and removeSubnet see the load balancer.
 */
async function placeLoadBalancer(
  tx: SqlTx,
  lb: { tenantId: string; accountId: string; region: string },
  subnetId: string | undefined,
  instanceSubnets: ReadonlyMap<string, string | null>,
): Promise<{ networkId: string; subnetId: string } | undefined> {
  let wanted = subnetId;
  if (wanted === undefined) {
    const distinct = [...new Set(instanceSubnets.values())];
    if (distinct.length > 1)
      throw new ComputeError(
        'INVALID_INPUT',
        'The named instances are on different subnets; a load balancer reaches the instances of one subnet (its VPC)',
        undefined,
        { reason: 'subnets' },
      );
    wanted = distinct[0] ?? undefined;
  } else
    for (const [instanceId, subnet] of instanceSubnets)
      if (subnet !== wanted)
        throw new ComputeError(
          'INVALID_INPUT',
          `Instance ${instanceId} is not on subnet ${wanted}; a load balancer reaches only the instances of its subnet`,
          undefined,
          { reason: 'subnet' },
        );
  if (wanted === undefined) return undefined;
  const { rows } = await tx.query<{
    network_id: string;
    region: string;
    subnet_desired: string;
    tenant_id: string;
    provider_account_id: string;
    network_desired: string;
  }>(
    `SELECT s.network_id, s.region, s.desired_state AS subnet_desired, n.tenant_id, n.provider_account_id,
            n.desired_state AS network_desired
       FROM network_subnets s JOIN networks n ON n.id = s.network_id
      WHERE s.id = $1 AND n.state <> 'deleted'
        FOR SHARE OF s, n`,
    [wanted],
  );
  const subnet = rows[0];
  if (!subnet || subnet.tenant_id !== lb.tenantId)
    throw new ComputeError('NOT_FOUND', `Subnet ${wanted} not found`);
  if (subnet.provider_account_id !== lb.accountId)
    throw new ComputeError('INVALID_INPUT', `Subnet ${wanted} is not on the provider account ${lb.accountId}`);
  if (subnet.region !== lb.region && zoneRegion(subnet.region) !== lb.region)
    throw new ComputeError('INVALID_INPUT', `Subnet ${wanted} is in ${subnet.region}, not in ${lb.region}`);
  if (subnet.subnet_desired === 'deleted' || subnet.network_desired === 'deleted')
    throw new ComputeError('INVALID_STATE', `Subnet ${wanted} is being deleted`);
  return { networkId: subnet.network_id, subnetId: wanted };
}

// --- API ---------------------------------------------------------------------------------------

const loadBalancerHash = (input: CreateProviderLoadBalancerInput) =>
  sha256Hex(canonical({ ...input, tenantId: undefined, idempotencyKey: undefined }));

const settingsJson = (settings: Partial<LoadBalancerSettings>): LoadBalancerSettings => {
  const out: Record<string, unknown> = {};
  for (const field of settingFields) if (settings[field] !== undefined) out[field] = settings[field];
  return out as unknown as LoadBalancerSettings;
};

/** `loadBalancers.create` transaction 1 (admission): decided on `provider-load-balancer/<id>`. */
export async function prepareCreateProviderLoadBalancer(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderLoadBalancerInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ProviderLoadBalancerView>> {
  const identity = caller(context);
  const loadBalancerId = await draftId('plb', input.tenantId, identity, input.idempotencyKey);
  const existing = await readLoadBalancer(tx, loadBalancerId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, await loadBalancerHash(input));
    return { status: 'replay', result: providerLoadBalancerView(existing) };
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'loadBalancers');
  if (input.region !== undefined) assertRegion(provider, input.region);
  await assertNameFree(tx, 'provider_load_balancers', input.tenantId, input.name);
  await context.authz.upsert(
    tx,
    loadBalancerAuthz(
      {
        id: loadBalancerId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        scope: input.scope,
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      identity,
    ),
  );
  return { status: 'decide', resource: { type: 'provider-load-balancer', id: loadBalancerId } };
}

export async function clearStagedProviderLoadBalancer(
  context: MethodContext,
  input: CreateProviderLoadBalancerInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const loadBalancerId = await draftId('plb', input.tenantId, context.caller.identityId, input.idempotencyKey);
  if (!(await readLoadBalancer(tx, loadBalancerId)))
    await context.authz.remove(tx, { type: 'provider-load-balancer', id: loadBalancerId, tenantId: input.tenantId });
}

/**
 * `loadBalancers.create` (in the method's transaction): books one `loadBalancers` quota, records the load balancer
 * `pending` and wakes the reconciler, which creates it once its certificates are ready.
 */
export async function createProviderLoadBalancer(
  deps: ProviderResourceDeps,
  context: MethodContext,
  input: CreateProviderLoadBalancerInput,
): Promise<ProviderLoadBalancerView> {
  const tx = context.sql;
  const identity = caller(context);
  const loadBalancerId = await draftId('plb', input.tenantId, identity, input.idempotencyKey);
  const hash = await loadBalancerHash(input);
  const existing = await readLoadBalancer(tx, loadBalancerId, { tenantId: input.tenantId });
  if (existing) {
    sameRequest(existing, hash);
    return providerLoadBalancerView(existing);
  }
  const provider = await resourceProvider(deps, tx, input.tenantId, input.poolId, 'loadBalancers');
  if (input.region !== undefined) assertRegion(provider, input.region);
  const certificateIds = certificatesOf(input);
  const { instanceSubnets } = await checkReferences(
    tx,
    {
      tenantId: input.tenantId,
      accountId: provider.accountId,
      ...(input.region !== undefined ? { region: input.region } : {}),
    },
    certificateIds,
    input.targets,
  );
  const placed =
    input.scope === 'regional'
      ? await placeLoadBalancer(
          tx,
          { tenantId: input.tenantId, accountId: provider.accountId, region: input.region! },
          input.subnetId,
          instanceSubnets,
        )
      : undefined;
  await lockTenant(tx, input.tenantId);
  await assertNameFree(tx, 'provider_load_balancers', input.tenantId, input.name);
  await chargeQuota(tx, input.tenantId, input.poolId, { [loadBalancerQuotaResource]: 1 });
  const mode = input.targets.pool ? 'pool' : input.targets.instanceIds ? 'instances' : 'loadBalancers';
  try {
    await tx.query(
      `INSERT INTO provider_load_balancers (id, tenant_id, project_id, pool_id, provider_account_id, name, description,
                                            scope, region, spec, target_mode, target_ids, certificate_ids, network_id,
                                            subnet_id, charged, state, desired_state, created_by, idempotency_key,
                                            request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::text[], $13::text[], $17, $18, 1, 'pending',
               'present', $14, $15, decode($16, 'hex'), 1)`,
      [
        loadBalancerId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        provider.accountId,
        input.name,
        input.description ?? null,
        input.scope,
        input.region ?? null,
        JSON.stringify(settingsJson(input)),
        mode,
        input.targets.instanceIds ?? input.targets.loadBalancerIds ?? [],
        certificateIds,
        identity,
        input.idempotencyKey,
        hash,
        placed?.networkId ?? null,
        placed?.subnetId ?? null,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Load balancer ${input.name} already exists`);
    throw error;
  }
  await deps.authz.upsert(
    tx,
    loadBalancerAuthz(
      {
        id: loadBalancerId,
        tenantId: input.tenantId,
        accountId: provider.accountId,
        poolId: input.poolId,
        scope: input.scope,
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      identity,
    ),
  );
  await deps.work.enqueue(tx, workKind, loadBalancerId);
  await publish(deps, tx, 'providerLoadBalancer', { id: loadBalancerId, tenant_id: input.tenantId }, 'created', {
    poolId: input.poolId,
    providerAccountId: provider.accountId,
    name: input.name,
    scope: input.scope,
    ...(input.region !== undefined ? { region: input.region } : {}),
  });
  return providerLoadBalancerView((await readLoadBalancer(tx, loadBalancerId))!);
}

export async function getProviderLoadBalancer(
  tx: SqlTx,
  ref: ProviderLoadBalancerRef,
): Promise<ProviderLoadBalancerView> {
  return providerLoadBalancerView(await requireLoadBalancer(tx, ref));
}

export async function listProviderLoadBalancers(
  tx: SqlTx,
  input: ListProviderLoadBalancersInput,
): Promise<{ items: ProviderLoadBalancerView[] }> {
  const { rows } = await tx.query<LoadBalancerRow>(
    `SELECT ${loadBalancerColumns} FROM provider_load_balancers
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 1000`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  return { items: rows.map(providerLoadBalancerView) };
}

/**
 * `loadBalancers.update`: replaces each part given (forwarding, health check, targets, …) in place; the scope, region
 * and pool never change (create another load balancer). The reconciler applies it (`updating` until the provider has).
 */
export async function updateProviderLoadBalancer(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: UpdateProviderLoadBalancerInput,
): Promise<ProviderLoadBalancerView> {
  const row = await requireLoadBalancer(tx, input, true);
  if (row.desired_state === 'deleted' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Load balancer ${row.id} is being deleted`);
  try {
    checkScope(row.scope, input.targets, input.domains);
  } catch (error) {
    throw new ComputeError('INVALID_INPUT', (error as Error).message);
  }
  const settings: LoadBalancerSettings = { ...row.spec };
  for (const field of settingFields)
    if (input[field] !== undefined) (settings as unknown as Record<string, unknown>)[field] = input[field];
  const certificateIds = certificatesOf(settings);
  const { instanceSubnets } = await checkReferences(
    tx,
    {
      tenantId: row.tenant_id,
      accountId: row.provider_account_id,
      ...(row.region !== null ? { region: row.region } : {}),
      selfId: row.id,
    },
    certificateIds.filter((certificateId) => !row.certificate_ids.includes(certificateId)),
    input.targets,
  );
  // The subnet (the provider-side VPC) never changes: named instances must be on it.
  for (const [instanceId, subnet] of instanceSubnets)
    if (subnet !== row.subnet_id)
      throw new ComputeError(
        'INVALID_INPUT',
        row.subnet_id
          ? `Instance ${instanceId} is not on subnet ${row.subnet_id}; a load balancer reaches only the instances of its subnet`
          : `Instance ${instanceId} is on a tenant network; this load balancer reaches only instances on no tenant network`,
        undefined,
        { reason: 'subnet' },
      );
  const targets = input.targets ?? targetsView(row);
  const mode = targets.pool ? 'pool' : targets.instanceIds ? 'instances' : 'loadBalancers';
  await tx.query(
    `UPDATE provider_load_balancers
        SET spec = $2::jsonb, target_mode = $3, target_ids = $4::text[], certificate_ids = $5::text[],
            state = CASE WHEN state = 'pending' THEN 'pending' ELSE 'updating' END, message = NULL,
            version = version + 1
      WHERE id = $1`,
    [
      row.id,
      JSON.stringify(settingsJson(settings)),
      mode,
      targets.instanceIds ?? targets.loadBalancerIds ?? [],
      certificateIds,
    ],
  );
  await deps.work.enqueue(tx, workKind, row.id);
  await publish(deps, tx, 'providerLoadBalancer', row, 'updated', {
    changed: [...settingFields.filter((field) => input[field] !== undefined), ...(input.targets ? ['targets'] : [])],
  });
  return providerLoadBalancerView((await readLoadBalancer(tx, row.id))!);
}

/**
 * `loadBalancers.delete`: INVALID_STATE while a global load balancer of the tenant targets it; the reconciler deletes
 * it at the provider and refunds its quota.
 */
export async function deleteProviderLoadBalancer(
  deps: ProviderResourceDeps,
  tx: SqlTx,
  input: ProviderLoadBalancerRef,
): Promise<ProviderLoadBalancerView> {
  const row = await requireLoadBalancer(tx, input, true);
  if (row.desired_state === 'deleted') return providerLoadBalancerView(row);
  const users = await tx.query<{ id: string }>(
    `SELECT id FROM provider_load_balancers
      WHERE target_mode = 'loadBalancers' AND $1 = ANY(target_ids) AND desired_state = 'present'
        AND state <> 'deleted' ORDER BY id LIMIT 5`,
    [row.id],
  );
  if (users.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Load balancer ${row.id} is a target of ${users.rows.map((user) => user.id).join(', ')}`,
      undefined,
      { reason: 'inUse' },
    );
  await tx.query(
    `UPDATE provider_load_balancers SET desired_state = 'deleted', state = 'deleting', message = NULL,
            version = version + 1
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, workKind, row.id);
  await publish(deps, tx, 'providerLoadBalancer', row, 'deleting');
  return providerLoadBalancerView((await readLoadBalancer(tx, row.id))!);
}

/**
 * Called when an instance's deletion finishes: the load balancers it may have been a target of (the tenant's, in
 * its pool or naming it) are woken, so the provider stops sending it traffic now rather than at the periodic pass.
 */
export async function onLoadBalancedInstanceGone(
  deps: Pick<ProviderResourceDeps, 'work'>,
  tx: SqlTx,
  instanceId: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT lb.id FROM provider_load_balancers lb JOIN instances i ON i.id = $1
      WHERE lb.tenant_id = i.tenant_id AND lb.state <> 'deleted' AND lb.desired_state = 'present'
        AND ((lb.target_mode = 'pool' AND lb.pool_id = i.pool_id)
             OR (lb.target_mode = 'instances' AND i.id = ANY(lb.target_ids)))
      ORDER BY lb.id`,
    [instanceId],
  );
  for (const row of rows) await deps.work.enqueue(tx, workKind, row.id);
}

// --- The reconciler ----------------------------------------------------------------------------

interface LoadedLoadBalancer {
  lb: LoadBalancerRow;
  targets: string[];
  /** regional on a subnet: its network's and subnet's provider-side names, as instances on it were placed. */
  network?: { network: string; subnet: string };
  /** vps certificate id -> its provider id, state and whether it is wanted. */
  certificates: Map<string, { external_id: string | null; state: string; desired_state: string }>;
}

async function loadLoadBalancer(tx: SqlTx, loadBalancerId: string): Promise<LoadedLoadBalancer | undefined> {
  const lb = await readLoadBalancer(tx, loadBalancerId);
  if (!lb) return undefined;
  const targets = await tx.query<{ targets: string[] }>(
    `SELECT provider_load_balancer_targets(lb) AS targets FROM provider_load_balancers lb WHERE lb.id = $1`,
    [loadBalancerId],
  );
  const certificates = await tx.query<{ id: string; external_id: string | null; state: string; desired_state: string }>(
    `SELECT id, external_id, state, desired_state FROM provider_certificates
      WHERE id = ANY($1::text[]) AND tenant_id = $2 AND provider_account_id = $3`,
    [lb.certificate_ids, lb.tenant_id, lb.provider_account_id],
  );
  let network: { network: string; subnet: string } | undefined;
  if (lb.network_id && lb.subnet_id) {
    const { rows } = await tx.query<{ external_name: string | null }>(
      `SELECT external_name FROM networks WHERE id = $1`,
      [lb.network_id],
    );
    network = {
      network: providerResourceName(lb.network_id, rows[0]?.external_name),
      subnet: providerResourceName(lb.subnet_id),
    };
  }
  return {
    lb,
    targets: [...(targets.rows[0]?.targets ?? [])],
    ...(network ? { network } : {}),
    certificates: new Map(certificates.rows.map((row) => [row.id, row])),
  };
}

export async function reconcileLoadBalancer(run: Run, loadBalancerId: string): Promise<void> {
  const loaded = await run.sql.transaction(async (tx) => {
    const found = await loadLoadBalancer(tx, loadBalancerId);
    if (!found) return undefined;
    return { ...found, account: await readAccount(tx, found.lb.provider_account_id) };
  });
  if (!loaded || loaded.lb.state === 'deleted') return;
  const { lb } = loaded;
  const set = async (fields: Fields) => {
    const state = fields.state as ProviderResourceStatus | undefined;
    const becameReady = state === 'ready' && lb.state !== 'ready';
    const becameError = state === 'error' && (lb.state !== 'error' || lb.message !== fields.message);
    await run.write(
      'provider_load_balancers',
      lb,
      { ...fields, ...(becameReady && !lb.applied_version ? { ready_at: new Date(run.deps.clock.now()).toISOString() } : {}) },
      async (tx) => {
        if (becameReady)
          await publish(run.deps, tx, 'providerLoadBalancer', lb, 'ready', {
            ...(typeof fields.address === 'string' ? { address: fields.address } : {}),
          });
        if (becameError)
          await publish(run.deps, tx, 'providerLoadBalancer', lb, 'error', { message: String(fields.message ?? '') });
      },
    );
  };
  const loadBalancers = await run.client(loaded.account, lb.provider_account_id, 'loadBalancers');
  if (typeof loadBalancers === 'string') {
    await set(settled('error', loadBalancers));
    return;
  }
  if (lb.desired_state === 'deleted') await teardownLoadBalancer(run, loadBalancers, lb, set);
  else await convergeLoadBalancer(run, loadBalancers, loaded, set);
}

/** The provider spec, or why it cannot be built yet (`wait`: a certificate is not ready; `error`: one is gone). */
function loadBalancerSpec(
  loaded: LoadedLoadBalancer,
): { spec: ProviderLoadBalancerSpec } | { wait: string } | { error: string } {
  const { lb } = loaded;
  const certificate = (certificateId: string): string | { wait: string } | { error: string } => {
    const row = loaded.certificates.get(certificateId);
    if (!row || row.state === 'deleted' || row.desired_state === 'deleted')
      return { error: `Certificate ${certificateId} is deleted; update the load balancer` };
    if (row.state === 'error') return { error: `Certificate ${certificateId} is in error` };
    if (row.state !== 'ready' || !row.external_id) return { wait: `Waiting for certificate ${certificateId}` };
    return row.external_id;
  };
  const forwarding: ProviderLoadBalancerRule[] = [];
  for (const rule of lb.spec.forwarding) {
    const out: ProviderLoadBalancerRule = {
      entryProtocol: rule.entryProtocol,
      entryPort: rule.entryPort,
      targetProtocol: rule.targetProtocol,
      targetPort: rule.targetPort,
      ...(rule.tlsPassthrough ? { tlsPassthrough: true } : {}),
    };
    if (rule.certificateId) {
      const resolved = certificate(rule.certificateId);
      if (typeof resolved !== 'string') return resolved;
      out.certificate = resolved;
    }
    forwarding.push(out);
  }
  const domains: { name: string; certificate?: string }[] = [];
  for (const domain of lb.spec.domains ?? []) {
    if (!domain.certificateId) {
      domains.push({ name: domain.name });
      continue;
    }
    const resolved = certificate(domain.certificateId);
    if (typeof resolved !== 'string') return resolved;
    domains.push({ name: domain.name, certificate: resolved });
  }
  const spec: ProviderLoadBalancerSpec = {
    name: edgeResourceName(lb.id),
    scope: lb.scope,
    forwarding,
    targets: lb.scope === 'regional' ? { machines: loaded.targets } : { loadBalancers: loaded.targets },
    ...(lb.region ? { region: lb.region } : {}),
    ...(loaded.network ? { network: loaded.network } : {}),
    ...(lb.spec.healthCheck ? { healthCheck: lb.spec.healthCheck } : {}),
    ...(lb.spec.stickySessions ? { stickySessions: lb.spec.stickySessions } : {}),
    ...(lb.spec.sourceRanges ? { sourceRanges: lb.spec.sourceRanges } : {}),
    ...(lb.spec.redirectHttpToHttps !== undefined ? { redirectHttpToHttps: lb.spec.redirectHttpToHttps } : {}),
    ...(lb.scope === 'global' ? { domains } : {}),
    ...(lb.external_id ? { id: lb.external_id } : {}),
  };
  return { spec };
}

async function convergeLoadBalancer(
  run: Run,
  loadBalancers: ProviderLoadBalancers,
  loaded: LoadedLoadBalancer,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  const { lb } = loaded;
  const built = loadBalancerSpec(loaded);
  if ('error' in built) {
    await set(settled('error', built.error));
    return;
  }
  if ('wait' in built) {
    // A certificate still being issued: the certificate's own run settles it, the periodic pass wakes this one.
    run.inFlight = true;
    await set(settled(lb.external_id ? 'updating' : 'pending', built.wait));
    return;
  }
  // Load balancers are found again by name (the provider's ensure looks before it creates).
  if (!lb.external_id && !lb.ensure_requested) {
    if (!(await run.write('provider_load_balancers', lb, { ensure_requested: true }))) return;
  }
  const ensured = await run.attempt(`ensure ${lb.id}`, () =>
    loadBalancers.ensureLoadBalancer(built.spec, run.call(`ensure:${lb.id}:${lb.version}`)),
  );
  if (ensured === undefined) return;
  if (ensured === 'missing' || ensured.state === 'error' || !ensured.id) {
    await set(
      settled('error', ensured === 'missing' ? 'The provider did not answer' : (ensured.message ?? 'No load balancer id')),
    );
    return;
  }
  const fields: Fields = {
    external_id: ensured.id,
    ...(output(ensured, 'address') ? { address: output(ensured, 'address')! } : {}),
    ...(output(ensured, 'addressV6') ? { address_v6: output(ensured, 'addressV6')! } : {}),
  };
  if (ensured.state !== 'ready') {
    run.inFlight = true;
    await set({ ...fields, ...settled(ensured.state === 'updating' ? 'updating' : lb.external_id ? 'updating' : 'pending') });
    return;
  }
  // What the provider now has: the periodic pass compares it with what the load balancer should reach.
  await set({
    ...fields,
    ...settled('ready'),
    applied_targets: loaded.targets.join(','),
    applied_version: Number(lb.version),
  });
}

async function teardownLoadBalancer(
  run: Run,
  loadBalancers: ProviderLoadBalancers,
  lb: LoadBalancerRow,
  set: (fields: Fields) => Promise<void>,
): Promise<void> {
  const finish = () =>
    run.write('provider_load_balancers', lb, { state: 'deleted', message: null, charged: 0 }, async (tx) => {
      if (Number(lb.charged) > 0)
        await refundQuota(tx, lb.tenant_id, lb.pool_id, { [loadBalancerQuotaResource]: Number(lb.charged) });
      await run.deps.authz.remove(tx, { type: 'provider-load-balancer', id: lb.id });
      await publish(run.deps, tx, 'providerLoadBalancer', lb, 'deleted');
    });
  let externalId = lb.external_id;
  if (!externalId && lb.ensure_requested) {
    // A create whose answer was lost: found by its name when the provider can look one up without creating it.
    if (loadBalancers.findLoadBalancer) {
      const found = await run.attempt(`find ${lb.id}`, () =>
        loadBalancers.findLoadBalancer!(edgeResourceName(lb.id), run.call(`find:${lb.id}`)),
      );
      if (found === undefined) return;
      if (found !== 'missing' && found.state === 'error') {
        await set(settled('error', found.message));
        return;
      }
      if (found !== 'missing' && found.id) externalId = found.id;
    } else
      run.deps.log.warn('providerResources: deleting a load balancer whose create answer was lost', {
        loadBalancerId: lb.id,
        providerAccountId: lb.provider_account_id,
      });
  }
  if (!externalId) {
    await finish();
    return;
  }
  const deleted = await run.attempt(`delete ${lb.id}`, () =>
    loadBalancers.deleteLoadBalancer(externalId!, run.call(`delete:${lb.id}`)),
  );
  if (deleted === undefined) return;
  if (deleted === 'missing' || deleted.state === 'deleted') {
    await finish();
    return;
  }
  if (deleted.state === 'error' && run.lastCode === 'INVALID_STATE' && run.lastReason === 'notManaged') {
    run.deps.log.warn('providerResources: the load balancer at this id is not ours; not deleted', {
      loadBalancerId: lb.id,
      providerAccountId: lb.provider_account_id,
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

/**
 * Live load balancers that are not settled: not `ready`, or the provider was last given another version of the row
 * or another set of targets than what it reaches now (an instance of its pool gained a machine or went away).
 */
export const unsettledLoadBalancersSql = `
  SELECT lb.id FROM provider_load_balancers lb
   WHERE lb.state <> 'deleted'
     AND (lb.state <> 'ready' OR lb.desired_state <> 'present'
          OR lb.applied_version IS DISTINCT FROM lb.version
          OR lb.applied_targets IS DISTINCT FROM array_to_string(provider_load_balancer_targets(lb), ','))`;
export const liveLoadBalancersSql = `SELECT id FROM provider_load_balancers WHERE state <> 'deleted'`;

