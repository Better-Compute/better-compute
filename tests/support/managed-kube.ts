import type { KubeTransport as GkeKubeTransport } from '@better-compute/provider-gcp';
import { KubeAccessClusters, type KubeAccessRequest } from './kube-access.js';

// The provider side of a GKE cluster's own Kubernetes API for the multicloud tests: the access objects provider-gcp's
// `credentials` writes (namespaces, service accounts, ClusterRoles, bindings, the access guard, the TokenRequest API),
// one store per cluster (by API host). A request authenticates only with a token `authorize` vouches for (the
// account's Google token); minted service-account tokens are kept in `issued`, so the substrate agent's cluster API
// can accept exactly those, and `can` says what one may do. (EKS and DOKS have their own in their emulators:
// EksKubeApi, FakeClusterApis; all three keep their objects in kube-access.ts.)

export class TokenRequestApi {
  readonly clusters = new KubeAccessClusters();
  readonly issued: string[] = [];
  /** The account tokens requests carried (the driver's own bearer). */
  readonly bearers = new Set<string>();

  constructor(
    private readonly options: {
      authorize: (token: string) => boolean;
      caPem: string;
      now: () => number;
    },
  ) {}

  /** Whether a token minted for the cluster at `server` may do `request` there now. */
  can(server: string, token: string, request: KubeAccessRequest): boolean {
    return this.clusters.can(server, token, request);
  }

  transport: GkeKubeTransport = async (request) => {
    if (request.caPem !== this.options.caPem) throw new Error('self-signed certificate in chain');
    this.bearers.add(request.token);
    if (!this.options.authorize(request.token))
      return { status: 401, body: { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' } };
    const url = new URL(request.url);
    const answer = this.clusters.of(url.host).handle(
      { method: request.method, path: url.pathname, ...(request.body !== undefined ? { body: request.body } : {}) },
      {
        issue: () => {
          const token = `gke-sa-token-${this.issued.length + 1}`;
          this.issued.push(token);
          return token;
        },
        now: this.options.now,
      },
    );
    return answer ?? { status: 404, body: { kind: 'Status', reason: 'NotFound', message: 'not found' } };
  };
}
