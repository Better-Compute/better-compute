// The IAM catalog (PLAN.md §12.3) and the normative method → action table (§9.2), as data.
// Browser-safe and free of better-iam imports: `ComputeResourceType` is shaped so it is assignable
// to better-iam's `ResourceTypeDefinition`.

import { ComputeError } from './errors.js';
import type { MethodKind } from './extension.js';

export type AttributeType = 'string' | 'number' | 'boolean';

/** A resource type as better-iam's plugin catalog takes it. */
export interface ComputeResourceType {
  description?: string;
  /** Fully qualified actions (`compute:<area>:<verb>`). */
  actions?: string[];
  /** At most 64; exposed to policies as `resource.<name>`. */
  attributes?: Record<string, AttributeType>;
  parent?: string;
  /** At most 32; exposed as `resource.relations` and, through the parent, `resource.parentRelations`. */
  relations?: string[];
}

/** better-iam's limits for one resource type. */
export const resourceTypeLimits = { attributes: 64, relations: 32, typeLength: 64 } as const;

/** Compute's resource kinds; the IAM type is the configured prefix plus the kind (`compute-pool`). */
export const computeResourceKinds = [
  'fleet',
  'tenant',
  'project',
  'site',
  'pool',
  'node',
  'reservation',
  'instance',
  'image',
  'profile',
  'provider-account',
] as const;
export type ComputeResourceKind = (typeof computeResourceKinds)[number];

/** The only id of the `fleet` scope type; it resolves only in the root tenant. */
export const fleetResourceId = 'global';

const a = <A extends string, V extends string>(area: A, ...verbs: V[]): `compute:${A}:${V}`[] =>
  verbs.map((verb) => `compute:${area}:${verb}` as `compute:${A}:${V}`);

interface KindDefinition {
  description: string;
  actions: readonly string[];
  attributes?: Readonly<Record<string, AttributeType>>;
  parent?: ComputeResourceKind;
  relations?: readonly string[];
}

// Normative: every action named in §9.2 appears here (checked by tests/core-catalog.test.ts).
const definitions = {
  fleet: {
    description: 'The platform fleet (scope type; resolves only in the root tenant)',
    actions: [
      ...a('fleet', 'admin'),
      ...a('sites', 'manage'),
      ...a('pools', 'create'),
      ...a('quotas', 'manage'),
      ...a('secrets', 'manage'),
      ...a('images', 'publish'),
      ...a('providers', 'manage'),
      ...a('drivers', 'read'),
    ],
  },
  tenant: {
    description: "A tenant's compute scope (scope type; resolves only in that tenant)",
    actions: [
      ...a('sites', 'read', 'manage'),
      ...a('pools', 'read', 'create'),
      ...a('capacity', 'read'),
      ...a('nodes', 'read'),
      ...a('reservations', 'read'),
      ...a('instances', 'read'),
      ...a('projects', 'read', 'manage'),
      ...a('quotas', 'read'),
      ...a('usage', 'read'),
      ...a('events', 'read'),
      ...a('webhooks', 'manage'),
      ...a('drivers', 'read'),
      ...a('secrets', 'manage'),
      ...a('profiles', 'read', 'manage'),
      ...a('images', 'read', 'publish'),
      ...a('providers', 'read', 'manage'),
    ],
  },
  project: {
    description: 'A project (scope type; resolves in its owner tenant)',
    actions: [...a('projects', 'read', 'manage'), ...a('usage', 'read')],
    relations: ['member', 'admin'],
  },
  site: {
    description: 'A boot and failure domain',
    actions: a('sites', 'read', 'manage'),
    attributes: { region: 'string', iamRegion: 'string', kind: 'string' },
  },
  pool: {
    description: 'A scheduling and policy domain',
    actions: [
      ...a('pools', 'read', 'manage', 'share'),
      ...a('capacity', 'read'),
      ...a('join-tokens', 'create', 'read', 'revoke'),
      ...a('flavors', 'read', 'manage'),
      ...a('nodes', 'provision'),
    ],
    relations: ['viewer', 'user', 'operator', 'admin'],
    attributes: {
      region: 'string',
      class: 'string',
      gpuModel: 'string',
      gpuMemoryGb: 'number',
      sharing: 'string',
    },
  },
  node: {
    description: 'A machine',
    parent: 'pool',
    relations: ['operator'],
    actions: [
      ...a(
        'nodes',
        'read',
        'update',
        'cordon',
        'drain',
        'provision',
        'power',
        'exec',
        'console',
        'ssh-root',
        'delete',
        'revoke-identity',
      ),
      ...a('workflows', 'read', 'manage'),
    ],
    attributes: {
      region: 'string',
      gpuModel: 'string',
      gpuCount: 'number',
      lifecycle: 'string',
      trust: 'string',
      dedicatedTo: 'string',
    },
  },
  reservation: {
    description: 'A GPU reservation (drafts are decided before they exist)',
    parent: 'pool',
    actions: a('reservations', 'create', 'read', 'extend', 'release'),
    attributes: {
      region: 'string',
      gpuModel: 'string',
      gpuCount: 'number',
      durationHours: 'number',
      binding: 'string',
      projectId: 'string',
      spot: 'boolean',
    },
  },
  instance: {
    description: 'A VPS instance',
    parent: 'pool',
    actions: a('instances', 'create', 'read', 'update', 'exec', 'delete'),
    attributes: {
      vcpu: 'number',
      memoryGiB: 'number',
      gpus: 'number',
      imageId: 'string',
      imageVerified: 'boolean',
      projectId: 'string',
    },
  },
  image: {
    description: 'An OS or ramdisk image',
    actions: a('images', 'read', 'publish'),
    attributes: { visibility: 'string', verified: 'boolean' },
  },
  profile: {
    description: 'A provisioning profile',
    actions: a('profiles', 'read', 'manage'),
  },
  'provider-account': {
    description: 'An account with an external capacity provider',
    actions: a('providers', 'read', 'manage'),
  },
} as const satisfies Record<ComputeResourceKind, KindDefinition>;

/** Every compute action. */
export type ComputeAction = (typeof definitions)[ComputeResourceKind]['actions'][number];
/** An action without its `compute:` namespace, as §9.2 writes them (`pools:read`). */
export type ComputeActionName = ComputeAction extends `compute:${infer Name}` ? Name : never;

/** Every action of the catalog, deduplicated, in catalog order. */
export const computeActions: readonly ComputeAction[] = Object.freeze([
  ...new Set(
    Object.values(definitions).flatMap((kind) => kind.actions as readonly ComputeAction[]),
  ),
]);

const prefixPattern = /^[a-z][a-z0-9-]{0,31}$/;

/** The IAM resource type of a kind under a prefix: `resourceType('pool')` is `compute-pool`. */
export function resourceType(kind: ComputeResourceKind, prefix = 'compute-'): string {
  return `${prefix}${kind}`;
}

/**
 * The resource types compute contributes to better-iam's catalog, keyed by prefixed type name. All
 * are app-owned: compute resolves them and never registers them with IAM.
 */
export function computeResourceTypes(prefix = 'compute-'): Record<string, ComputeResourceType> {
  if (!prefixPattern.test(prefix))
    throw new ComputeError(
      'INVALID_CONFIG',
      `Invalid resource type prefix ${JSON.stringify(prefix)}`,
    );
  const types: Record<string, ComputeResourceType> = {};
  for (const kind of computeResourceKinds) {
    const definition: KindDefinition = definitions[kind];
    const type: ComputeResourceType = {
      description: definition.description,
      actions: [...definition.actions],
    };
    if (definition.attributes) type.attributes = { ...definition.attributes };
    if (definition.parent) type.parent = resourceType(definition.parent, prefix);
    if (definition.relations) type.relations = [...definition.relations];
    types[resourceType(kind, prefix)] = type;
  }
  return types;
}

// ---------------------------------------------------------------------------------------------
// §9.2: groups, methods and their IAM actions (normative)
// ---------------------------------------------------------------------------------------------

export type ApiPhase = 'v0.1' | 'v0.2' | 'v0.3' | 'v0.4' | 'v0.5';
export type ApiModule =
  | 'server'
  | 'capacity'
  | 'inventory'
  | 'provision'
  | 'metal'
  | 'vps'
  /** `@better-compute/events` (webhooks); an injected module like provision. */
  | 'events'
  /** `@better-compute/fleet` (FleetConfig as code); an injected module. */
  | 'fleet'
  /** `@better-compute/rollout` (daemon releases and staged rollouts, v0.4); an injected module. */
  | 'rollout'
  /** The server's tunnels module (`tunnels.open`, `nodes.issueSshCert`), hosted when `tunnels` is configured. */
  | 'tunnels';

export interface ApiTarget {
  action: ComputeAction;
  resource: ComputeResourceKind;
}

/** One method of the public API and how it is authorized. */
export interface ApiSurfaceRow {
  group: string;
  method: string;
  /** The action decided before the handler; `null` for public methods. */
  action: ComputeAction | null;
  /** The resource kind decided on (the draft's type for creates); `null` for public methods. */
  resource: ComputeResourceKind | null;
  kind: MethodKind;
  phase: ApiPhase;
  module: ApiModule;
  /** Follows the list recipe (coarse gate on the scope, then per-item checks or an owner filter). */
  list?: true;
  /** Other `(action, resource)` pairs the method decides on for some inputs ("… or @ …" in §9.2). */
  alternatives?: readonly ApiTarget[];
}

type Entry = readonly [
  method: string,
  kind: MethodKind,
  action: ComputeActionName | null,
  resource: ComputeResourceKind | null,
  phase: ApiPhase,
  options?: {
    list?: true;
    or?: readonly (readonly [ComputeActionName, ComputeResourceKind])[];
    /** A method another module contributes to this group (`nodes.issueSshCert` from `tunnels`). */
    module?: ApiModule;
  },
];

const rows: ApiSurfaceRow[] = [];
function group(name: string, module: ApiModule, entries: readonly Entry[]): void {
  for (const [method, kind, action, resource, phase, options] of entries) {
    const row: ApiSurfaceRow = {
      group: name,
      method,
      action: action === null ? null : (`compute:${action}` as ComputeAction),
      resource,
      kind,
      phase,
      module: options?.module ?? module,
    };
    if (options?.list) row.list = true;
    if (options?.or)
      row.alternatives = options.or.map(([alternative, target]) => ({
        action: `compute:${alternative}` as ComputeAction,
        resource: target,
      }));
    rows.push(row);
  }
}

const list = { list: true } as const;

group('system', 'server', [
  ['whoami', 'public', null, null, 'v0.1'],
  ['version', 'public', null, null, 'v0.1'],
  ['selfCheck', 'read', 'fleet:admin', 'fleet', 'v0.1'],
]);
group('projects', 'server', [
  ['create', 'mutation', 'projects:manage', 'tenant', 'v0.1'],
  ['get', 'read', 'projects:read', 'project', 'v0.1'],
  ['list', 'read', 'projects:read', 'tenant', 'v0.1', list],
  ['archive', 'mutation', 'projects:manage', 'project', 'v0.2'],
]);
group('sites', 'server', [
  ['list', 'read', 'sites:read', 'tenant', 'v0.1', list],
  ['get', 'read', 'sites:read', 'site', 'v0.1'],
  ['create', 'mutation', 'sites:manage', 'fleet', 'v0.1', { or: [['sites:manage', 'tenant']] }],
  ['update', 'mutation', 'sites:manage', 'site', 'v0.2'],
  ['delete', 'mutation', 'sites:manage', 'site', 'v0.2'],
]);
group('siteTokens', 'server', [
  ['create', 'mutation', 'sites:manage', 'site', 'v0.2'],
  ['revoke', 'mutation', 'sites:manage', 'site', 'v0.2'],
]);
group('pools', 'capacity', [
  ['list', 'read', 'pools:read', 'tenant', 'v0.1', list],
  ['get', 'read', 'pools:read', 'pool', 'v0.1'],
  ['create', 'mutation', 'pools:create', 'fleet', 'v0.1', { or: [['pools:create', 'tenant']] }],
  ['capacity', 'read', 'capacity:read', 'pool', 'v0.1'],
  ['offer', 'mutation', 'pools:share', 'pool', 'v0.1'],
  ['unoffer', 'mutation', 'pools:share', 'pool', 'v0.1'],
  ['update', 'mutation', 'pools:manage', 'pool', 'v0.2'],
  ['archive', 'mutation', 'pools:manage', 'pool', 'v0.2'],
]);
group('joinTokens', 'server', [
  ['create', 'mutation', 'join-tokens:create', 'pool', 'v0.1'],
  ['list', 'read', 'join-tokens:read', 'pool', 'v0.1'],
  ['revoke', 'mutation', 'join-tokens:revoke', 'pool', 'v0.1'],
]);
group('joinRequests', 'server', [
  ['list', 'read', 'join-tokens:read', 'pool', 'v0.2'],
  ['approve', 'mutation', 'join-tokens:create', 'pool', 'v0.2'],
  ['reject', 'mutation', 'join-tokens:create', 'pool', 'v0.2'],
]);
group('nodes', 'server', [
  ['list', 'read', 'nodes:read', 'tenant', 'v0.1', list],
  ['get', 'read', 'nodes:read', 'node', 'v0.1'],
  ['events', 'read', 'nodes:read', 'node', 'v0.1'],
  ['cordon', 'mutation', 'nodes:cordon', 'node', 'v0.1'],
  ['uncordon', 'mutation', 'nodes:cordon', 'node', 'v0.1'],
  ['drain', 'mutation', 'nodes:drain', 'node', 'v0.1'],
  ['label', 'mutation', 'nodes:update', 'node', 'v0.1'],
  ['taint', 'mutation', 'nodes:update', 'node', 'v0.1'],
  ['adopt', 'mutation', 'nodes:provision', 'node', 'v0.1'],
  ['revokeIdentity', 'mutation', 'nodes:revoke-identity', 'node', 'v0.1'],
  ['delete', 'mutation', 'nodes:delete', 'node', 'v0.2'],
  ['issueSshCert', 'mutation', 'nodes:ssh-root', 'node', 'v0.3', { module: 'tunnels' }],
  ['revokeSshCert', 'mutation', 'nodes:ssh-root', 'node', 'v0.3', { module: 'tunnels' }],
]);
group('inventory', 'inventory', [
  ['get', 'read', 'nodes:read', 'node', 'v0.1'],
  ['history', 'read', 'nodes:read', 'node', 'v0.2'],
  ['diff', 'read', 'nodes:read', 'node', 'v0.2'],
]);
group('capacity', 'capacity', [
  ['summary', 'read', 'capacity:read', 'tenant', 'v0.1'],
  ['byPool', 'read', 'capacity:read', 'pool', 'v0.2'],
  ['preview', 'read', 'capacity:read', 'pool', 'v0.2'],
  ['timeline', 'read', 'capacity:read', 'pool', 'v0.2'],
]);
group('reservations', 'capacity', [
  ['create', 'mutation', 'reservations:create', 'reservation', 'v0.1'],
  ['get', 'read', 'reservations:read', 'reservation', 'v0.1'],
  ['list', 'read', 'reservations:read', 'tenant', 'v0.1', list],
  ['release', 'mutation', 'reservations:release', 'reservation', 'v0.1'],
  ['cancel', 'mutation', 'reservations:release', 'reservation', 'v0.2'],
  ['extend', 'mutation', 'reservations:extend', 'reservation', 'v0.1'],
  ['renew', 'mutation', 'reservations:extend', 'reservation', 'v0.1'],
]);
group('quotas', 'capacity', [
  ['get', 'read', 'quotas:read', 'tenant', 'v0.1'],
  ['set', 'mutation', 'quotas:manage', 'fleet', 'v0.2'],
]);
group('commands', 'server', [
  ['run', 'mutation', 'nodes:exec', 'node', 'v0.1'],
  ['get', 'read', 'nodes:read', 'node', 'v0.1'],
  ['list', 'read', 'nodes:read', 'node', 'v0.1'],
  ['cancel', 'mutation', 'nodes:exec', 'node', 'v0.2'],
]);
group('usage', 'server', [
  ['list', 'read', 'usage:read', 'tenant', 'v0.1', { or: [['usage:read', 'project']] }],
  ['export', 'read', 'usage:read', 'tenant', 'v0.2', { or: [['usage:read', 'project']] }],
]);
group('events', 'server', [['list', 'read', 'events:read', 'tenant', 'v0.1']]);
group('webhooks', 'events', [
  ['create', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
  ['list', 'read', 'webhooks:manage', 'tenant', 'v0.3'],
  ['get', 'read', 'webhooks:manage', 'tenant', 'v0.3'],
  ['update', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
  ['rotateSecret', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
  ['delete', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
  ['ping', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
  ['deliveries', 'read', 'webhooks:manage', 'tenant', 'v0.3'],
  ['redeliver', 'mutation', 'webhooks:manage', 'tenant', 'v0.3'],
]);
group('drivers', 'server', [['list', 'read', 'drivers:read', 'tenant', 'v0.2']]);
group('secrets', 'server', [
  ['put', 'mutation', 'secrets:manage', 'tenant', 'v0.2', { or: [['secrets:manage', 'fleet']] }],
  ['delete', 'mutation', 'secrets:manage', 'tenant', 'v0.2', { or: [['secrets:manage', 'fleet']] }],
]);
group('metal', 'metal', [
  ['enroll', 'mutation', 'nodes:provision', 'pool', 'v0.2'],
  ['manage', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['inspect', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['provide', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['deploy', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['undeploy', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['rescue', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['unrescue', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['abort', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['recover', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['retire', 'mutation', 'nodes:provision', 'node', 'v0.2'],
  ['power', 'mutation', 'nodes:power', 'node', 'v0.2'],
]);
group('profiles', 'provision', [
  ['create', 'mutation', 'profiles:manage', 'tenant', 'v0.2'],
  ['get', 'read', 'profiles:read', 'profile', 'v0.2'],
  ['validate', 'read', 'profiles:read', 'profile', 'v0.2'],
  ['render', 'read', 'profiles:read', 'profile', 'v0.2'],
  ['list', 'read', 'profiles:read', 'tenant', 'v0.2', list],
  ['update', 'mutation', 'profiles:manage', 'profile', 'v0.2'],
  ['delete', 'mutation', 'profiles:manage', 'profile', 'v0.2'],
]);
group('images', 'provision', [
  [
    'register',
    'mutation',
    'images:publish',
    'tenant',
    'v0.2',
    { or: [['images:publish', 'fleet']] },
  ],
  ['get', 'read', 'images:read', 'image', 'v0.2'],
  ['list', 'read', 'images:read', 'tenant', 'v0.2', list],
  ['promote', 'mutation', 'images:publish', 'image', 'v0.2'],
]);
group('workflows', 'provision', [
  ['get', 'read', 'workflows:read', 'node', 'v0.2'],
  ['list', 'read', 'workflows:read', 'node', 'v0.2'],
  ['abort', 'mutation', 'workflows:manage', 'node', 'v0.2'],
  ['retry', 'mutation', 'workflows:manage', 'node', 'v0.2'],
  ['pause', 'mutation', 'workflows:manage', 'node', 'v0.2'],
  ['resume', 'mutation', 'workflows:manage', 'node', 'v0.2'],
]);
group('instances', 'vps', [
  ['create', 'mutation', 'instances:create', 'instance', 'v0.3'],
  ['list', 'read', 'instances:read', 'tenant', 'v0.3', list],
  ['get', 'read', 'instances:read', 'instance', 'v0.3'],
  ['start', 'mutation', 'instances:update', 'instance', 'v0.3'],
  ['stop', 'mutation', 'instances:update', 'instance', 'v0.3'],
  ['resize', 'mutation', 'instances:update', 'instance', 'v0.3'],
  ['delete', 'mutation', 'instances:delete', 'instance', 'v0.3'],
]);
group('flavors', 'vps', [
  ['list', 'read', 'flavors:read', 'pool', 'v0.3'],
  ['create', 'mutation', 'flavors:manage', 'pool', 'v0.3'],
  ['update', 'mutation', 'flavors:manage', 'pool', 'v0.3'],
  ['delete', 'mutation', 'flavors:manage', 'pool', 'v0.3'],
]);
group('providerAccounts', 'vps', [
  [
    'create',
    'mutation',
    'providers:manage',
    'fleet',
    'v0.3',
    { or: [['providers:manage', 'tenant']] },
  ],
  ['list', 'read', 'providers:read', 'tenant', 'v0.3', list],
  ['get', 'read', 'providers:read', 'provider-account', 'v0.3'],
  ['offers', 'read', 'providers:read', 'provider-account', 'v0.3'],
  ['update', 'mutation', 'providers:manage', 'provider-account', 'v0.3'],
  ['delete', 'mutation', 'providers:manage', 'provider-account', 'v0.3'],
  ['bootstrap', 'mutation', 'providers:manage', 'provider-account', 'v0.3'],
]);
group('tunnels', 'tunnels', [
  ['open', 'mutation', 'instances:exec', 'instance', 'v0.3', { or: [['nodes:console', 'node']] }],
]);
group('fleet', 'fleet', [
  ['export', 'read', 'fleet:admin', 'fleet', 'v0.2'],
  ['plan', 'read', 'fleet:admin', 'fleet', 'v0.2'],
  ['apply', 'mutation', 'fleet:admin', 'fleet', 'v0.2'],
  ['status', 'read', 'fleet:admin', 'fleet', 'v0.2'],
]);
group('releases', 'rollout', [
  ['register', 'mutation', 'fleet:admin', 'fleet', 'v0.4'],
  ['list', 'read', 'fleet:admin', 'fleet', 'v0.4'],
]);
group('rollouts', 'rollout', [
  ['create', 'mutation', 'fleet:admin', 'fleet', 'v0.4'],
  ['list', 'read', 'fleet:admin', 'fleet', 'v0.4'],
  ['get', 'read', 'fleet:admin', 'fleet', 'v0.4'],
  ['pause', 'mutation', 'fleet:admin', 'fleet', 'v0.4'],
  ['resume', 'mutation', 'fleet:admin', 'fleet', 'v0.4'],
  ['abort', 'mutation', 'fleet:admin', 'fleet', 'v0.4'],
]);

/**
 * The normative method → action table (§9.2), one row per method. Rows the plan marks bold are
 * `v0.1`; rows in a group with a phase take it; the remaining unmarked rows are assigned `v0.2`
 * (webhooks `v0.3`, the plan's "webhooks + SSE" deliverable).
 */
export const apiSurface: readonly ApiSurfaceRow[] = Object.freeze(
  rows.map((row) => Object.freeze(row)),
);

/** The row for `group.method`, if the method is part of the table. */
export function apiMethod(groupName: string, method: string): ApiSurfaceRow | undefined {
  return apiSurface.find((row) => row.group === groupName && row.method === method);
}
