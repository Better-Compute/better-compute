import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import { touchTags } from './tags.js';
import type { DoState, Json } from './state.js';

// Managed Databases: clusters with their connection (the password included, as DO returns it on create and on
// every read), users, PgBouncer pools, replicas and the trusted-source firewall. Shapes follow the API reference
// (databases.yml), not a recording: the live suite captures real bodies before release. A new cluster is
// `creating` for `emulator.databaseReads` reads, and a resize or upgrade is `resizing` / `migrating` as long.

const engines = new Set(['pg', 'mysql', 'valkey', 'mongodb', 'kafka', 'opensearch']);
const ports: Record<string, number> = {
  pg: 25060,
  mysql: 25060,
  valkey: 25061,
  mongodb: 27017,
  kafka: 25062,
  opensearch: 25060,
};
const schemes: Record<string, string> = {
  pg: 'postgresql',
  mysql: 'mysql',
  valkey: 'rediss',
  mongodb: 'mongodb+srv',
  kafka: 'kafka',
  opensearch: 'https',
};

let passwords = 0;
/** A fresh password, recognisable in a test (`AVNS_` as DO's are). */
export const newPassword = () =>
  `AVNS_pw${++passwords}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function connection(cluster: Json, user: string, password: string, isPrivate = false): Json {
  const host = `${isPrivate ? 'private-' : ''}${cluster.name}-do-user-1.db.ondigitalocean.com`;
  const port = ports[cluster.engine as string]!;
  const database =
    cluster.engine === 'pg' ? 'defaultdb' : cluster.engine === 'mysql' ? 'defaultdb' : '';
  return {
    uri: `${schemes[cluster.engine as string]}://${user}:${password}@${host}:${port}/${database}?sslmode=require`,
    database,
    host,
    port,
    user,
    password,
    ssl: true,
  };
}

/** The cluster as DO returns it, with the admin connection. */
function body(cluster: Json): Json {
  const { _admin, _reads, _users, _pools, _replicas, _firewall, ...rest } = cluster;
  return {
    ...structuredClone(rest),
    connection: connection(cluster, 'doadmin', _admin.password),
    private_connection: connection(cluster, 'doadmin', _admin.password, true),
    users: (_users as Json[]).map((user) => ({ ...user })),
  };
}

/** Counts a read of the cluster; a transition ends after `databaseReads` reads. */
function observe(emulator: DoEmulator, cluster: Json): void {
  if (cluster.status === 'online') return;
  cluster._reads = (cluster._reads ?? 0) + 1;
  if (cluster._reads > emulator.databaseReads) {
    cluster.status = 'online';
    cluster._reads = 0;
  }
}

function clusterOf(context: RouteContext, emulator: DoEmulator): Json | undefined {
  const cluster = context.state.databases.get(decodeURIComponent(context.match[1]!));
  return cluster;
}

/** Seeds a cluster made outside better-compute (online), with the given tags. */
export function seedDatabase(state: DoState, fields: Json): Json {
  const id = randomUUID();
  const cluster: Json = {
    id,
    name: `seeded-${id.slice(0, 8)}`,
    engine: 'pg',
    version: '16',
    region: 'nyc3',
    size: 'db-s-1vcpu-1gb',
    num_nodes: 1,
    storage_size_mib: 10240,
    status: 'online',
    tags: [],
    created_at: new Date(state.now()).toISOString(),
    ...fields,
    _admin: { name: 'doadmin', role: 'primary', password: newPassword() },
    _users: [],
    _pools: [],
    _replicas: [],
    _firewall: [],
  };
  cluster._users.push({ ...cluster._admin });
  touchTags(state, cluster.tags);
  state.databases.set(id, cluster);
  return cluster;
}

export function registerDatabases(emulator: DoEmulator): void {
  emulator.route('GET', /^\/databases$/, (context) => {
    const tag = context.url.searchParams.get('tag_name')?.toLowerCase();
    const clusters = [...context.state.databases.values()].filter(
      (cluster) => !tag || (cluster.tags as string[]).some((t) => t.toLowerCase() === tag),
    );
    for (const cluster of clusters) observe(emulator, cluster);
    return emulator.paged(context, 'databases', clusters.map(body));
  });

  emulator.route('POST', /^\/databases$/, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      !engines.has(input.engine) ||
      typeof input.region !== 'string'
    )
      return emulator.error('422-unknown');
    if ([...context.state.databases.values()].some((cluster) => cluster.name === input.name))
      return emulator.error('422-name-in-use');
    const cluster = seedDatabase(context.state, {
      name: input.name,
      engine: input.engine,
      version: input.version,
      region: input.region,
      size: input.size,
      num_nodes: input.num_nodes ?? 1,
      ...(input.storage_size_mib !== undefined ? { storage_size_mib: input.storage_size_mib } : {}),
      status: 'creating',
      tags: input.tags ?? [],
    });
    return { status: 201, body: { database: body(cluster) } };
  });

  emulator.route('GET', /^\/databases\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    observe(emulator, cluster);
    return { status: 200, body: { database: body(cluster) } };
  });

  emulator.route('DELETE', /^\/databases\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    context.state.databases.delete(cluster.id);
    return { status: 204 };
  });

  emulator.route('PUT', /^\/databases\/([^/]+)\/resize$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    if (cluster.status !== 'online') return emulator.error('422-unknown');
    const input = context.body ?? {};
    cluster.size = input.size ?? cluster.size;
    cluster.num_nodes = input.num_nodes ?? cluster.num_nodes;
    if (input.storage_size_mib !== undefined) cluster.storage_size_mib = input.storage_size_mib;
    cluster.status = 'resizing';
    return { status: 202 };
  });

  emulator.route('PUT', /^\/databases\/([^/]+)\/upgrade$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    cluster.version = context.body?.version;
    cluster.status = 'migrating';
    return { status: 204 };
  });

  // Users.
  emulator.route('GET', /^\/databases\/([^/]+)\/users\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    const user = cluster?._users.find(
      (u: Json) => u.name === decodeURIComponent(context.match[2]!),
    );
    if (!user) return emulator.error('not-found');
    return { status: 200, body: { user: { ...user } } };
  });
  emulator.route('POST', /^\/databases\/([^/]+)\/users$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const name = context.body?.name;
    if (typeof name !== 'string') return emulator.error('422-unknown');
    if (cluster._users.some((u: Json) => u.name === name)) return emulator.error('422-name-in-use');
    const user = { name, role: 'normal', password: newPassword() };
    cluster._users.push(user);
    return { status: 201, body: { user: { ...user } } };
  });
  emulator.route('DELETE', /^\/databases\/([^/]+)\/users\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const name = decodeURIComponent(context.match[2]!);
    if (!cluster._users.some((u: Json) => u.name === name)) return emulator.error('not-found');
    cluster._users = cluster._users.filter((u: Json) => u.name !== name);
    return { status: 204 };
  });

  // Connection pools (PostgreSQL).
  const poolBody = (cluster: Json, pool: Json) => {
    const user =
      cluster._users.find((u: Json) => u.name === (pool.user ?? 'doadmin')) ?? cluster._admin;
    return { ...pool, connection: connection(cluster, user.name, user.password) };
  };
  emulator.route('GET', /^\/databases\/([^/]+)\/pools\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    const pool = cluster?._pools.find(
      (p: Json) => p.name === decodeURIComponent(context.match[2]!),
    );
    if (!pool) return emulator.error('not-found');
    return { status: 200, body: { pool: poolBody(cluster!, pool) } };
  });
  emulator.route('POST', /^\/databases\/([^/]+)\/pools$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    if (cluster.engine !== 'pg') return emulator.error('422-unknown');
    const input = context.body ?? {};
    if (cluster._pools.some((p: Json) => p.name === input.name))
      return emulator.error('422-name-in-use');
    const pool = {
      name: input.name,
      mode: input.mode,
      size: input.size,
      db: input.db,
      ...(input.user ? { user: input.user } : {}),
    };
    cluster._pools.push(pool);
    return { status: 201, body: { pool: poolBody(cluster, pool) } };
  });
  emulator.route('PUT', /^\/databases\/([^/]+)\/pools\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    const pool = cluster?._pools.find(
      (p: Json) => p.name === decodeURIComponent(context.match[2]!),
    );
    if (!pool) return emulator.error('not-found');
    Object.assign(pool, context.body ?? {});
    return { status: 204 };
  });
  emulator.route('DELETE', /^\/databases\/([^/]+)\/pools\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const name = decodeURIComponent(context.match[2]!);
    if (!cluster._pools.some((p: Json) => p.name === name)) return emulator.error('not-found');
    cluster._pools = cluster._pools.filter((p: Json) => p.name !== name);
    return { status: 204 };
  });

  // Read-only replicas.
  const replicaBody = (cluster: Json, replica: Json) => {
    if (replica.status !== 'online') {
      replica._reads = (replica._reads ?? 0) + 1;
      if (replica._reads > emulator.databaseReads) replica.status = 'online';
    }
    const { _reads, ...rest } = replica;
    return {
      ...rest,
      connection: connection(
        { ...cluster, name: replica.name },
        'doadmin',
        cluster._admin.password,
      ),
    };
  };
  emulator.route('GET', /^\/databases\/([^/]+)\/replicas\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    const replica = cluster?._replicas.find(
      (r: Json) => r.name === decodeURIComponent(context.match[2]!),
    );
    if (!replica) return emulator.error('not-found');
    return { status: 200, body: { replica: replicaBody(cluster!, replica) } };
  });
  emulator.route('POST', /^\/databases\/([^/]+)\/replicas$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const input = context.body ?? {};
    if (cluster._replicas.some((r: Json) => r.name === input.name))
      return emulator.error('422-name-in-use');
    const replica = {
      name: input.name,
      region: input.region,
      size: input.size,
      status: 'forking',
      tags: input.tags ?? [],
    };
    cluster._replicas.push(replica);
    return { status: 201, body: { replica: replicaBody(cluster, replica) } };
  });
  emulator.route('DELETE', /^\/databases\/([^/]+)\/replicas\/([^/]+)$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const name = decodeURIComponent(context.match[2]!);
    if (!cluster._replicas.some((r: Json) => r.name === name)) return emulator.error('not-found');
    cluster._replicas = cluster._replicas.filter((r: Json) => r.name !== name);
    return { status: 204 };
  });

  // Trusted sources.
  emulator.route('GET', /^\/databases\/([^/]+)\/firewall$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    return {
      status: 200,
      body: {
        rules: (cluster._firewall as Json[]).map((rule) => ({ ...rule, cluster_uuid: cluster.id })),
      },
    };
  });
  emulator.route('PUT', /^\/databases\/([^/]+)\/firewall$/, (context) => {
    const cluster = clusterOf(context, emulator);
    if (!cluster) return emulator.error('not-found');
    const rules = context.body?.rules;
    if (!Array.isArray(rules)) return emulator.error('422-unknown');
    cluster._firewall = rules.map((rule: Json) => ({
      uuid: randomUUID(),
      type: rule.type,
      value: rule.value,
    }));
    return { status: 204 };
  });
}
