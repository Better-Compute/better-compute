import { describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  kubernetesApiClient,
  kubernetesObjectPath,
  kubernetesSubstrateAgent,
  type KubeApiRequest,
  type KubeApiResponse,
} from '@better-compute/provider-kubernetes';

// The Kubernetes API client a pool substrate applies bcd with: server-side apply (PATCH with
// application/apply-patch+yaml and a field manager), deletes that tolerate absence, and the Node list.
// The bearer token only ever goes into the transport's `token`; it is never in an error.

const pin = (n: number) => `sha256/${Buffer.alloc(32, n).toString('base64')}`;
const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) });
const access = {
  server: 'https://34.118.0.7',
  certificateAuthorityData: Buffer.from('-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n').toString(
    'base64',
  ),
  token: 'super-secret-bearer',
};

function recorder(answer: (request: KubeApiRequest) => KubeApiResponse | Promise<KubeApiResponse>) {
  const calls: KubeApiRequest[] = [];
  return {
    calls,
    transport: async (request: KubeApiRequest) => {
      calls.push(request);
      return answer(request);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('kubernetesObjectPath', () => {
  it('maps core, grouped, namespaced and cluster-scoped kinds', () => {
    expect(kubernetesObjectPath({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'bcd-system' } })).toBe(
      '/api/v1/namespaces/bcd-system',
    );
    expect(
      kubernetesObjectPath({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bcd-join', namespace: 'bcd-system' } }),
    ).toBe('/api/v1/namespaces/bcd-system/secrets/bcd-join');
    expect(
      kubernetesObjectPath({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'bcd', namespace: 'bcd-system' } }),
    ).toBe('/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
    expect(
      kubernetesObjectPath({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'bcd-config', namespace: 'x' } }),
    ).toBe('/api/v1/namespaces/x/configmaps/bcd-config');
  });

  it('refuses kinds it does not know, a namespaced kind without a namespace, and unsafe names', () => {
    for (const object of [
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'x' } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'p' } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: '../nodes', namespace: 'x' } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'a', namespace: 'x' } },
    ])
      expect(() => kubernetesObjectPath(object)).toThrow(/Kubernetes object/);
  });
});

describe('kubernetesApiClient', () => {
  it('server-side applies with a field manager, forced, as apply-patch JSON', async () => {
    const kube = recorder((request) => ({ status: 200, body: request.body }));
    const client = kubernetesApiClient(access, { transport: kube.transport });
    const object = { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'bcd', namespace: 'bcd-system' }, spec: {} };
    await client.apply(object);
    expect(kube.calls).toHaveLength(1);
    const [call] = kube.calls;
    expect(call!.method).toBe('PATCH');
    expect(call!.url).toBe(
      'https://34.118.0.7/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd?fieldManager=better-compute&force=true',
    );
    expect(call!.contentType).toBe('application/apply-patch+yaml');
    expect(call!.body).toEqual(object);
    expect(call!.token).toBe('super-secret-bearer');
    expect(call!.caPem).toContain('BEGIN CERTIFICATE');
    expect(call!.signal).toBeInstanceOf(AbortSignal);
  });

  it('takes another field manager', async () => {
    const kube = recorder(() => ({ status: 201, body: {} }));
    await kubernetesApiClient(access, { transport: kube.transport, fieldManager: 'bc-substrate' }).apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'bcd-system' },
    });
    expect(kube.calls[0]!.url).toContain('fieldManager=bc-substrate');
  });

  it('deletes, and a missing object is already gone', async () => {
    const kube = recorder((request) =>
      request.url.includes('/secrets/') ? { status: 404, body: { kind: 'Status', reason: 'NotFound' } } : { status: 200, body: {} },
    );
    const client = kubernetesApiClient(access, { transport: kube.transport });
    await client.remove({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bcd-join', namespace: 'bcd-system' } });
    await client.remove({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'bcd', namespace: 'bcd-system' } });
    expect(kube.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'DELETE /api/v1/namespaces/bcd-system/secrets/bcd-join',
      'DELETE /apis/apps/v1/namespaces/bcd-system/daemonsets/bcd',
    ]);
  });

  it('creates only what does not exist: a taken name is false and nothing is replaced', async () => {
    const taken = new Set<string>();
    const kube = recorder((request) => {
      const name = (request.body as { metadata: { name: string } }).metadata.name;
      if (taken.has(name)) return { status: 409, body: { kind: 'Status', reason: 'AlreadyExists' } };
      taken.add(name);
      return { status: 201, body: request.body };
    });
    const client = kubernetesApiClient(access, { transport: kube.transport });
    const claim = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'better-compute-substrate', namespace: 'kube-system', labels: { pool: 'pool_1' } },
      data: { poolId: 'pool_1' },
    };
    expect(await client.create(claim)).toBe(true);
    expect(await client.create({ ...claim, data: { poolId: 'pool_2' } })).toBe(false);
    // A POST to the collection (never a forced apply), as JSON, with the field manager.
    expect(kube.calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
      'POST /api/v1/namespaces/kube-system/configmaps?fieldManager=better-compute',
      'POST /api/v1/namespaces/kube-system/configmaps?fieldManager=better-compute',
    ]);
    expect(kube.calls[0]!.contentType).toBe('application/json');
    const refused = recorder(() => ({ status: 403, body: { kind: 'Status', reason: 'Forbidden', message: 'no' } }));
    const error = await rejection(kubernetesApiClient(access, { transport: refused.transport }).create(claim));
    expect(isComputeError(error, 'ACCESS_DENIED')).toBe(true);
  });

  it("reads an object's metadata only (never a Secret's data), and a missing one is undefined", async () => {
    const kube = recorder((request) =>
      request.url.endsWith('/configmaps/gone')
        ? { status: 404, body: { kind: 'Status', reason: 'NotFound' } }
        : {
            status: 200,
            body: { metadata: { name: 'bcd-join', uid: 'u1', labels: { a: 'b', n: 1 } }, data: { token: 'c2VjcmV0' } },
          },
    );
    const client = kubernetesApiClient(access, { transport: kube.transport });
    const secret = await client.get({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bcd-join', namespace: 'bcd-system' } });
    expect(secret).toEqual({ metadata: { name: 'bcd-join', namespace: 'bcd-system', labels: { a: 'b' }, uid: 'u1' } });
    expect(JSON.stringify(secret)).not.toContain('c2VjcmV0');
    expect(await client.get({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'gone', namespace: 'x' } })).toBeUndefined();
    expect(kube.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/v1/namespaces/bcd-system/secrets/bcd-join',
      'GET /api/v1/namespaces/x/configmaps/gone',
    ]);
  });

  it('lists nodes with their labels, readiness and cordon', async () => {
    const kube = recorder(() => ({
      status: 200,
      body: {
        kind: 'NodeList',
        items: [
          {
            metadata: { name: 'gke-a', labels: { 'better-compute.dev/substrate-pool': 'pool_1' } },
            spec: {},
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
          {
            metadata: { name: 'gke-b' },
            spec: { unschedulable: true },
            status: { conditions: [{ type: 'Ready', status: 'False' }] },
          },
        ],
      },
    }));
    const nodes = await kubernetesApiClient(access, { transport: kube.transport }).nodes(
      'better-compute.dev/substrate-pool=pool_1',
    );
    expect(new URL(kube.calls[0]!.url).pathname).toBe('/api/v1/nodes');
    expect(new URL(kube.calls[0]!.url).searchParams.get('labelSelector')).toBe('better-compute.dev/substrate-pool=pool_1');
    expect(nodes).toEqual([
      { name: 'gke-a', labels: { 'better-compute.dev/substrate-pool': 'pool_1' }, ready: true, unschedulable: false },
      { name: 'gke-b', labels: {}, ready: false, unschedulable: true },
    ]);
  });

  it('pages through a large Node list (limit and continue), with each Node uid and provider id', async () => {
    const pages: Record<string, { items: unknown[]; next?: string }> = {
      '': { items: [{ metadata: { name: 'n-0', uid: 'u-0' }, spec: { providerID: 'gce://p/z/n-0' } }], next: 'c1' },
      c1: { items: [{ metadata: { name: 'n-1', uid: 'u-1' } }], next: 'c2' },
      c2: { items: [{ metadata: { name: 'n-2' } }] },
    };
    const kube = recorder((request) => {
      const page = pages[new URL(request.url).searchParams.get('continue') ?? '']!;
      return {
        status: 200,
        body: { kind: 'NodeList', metadata: page.next ? { continue: page.next } : {}, items: page.items },
      };
    });
    const nodes = await kubernetesApiClient(access, { transport: kube.transport }).nodes('a=b');
    expect(nodes.map((node) => node.name)).toEqual(['n-0', 'n-1', 'n-2']);
    expect(nodes[0]).toMatchObject({ uid: 'u-0', providerId: 'gce://p/z/n-0' });
    expect(nodes[2]!.uid).toBeUndefined();
    const queries = kube.calls.map((call) => new URL(call.url).searchParams);
    expect(queries.map((query) => query.get('continue'))).toEqual([null, 'c1', 'c2']);
    expect(queries.every((query) => query.get('limit') === '100' && query.get('labelSelector') === 'a=b')).toBe(true);
  });

  it('stops a Node list that never ends (a bounded number of pages) with an error, not a retry', async () => {
    let n = 0;
    const kube = recorder(() => ({
      status: 200,
      body: { kind: 'NodeList', metadata: { continue: `c${++n}` }, items: [{ metadata: { name: `n-${n}` } }] },
    }));
    const error = await rejection(kubernetesApiClient(access, { transport: kube.transport }).nodes());
    expect(isComputeError(error, 'PROVIDER_ERROR')).toBe(true);
    expect(kube.calls.length).toBeLessThanOrEqual(500);
  });

  it('maps failures to codes and never puts the token or a Secret value in an error', async () => {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'bcd-join', namespace: 'bcd-system' },
      stringData: { token: 'bcjt_abc.very-secret' },
    };
    const echoing = (status: number) =>
      recorder(() => ({
        status,
        body: { kind: 'Status', reason: 'Invalid', message: 'bad token super-secret-bearer and bcjt_abc.very-secret' },
      }));
    const cases: [number, string][] = [
      [401, 'ACCESS_DENIED'],
      [403, 'ACCESS_DENIED'],
      [409, 'CONFLICT'],
      [422, 'INVALID_INPUT'],
      [429, 'RATE_LIMITED'],
      [503, 'UNAVAILABLE'],
    ];
    for (const [status, code] of cases) {
      const kube = echoing(status);
      const error = await rejection(kubernetesApiClient(access, { transport: kube.transport }).apply(secret));
      expect(isComputeError(error, code as never)).toBe(true);
      const text = JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details });
      expect(text).not.toContain('super-secret-bearer');
      expect(text).not.toContain('very-secret');
      expect(text).toContain('Secret bcd-system/bcd-join');
    }
    const down = await rejection(
      kubernetesApiClient(access, {
        transport: async () => {
          throw new Error('connect ECONNREFUSED super-secret-bearer');
        },
      }).nodes(),
    );
    expect(isComputeError(down, 'UNAVAILABLE')).toBe(true);
    expect((down as Error).message).not.toContain('super-secret-bearer');
  });

  it('refuses an endpoint that is not https and hides the token from inspection', () => {
    expect(() => kubernetesApiClient({ ...access, server: 'http://34.118.0.7' })).toThrow(/https/);
    const client = kubernetesApiClient(access, { transport: async () => ({ status: 200, body: {} }) });
    expect(JSON.stringify(client)).not.toContain('super-secret-bearer');
    expect(String(client)).not.toContain('super-secret-bearer');
  });
});

describe('kubernetesSubstrateAgent', () => {
  const agent = kubernetesSubstrateAgent({
    image: `registry.example.com/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
    gatewayUrl: 'https://gw.example.com:8443',
    pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
    joinEncryptionJwk: jwk,
  });

  it('renders the namespace, the token Secret, the config and the DaemonSet, device plugin only', () => {
    const objects = agent.manifests({
      siteId: 'site_k8s',
      joinToken: 'bcjt_abc.secret',
      nodeSelector: { 'better-compute.dev/substrate-pool': 'pool_1' },
    });
    expect(objects.map((object) => `${object.kind}/${object.metadata.name}`)).toEqual([
      'Namespace/bcd-system',
      'Secret/bcd-join-token',
      'ConfigMap/bcd-config',
      'DaemonSet/bcd',
    ]);
    const secret = objects[1] as any;
    expect(secret).toMatchObject({ type: 'Opaque', stringData: { token: 'bcjt_abc.secret' } });
    expect(secret.metadata.namespace).toBe('bcd-system');
    const daemonSet = objects[3] as any;
    expect(daemonSet.spec.template.spec.nodeSelector).toEqual({ 'better-compute.dev/substrate-pool': 'pool_1' });
    const config = (objects[2] as any).data['config.toml'] as string;
    expect(config).toContain('gpu_api = "device-plugin"');
    expect(config).toContain('site = "site_k8s"');
    expect(agent.tokenSecret).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'bcd-join-token', namespace: 'bcd-system' },
    });
  });

  it('leaves the Secret out without a token, and is otherwise deterministic', () => {
    const withoutToken = agent.manifests({ siteId: 'site_k8s' });
    expect(withoutToken.map((object) => object.kind)).toEqual(['Namespace', 'ConfigMap', 'DaemonSet']);
    expect(JSON.stringify(agent.manifests({ siteId: 'site_k8s' }))).toBe(JSON.stringify(withoutToken));
  });

  it('refuses a bad token and connects through its transport', async () => {
    expect(() => agent.manifests({ siteId: 'site_k8s', joinToken: 'not a token\n' })).toThrow(/join token/);
    const kube = recorder(() => ({ status: 200, body: { items: [] } }));
    const withTransport = kubernetesSubstrateAgent({
      image: `registry.example.com/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
      gatewayUrl: 'https://gw.example.com:8443',
      pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
      controlPlaneUrl: 'https://compute.example.com/api/compute',
      transport: kube.transport,
    });
    expect(await withTransport.connect(access, { signal: new AbortController().signal }).nodes()).toEqual([]);
    expect(kube.calls).toHaveLength(1);
  });
});
