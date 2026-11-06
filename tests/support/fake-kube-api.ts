import type { KubeApiRequest, KubeApiResponse, KubeApiTransport } from '@better-compute/provider-kubernetes';

// An in-memory Kubernetes API for the pool substrate's tests, as provider-kubernetes' KubeApiTransport: one object
// store per API server (origin), server-side apply (PATCH apply-patch+yaml: create or replace, with the field
// manager recorded), DELETE, and the Node list (from `nodes`, e.g. a FakeKubernetes cloud's node pools), with label
// selectors of the `k=v[,k=v]` form. Only tokens `accepts` vouches for authenticate: a test proves the substrate uses
// the credential the provider minted. The log keeps method, path and field manager, never the token.

export interface FakeKubeNode {
  name: string;
  labels: Record<string, string>;
  ready?: boolean;
  unschedulable?: boolean;
  /** `metadata.uid` (default: derived from the name, so a re-created Node needs another one set). */
  uid?: string;
}

export interface FakeKubeCall {
  server: string;
  method: string;
  path: string;
  fieldManager?: string;
  contentType?: string;
}

export class FakeKubeApi {
  /** origin → path → object. */
  readonly objects = new Map<string, Map<string, any>>();
  readonly calls: FakeKubeCall[] = [];
  /** Every token a request carried, in order (to check freshness; never logged elsewhere). */
  readonly tokens: string[] = [];
  /** Answers every request with this status instead. */
  failWith?: number;
  /** Throws (no answer) instead. */
  unreachable = false;
  /** NodeList pages answered. */
  nodePages = 0;

  constructor(
    private readonly options: {
      nodes: (server: string) => FakeKubeNode[];
      accepts: (token: string) => boolean;
    },
  ) {}

  store(server: string): Map<string, any> {
    const origin = new URL(server).origin;
    let store = this.objects.get(origin);
    if (!store) this.objects.set(origin, (store = new Map()));
    return store;
  }

  /** The object at a path on a server, if applied. */
  get(server: string, path: string): any {
    return this.store(server).get(path);
  }

  /** `Kind/name` of every object on a server, in path order. */
  kinds(server: string): string[] {
    return [...this.store(server).values()].map((object) => `${object.kind}/${object.metadata.name}`).sort();
  }

  /** The Nodes a server lists now (every one, no selector). */
  nodeList(server: string): FakeKubeNode[] {
    return this.options.nodes(new URL(server).origin);
  }

  routes(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  transport: KubeApiTransport = async (request: KubeApiRequest): Promise<KubeApiResponse> => {
    const url = new URL(request.url);
    this.calls.push({
      server: url.origin,
      method: request.method,
      path: url.pathname,
      ...(url.searchParams.get('fieldManager') ? { fieldManager: url.searchParams.get('fieldManager')! } : {}),
      ...(request.contentType ? { contentType: request.contentType } : {}),
    });
    this.tokens.push(request.token);
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    if (!request.caPem.includes('BEGIN CERTIFICATE')) return { status: 495, body: { message: 'bad CA' } };
    if (!this.options.accepts(request.token))
      return { status: 401, body: { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' } };
    if (this.failWith) return { status: this.failWith, body: { kind: 'Status', reason: 'Failure', message: 'refused' } };
    const store = this.store(url.origin);
    if (request.method === 'GET' && url.pathname === '/api/v1/nodes') {
      const selector = url.searchParams.get('labelSelector');
      const wanted = selector
        ? selector.split(',').map((term) => term.split('=') as [string, string])
        : [];
      const all = this.options
        .nodes(url.origin)
        .filter((node) => wanted.every(([key, value]) => node.labels[key] === value))
        .map((node) => ({
          metadata: { name: node.name, labels: node.labels, uid: node.uid ?? `uid-${node.name}` },
          spec: node.unschedulable ? { unschedulable: true } : {},
          status: { conditions: [{ type: 'Ready', status: node.ready === false ? 'False' : 'True' }] },
        }));
      // Paged as the API server pages: `limit`, and `continue` (here the offset) until it is empty.
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const from = Number(url.searchParams.get('continue') ?? 0);
      const items = limit > 0 ? all.slice(from, from + limit) : all;
      const more = limit > 0 && from + limit < all.length;
      this.nodePages++;
      return {
        status: 200,
        body: { kind: 'NodeList', metadata: more ? { continue: String(from + limit) } : {}, items },
      };
    }
    if (request.method === 'PATCH') {
      if (request.contentType !== 'application/apply-patch+yaml')
        return { status: 415, body: { kind: 'Status', message: 'unsupported media type' } };
      const object = structuredClone(request.body) as any;
      const namespace = /\/namespaces\/([^/]+)\//.exec(url.pathname)?.[1];
      if (namespace && !store.has(`/api/v1/namespaces/${namespace}`))
        return { status: 404, body: { kind: 'Status', reason: 'NotFound', message: `namespaces "${namespace}" not found` } };
      const existed = store.has(url.pathname);
      store.set(url.pathname, object);
      return { status: existed ? 200 : 201, body: object };
    }
    if (request.method === 'DELETE') {
      if (!store.has(url.pathname)) return { status: 404, body: { kind: 'Status', reason: 'NotFound' } };
      store.delete(url.pathname);
      // A Namespace takes what is in it.
      if (/^\/api\/v1\/namespaces\/[^/]+$/.test(url.pathname)) {
        const name = url.pathname.split('/').pop();
        for (const path of [...store.keys()]) if (path.includes(`/namespaces/${name}/`)) store.delete(path);
      }
      return { status: 200, body: { kind: 'Status', status: 'Success' } };
    }
    return { status: 404, body: { kind: 'Status', reason: 'NotFound' } };
  };
}
