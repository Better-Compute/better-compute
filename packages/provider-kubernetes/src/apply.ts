import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ComputeError, type ErrorCode } from '@better-compute/core';
import {
  bcdDaemonSetManifests,
  type BcdDaemonSetOptions,
  type KubernetesObject,
} from './daemonset.js';

// The Kubernetes API client a pool substrate (the kubernetes module's `kubernetes({ substrate })`) applies bcd with:
// server-side apply (PATCH, `application/apply-patch+yaml`, a field manager, forced), deletes that treat a missing
// object as gone, and the Node list. It reaches a cluster with a short-lived bearer token the caller minted
// (`ProviderKubernetes.credentials`) and trusts only the cluster's CA. The token only ever goes into the transport's
// `token` field: it is never logged, never put in an error and never shown by `JSON.stringify` or `String()` of the
// client. Status messages the API answers are scrubbed of the token and of the values of the object applied.

/** One request to a cluster's Kubernetes API. */
export interface KubeApiRequest {
  /** `https://<endpoint>/<path>[?query]`. */
  url: string;
  method: 'GET' | 'PATCH' | 'DELETE';
  /** The body's media type (`application/apply-patch+yaml` for server-side apply). */
  contentType?: string;
  /** JSON-encoded when present. */
  body?: unknown;
  /** The cluster's CA certificate (PEM): the only CA the connection trusts. */
  caPem: string;
  /** The bearer token. */
  token: string;
  signal: AbortSignal;
}

/** The answer: the HTTP status and the parsed JSON body (undefined when it was not JSON). */
export interface KubeApiResponse {
  status: number;
  body: unknown;
}

/** Sends one request; rejects only when no HTTP answer came back (network, TLS, timeout, signal). */
export type KubeApiTransport = (request: KubeApiRequest) => Promise<KubeApiResponse>;

/** Where a cluster's API is and the credential to use: `ProviderKubernetes.credentials`' answer. */
export interface KubernetesAccess {
  /** `https://<address>` of the control plane. */
  server: string;
  /** PEM, base64 (the kubeconfig `certificate-authority-data`). */
  certificateAuthorityData: string;
  token: string;
}

/** A Node as the substrate reads it. */
export interface KubernetesNode {
  name: string;
  labels: Record<string, string>;
  /** The `Ready` condition is `True`. */
  ready: boolean;
  /** Cordoned (`spec.unschedulable`). */
  unschedulable: boolean;
}

/** An object's identity: enough to address it. */
export type KubernetesObjectRef = Pick<KubernetesObject, 'apiVersion' | 'kind'> & {
  metadata: { name: string; namespace?: string };
};

export interface KubernetesApiClient {
  /** Server-side apply: creates the object or takes ownership of the fields it names. */
  apply(object: KubernetesObject): Promise<void>;
  /** Deletes the object; one that does not exist is already gone. */
  remove(object: KubernetesObjectRef): Promise<void>;
  /** The cluster's Nodes, optionally those matching a label selector (`key=value[,…]`). */
  nodes(labelSelector?: string): Promise<KubernetesNode[]>;
}

export interface KubernetesApiClientOptions {
  /** Default: `node:https` trusting only the cluster's CA. */
  transport?: KubeApiTransport;
  /** The server-side apply field manager (default `better-compute`). */
  fieldManager?: string;
  signal?: AbortSignal;
}

const maxResponseBytes = 4 << 20;
const timeoutMs = 30_000;

/** The default transport: `node:https` with `ca` set to the cluster's CA only (no public roots). */
export const httpsKubeApiTransport: KubeApiTransport = (req) =>
  new Promise<KubeApiResponse>((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') {
      reject(new Error('The Kubernetes API is only reached over https'));
      return;
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    const call = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        ca: req.caPem,
        // SNI takes a host name only (RFC 6066); an IP endpoint is checked against the IP SANs.
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
        agent: false,
        signal: req.signal,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${req.token}`,
          accept: 'application/json',
          ...(payload !== undefined
            ? {
                'content-type': req.contentType ?? 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            response.destroy(new Error('The Kubernetes API answer is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    call.on('timeout', () => call.destroy(new Error('The Kubernetes API did not answer in time')));
    call.on('error', reject);
    call.end(payload);
  });

/** Kinds the client addresses: their plural resource and whether they live in a namespace. */
const kinds: Readonly<Record<string, { plural: string; namespaced: boolean }>> = Object.freeze({
  Namespace: { plural: 'namespaces', namespaced: false },
  ConfigMap: { plural: 'configmaps', namespaced: true },
  Secret: { plural: 'secrets', namespaced: true },
  ServiceAccount: { plural: 'serviceaccounts', namespaced: true },
  DaemonSet: { plural: 'daemonsets', namespaced: true },
  Role: { plural: 'roles', namespaced: true },
  RoleBinding: { plural: 'rolebindings', namespaced: true },
  ClusterRole: { plural: 'clusterroles', namespaced: false },
  ClusterRoleBinding: { plural: 'clusterrolebindings', namespaced: false },
  PriorityClass: { plural: 'priorityclasses', namespaced: false },
  RuntimeClass: { plural: 'runtimeclasses', namespaced: false },
});
const dns1123Subdomain =
  /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/;
const dns1123Label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const apiVersionPattern = /^(?:[a-z0-9.-]{1,253}\/)?v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/;

function badObject(message: string): never {
  throw new ComputeError('INVALID_INPUT', `Kubernetes object: ${message}`);
}

/** The REST path of an object (`/api/v1/namespaces/x/secrets/y`, `/apis/apps/v1/…`). */
export function kubernetesObjectPath(object: KubernetesObjectRef): string {
  const kind = Object.hasOwn(kinds, object.kind) ? kinds[object.kind] : undefined;
  if (!kind) return badObject(`kind ${String(object.kind)} is not one the substrate applies`);
  if (typeof object.apiVersion !== 'string' || !apiVersionPattern.test(object.apiVersion))
    return badObject(`apiVersion ${String(object.apiVersion)} is invalid`);
  const name = object.metadata?.name;
  if (typeof name !== 'string' || !dns1123Subdomain.test(name))
    return badObject(`name ${String(name)} is invalid`);
  const namespace = object.metadata.namespace;
  if (kind.namespaced && (typeof namespace !== 'string' || !dns1123Label.test(namespace)))
    return badObject(`${object.kind} ${name} needs a namespace (a DNS-1123 label)`);
  if (!kind.namespaced && namespace !== undefined)
    return badObject(`${object.kind} ${name} is cluster-scoped and takes no namespace`);
  const base = object.apiVersion.includes('/') ? `/apis/${object.apiVersion}` : `/api/${object.apiVersion}`;
  return kind.namespaced
    ? `${base}/namespaces/${namespace}/${kind.plural}/${name}`
    : `${base}/${kind.plural}/${name}`;
}

const describe = (object: KubernetesObjectRef) =>
  `${object.kind} ${object.metadata.namespace ? `${object.metadata.namespace}/` : ''}${object.metadata.name}`;

/** The string values of a Secret's `data` / `stringData`: never allowed into an error. */
function secretValues(object: KubernetesObjectRef): string[] {
  const values: string[] = [];
  for (const field of ['data', 'stringData'] as const) {
    const entries = (object as Record<string, unknown>)[field];
    if (entries && typeof entries === 'object')
      for (const value of Object.values(entries as Record<string, unknown>))
        if (typeof value === 'string' && value.length >= 4) values.push(value);
  }
  return values;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.slice(0, 300);
}

function statusCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400 || status === 422) return 'INVALID_INPUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

const caPemOf = (data: string): string => {
  const pem = Buffer.from(data, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----'))
    throw new ComputeError('INVALID_INPUT', 'certificateAuthorityData is not a base64 PEM certificate');
  return pem;
};

/** A client for one cluster's API with one short-lived credential. */
export function kubernetesApiClient(
  access: KubernetesAccess,
  options: KubernetesApiClientOptions = {},
): KubernetesApiClient {
  let server: URL;
  try {
    server = new URL(access.server);
  } catch {
    throw new ComputeError('INVALID_INPUT', 'The Kubernetes API server must be an https URL');
  }
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash)
    throw new ComputeError('INVALID_INPUT', 'The Kubernetes API server must be an https URL');
  if (typeof access.token !== 'string' || access.token.length === 0)
    throw new ComputeError('INVALID_INPUT', 'A Kubernetes API token is required');
  const fieldManager = options.fieldManager ?? 'better-compute';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fieldManager))
    throw new ComputeError('INVALID_INPUT', 'fieldManager is invalid');
  const caPem = caPemOf(access.certificateAuthorityData);
  const origin = server.href.replace(/\/$/, '');
  const transport = options.transport ?? httpsKubeApiTransport;
  const signal = options.signal ?? new AbortController().signal;
  // Held in this closure only: the client object itself carries no field with it.
  const token = access.token;

  async function send(
    what: string,
    secrets: readonly string[],
    request: Omit<KubeApiRequest, 'caPem' | 'token' | 'signal'>,
  ): Promise<KubeApiResponse> {
    let response: KubeApiResponse;
    try {
      response = await transport({ ...request, caPem, token, signal });
    } catch (error) {
      if (signal.aborted) throw new ComputeError('UNAVAILABLE', `${what}: the request was aborted`);
      throw new ComputeError(
        'UNAVAILABLE',
        `${what}: the Kubernetes API did not answer (${scrub(String((error as Error)?.message ?? error), [token, ...secrets])})`,
      );
    }
    return response;
  }

  function failure(what: string, response: KubeApiResponse, secrets: readonly string[]): ComputeError {
    const status = response.body as { message?: unknown; reason?: unknown } | undefined;
    const message = typeof status?.message === 'string' ? `: ${scrub(status.message, [token, ...secrets])}` : '';
    const reason = typeof status?.reason === 'string' ? scrub(status.reason, [token, ...secrets]).slice(0, 64) : undefined;
    return new ComputeError(
      statusCode(response.status),
      `${what}: the Kubernetes API answered ${response.status}${message}`,
      undefined,
      { status: response.status, ...(reason ? { reason } : {}) },
    );
  }

  const client: KubernetesApiClient = {
    async apply(object) {
      const path = kubernetesObjectPath(object);
      const what = `Applying ${describe(object)}`;
      const secrets = secretValues(object);
      const query = new URLSearchParams({ fieldManager, force: 'true' });
      const response = await send(what, secrets, {
        url: `${origin}${path}?${query}`,
        method: 'PATCH',
        contentType: 'application/apply-patch+yaml',
        body: object,
      });
      if (response.status !== 200 && response.status !== 201) throw failure(what, response, secrets);
    },
    async remove(object) {
      const path = kubernetesObjectPath(object);
      const what = `Deleting ${describe(object)}`;
      const response = await send(what, [], { url: `${origin}${path}`, method: 'DELETE' });
      if (response.status === 404) return;
      if (response.status !== 200 && response.status !== 202) throw failure(what, response, []);
    },
    async nodes(labelSelector) {
      const what = 'Listing nodes';
      const query = labelSelector ? `?${new URLSearchParams({ labelSelector })}` : '';
      const response = await send(what, [], { url: `${origin}/api/v1/nodes${query}`, method: 'GET' });
      if (response.status !== 200) throw failure(what, response, []);
      const items = (response.body as { items?: unknown })?.items;
      if (!Array.isArray(items))
        throw new ComputeError('PROVIDER_ERROR', `${what}: the Kubernetes API answered no NodeList`);
      return items.map((item) => {
        const node = item as {
          metadata?: { name?: unknown; labels?: unknown };
          spec?: { unschedulable?: unknown };
          status?: { conditions?: unknown };
        };
        const labels: Record<string, string> = {};
        if (node.metadata?.labels && typeof node.metadata.labels === 'object')
          for (const [key, value] of Object.entries(node.metadata.labels as Record<string, unknown>))
            if (typeof value === 'string') labels[key] = value;
        const conditions = Array.isArray(node.status?.conditions) ? node.status.conditions : [];
        return {
          name: String(node.metadata?.name ?? ''),
          labels,
          ready: conditions.some(
            (condition: { type?: unknown; status?: unknown }) =>
              condition?.type === 'Ready' && condition?.status === 'True',
          ),
          unschedulable: node.spec?.unschedulable === true,
        };
      });
    },
  };
  Object.defineProperty(client, 'toString', { value: () => `[KubernetesApiClient ${origin}]` });
  Object.defineProperty(client, 'toJSON', { value: () => ({ server: origin }) });
  return client;
}

// --- The substrate agent ---------------------------------------------------------------------------

/**
 * What `kubernetes({ substrate })` needs to run bcd on a pool's cluster: the bcd DaemonSet options except what the
 * pool decides (its site, the token Secret, the node selector) and `gpuApi` (a substrate pool books GPUs through
 * bcd's device plugin only).
 */
export interface KubernetesSubstrateAgentOptions
  extends Omit<BcdDaemonSetOptions, 'siteId' | 'joinTokenSecret' | 'gpuApi' | 'nodeSelector' | 'createNamespace'> {
  /** The token Secret's name (default `bcd-join-token`). */
  joinTokenSecretName?: string;
  /** The Kubernetes API transport (default `node:https` trusting only the cluster CA). */
  transport?: KubeApiTransport;
  /** Default `better-compute`. */
  fieldManager?: string;
}

/** The agent a pool substrate applies: bcd's objects for a pool, and a client per short-lived credential. */
export interface KubernetesSubstrateAgent {
  /**
   * The objects to apply, in order: the Namespace, the join-token Secret (only with `joinToken`), bcd's ConfigMap
   * and the DaemonSet (`gpuApi: 'device-plugin'`).
   */
  manifests(input: {
    siteId: string;
    joinToken?: string;
    nodeSelector?: Readonly<Record<string, string>>;
  }): KubernetesObject[];
  /** The join-token Secret, to delete once every node joined. */
  readonly tokenSecret: KubernetesObjectRef;
  connect(access: KubernetesAccess, options: { signal: AbortSignal }): KubernetesApiClient;
}

const joinTokenPattern = /^[A-Za-z0-9_.~+/=-]{8,512}$/;

export function kubernetesSubstrateAgent(options: KubernetesSubstrateAgentOptions): KubernetesSubstrateAgent {
  const { transport, fieldManager, joinTokenSecretName, ...bcd } = options;
  const namespace = bcd.namespace ?? 'bcd-system';
  const secretName = joinTokenSecretName ?? 'bcd-join-token';
  if (!dns1123Subdomain.test(secretName))
    throw new ComputeError('INVALID_CONFIG', 'kubernetesSubstrateAgent: joinTokenSecretName must be a Secret name');
  const tokenSecret: KubernetesObjectRef = Object.freeze({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: Object.freeze({ name: secretName, namespace }),
  });
  const render = (siteId: string, nodeSelector?: Readonly<Record<string, string>>) =>
    bcdDaemonSetManifests({
      ...bcd,
      siteId,
      gpuApi: 'device-plugin',
      joinTokenSecret: { name: secretName, key: 'token' },
      ...(nodeSelector && Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
    });
  // Checks the options once, up front: a misconfigured agent fails at startup, not on the first pool.
  render('site_check');
  return Object.freeze({
    tokenSecret,
    manifests(input: { siteId: string; joinToken?: string; nodeSelector?: Readonly<Record<string, string>> }) {
      const objects = render(input.siteId, input.nodeSelector);
      if (input.joinToken === undefined) return objects;
      if (typeof input.joinToken !== 'string' || !joinTokenPattern.test(input.joinToken))
        throw new ComputeError('INVALID_INPUT', 'The join token is not a join token');
      const secret: KubernetesObject = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace,
          labels: { 'app.kubernetes.io/name': 'bcd', 'app.kubernetes.io/part-of': 'better-compute' },
        },
        type: 'Opaque',
        stringData: { token: input.joinToken },
      };
      const at = objects[0]?.kind === 'Namespace' ? 1 : 0;
      return [...objects.slice(0, at), secret, ...objects.slice(at)];
    },
    connect(access: KubernetesAccess, connectOptions: { signal: AbortSignal }) {
      return kubernetesApiClient(access, {
        signal: connectOptions.signal,
        ...(transport ? { transport } : {}),
        ...(fieldManager ? { fieldManager } : {}),
      });
    },
  });
}
