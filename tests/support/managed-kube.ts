import type { KubeTransport as GkeKubeTransport } from '@better-compute/provider-gcp';

// The provider side of a GKE cluster's own Kubernetes API for the multicloud tests: namespaces, service accounts,
// cluster role bindings and the TokenRequest API, as provider-gcp's `credentials` uses them. A request authenticates
// only with a token `authorize` vouches for (the account's Google token); minted service-account tokens are kept in
// `issued`, so the substrate agent's cluster API can accept exactly those. (EKS and DOKS have their own in their
// emulators: EksKubeApi, FakeClusterApis.)

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class TokenRequestApi {
  readonly namespaces = new Set<string>();
  readonly serviceAccounts = new Set<string>();
  readonly bindings = new Map<string, Json>();
  readonly issued: string[] = [];

  constructor(
    private readonly options: {
      authorize: (token: string) => boolean;
      caPem: string;
      now: () => number;
    },
  ) {}

  transport: GkeKubeTransport = async (request) => {
    const ok = (status: number, payload: unknown) => ({ status, body: payload });
    if (request.caPem !== this.options.caPem) throw new Error('self-signed certificate in chain');
    if (!this.options.authorize(request.token))
      return ok(401, { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' });
    const host = new URL(request.url).host;
    const path = new URL(request.url).pathname;
    const body = request.body as Json;
    const exists = { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' };
    const missing = { kind: 'Status', reason: 'NotFound', message: 'not found' };
    let m: RegExpExecArray | null;
    if (request.method === 'POST' && path === '/api/v1/namespaces') {
      const key = `${host}/${body.metadata.name}`;
      if (this.namespaces.has(key)) return ok(409, exists);
      this.namespaces.add(key);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path)) && request.method === 'POST') {
      if (!this.namespaces.has(`${host}/${m[1]}`)) return ok(404, missing);
      const key = `${host}/${m[1]}/${body.metadata.name}`;
      if (this.serviceAccounts.has(key)) return ok(409, exists);
      this.serviceAccounts.add(key);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)\/token$/.exec(path))) {
      if (!this.serviceAccounts.has(`${host}/${m[1]}/${m[2]}`)) return ok(404, missing);
      const token = `gke-sa-token-${this.issued.length + 1}`;
      this.issued.push(token);
      const ttl = body.spec.expirationSeconds as number;
      return ok(201, {
        ...body,
        status: { token, expirationTimestamp: new Date(this.options.now() + ttl * 1000).toISOString() },
      });
    }
    const bindings = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
    if (path === bindings && request.method === 'POST') {
      const key = `${host}/${body.metadata.name}`;
      if (this.bindings.has(key)) return ok(409, exists);
      this.bindings.set(key, body);
      return ok(201, body);
    }
    if (path.startsWith(`${bindings}/`)) {
      const key = `${host}/${decodeURIComponent(path.slice(bindings.length + 1))}`;
      const found = this.bindings.get(key);
      if (!found) return ok(404, missing);
      if (request.method === 'GET') return ok(200, found);
      if (request.method === 'DELETE') {
        this.bindings.delete(key);
        return ok(200, { kind: 'Status', status: 'Success' });
      }
    }
    return ok(404, missing);
  };
}
