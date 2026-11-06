import { isoSeconds } from './do-emulator/actions.js';
import { DoEmulator, type Json, type RouteContext, type RouteResult } from './do-emulator/index.js';

// An in-memory emulator of the DigitalOcean Kubernetes (DOKS) endpoints of API v2 that
// provider-digitalocean's managed Kubernetes uses: clusters, node pools, upgrades, the options
// list, short-lived cluster credentials and the associated-resources listing. It registers its
// routes on a DoEmulator (so authentication, rate-limit headers, failure injection and the rest of
// the API come from there): plug `emulator.fetch` into `digitaloceanProvider({ fetch })`.
//
// DOKS has no operations: a cluster, an upgrade, a node pool and its nodes each change state on
// their own. Here a change completes after `transitionReads` reads of the cluster (a GET of the
// cluster, a list, or a read of one of its node pools), none of DO's timing. `kube` is a fake of
// each cluster's own Kubernetes API, reached through `kube.transport`; it accepts only a
// cluster-admin token that `/credentials` issued for that cluster and that has not expired.

const caPem = '-----BEGIN CERTIFICATE-----\nMIIBemulateddokscluster\n-----END CERTIFICATE-----\n';
export const doksCaPem = caPem;
export const doksCaData = Buffer.from(caPem).toString('base64');

export interface DoksVersion {
  slug: string;
  kubernetes_version: string;
  supported_features?: string[];
}

export function defaultDoksVersions(): DoksVersion[] {
  return [
    { slug: '1.34.1-do.0', kubernetes_version: '1.34.1' },
    { slug: '1.33.5-do.1', kubernetes_version: '1.33.5' },
    { slug: '1.33.4-do.0', kubernetes_version: '1.33.4' },
    { slug: '1.32.9-do.2', kubernetes_version: '1.32.9' },
  ];
}

const versionParts = (version: string): number[] => version.split('.').map(Number);
function newer(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

interface Transition {
  remaining: number;
  done: () => void;
}

const unprocessable = (message: string): RouteResult => ({
  status: 422,
  body: { id: 'unprocessable_entity', message },
});
const notFound = (): RouteResult => ({
  status: 404,
  body: { id: 'not_found', message: 'The resource you were accessing could not be found.' },
});

export class DoksEmulator {
  readonly do: DoEmulator;
  /** Keyed by uuid; each cluster embeds its `node_pools`. */
  readonly clusters = new Map<string, Json>();
  versions: DoksVersion[] = defaultDoksVersions();
  /** Reads of a cluster before one of its changes completes. */
  transitionReads = 1;
  /** Whether a second cluster with a taken name is refused (DO's behaviour); off to test reaping. */
  uniqueNames = true;
  /** What `destroy_with_associated_resources` lists per cluster (load balancers, volumes, snapshots). */
  readonly associated = new Map<string, Json>();
  /** Every cluster-admin token `/credentials` issued, with its cluster and expiry (epoch ms). */
  readonly adminTokens = new Map<string, { cluster: string; expiresAt: number }>();
  /** The `expiry_seconds` of every `/credentials` request. */
  readonly credentialExpiries: number[] = [];
  readonly kube: FakeClusterApis;

  #seq = 0;
  readonly #transitions = new Map<string, Map<string, Transition>>();
  readonly #deletingPools = new Set<string>();

  constructor(emulator: DoEmulator = new DoEmulator()) {
    this.do = emulator;
    this.kube = new FakeClusterApis(this);
    this.#register();
  }

  get fetch(): DoEmulator['fetch'] {
    return this.do.fetch;
  }

  now(): number {
    return this.do.state.now();
  }

  #uuid(): string {
    this.#seq += 1;
    return `0d0c5000-0000-4000-8000-${String(this.#seq).padStart(12, '0')}`;
  }

  /** Schedules `done` after `transitionReads` reads of `cluster`; a later one under `key` replaces it. */
  later(cluster: string, key: string, done: () => void): void {
    let pending = this.#transitions.get(cluster);
    if (!pending) this.#transitions.set(cluster, (pending = new Map()));
    if (this.transitionReads <= 0) {
      pending.delete(key);
      done();
      return;
    }
    pending.set(key, { remaining: this.transitionReads, done });
  }

  /** One read of a cluster: every change of it moves one step. */
  #tick(cluster: string): void {
    const pending = this.#transitions.get(cluster);
    if (!pending) return;
    for (const [key, transition] of [...pending]) {
      transition.remaining -= 1;
      if (transition.remaining <= 0) {
        pending.delete(key);
        transition.done();
      }
    }
  }

  /** Whether a change of the cluster is still in flight. */
  busy(cluster: string): boolean {
    return (this.#transitions.get(cluster)?.size ?? 0) > 0;
  }

  /** A cluster that exists already (made elsewhere): running, with one node pool. */
  seedCluster(input: {
    name: string;
    region: string;
    tags?: string[];
    version?: string;
    created_at?: string;
    nodePool?: Json;
    extra?: Json;
  }): Json {
    const id = this.#uuid();
    const cluster = this.#newCluster(id, {
      name: input.name,
      region: input.region,
      version: input.version ?? this.versions[1]!.slug,
      tags: input.tags ?? [],
      node_pools: [input.nodePool ?? { name: 'seed', size: 's-2vcpu-4gb', count: 1 }],
      ...input.extra,
    });
    if (input.created_at) cluster.created_at = input.created_at;
    this.#run(cluster);
    for (const pool of cluster.node_pools as Json[]) this.#settleNodes(pool);
    return cluster;
  }

  #newCluster(id: string, body: Json): Json {
    const now = isoSeconds(this.now());
    const cluster: Json = {
      id,
      name: body.name,
      region: body.region,
      version: body.version,
      cluster_subnet: '10.244.0.0/16',
      service_subnet: '10.245.0.0/16',
      vpc_uuid: body.vpc_uuid ?? `vpc-default-${body.region}`,
      ipv4: '',
      endpoint: '',
      tags: ['k8s', `k8s:${id}`, ...((body.tags as string[] | undefined) ?? [])],
      node_pools: [],
      maintenance_policy: body.maintenance_policy ?? { start_time: '00:00', day: 'any' },
      auto_upgrade: body.auto_upgrade ?? false,
      status: { state: 'provisioning', message: 'provisioning' },
      created_at: now,
      updated_at: now,
      surge_upgrade: body.surge_upgrade ?? false,
      registry_enabled: false,
      ha: body.ha ?? false,
      control_plane_firewall: body.control_plane_firewall ?? {
        enabled: false,
        allowed_addresses: [],
      },
      // DOKS >= 1.37 leaves the device plugins off unless asked (DO-D18); older ones turned
      // NVIDIA's on: absent from a request means on here, so the driver must say so.
      nvidia_gpu_device_plugin: body.nvidia_gpu_device_plugin ?? { enabled: true },
      amd_gpu_device_plugin: body.amd_gpu_device_plugin ?? { enabled: true },
      amd_gpu_device_metrics_exporter_plugin: body.amd_gpu_device_metrics_exporter_plugin ?? {
        enabled: false,
      },
    };
    for (const pool of (body.node_pools as Json[] | undefined) ?? [])
      (cluster.node_pools as Json[]).push(this.#newPool(cluster, pool));
    this.clusters.set(id, cluster);
    return cluster;
  }

  #run(cluster: Json): void {
    const n = [...this.clusters.keys()].indexOf(cluster.id as string) + 10;
    cluster.status = { state: 'running', message: 'Cluster is running' };
    cluster.endpoint = `https://${cluster.id}.k8s.ondigitalocean.com`;
    cluster.ipv4 = `203.0.113.${n}`;
  }

  #newPool(cluster: Json, body: Json): Json {
    const id = this.#uuid();
    const pool: Json = {
      id,
      name: body.name,
      size: body.size,
      count: body.count ?? 0,
      tags: [
        'k8s',
        `k8s:${cluster.id}`,
        'k8s-worker',
        ...((body.tags as string[] | undefined) ?? []),
      ],
      labels: body.labels ?? null,
      taints: body.taints ?? [],
      auto_scale: body.auto_scale ?? false,
      min_nodes: body.min_nodes ?? 0,
      max_nodes: body.max_nodes ?? 0,
      nodes: [],
      ...(body.spot !== undefined ? { spot: body.spot } : {}),
    };
    this.#resize(cluster, pool, pool.count as number);
    return pool;
  }

  #node(pool: Json): Json {
    const now = isoSeconds(this.now());
    return {
      id: this.#uuid(),
      name: `${pool.name}-${Math.random().toString(36).slice(2, 7)}`,
      status: { state: 'provisioning' },
      droplet_id: String(this.do.state.nextId()),
      created_at: now,
      updated_at: now,
    };
  }

  /** Brings the pool's nodes to `count`: new ones provision, extra ones drain, both settle later. */
  #resize(cluster: Json, pool: Json, count: number): void {
    const nodes = pool.nodes as Json[];
    const live = nodes.filter((node) => node.status.state !== 'deleting');
    for (let i = live.length; i < count; i++) nodes.push(this.#node(pool));
    for (const node of live.slice(count)) node.status = { state: 'deleting' };
    this.later(cluster.id as string, `pool:${pool.id}:nodes`, () => this.#settleNodes(pool));
  }

  #settleNodes(pool: Json): void {
    pool.nodes = (pool.nodes as Json[])
      .filter((node) => node.status.state !== 'deleting')
      .map((node) => ({ ...node, status: { state: 'running' } }));
  }

  /** The autoscaler took the pool to `count` nodes (a scale-down drops the newest). */
  autoscale(clusterId: string, poolName: string, count: number): void {
    const cluster = this.clusters.get(clusterId)!;
    const pool = (cluster.node_pools as Json[]).find((p) => p.name === poolName)!;
    pool.count = count;
    this.#resize(cluster, pool, count);
  }

  /** Puts the cluster into `state` (`degraded`, `error`, …) with a message. */
  setStatus(clusterId: string, state: string, message?: string): void {
    const cluster = this.clusters.get(clusterId)!;
    cluster.status = { state, ...(message !== undefined ? { message } : {}) };
  }

  byName(name: string): Json[] {
    return [...this.clusters.values()].filter((cluster) => cluster.name === name);
  }

  #register(): void {
    const emu = this.do;
    const cluster = (context: RouteContext): Json | undefined =>
      this.clusters.get(context.match[1]!);
    const read = (context: RouteContext): Json | undefined => {
      const found = cluster(context);
      if (found) this.#tick(found.id as string);
      return this.clusters.get(context.match[1]!);
    };
    const pool = (found: Json, id: string): Json | undefined =>
      (found.node_pools as Json[]).find((p) => p.id === id);

    emu.route('GET', /^\/kubernetes\/options$/, () => ({
      status: 200,
      body: {
        options: {
          regions: this.do.state.regions.map((r) => ({ name: r.name, slug: r.slug })),
          versions: this.versions,
          sizes: this.do.state.sizes.map((s) => ({ name: s.slug, slug: s.slug })),
        },
      },
    }));

    emu.route('GET', /^\/kubernetes\/clusters$/, (context) => {
      for (const id of [...this.clusters.keys()]) this.#tick(id);
      return emu.paged(context, 'kubernetes_clusters', [...this.clusters.values()]);
    });

    emu.route('POST', /^\/kubernetes\/clusters$/, (context) => this.#create(context.body ?? {}));

    emu.route('GET', /^\/kubernetes\/clusters\/([^/]+)$/, (context) => {
      const found = read(context);
      return found ? { status: 200, body: { kubernetes_cluster: found } } : notFound();
    });

    emu.route('PUT', /^\/kubernetes\/clusters\/([^/]+)$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      const body = context.body ?? {};
      if (typeof body.name !== 'string' || !body.name) return unprocessable('name is required');
      for (const field of [
        'tags',
        'auto_upgrade',
        'surge_upgrade',
        'ha',
        'maintenance_policy',
        'control_plane_firewall',
        'nvidia_gpu_device_plugin',
        'amd_gpu_device_plugin',
        'amd_gpu_device_metrics_exporter_plugin',
      ])
        if (body[field] !== undefined)
          found[field] =
            field === 'tags'
              ? ['k8s', `k8s:${found.id}`, ...(body.tags as string[])]
              : structuredClone(body[field]);
      found.name = body.name;
      found.updated_at = isoSeconds(this.now());
      return { status: 202, body: { kubernetes_cluster: found } };
    });

    emu.route('DELETE', /^\/kubernetes\/clusters\/([^/]+)$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      if (found.status.state === 'deleting') return { status: 204 };
      found.status = { state: 'deleting', message: 'deleting' };
      this.later(found.id as string, 'cluster', () => {
        this.clusters.delete(found.id as string);
        this.#transitions.delete(found.id as string);
      });
      return { status: 204 };
    });

    emu.route(
      'GET',
      /^\/kubernetes\/clusters\/([^/]+)\/destroy_with_associated_resources$/,
      (context) => {
        const found = cluster(context);
        if (!found) return notFound();
        return {
          status: 200,
          body: this.associated.get(found.id as string) ?? {
            load_balancers: [],
            volumes: [],
            volume_snapshots: [],
          },
        };
      },
    );

    emu.route('GET', /^\/kubernetes\/clusters\/([^/]+)\/upgrades$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      const current = this.versions.find((v) => v.slug === found.version);
      return {
        status: 200,
        body: {
          available_upgrade_versions: this.versions.filter(
            (v) => current && newer(v.kubernetes_version, current.kubernetes_version) > 0,
          ),
        },
      };
    });

    emu.route('POST', /^\/kubernetes\/clusters\/([^/]+)\/upgrade$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      if (found.status.state !== 'running')
        return unprocessable('the cluster must be running to be upgraded');
      const current = this.versions.find((v) => v.slug === found.version);
      const target = this.versions.find((v) => v.slug === context.body?.version);
      if (!current || !target || newer(target.kubernetes_version, current.kubernetes_version) <= 0)
        return unprocessable('the requested version is not an available upgrade');
      found.status = { state: 'upgrading', message: 'upgrading' };
      this.later(found.id as string, 'cluster', () => {
        found.version = target.slug;
        found.status = { state: 'running', message: 'Cluster is running' };
      });
      return { status: 202 };
    });

    emu.route('GET', /^\/kubernetes\/clusters\/([^/]+)\/credentials$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      if (!found.endpoint) return unprocessable('the cluster is not running yet');
      const expiry = Number(context.url.searchParams.get('expiry_seconds') ?? 0);
      this.credentialExpiries.push(expiry);
      const seconds = expiry > 0 ? expiry : 7 * 86_400;
      const token = `doks-admin-${this.adminTokens.size + 1}-${found.id}`;
      const expiresAt = this.now() + seconds * 1000;
      this.adminTokens.set(token, { cluster: found.id as string, expiresAt });
      return {
        status: 200,
        body: {
          server: found.endpoint,
          certificate_authority_data: doksCaData,
          client_certificate_data: null,
          client_key_data: null,
          token,
          expires_at: new Date(expiresAt).toISOString(),
        },
      };
    });

    emu.route('GET', /^\/kubernetes\/clusters\/([^/]+)\/node_pools$/, (context) => {
      const found = read(context);
      if (!found) return notFound();
      return { status: 200, body: { node_pools: found.node_pools } };
    });

    emu.route('POST', /^\/kubernetes\/clusters\/([^/]+)\/node_pools$/, (context) => {
      const found = cluster(context);
      if (!found) return notFound();
      const body = context.body ?? {};
      const problem = this.#poolProblem(found.region as string, body);
      if (problem) return problem;
      if ((found.node_pools as Json[]).some((p) => p.name === body.name))
        return unprocessable('a node pool with this name already exists');
      const created = this.#newPool(found, body);
      (found.node_pools as Json[]).push(created);
      return { status: 201, body: { node_pool: created } };
    });

    emu.route('GET', /^\/kubernetes\/clusters\/([^/]+)\/node_pools\/([^/]+)$/, (context) => {
      const found = read(context);
      const p = found && pool(found, context.match[2]!);
      return p ? { status: 200, body: { node_pool: p } } : notFound();
    });

    emu.route('PUT', /^\/kubernetes\/clusters\/([^/]+)\/node_pools\/([^/]+)$/, (context) => {
      const found = cluster(context);
      const p = found && pool(found, context.match[2]!);
      if (!found || !p) return notFound();
      const body = context.body ?? {};
      if (typeof body.name !== 'string' || typeof body.count !== 'number')
        return unprocessable('name and count are required');
      for (const field of ['labels', 'taints', 'auto_scale', 'min_nodes', 'max_nodes'])
        if (body[field] !== undefined) p[field] = structuredClone(body[field]);
      if (body.tags !== undefined)
        p.tags = ['k8s', `k8s:${found.id}`, 'k8s-worker', ...(body.tags as string[])];
      if (body.count !== p.count) {
        p.count = body.count;
        this.#resize(found, p, body.count as number);
      }
      return { status: 202, body: { node_pool: p } };
    });

    emu.route('DELETE', /^\/kubernetes\/clusters\/([^/]+)\/node_pools\/([^/]+)$/, (context) => {
      const found = cluster(context);
      const p = found && pool(found, context.match[2]!);
      if (!found || !p) return notFound();
      for (const node of p.nodes as Json[]) node.status = { state: 'deleting' };
      // Asked again while it goes: nothing changes.
      if (this.#deletingPools.has(p.id as string)) return { status: 204 };
      this.#deletingPools.add(p.id as string);
      this.later(found.id as string, `pool:${p.id}:delete`, () => {
        found.node_pools = (found.node_pools as Json[]).filter((x) => x.id !== p.id);
      });
      return { status: 204 };
    });
  }

  #poolProblem(region: string, body: Json): RouteResult | undefined {
    if (typeof body.name !== 'string' || !body.name) return unprocessable('name is required');
    const size = this.do.state.sizes.find((s) => s.slug === body.size);
    if (!size) return unprocessable(`invalid size: ${String(body.size)}`);
    if (!(size.regions as string[]).includes(region))
      return unprocessable('size is not available in this region');
    if (body.auto_scale && !(body.max_nodes >= 1 && body.min_nodes <= body.max_nodes))
      return unprocessable('invalid autoscaling bounds');
    if (!body.auto_scale && !(body.count >= 1)) return unprocessable('count must be at least 1');
    return undefined;
  }

  #create(body: Json): RouteResult {
    if (typeof body.name !== 'string' || !body.name) return unprocessable('name is required');
    if (!this.do.state.regions.some((r) => r.slug === body.region))
      return unprocessable(`invalid region: ${String(body.region)}`);
    const version =
      body.version === 'latest'
        ? this.versions[0]!.slug
        : this.versions.find((v) => v.slug === body.version)?.slug;
    if (!version) return unprocessable(`invalid version: ${String(body.version)}`);
    const pools = (body.node_pools as Json[] | undefined) ?? [];
    if (pools.length === 0) return unprocessable('a cluster needs at least one node pool');
    for (const p of pools) {
      const problem = this.#poolProblem(body.region as string, p);
      if (problem) return problem;
    }
    if (this.uniqueNames && this.byName(body.name).length > 0)
      return unprocessable('a cluster with this name already exists');
    const created = this.#newCluster(this.#uuid(), { ...body, version });
    this.later(created.id as string, 'cluster', () => this.#run(created));
    return { status: 201, body: { kubernetes_cluster: created } };
  }
}

/** A recorded request to a cluster's own Kubernetes API. */
export interface ClusterApiCall {
  url: string;
  method: string;
  body?: unknown;
  caPem: string;
  token: string;
}

/**
 * Each cluster's own Kubernetes API: namespaces, service accounts, cluster role bindings and the
 * TokenRequest API, by the cluster's endpoint host. Only an unexpired admin token that
 * `/credentials` issued for that very cluster is accepted (401 otherwise).
 */
export class FakeClusterApis {
  calls: ClusterApiCall[] = [];
  readonly namespaces = new Set<string>();
  readonly serviceAccounts = new Set<string>();
  readonly bindings = new Map<string, Json>();
  readonly issued: string[] = [];
  /** Answers every request with this status instead. */
  failWith?: number;
  /** Throws instead of answering (a network failure). */
  unreachable = false;

  constructor(private readonly doks: DoksEmulator) {}

  transport = async (request: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    caPem: string;
    token: string;
    signal: AbortSignal;
  }): Promise<{ status: number; body: unknown }> => {
    this.calls.push({
      url: request.url,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
      caPem: request.caPem,
      token: request.token,
    });
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    const url = new URL(request.url);
    const cluster = [...this.doks.clusters.values()].find(
      (c) => c.endpoint && new URL(c.endpoint as string).host === url.host,
    );
    const ok = (status: number, payload: unknown) => ({ status, body: payload });
    if (!cluster) throw new Error('getaddrinfo ENOTFOUND');
    if (request.caPem !== doksCaPem) throw new Error('unable to verify the first certificate');
    const admin = this.doks.adminTokens.get(request.token);
    if (!admin || admin.cluster !== cluster.id || admin.expiresAt <= this.doks.now())
      return ok(401, { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' });
    if (this.failWith)
      return ok(this.failWith, { kind: 'Status', message: 'forbidden', reason: 'Forbidden' });
    const path = url.pathname;
    const body = request.body as Json | undefined;
    const exists = { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' };
    const missing = { kind: 'Status', reason: 'NotFound', message: 'not found' };
    let m: RegExpExecArray | null;
    if (request.method === 'POST' && path === '/api/v1/namespaces') {
      if (this.namespaces.has(body!.metadata.name)) return ok(409, exists);
      this.namespaces.add(body!.metadata.name);
      return ok(201, body);
    }
    if (
      (m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path)) &&
      request.method === 'POST'
    ) {
      if (!this.namespaces.has(m[1]!)) return ok(404, missing);
      const key = `${m[1]}/${body!.metadata.name}`;
      if (this.serviceAccounts.has(key)) return ok(409, exists);
      this.serviceAccounts.add(key);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)\/token$/.exec(path))) {
      if (!this.serviceAccounts.has(`${m[1]}/${m[2]}`)) return ok(404, missing);
      const token = `doks-sa-token-${this.issued.length + 1}`;
      this.issued.push(token);
      const ttl = body!.spec.expirationSeconds as number;
      return ok(201, {
        ...body,
        status: {
          token,
          expirationTimestamp: new Date(this.doks.now() + ttl * 1000).toISOString(),
        },
      });
    }
    const bindings = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
    if (path === bindings && request.method === 'POST') {
      if (this.bindings.has(body!.metadata.name)) return ok(409, exists);
      this.bindings.set(body!.metadata.name, body!);
      return ok(201, body);
    }
    if (path.startsWith(`${bindings}/`)) {
      const name = decodeURIComponent(path.slice(bindings.length + 1));
      const found = this.bindings.get(name);
      if (!found) return ok(404, missing);
      if (request.method === 'GET') return ok(200, found);
      if (request.method === 'DELETE') {
        this.bindings.delete(name);
        return ok(200, { kind: 'Status', status: 'Success' });
      }
    }
    return ok(404, missing);
  };

  routes(): string[] {
    return this.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  }
}
