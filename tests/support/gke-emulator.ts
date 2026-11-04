import { GceEmulator, type Json, type RecordedRequest } from './gce-emulator.js';

// An in-memory emulator of the GKE REST v1 endpoints (container.googleapis.com/v1) the GKE driver
// uses: clusters, node pools, container operations and serverConfig, plus the Compute Engine
// instanceGroupManagers.get that node pool sizes are read from. Everything else (the token
// endpoints, the rest of Compute Engine) goes to a GceEmulator, whose tokens it accepts. Plug
// `emulator.fetch` into `gcpProvider({ fetch })`. Operations stay RUNNING for
// `operationDelayTicks` reads of themselves, then finish and apply their effect, as on GKE (but
// none of its timing). One operation per cluster at a time, like GKE.

interface GkeOp {
  name: string;
  location: string;
  /** `location/cluster`: the cluster the operation runs on. */
  cluster: string;
  operationType: string;
  /** Reads that still answer RUNNING before the operation turns DONE. */
  remaining: number;
  complete?: () => void;
  /** Runs when the operation finishes with an error. */
  fail?: () => void;
  error?: { code: number; message: string };
}

const host = 'container.googleapis.com';
const caPem = '-----BEGIN CERTIFICATE-----\nMIIBemulatedgkeclusterca\n-----END CERTIFICATE-----\n';
export const emulatedCaData = Buffer.from(caPem).toString('base64');
export const emulatedCaPem = caPem;

export function defaultServerConfig(): Json {
  return {
    defaultClusterVersion: '1.33.5-gke.1000',
    validMasterVersions: [
      '1.34.1-gke.1200',
      '1.33.5-gke.1000',
      '1.33.4-gke.900',
      '1.32.9-gke.1100',
    ],
    channels: [
      {
        channel: 'RAPID',
        defaultVersion: '1.34.1-gke.1200',
        validVersions: ['1.34.1-gke.1200', '1.33.5-gke.1000'],
      },
      {
        channel: 'REGULAR',
        defaultVersion: '1.33.5-gke.1000',
        validVersions: ['1.33.5-gke.1000', '1.33.4-gke.900', '1.32.9-gke.1100'],
      },
      {
        channel: 'STABLE',
        defaultVersion: '1.32.9-gke.1100',
        validVersions: ['1.32.9-gke.1100'],
      },
      {
        channel: 'EXTENDED',
        defaultVersion: '1.32.9-gke.1100',
        validVersions: ['1.32.9-gke.1100'],
      },
    ],
  };
}

const isZone = (location: string) => /-[a-z]$/.test(location);

export class GkeEmulator {
  readonly gce: GceEmulator;
  /** Keyed `location/name`. Values are GKE `Cluster` resources (with their `nodePools`). */
  clusters = new Map<string, Json>();
  operations = new Map<string, GkeOp>();
  /** Every request to the GKE host and to instanceGroupManagers. */
  requests: RecordedRequest[] = [];
  /** New operations stay RUNNING for this many reads of themselves. */
  operationDelayTicks = 1;
  /** The next operation finishes DONE with this error and its effect is not applied. */
  failNextOperation?: { message: string };
  /** Fails the next GKE request with this google.rpc.Status error. */
  failNext?: { status: number; rpcStatus: string; message: string };
  /** `zone/name` → target size of the node pools' managed instance groups. */
  instanceGroupSizes = new Map<string, number>();
  serverConfig: Json = defaultServerConfig();
  /** The control-plane address a cluster gets when it is running. */
  endpoint = '34.118.0.10';

  #seq = 0;

  constructor(gce: GceEmulator = new GceEmulator()) {
    this.gce = gce;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const isMig =
      url.hostname === 'compute.googleapis.com' && url.pathname.includes('/instanceGroupManagers/');
    if (url.hostname !== host && !isMig) return this.gce.fetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: Json | undefined;
    if (typeof init?.body === 'string' && headers.get('content-type')?.includes('json'))
      body = JSON.parse(init.body) as Json;
    this.requests.push({ method, path: url.pathname + url.search, url, headers, body });
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !this.gce.validTokens.has(bearer))
      return this.error(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    if (isMig) return this.#mig(url);
    if (this.failNext) {
      const failure = this.failNext;
      delete this.failNext;
      return this.error(failure.status, failure.rpcStatus, failure.message);
    }
    return this.#container(method, url, body);
  };

  // ---------------------------------------------------------------------------------- helpers

  json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  error(status: number, rpcStatus: string, message: string): Response {
    return this.json(status, { error: { code: status, message, status: rpcStatus } });
  }

  /** Requests of `method` whose path ends with `suffix`. */
  calls(method: string, suffix: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === method &&
        (typeof suffix === 'string'
          ? r.url.pathname.endsWith(suffix)
          : suffix.test(r.url.pathname)),
    );
  }

  /** Lets every running operation finish now. */
  finishOperations(): void {
    for (const operation of this.operations.values())
      if (operation.remaining > 0) this.#finish(operation);
  }

  /** Starts an operation on a cluster that nobody polls (another client's): the cluster is busy. */
  occupy(clusterKey: string, operationType = 'UPGRADE_MASTER'): string {
    const [location] = clusterKey.split('/');
    const op = this.#operation(location!, clusterKey, operationType, {});
    op.remaining = Number.POSITIVE_INFINITY;
    return op.name;
  }

  /** Resolves a version alias (`1.33`) to the newest valid version it names. */
  resolveVersion(version: string | undefined, channel?: string): string {
    if (!version) {
      const entry = (this.serverConfig.channels as Json[]).find((c) => c.channel === channel);
      return entry?.defaultVersion ?? this.serverConfig.defaultClusterVersion;
    }
    const valid = this.serverConfig.validMasterVersions as string[];
    if (valid.includes(version)) return version;
    const match = valid.find((v) => v.startsWith(`${version}.`));
    if (!match) throw new Error(`version ${version} is not valid`);
    return match;
  }

  #operation(
    location: string,
    cluster: string,
    operationType: string,
    effects: { complete?: () => void; fail?: () => void },
  ): GkeOp {
    const op: GkeOp = {
      name: `operation-${++this.#seq}-emulated`,
      location,
      cluster,
      operationType,
      remaining: this.operationDelayTicks,
      ...effects,
    };
    if (this.failNextOperation) {
      op.error = { code: 13, message: this.failNextOperation.message };
      delete this.failNextOperation;
    }
    this.operations.set(op.name, op);
    if (op.remaining <= 0) this.#finish(op);
    return op;
  }

  #finish(op: GkeOp): void {
    op.remaining = 0;
    if (op.error) op.fail?.();
    else op.complete?.();
  }

  #view(op: GkeOp): Json {
    return {
      name: op.name,
      operationType: op.operationType,
      status: op.remaining > 0 ? 'RUNNING' : 'DONE',
      targetLink: `https://${host}/v1/projects/p/locations/${op.cluster}`,
      ...(op.remaining <= 0 && op.error ? { error: op.error } : {}),
    };
  }

  #busy(clusterKey: string): Response | undefined {
    for (const op of this.operations.values())
      if (op.cluster === clusterKey && op.remaining > 0)
        return this.error(
          400,
          'FAILED_PRECONDITION',
          `Cluster is running incompatible operation ${op.name}.`,
        );
    return undefined;
  }

  #mig(url: URL): Response {
    const match = /\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)$/.exec(url.pathname);
    const key = match ? `${match[1]}/${match[2]}` : '';
    const size = this.instanceGroupSizes.get(key);
    if (size === undefined)
      return this.error(404, 'NOT_FOUND', `instanceGroupManager ${key} not found`);
    return this.json(200, { name: match![2], zone: match![1], targetSize: size });
  }

  // -------------------------------------------------------------------------------- the API

  #container(method: string, url: URL, body: Json | undefined): Response {
    const match = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) return this.error(404, 'NOT_FOUND', `No route ${url.pathname}`);
    const [, , location, rest] = match as unknown as [string, string, string, string];
    let m: RegExpExecArray | null;
    if (rest === 'serverConfig' && method === 'GET') return this.json(200, this.serverConfig);
    if ((m = /^operations\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const op = this.operations.get(decodeURIComponent(m[1]!));
      if (!op) return this.error(404, 'NOT_FOUND', 'Operation not found');
      if (op.remaining > 0 && --op.remaining <= 0) this.#finish(op);
      return this.json(200, this.#view(op));
    }
    if (rest === 'clusters' && method === 'POST') return this.#createCluster(location, body);
    if ((m = /^clusters\/([^/]+)$/.exec(rest))) {
      const key = `${location}/${m[1]}`;
      const cluster = this.clusters.get(key);
      if (!cluster) return this.error(404, 'NOT_FOUND', `Not found: projects/p/locations/${key}.`);
      if (method === 'GET') return this.json(200, cluster);
      if (method === 'PUT') return this.#updateCluster(key, cluster, body);
      if (method === 'DELETE') return this.#deleteCluster(key, cluster);
    }
    if ((m = /^clusters\/([^/]+)\/nodePools(?:\/([^/:]+)(?::(\w+))?)?$/.exec(rest))) {
      const key = `${location}/${m[1]}`;
      const cluster = this.clusters.get(key);
      if (!cluster) return this.error(404, 'NOT_FOUND', `Not found: projects/p/locations/${key}.`);
      const poolName = m[2];
      const action = m[3];
      if (!poolName && method === 'POST') return this.#createPool(key, cluster, body);
      const pool = (cluster.nodePools as Json[]).find((p) => p.name === poolName);
      if (!pool) return this.error(404, 'NOT_FOUND', `Not found: node pool ${poolName}.`);
      if (!action && method === 'GET') return this.json(200, pool);
      if (!action && method === 'DELETE') return this.#deletePool(key, cluster, pool);
      if (action === 'setSize' && method === 'POST') return this.#setSize(key, pool, body);
      if (action === 'setAutoscaling' && method === 'POST')
        return this.#setAutoscaling(key, pool, body);
    }
    return this.error(404, 'NOT_FOUND', `No route ${method} ${url.pathname}`);
  }

  #createCluster(location: string, body: Json | undefined): Response {
    const spec = body?.cluster as Json | undefined;
    if (!spec?.name) return this.error(400, 'INVALID_ARGUMENT', 'cluster.name is required');
    const key = `${location}/${spec.name}`;
    if (this.clusters.has(key))
      return this.error(409, 'ALREADY_EXISTS', `Already exists: projects/p/locations/${key}.`);
    const autopilot = spec.autopilot?.enabled === true;
    if (!autopilot && !(spec.nodePools as Json[] | undefined)?.length)
      return this.error(400, 'INVALID_ARGUMENT', 'Cluster.node_pools must be non-empty');
    const channel = spec.releaseChannel?.channel;
    const version = this.resolveVersion(spec.initialClusterVersion, channel);
    const cluster: Json = {
      ...structuredClone(spec),
      location,
      status: 'PROVISIONING',
      currentMasterVersion: version,
      currentNodeVersion: version,
      masterAuth: {},
      network: String(spec.network ?? 'default')
        .split('/')
        .pop(),
      subnetwork: String(spec.subnetwork ?? spec.network ?? 'default')
        .split('/')
        .pop(),
      nodePools: autopilot
        ? []
        : (spec.nodePools as Json[]).map((pool) => ({
            ...structuredClone(pool),
            status: 'PROVISIONING',
            version,
          })),
    };
    delete cluster.initialClusterVersion;
    this.clusters.set(key, cluster);
    const op = this.#operation(location, key, 'CREATE_CLUSTER', {
      complete: () => {
        cluster.status = 'RUNNING';
        cluster.endpoint = this.endpoint;
        cluster.masterAuth = { clusterCaCertificate: emulatedCaData };
        for (const pool of cluster.nodePools as Json[]) this.#runPool(cluster, pool);
      },
      fail: () => {
        cluster.status = 'ERROR';
        cluster.statusMessage = op.error?.message;
      },
    });
    return this.json(200, this.#view(op));
  }

  #runPool(cluster: Json, pool: Json): void {
    pool.status = 'RUNNING';
    pool.version = cluster.currentNodeVersion;
    const zones: string[] = pool.locations ?? [
      isZone(cluster.location) ? cluster.location : `${cluster.location}-a`,
    ];
    pool.instanceGroupUrls = zones.map((zone) => {
      const name = `gke-${cluster.name}-${pool.name}-grp`;
      this.instanceGroupSizes.set(`${zone}/${name}`, pool.initialNodeCount ?? 0);
      return `https://www.googleapis.com/compute/v1/projects/p/zones/${zone}/instanceGroupManagers/${name}`;
    });
  }

  #updateCluster(key: string, cluster: Json, body: Json | undefined): Response {
    const busy = this.#busy(key);
    if (busy) return busy;
    const update = (body?.update ?? {}) as Json;
    const fields = Object.keys(update);
    if (fields.length !== 1)
      return this.error(
        400,
        'INVALID_ARGUMENT',
        `Exactly one update is allowed, got ${fields.length}`,
      );
    const previous = cluster.status;
    cluster.status = 'RECONCILING';
    const op = this.#operation(key.split('/')[0]!, key, 'UPDATE_CLUSTER', {
      complete: () => {
        cluster.status = previous;
        if (update.desiredMasterVersion)
          cluster.currentMasterVersion = this.resolveVersion(update.desiredMasterVersion);
        if (update.desiredReleaseChannel) cluster.releaseChannel = update.desiredReleaseChannel;
        if (update.desiredMasterAuthorizedNetworksConfig)
          cluster.masterAuthorizedNetworksConfig = update.desiredMasterAuthorizedNetworksConfig;
      },
      fail: () => {
        cluster.status = previous;
      },
    });
    return this.json(200, this.#view(op));
  }

  #deleteCluster(key: string, cluster: Json): Response {
    const busy = this.#busy(key);
    if (busy) return busy;
    cluster.status = 'STOPPING';
    const op = this.#operation(key.split('/')[0]!, key, 'DELETE_CLUSTER', {
      complete: () => {
        this.clusters.delete(key);
      },
    });
    return this.json(200, this.#view(op));
  }

  #createPool(key: string, cluster: Json, body: Json | undefined): Response {
    if (cluster.autopilot?.enabled)
      return this.error(400, 'FAILED_PRECONDITION', 'Autopilot clusters do not support node pools');
    const spec = body?.nodePool as Json | undefined;
    if (!spec?.name) return this.error(400, 'INVALID_ARGUMENT', 'nodePool.name is required');
    if ((cluster.nodePools as Json[]).some((p) => p.name === spec.name))
      return this.error(409, 'ALREADY_EXISTS', `Already exists: node pool ${spec.name}.`);
    const busy = this.#busy(key);
    if (busy) return busy;
    const pool: Json = { ...structuredClone(spec), status: 'PROVISIONING' };
    (cluster.nodePools as Json[]).push(pool);
    const op = this.#operation(key.split('/')[0]!, key, 'CREATE_NODE_POOL', {
      complete: () => this.#runPool(cluster, pool),
      fail: () => {
        pool.status = 'ERROR';
      },
    });
    return this.json(200, this.#view(op));
  }

  #setSize(key: string, pool: Json, body: Json | undefined): Response {
    const busy = this.#busy(key);
    if (busy) return busy;
    pool.status = 'RECONCILING';
    const op = this.#operation(key.split('/')[0]!, key, 'SET_NODE_POOL_SIZE', {
      complete: () => {
        pool.status = 'RUNNING';
        for (const url of pool.instanceGroupUrls as string[]) {
          const [, zone, name] = /\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)$/.exec(url)!;
          this.instanceGroupSizes.set(`${zone}/${name}`, body?.nodeCount);
        }
      },
      fail: () => {
        pool.status = 'RUNNING';
      },
    });
    return this.json(200, this.#view(op));
  }

  #setAutoscaling(key: string, pool: Json, body: Json | undefined): Response {
    const busy = this.#busy(key);
    if (busy) return busy;
    pool.status = 'RECONCILING';
    const op = this.#operation(key.split('/')[0]!, key, 'SET_NODE_POOL_MANAGEMENT', {
      complete: () => {
        pool.status = 'RUNNING';
        pool.autoscaling = body?.autoscaling;
      },
      fail: () => {
        pool.status = 'RUNNING';
      },
    });
    return this.json(200, this.#view(op));
  }

  #deletePool(key: string, cluster: Json, pool: Json): Response {
    const busy = this.#busy(key);
    if (busy) return busy;
    pool.status = 'STOPPING';
    const op = this.#operation(key.split('/')[0]!, key, 'DELETE_NODE_POOL', {
      complete: () => {
        cluster.nodePools = (cluster.nodePools as Json[]).filter((p) => p !== pool);
        for (const url of (pool.instanceGroupUrls as string[] | undefined) ?? []) {
          const [, zone, name] = /\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)$/.exec(url)!;
          this.instanceGroupSizes.delete(`${zone}/${name}`);
        }
      },
    });
    return this.json(200, this.#view(op));
  }
}
