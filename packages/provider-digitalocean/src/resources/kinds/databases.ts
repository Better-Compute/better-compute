import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { keyTag } from '../../ids.js';
import {
  assertOwned,
  childId,
  found,
  managedBy,
  ownershipTags,
  ownTags,
  parseChildId,
  replaceRequired,
  strings,
  tagResource,
  untagResource,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';

// Managed Databases: one cluster kind per engine (`do.database.<engine>`), and the resources that live in a cluster
// (`.user`, `.pool`, `.replica`, `.firewall`). A cluster is taggable, so it follows the key-tag protocol (DO-D4): a
// lookup by the key's tag before a create, the name (unique per account) settling a race. Connection URIs carry
// the password, so they are secret outputs like the password itself; the plain outputs are what a client may
// show. Children are owned through their cluster: a child of a cluster this deployment does not manage is refused.

export interface DoConnection {
  uri?: string;
  database?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface DoDatabase {
  id: string;
  name: string;
  engine: string;
  version: string;
  region: string;
  size: string;
  num_nodes: number;
  storage_size_mib?: number;
  private_network_uuid?: string;
  status: string;
  tags?: string[] | null;
  connection?: DoConnection;
  private_connection?: DoConnection;
  created_at: string;
}

export type DoEngine = 'pg' | 'mysql' | 'valkey' | 'mongodb' | 'kafka' | 'opensearch';

interface EngineInfo {
  engine: DoEngine;
  name: string;
  minNodes: number;
  maxNodes: number;
  /** In-place major/minor upgrades (`PUT /databases/{id}/upgrade`). */
  upgradable: boolean;
  users: boolean;
  replicas: boolean;
  pools: boolean;
}

export const engines: readonly EngineInfo[] = [
  {
    engine: 'pg',
    name: 'PostgreSQL',
    minNodes: 1,
    maxNodes: 3,
    upgradable: true,
    users: true,
    replicas: true,
    pools: true,
  },
  {
    engine: 'mysql',
    name: 'MySQL',
    minNodes: 1,
    maxNodes: 3,
    upgradable: true,
    users: true,
    replicas: true,
    pools: false,
  },
  {
    engine: 'valkey',
    name: 'Valkey',
    minNodes: 1,
    maxNodes: 3,
    upgradable: false,
    users: false,
    replicas: false,
    pools: false,
  },
  {
    engine: 'mongodb',
    name: 'MongoDB',
    minNodes: 1,
    maxNodes: 3,
    upgradable: false,
    users: true,
    replicas: false,
    pools: false,
  },
  {
    engine: 'kafka',
    name: 'Kafka',
    minNodes: 3,
    maxNodes: 15,
    upgradable: false,
    users: true,
    replicas: false,
    pools: false,
  },
  {
    engine: 'opensearch',
    name: 'OpenSearch',
    minNodes: 1,
    maxNodes: 15,
    upgradable: false,
    users: true,
    replicas: false,
    pools: false,
  },
];

export const databaseKind = (engine: DoEngine) => `do.database.${engine}`;

const regionField = field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. nyc3');
const sizeField = field
  .string({ pattern: /^[a-z0-9]+(-[a-z0-9]+)+$/, maxLength: 64 })
  .describe('Node size slug, e.g. db-s-1vcpu-1gb');

const plainOutputs = [
  'host',
  'port',
  'user',
  'database',
  'ssl',
  'privateHost',
  'engine',
  'version',
  'urn',
];
const secretOutputs = ['password', 'uri', 'privateUri'];

function status(value: string): ProviderResourceState['state'] {
  if (value === 'online') return 'ready';
  if (value === 'resizing' || value === 'migrating' || value === 'forking') return 'updating';
  return 'pending';
}

/** The plain and secret outputs of a connection (a password only ever goes to `secretOutputs`). */
function connectionOutputs(connection: DoConnection | undefined, privateConnection?: DoConnection) {
  return {
    outputs: strings({
      host: connection?.host,
      port: connection?.port,
      user: connection?.user,
      database: connection?.database,
      ssl: connection?.ssl,
      privateHost: privateConnection?.host,
    }),
    secretOutputs: strings({
      password: connection?.password,
      uri: connection?.uri,
      privateUri: privateConnection?.uri,
    }),
  };
}

function clusterState(database: DoDatabase): ProviderResourceState {
  const { outputs, secretOutputs } = connectionOutputs(
    database.connection,
    database.private_connection,
  );
  return {
    id: database.id,
    state: status(database.status),
    outputs: {
      ...outputs,
      ...strings({
        engine: database.engine,
        version: database.version,
        urn: `do:dbaas:${database.id}`,
      }),
    },
    ...(Object.keys(secretOutputs).length > 0 ? { secretOutputs } : {}),
    spec: {
      region: database.region,
      version: database.version,
      size: database.size,
      nodes: database.num_nodes,
      ...(database.storage_size_mib !== undefined ? { storageMiB: database.storage_size_mib } : {}),
      ...(database.private_network_uuid ? { vpc: database.private_network_uuid } : {}),
    },
  };
}

/** `a` < `b` for dotted versions (`15` < `16`, `8.0` < `8.4`). */
function lower(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r;
  }
  return false;
}

interface ClusterSpec {
  region: string;
  version: string;
  size: string;
  nodes: number;
  storageMiB?: number;
  vpc?: string;
}

async function readCluster(
  env: DoKindEnv,
  id: string,
  signal: AbortSignal,
): Promise<DoDatabase | undefined> {
  const reply = await found(() =>
    env.client.request<{ database: DoDatabase }>('GET', `/databases/${encodeURIComponent(id)}`, {
      signal,
      budget: 'observe',
    }),
  );
  return reply?.database;
}

/** The oldest cluster of the engine carrying the key's tag. */
async function byKey(
  env: DoKindEnv,
  engine: DoEngine,
  context: CallContext,
): Promise<DoDatabase | undefined> {
  const reply = await env.client.request<{ databases?: DoDatabase[] | null }>('GET', '/databases', {
    query: { tag_name: keyTag(context.idempotencyKey) },
    signal: context.signal,
    budget: 'observe',
  });
  return (reply.databases ?? [])
    .filter((database) => database.engine === engine)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
}

function clusterKind(info: EngineInfo): DoKind {
  const kind = databaseKind(info.engine);
  const spec = manifest({
    region: regionField,
    version: field
      .string({ pattern: /^[0-9]{1,3}(\.[0-9]{1,3})?$/ })
      .describe('Engine version, e.g. 16'),
    size: sizeField,
    nodes: field
      .int({ min: info.minNodes, max: info.maxNodes })
      .default(info.minNodes)
      .describe('Nodes in the cluster (standby nodes included)'),
    storageMiB: field
      .int({ min: 10_240, max: 16_777_216 })
      .optional()
      .describe('Disk per node in MiB; it can only grow'),
    vpc: field
      .string({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ })
      .optional()
      .describe("A VPC of the tenant's own account (its uuid); refused on a shared account"),
  });
  const what = (id: string) => `${info.name} cluster ${id}`;

  /** Applies the updatable differences, one call per run; returns the state, or undefined when nothing changed. */
  async function change(
    env: DoKindEnv,
    database: DoDatabase,
    wanted: Partial<ClusterSpec>,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    if (wanted.region !== undefined && wanted.region !== database.region)
      throw replaceRequired(kind, 'region');
    if (wanted.vpc !== undefined && wanted.vpc !== database.private_network_uuid)
      throw replaceRequired(kind, 'vpc');
    if (wanted.version !== undefined && wanted.version !== database.version) {
      if (!info.upgradable)
        throw replaceRequired(kind, 'version', `${info.name} has no in-place upgrade`);
      if (lower(wanted.version, database.version))
        throw replaceRequired(kind, 'version', `a downgrade from ${database.version}`);
      if (database.status !== 'online') return clusterState(database);
      await env.client.request('PUT', `/databases/${database.id}/upgrade`, {
        body: { version: wanted.version },
        signal: context.signal,
        budget: 'mutate',
      });
      return { ...clusterState(database), state: 'updating' };
    }
    if (
      wanted.storageMiB !== undefined &&
      database.storage_size_mib !== undefined &&
      wanted.storageMiB < database.storage_size_mib
    )
      throw replaceRequired(kind, 'storageMiB', 'disks only grow');
    const resize =
      (wanted.size !== undefined && wanted.size !== database.size) ||
      (wanted.nodes !== undefined && wanted.nodes !== database.num_nodes) ||
      (wanted.storageMiB !== undefined && wanted.storageMiB !== database.storage_size_mib);
    if (!resize) return undefined;
    if (database.status !== 'online') return clusterState(database);
    await env.client.request('PUT', `/databases/${database.id}/resize`, {
      body: {
        size: wanted.size ?? database.size,
        num_nodes: wanted.nodes ?? database.num_nodes,
        ...(wanted.storageMiB !== undefined ? { storage_size_mib: wanted.storageMiB } : {}),
      },
      signal: context.signal,
      budget: 'mutate',
    });
    return { ...clusterState(database), state: 'updating' };
  }

  return {
    definition: {
      kind,
      family: 'data',
      description: `A DigitalOcean Managed ${info.name} cluster`,
      spec,
      outputs: plainOutputs,
      secretOutputs,
      regional: true,
      updatable: ['size', 'nodes', 'storageMiB', ...(info.upgradable ? ['version'] : [])],
      meters: [{ meter: `do.database.${info.engine}.node.hours`, unit: 'hour' }],
    },

    async ensure(env, request: ProviderResourceRequest, context) {
      const wanted = request.spec as Partial<ClusterSpec>;
      let database: DoDatabase | undefined;
      if (request.id !== undefined) {
        database = await readCluster(env, request.id, context.signal);
        if (!database)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertOwned(env, database.tags, what(database.id));
      } else database = await byKey(env, info.engine, context);
      if (!database) {
        const full = wanted as ClusterSpec;
        if (full.vpc !== undefined && request.accountScope !== 'tenant')
          throw new ComputeError(
            'INVALID_INPUT',
            `${kind}: vpc is account-wide; only a cluster on the tenant's own account may name one`,
            undefined,
            { provider: 'digitalocean', reason: 'accountWide', fields: ['vpc'] },
          );
        try {
          const created = await env.client.request<{ database: DoDatabase }>('POST', '/databases', {
            body: {
              name: request.name,
              engine: info.engine,
              version: full.version,
              region: full.region,
              size: full.size,
              num_nodes: full.nodes,
              ...(full.storageMiB !== undefined ? { storage_size_mib: full.storageMiB } : {}),
              ...(full.vpc !== undefined ? { private_network_uuid: full.vpc } : {}),
              tags: ownershipTags(env, request.labels, context),
            },
            signal: context.signal,
            budget: 'mutate',
          });
          return clusterState(created.database);
        } catch (error) {
          // The name is taken: a racing create of ours made it (its key tag finds it), or it is someone else's.
          if (!isComputeError(error, 'CONFLICT')) throw error;
          database = await byKey(env, info.engine, context);
          if (!database) throw error;
        }
      }
      return (await change(env, database, wanted, context)) ?? clusterState(database);
    },

    async get(env, id, context) {
      const database = await readCluster(env, id, context.signal);
      return database ? clusterState(database) : undefined;
    },

    async delete(env, id, context) {
      const database = await readCluster(env, id, context.signal);
      if (!database) return { id, state: 'deleted' };
      assertOwned(env, database.tags, what(id));
      try {
        await env.client.request('DELETE', `/databases/${encodeURIComponent(id)}`, {
          signal: context.signal,
          budget: 'mutate',
        });
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND')) return { id, state: 'deleted' };
        throw error;
      }
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const database of env.client.pages<DoDatabase>('/databases', 'databases', {
        signal: context.signal,
        budget: 'sweep',
      })) {
        if (database.engine !== info.engine) continue;
        const owner = managedBy(env, database.tags);
        yield {
          id: database.id,
          name: database.name,
          region: database.region,
          ...(owner !== undefined ? { managedBy: owner } : {}),
          spec: clusterState(database).spec!,
        };
      }
    },

    async adopt(env, id, labels, context) {
      const database = await readCluster(env, id, context.signal);
      if (!database || database.engine !== info.engine)
        throw new ComputeError('NOT_FOUND', `${what(id)} not found`);
      const owner = managedBy(env, database.tags);
      if (owner === 'other')
        throw new ComputeError(
          'INVALID_STATE',
          `${what(id)} is managed by another deployment`,
          undefined,
          {
            provider: 'digitalocean',
            reason: 'managedByAnother',
          },
        );
      const tags = ownershipTags(env, labels, context).filter(
        (tag) => !(database.tags ?? []).some((have) => have.toLowerCase() === tag),
      );
      await tagResource(env.client, 'database', database.id, tags, context.signal);
      return clusterState({ ...database, tags: [...(database.tags ?? []), ...tags] });
    },

    async release(env, id, context) {
      const database = await readCluster(env, id, context.signal);
      if (!database) return;
      assertOwned(env, database.tags, what(id));
      await untagResource(
        env.client,
        'database',
        database.id,
        ownTags(database.tags),
        context.signal,
      );
    },
  };
}

// --- resources living in a cluster -----------------------------------------------------------------------------

/** The parent cluster, managed by this deployment; `notManaged` otherwise (nothing is sent). */
async function ownedParent(
  env: DoKindEnv,
  kind: string,
  parent: string | undefined,
  signal: AbortSignal,
): Promise<DoDatabase | undefined> {
  if (parent === undefined)
    throw new ComputeError('INVALID_INPUT', `${kind} needs the cluster it lives in`, undefined, {
      provider: 'digitalocean',
      reason: 'parent',
    });
  const database = await readCluster(env, parent, signal);
  if (database) assertOwned(env, database.tags, `Database cluster ${parent}`);
  return database;
}

interface DoUser {
  name: string;
  role?: string;
  password?: string;
}

function userKind(info: EngineInfo): DoKind {
  const kind = `${databaseKind(info.engine)}.user`;
  const state = (parent: string, user: DoUser): ProviderResourceState => ({
    id: childId(parent, user.name),
    state: 'ready',
    outputs: strings({ user: user.name, role: user.role }),
    ...(user.password ? { secretOutputs: { password: user.password } } : {}),
    spec: { name: user.name },
  });
  const read = (env: DoKindEnv, parent: string, name: string, signal: AbortSignal) =>
    found(() =>
      env.client.request<{ user: DoUser }>(
        'GET',
        `/databases/${parent}/users/${encodeURIComponent(name)}`,
        { signal, budget: 'observe' },
      ),
    );
  return {
    definition: {
      kind,
      family: 'data',
      description: `A user of a DigitalOcean Managed ${info.name} cluster; its password is sealed`,
      spec: manifest({
        name: field.string({ pattern: /^[a-z][a-z0-9_-]{0,62}$/ }).describe('The user name'),
      }),
      outputs: ['user', 'role'],
      secretOutputs: ['password'],
      regional: false,
      updatable: [],
      parent: databaseKind(info.engine),
    },
    async ensure(env, request, context) {
      const name = (request.spec as { name: string }).name;
      if (request.id !== undefined && parseChildId(kind, request.id).name !== name)
        throw replaceRequired(kind, 'name');
      const database = await ownedParent(env, kind, request.parent, context.signal);
      if (!database)
        return {
          id: childId(request.parent!, name),
          state: 'error',
          message: 'Its cluster is gone',
        };
      if (database.status !== 'online') return { id: childId(database.id, name), state: 'pending' };
      const existing = await read(env, database.id, name, context.signal);
      if (existing) return state(database.id, existing.user);
      try {
        const created = await env.client.request<{ user: DoUser }>(
          'POST',
          `/databases/${database.id}/users`,
          {
            body: { name },
            signal: context.signal,
            budget: 'mutate',
          },
        );
        return state(database.id, created.user);
      } catch (error) {
        if (!isComputeError(error, 'CONFLICT')) throw error;
        const raced = await read(env, database.id, name, context.signal);
        if (!raced) throw error;
        return state(database.id, raced.user);
      }
    },
    async get(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const reply = await read(env, parent, name, context.signal);
      return reply ? state(parent, reply.user) : undefined;
    },
    async delete(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const database = await ownedParent(env, kind, parent, context.signal);
      if (!database) return { id, state: 'deleted' };
      const reply = await read(env, parent, name, context.signal);
      if (!reply) return { id, state: 'deleted' };
      if (reply.user.role === 'primary')
        throw new ComputeError(
          'INVALID_STATE',
          `${name} is the cluster's admin user; it goes with the cluster`,
          undefined,
          {
            provider: 'digitalocean',
            reason: 'primaryUser',
          },
        );
      await found(() =>
        env.client.request('DELETE', `/databases/${parent}/users/${encodeURIComponent(name)}`, {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: 'deleted' };
    },
  };
}

interface DoPool {
  name: string;
  mode: string;
  size: number;
  db: string;
  user?: string;
  connection?: DoConnection;
  private_connection?: DoConnection;
}

function poolKind(): DoKind {
  const kind = 'do.database.pg.pool';
  const state = (parent: string, pool: DoPool): ProviderResourceState => {
    const { outputs, secretOutputs } = connectionOutputs(pool.connection, pool.private_connection);
    return {
      id: childId(parent, pool.name),
      state: 'ready',
      outputs,
      ...(Object.keys(secretOutputs).length > 0 ? { secretOutputs } : {}),
      spec: {
        name: pool.name,
        mode: pool.mode,
        size: pool.size,
        database: pool.db,
        ...(pool.user ? { user: pool.user } : {}),
      },
    };
  };
  const read = (env: DoKindEnv, parent: string, name: string, signal: AbortSignal) =>
    found(() =>
      env.client.request<{ pool: DoPool }>(
        'GET',
        `/databases/${parent}/pools/${encodeURIComponent(name)}`,
        {
          signal,
          budget: 'observe',
        },
      ),
    );
  return {
    definition: {
      kind,
      family: 'data',
      description: 'A PgBouncer connection pool of a DigitalOcean Managed PostgreSQL cluster',
      spec: manifest({
        name: field.string({ pattern: /^[a-z][a-z0-9_-]{0,62}$/ }).describe('The pool name'),
        mode: field
          .option(['transaction', 'session', 'statement'])
          .default('transaction')
          .describe('Pool mode'),
        size: field.int({ min: 1, max: 1000 }).describe('Backend connections'),
        database: field
          .string({ pattern: /^[A-Za-z0-9_-]{1,63}$/ })
          .default('defaultdb')
          .describe('Database'),
        user: field
          .string({ pattern: /^[a-z][a-z0-9_-]{0,62}$/ })
          .optional()
          .describe('The user it connects as; absent: the client’s own'),
      }),
      outputs: ['host', 'port', 'user', 'database', 'ssl', 'privateHost'],
      secretOutputs: ['password', 'uri', 'privateUri'],
      regional: false,
      updatable: ['mode', 'size', 'database', 'user'],
      parent: 'do.database.pg',
    },
    async ensure(env, request, context) {
      const wanted = request.spec as {
        name: string;
        mode: string;
        size: number;
        database: string;
        user?: string;
      };
      if (request.id !== undefined && parseChildId(kind, request.id).name !== wanted.name)
        throw replaceRequired(kind, 'name');
      const database = await ownedParent(env, kind, request.parent, context.signal);
      if (!database)
        return {
          id: childId(request.parent!, wanted.name),
          state: 'error',
          message: 'Its cluster is gone',
        };
      if (database.status !== 'online')
        return { id: childId(database.id, wanted.name), state: 'pending' };
      const body = {
        mode: wanted.mode,
        size: wanted.size,
        db: wanted.database,
        ...(wanted.user ? { user: wanted.user } : {}),
      };
      const existing = await read(env, database.id, wanted.name, context.signal);
      if (!existing) {
        const created = await env.client.request<{ pool: DoPool }>(
          'POST',
          `/databases/${database.id}/pools`,
          {
            body: { name: wanted.name, ...body },
            signal: context.signal,
            budget: 'mutate',
          },
        );
        return state(database.id, created.pool);
      }
      const pool = existing.pool;
      if (
        pool.mode !== wanted.mode ||
        pool.size !== wanted.size ||
        pool.db !== wanted.database ||
        (wanted.user !== undefined && pool.user !== wanted.user)
      ) {
        await env.client.request(
          'PUT',
          `/databases/${database.id}/pools/${encodeURIComponent(wanted.name)}`,
          {
            body,
            signal: context.signal,
            budget: 'mutate',
          },
        );
        return { ...state(database.id, pool), state: 'updating' };
      }
      return state(database.id, pool);
    },
    async get(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const reply = await read(env, parent, name, context.signal);
      return reply ? state(parent, reply.pool) : undefined;
    },
    async delete(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const database = await ownedParent(env, kind, parent, context.signal);
      if (!database) return { id, state: 'deleted' };
      await found(() =>
        env.client.request('DELETE', `/databases/${parent}/pools/${encodeURIComponent(name)}`, {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: 'deleted' };
    },
  };
}

interface DoReplica {
  name: string;
  region: string;
  size: string;
  status: string;
  connection?: DoConnection;
  private_connection?: DoConnection;
}

function replicaKind(info: EngineInfo): DoKind {
  const kind = `${databaseKind(info.engine)}.replica`;
  const state = (parent: string, replica: DoReplica): ProviderResourceState => {
    const { outputs, secretOutputs } = connectionOutputs(
      replica.connection,
      replica.private_connection,
    );
    return {
      id: childId(parent, replica.name),
      state: status(replica.status),
      outputs,
      ...(Object.keys(secretOutputs).length > 0 ? { secretOutputs } : {}),
      spec: { name: replica.name, region: replica.region, size: replica.size },
    };
  };
  const read = (env: DoKindEnv, parent: string, name: string, signal: AbortSignal) =>
    found(() =>
      env.client.request<{ replica: DoReplica }>(
        'GET',
        `/databases/${parent}/replicas/${encodeURIComponent(name)}`,
        { signal, budget: 'observe' },
      ),
    );
  return {
    definition: {
      kind,
      family: 'data',
      description: `A read-only replica of a DigitalOcean Managed ${info.name} cluster`,
      spec: manifest({
        name: field.string({ pattern: /^[a-z][a-z0-9-]{0,62}$/ }).describe('The replica name'),
        region: regionField,
        size: sizeField,
      }),
      outputs: ['host', 'port', 'user', 'database', 'ssl', 'privateHost'],
      secretOutputs: ['password', 'uri', 'privateUri'],
      regional: true,
      updatable: [],
      parent: databaseKind(info.engine),
    },
    async ensure(env, request, context) {
      const wanted = request.spec as { name: string; region: string; size: string };
      const database = await ownedParent(env, kind, request.parent, context.signal);
      if (!database)
        return {
          id: childId(request.parent!, wanted.name),
          state: 'error',
          message: 'Its cluster is gone',
        };
      if (database.status !== 'online')
        return { id: childId(database.id, wanted.name), state: 'pending' };
      const existing = await read(env, database.id, wanted.name, context.signal);
      if (existing) {
        for (const name of ['region', 'size'] as const)
          if (existing.replica[name] !== wanted[name]) throw replaceRequired(kind, name);
        return state(database.id, existing.replica);
      }
      const created = await env.client.request<{ replica: DoReplica }>(
        'POST',
        `/databases/${database.id}/replicas`,
        {
          body: {
            name: wanted.name,
            region: wanted.region,
            size: wanted.size,
            tags: ownershipTags(env, request.labels, context),
          },
          signal: context.signal,
          budget: 'mutate',
        },
      );
      return state(database.id, created.replica);
    },
    async get(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const reply = await read(env, parent, name, context.signal);
      return reply ? state(parent, reply.replica) : undefined;
    },
    async delete(env, id, context) {
      const { parent, name } = parseChildId(kind, id);
      const database = await ownedParent(env, kind, parent, context.signal);
      if (!database) return { id, state: 'deleted' };
      const gone = await found(() =>
        env.client.request('DELETE', `/databases/${parent}/replicas/${encodeURIComponent(name)}`, {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: gone === undefined ? 'deleted' : 'deleting' };
    },
  };
}

interface DoFirewallRule {
  type: 'ip_addr' | 'droplet' | 'k8s' | 'tag' | 'app';
  value: string;
}

const cidrPattern =
  /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$|^[0-9a-fA-F:]+(?:\/[0-9]{1,3})?$/;

function firewallKind(info: EngineInfo): DoKind {
  const kind = `${databaseKind(info.engine)}.firewall`;
  const rulesOf = (spec: {
    ipAddresses?: string[];
    tags?: string[];
    droplets?: string[];
  }): DoFirewallRule[] => [
    ...(spec.ipAddresses ?? []).map((value) => ({ type: 'ip_addr' as const, value })),
    ...(spec.tags ?? []).map((value) => ({ type: 'tag' as const, value })),
    ...(spec.droplets ?? []).map((value) => ({ type: 'droplet' as const, value })),
  ];
  const specOf = (rules: readonly DoFirewallRule[]) => ({
    ipAddresses: rules.filter((rule) => rule.type === 'ip_addr').map((rule) => rule.value),
    tags: rules.filter((rule) => rule.type === 'tag').map((rule) => rule.value),
    droplets: rules.filter((rule) => rule.type === 'droplet').map((rule) => rule.value),
  });
  const read = async (env: DoKindEnv, parent: string, signal: AbortSignal) =>
    (
      await env.client.request<{ rules?: DoFirewallRule[] | null }>(
        'GET',
        `/databases/${parent}/firewall`,
        {
          signal,
          budget: 'observe',
        },
      )
    ).rules ?? [];
  const same = (a: readonly DoFirewallRule[], b: readonly DoFirewallRule[]) => {
    const key = (rules: readonly DoFirewallRule[]) =>
      rules
        .map((rule) => `${rule.type}:${rule.value}`)
        .sort()
        .join(',');
    return key(a) === key(b);
  };
  return {
    definition: {
      kind,
      family: 'data',
      description: `The trusted sources of a DigitalOcean Managed ${info.name} cluster (addresses, tags, Droplets)`,
      spec: manifest({
        ipAddresses: field
          .list(field.string({ pattern: cidrPattern }), { max: 100 })
          .default([])
          .describe('Addresses or CIDRs that may connect'),
        tags: field
          .list(field.string({ pattern: /^[a-z0-9:_-]{1,255}$/ }), { max: 100 })
          .default([])
          .describe('Droplet tags whose Droplets may connect (e.g. a pool’s bc-* tag)'),
        droplets: field
          .list(field.string({ pattern: /^[1-9][0-9]{0,18}$/ }), { max: 100 })
          .default([])
          .describe('Droplet ids that may connect'),
      }),
      outputs: [],
      regional: false,
      updatable: ['ipAddresses', 'tags', 'droplets'],
      parent: databaseKind(info.engine),
    },
    async ensure(env, request, context) {
      const database = await ownedParent(env, kind, request.parent, context.signal);
      const id = childId(request.parent!, 'firewall');
      if (!database) return { id, state: 'error', message: 'Its cluster is gone' };
      if (database.status !== 'online') return { id, state: 'pending' };
      const wanted = rulesOf(request.spec as never);
      const current = await read(env, database.id, context.signal);
      if (!same(current, wanted))
        await env.client.request('PUT', `/databases/${database.id}/firewall`, {
          body: { rules: wanted },
          signal: context.signal,
          budget: 'mutate',
        });
      return { id, state: 'ready', spec: specOf(wanted) };
    },
    async get(env, id, context) {
      const { parent } = parseChildId(kind, id);
      if (!(await readCluster(env, parent, context.signal))) return undefined;
      return { id, state: 'ready', spec: specOf(await read(env, parent, context.signal)) };
    },
    async delete(env, id, context) {
      const { parent } = parseChildId(kind, id);
      const database = await ownedParent(env, kind, parent, context.signal);
      if (!database) return { id, state: 'deleted' };
      // No trusted sources: the cluster's own default again.
      await env.client.request('PUT', `/databases/${parent}/firewall`, {
        body: { rules: [] },
        signal: context.signal,
        budget: 'mutate',
      });
      return { id, state: 'deleted' };
    },
  };
}

/** Every Managed Databases kind: a cluster per engine and what lives in each. */
export function databaseKinds(): DoKind[] {
  const kinds: DoKind[] = [];
  for (const info of engines) {
    kinds.push(clusterKind(info));
    if (info.users) kinds.push(userKind(info));
    if (info.pools) kinds.push(poolKind());
    if (info.replicas) kinds.push(replicaKind(info));
    kinds.push(firewallKind(info));
  }
  return kinds;
}
