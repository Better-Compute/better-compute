import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type ProviderDefinition,
  type ProviderDiscoveredResource,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResources,
  type ProviderResourceState,
  type SecretRef,
} from '@better-compute/core';
import { defineProvider } from '@better-compute/vps';

// An in-memory long-tail provider for the cloud-resources module's tests (the DigitalOcean side lives in
// provider-digitalocean): resources whose operations stay in flight for `delayTicks` calls, a generated password
// on every database, in-place changes of updatable fields, ownership by label, and a log of every call. It is
// also the "minimal second fake" the conformance cases run against, next to the DigitalOcean emulator.

export interface FakeResource {
  id: string;
  kind: string;
  name: string;
  spec: Record<string, unknown>;
  labels: Record<string, string>;
  /** Which control plane manages it: this one, another deployment, or none (made by hand). */
  owner: 'this' | 'other' | 'none';
  ready: boolean;
  deleted: boolean;
  idempotencyKey?: string;
  /** The parent resource's id (a database user's database). */
  parent?: string;
  password?: string;
}

export interface FakeResourcesCloud {
  resources: Map<string, FakeResource>;
  /** Every call, in order: `ensure fake.database bc-r-…`, `delete fake.database 7`, … */
  calls: string[];
  /** Each create, update or delete answers in-flight this many times before it completes. */
  delayTicks: number;
  /** Names (or kinds) whose ensure answers `error`. */
  refuse: Set<string>;
  /** The next call throws this. */
  failNext?: ComputeError;
  /** Every password handed out, so tests can check none leaks. */
  passwords: string[];
  /** The value a spec's `secret` resolved to, by provider-side name. */
  resolved: Map<string, string>;
  /** The `accountScope` of the last ensure, by provider-side name. */
  scopes: Map<string, string | undefined>;
  /** Extra `usage` entries every fake.database reports (to check the module drops what it should). */
  usageExtra?: Record<string, number>;
  reset(): void;
  /** A resource made outside better-compute (or by another deployment). */
  seed(
    resource: Omit<FakeResource, 'id' | 'ready' | 'deleted' | 'labels'> & {
      labels?: Record<string, string>;
    },
  ): FakeResource;
}

export function fakeResourcesCloud(): FakeResourcesCloud {
  let next = 0;
  return {
    resources: new Map(),
    calls: [],
    delayTicks: 1,
    refuse: new Set(),
    passwords: [],
    scopes: new Map(),
    resolved: new Map(),
    reset() {
      this.resources.clear();
      this.calls.length = 0;
      this.delayTicks = 1;
      this.refuse.clear();
      delete this.failNext;
      this.passwords.length = 0;
      this.scopes.clear();
      this.resolved.clear();
      delete this.usageExtra;
    },
    seed(resource) {
      const id = `f-${++next}`;
      const seeded: FakeResource = {
        ...resource,
        id,
        labels: resource.labels ?? {},
        ready: true,
        deleted: false,
      };
      this.resources.set(id, seeded);
      return seeded;
    },
  };
}

const region = field.option(['nyc3', 'ams3', 'sfo3']).describe('Region');

export const fakeDatabaseSpec = manifest({
  region,
  engine: field.option(['pg', 'mysql']).describe('Engine'),
  version: field.string({ pattern: /^[0-9]+$/ }).describe('Major version'),
  size: field.option(['small', 'medium', 'large']).describe('Node size'),
  nodes: field.int({ min: 1, max: 3 }).default(1).describe('Nodes'),
});

export const fakeKinds: readonly ProviderResourceKind[] = Object.freeze([
  {
    kind: 'fake.database',
    family: 'data',
    description: 'A managed database cluster',
    spec: fakeDatabaseSpec,
    outputs: ['host', 'port', 'uri'],
    secretOutputs: ['password'],
    regional: true,
    updatable: ['size', 'nodes'],
    meters: [{ meter: 'fake.database.hours', unit: 'hour' }],
  },
  {
    kind: 'fake.database-user',
    family: 'data',
    description: 'A user of a managed database',
    spec: manifest({
      user: field.string({ pattern: /^[a-z][a-z0-9_]{0,31}$/ }).describe('User name'),
    }),
    outputs: ['user'],
    secretOutputs: ['password'],
    regional: false,
    updatable: [],
    parent: 'fake.database',
  },
  {
    kind: 'fake.app',
    family: 'platform',
    description: 'An app',
    spec: manifest({
      image: field.string().describe('Image'),
      instances: field.int({ min: 1, max: 10 }).default(1).describe('Instances'),
      secret: field
        .secret()
        .optional()
        .describe('A secret the app is given (resolved at the provider)'),
    }),
    outputs: ['url'],
    regional: false,
    updatable: ['image', 'instances'],
  },
  {
    kind: 'fake.agent',
    family: 'ai',
    description: 'A preview agent',
    spec: manifest({ model: field.string().describe('Model') }),
    outputs: [],
    regional: false,
    updatable: [],
    preview: true,
  },
]);

const progress = new WeakMap<FakeResourcesCloud, Map<string, number>>();

/** Whether operation `op` is still in flight: it answers so `delayTicks` times, then completes. */
function inFlight(cloud: FakeResourcesCloud, op: string): boolean {
  let ops = progress.get(cloud);
  if (!ops) progress.set(cloud, (ops = new Map()));
  const seen = ops.get(op) ?? 0;
  if (seen >= cloud.delayTicks) {
    ops.delete(op);
    return false;
  }
  ops.set(op, seen + 1);
  return true;
}

function kindOf(kind: string): ProviderResourceKind {
  const found = fakeKinds.find((entry) => entry.kind === kind);
  if (!found) throw new ComputeError('UNSUPPORTED', `The fake provider has no kind ${kind}`);
  return found;
}

function outputs(resource: FakeResource, cloud: FakeResourcesCloud): ProviderResourceState {
  const state: ProviderResourceState = {
    id: resource.id,
    state: resource.ready ? 'ready' : 'pending',
    spec: { ...resource.spec },
    // A database bills one fake.database.hours per node per hour.
    ...(resource.kind === 'fake.database'
      ? {
          usage: {
            'fake.database.hours': Number(resource.spec.nodes ?? 1),
            ...cloud.usageExtra,
          },
        }
      : {}),
  };
  if (!resource.ready) return state;
  if (resource.kind === 'fake.database')
    return {
      ...state,
      outputs: {
        host: `${resource.name}.db.fake`,
        port: '25060',
        uri: `pg://${resource.name}.db.fake:25060`,
      },
      ...(resource.password ? { secretOutputs: { password: resource.password } } : {}),
    };
  if (resource.kind === 'fake.database-user')
    return {
      ...state,
      outputs: { user: String(resource.spec.user) },
      ...(resource.password ? { secretOutputs: { password: resource.password } } : {}),
    };
  if (resource.kind === 'fake.app')
    return { ...state, outputs: { url: `https://${resource.name}.apps.fake` } };
  return state;
}

export function fakeProviderResources(
  cloud: FakeResourcesCloud,
  options: { previews?: boolean } = {},
): ProviderResources {
  let counter = 1000;
  const call = (line: string) => {
    cloud.calls.push(line);
    const failure = cloud.failNext;
    if (failure) {
      delete cloud.failNext;
      throw failure;
    }
  };
  const live = (kind: string, id: string) => {
    const found = cloud.resources.get(id);
    return found && found.kind === kind && !found.deleted ? found : undefined;
  };
  return {
    kinds: () => fakeKinds,
    async ensure(request: ProviderResourceRequest, context: CallContext) {
      call(`ensure ${request.kind} ${request.name}`);
      cloud.scopes.set(request.name, request.accountScope);
      const secretRef = (request.spec as { secret?: SecretRef }).secret;
      if (secretRef !== undefined)
        cloud.resolved.set(request.name, await context.secrets.resolve(secretRef));
      const kind = kindOf(request.kind);
      if (kind.preview && options.previews !== true)
        throw new ComputeError('UNSUPPORTED', `${kind.kind} is a preview`, undefined, {
          reason: 'preview',
        });
      if (cloud.refuse.has(request.name) || cloud.refuse.has(request.kind))
        return { id: request.id ?? 'refused', state: 'error', message: 'refused by the fake' };
      const spec = request.spec as Record<string, unknown>;
      let resource =
        (request.id !== undefined ? live(request.kind, request.id) : undefined) ??
        [...cloud.resources.values()].find(
          (entry) =>
            !entry.deleted &&
            entry.kind === request.kind &&
            entry.idempotencyKey === context.idempotencyKey,
        );
      if (!resource) {
        if (request.kind === 'fake.database-user') {
          const parent = request.parent ? live('fake.database', request.parent) : undefined;
          if (!parent || !parent.ready)
            throw new ComputeError(
              'INVALID_STATE',
              `database ${String(request.parent)} is not ready`,
            );
        }
        resource = {
          id: String(++counter),
          kind: request.kind,
          name: request.name,
          spec: { ...spec },
          labels: { ...(request.labels ?? {}) },
          owner: 'this',
          ready: false,
          deleted: false,
          idempotencyKey: context.idempotencyKey,
          ...(request.parent !== undefined ? { parent: request.parent } : {}),
        };
        if (kind.secretOutputs?.includes('password')) {
          resource.password = `pw-${counter}-${Math.random().toString(36).slice(2, 10)}`;
          cloud.passwords.push(resource.password);
        }
        cloud.resources.set(resource.id, resource);
        inFlight(cloud, `create ${resource.id}`);
        return { id: resource.id, state: 'pending' };
      }
      for (const [name, value] of Object.entries(spec))
        if (JSON.stringify(resource.spec[name]) !== JSON.stringify(value)) {
          if (!kind.updatable.includes(name))
            throw new ComputeError(
              'INVALID_STATE',
              `${request.kind} ${resource.id}: ${name} cannot change in place`,
              undefined,
              { reason: 'replaceRequired', field: name },
            );
          resource.spec[name] = value;
          resource.ready = false;
          inFlight(cloud, `update ${resource.id}`);
          return { id: resource.id, state: 'updating' };
        }
      if (!resource.ready) {
        const op = progress.get(cloud)?.has(`update ${resource.id}`)
          ? `update ${resource.id}`
          : `create ${resource.id}`;
        if (inFlight(cloud, op)) return { id: resource.id, state: 'pending' };
        resource.ready = true;
      }
      return outputs(resource, cloud);
    },
    async get(kind, id) {
      call(`get ${kind} ${id}`);
      const resource = live(kind, id);
      return resource ? outputs(resource, cloud) : undefined;
    },
    async delete(kind, id) {
      call(`delete ${kind} ${id}`);
      const resource = cloud.resources.get(id);
      if (!resource || resource.kind !== kind || resource.deleted) return { id, state: 'deleted' };
      if (resource.owner !== 'this' || resource.labels['better-compute-managed'] !== 'true')
        throw new ComputeError('INVALID_STATE', `${kind} ${id} is not managed here`, undefined, {
          reason: 'notManaged',
        });
      if (inFlight(cloud, `delete ${id}`)) return { id, state: 'deleting' };
      resource.deleted = true;
      return { id, state: 'deleted' };
    },
    async *discover(kind) {
      call(`discover ${kind}`);
      kindOf(kind);
      for (const resource of cloud.resources.values()) {
        if (resource.kind !== kind || resource.deleted) continue;
        const found: ProviderDiscoveredResource = {
          id: resource.id,
          name: resource.name,
          ...(typeof resource.spec.region === 'string' ? { region: resource.spec.region } : {}),
          ...(resource.owner !== 'none' && resource.labels['better-compute-managed'] === 'true'
            ? { managedBy: resource.owner === 'this' ? ('this' as const) : ('other' as const) }
            : {}),
          spec: { ...resource.spec },
        };
        yield found;
      }
    },
    async adopt(kind, id, labels) {
      call(`adopt ${kind} ${id}`);
      const resource = live(kind, id);
      if (!resource) throw new ComputeError('NOT_FOUND', `${kind} ${id} not found`);
      if (resource.owner === 'other')
        throw new ComputeError(
          'INVALID_STATE',
          `${kind} ${id} is managed by another deployment`,
          undefined,
          {
            reason: 'managedByAnother',
          },
        );
      resource.owner = 'this';
      resource.labels = { ...resource.labels, ...labels };
      return outputs(resource, cloud);
    },
    async release(kind, id) {
      call(`release ${kind} ${id}`);
      const resource = live(kind, id);
      if (!resource) return;
      resource.owner = 'none';
      resource.labels = Object.fromEntries(
        Object.entries(resource.labels).filter(([name]) => !name.startsWith('better-compute-')),
      );
    },
  };
}

/** Passes any config through; `previews: true` turns preview kinds on. */
const anyConfig = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

/** A provider whose accounts serve long-tail resources from `cloud`. */
export function fakeResourcesProvider(
  cloud: FakeResourcesCloud,
  id = 'fake-cloud',
): ProviderDefinition {
  return defineProvider({
    id,
    version: '1.0.0',
    provides: ['vps'],
    config: anyConfig as never,
    create: (config: unknown) => ({
      async listOffers() {
        return [];
      },
      async create() {
        throw new ComputeError('UNSUPPORTED', 'unused');
      },
      async get() {
        return undefined;
      },
      async delete() {},
      resources: fakeProviderResources(cloud, {
        previews: (config as { previews?: boolean } | undefined)?.previews === true,
      }),
    }),
  });
}

/** A provider without long-tail resources (a Hetzner stand-in). */
export const noResourcesProvider: ProviderDefinition = defineProvider({
  id: 'fake-plain',
  version: '1.0.0',
  provides: ['vps'],
  config: anyConfig as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new ComputeError('UNSUPPORTED', 'unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});
