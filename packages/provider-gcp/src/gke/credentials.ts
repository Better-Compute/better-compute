import { isIP } from 'node:net';
import {
  ComputeError,
  type Clock,
  type ErrorCode,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
} from '@better-compute/core';
import { invalid, type GkeCluster } from './client.js';
import type { KubeResponse, KubeTransport } from './transport.js';

// Credentials for one principal on a GKE cluster, minted through the cluster's own Kubernetes API.
// The driver authenticates there with the account's Google access token (GKE maps a project
// principal holding container.admin to cluster-admin), creates or reuses a service account named
// `subject` in the `bc-access` namespace, binds it to the built-in ClusterRole for the role, and
// asks the TokenRequest API for a bound token. Neither token is ever logged or put in an error.

/** The namespace that holds the service accounts better-compute mints credentials for. */
export const accessNamespace = 'bc-access';

const managedBy = { 'app.kubernetes.io/managed-by': 'better-compute' };
const rbacGroup = 'rbac.authorization.k8s.io';
const subjectPattern = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const hostPattern = /^[A-Za-z0-9]([-A-Za-z0-9.]{0,251}[A-Za-z0-9])?$/;
const minTtlSeconds = 600;
const maxTtlSeconds = 86_400;

/** The built-in ClusterRole each role binds to. */
export const clusterRoles = { view: 'view', edit: 'edit', admin: 'cluster-admin' } as const;

/** Validates a credential request: subject a DNS-1123 label, role, and a TTL of 600..86400 s. */
export function checkCredentialRequest(request: KubernetesCredentialRequest): void {
  if (typeof request.subject !== 'string' || !subjectPattern.test(request.subject))
    throw invalid(
      `The subject ${JSON.stringify(request.subject)} is not a DNS-1123 label (lowercase letters, digits and hyphens, at most 63)`,
    );
  if (!Object.hasOwn(clusterRoles, request.role))
    throw invalid(`The role ${JSON.stringify(request.role)} is not view, edit or admin`);
  if (
    !Number.isInteger(request.ttlSeconds) ||
    request.ttlSeconds < minTtlSeconds ||
    request.ttlSeconds > maxTtlSeconds
  )
    throw invalid(`ttlSeconds must be a whole number from ${minTtlSeconds} to ${maxTtlSeconds}`);
}

function kubeError(id: string, what: string, response: KubeResponse): ComputeError {
  const body = response.body as { message?: unknown; reason?: unknown } | undefined;
  const said =
    typeof body?.message === 'string' ? body.message.slice(0, 300) : `HTTP ${response.status}`;
  const { status } = response;
  const details: Record<string, unknown> = {
    provider: 'gcp',
    status,
    reason: typeof body?.reason === 'string' ? body.reason : 'kubernetes',
  };
  let code: ErrorCode;
  if (status === 401 || status === 403) code = 'ACCESS_DENIED';
  else if (status === 404) code = 'NOT_FOUND';
  else if (status === 409) code = 'CONFLICT';
  else if (status === 400 || status === 422) code = 'INVALID_INPUT';
  else if (status === 429) {
    code = 'RATE_LIMITED';
    details.retryAfterMs = 5000;
  } else if (status >= 500) code = 'UNAVAILABLE';
  else code = 'PROVIDER_ERROR';
  return new ComputeError(code, `${what} on cluster ${id}: ${said}`, undefined, details);
}

/** The control plane's address and the cluster's CA, as PEM and as base64 PEM. */
function endpointOf(
  id: string,
  cluster: GkeCluster,
): { server: string; caPem: string; caData: string } {
  const endpoint = cluster.endpoint;
  const caData = cluster.masterAuth?.clusterCaCertificate;
  if (!endpoint || !caData)
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${id} has no control-plane endpoint yet (${cluster.status ?? 'unknown'})`,
      undefined,
      { provider: 'gcp', reason: 'notReady' },
    );
  const family = isIP(endpoint);
  if (!family && !hostPattern.test(endpoint))
    throw new ComputeError('PROVIDER_ERROR', `Cluster ${id} has a malformed endpoint`, undefined, {
      provider: 'gcp',
      reason: 'endpoint',
    });
  const caPem = Buffer.from(caData, 'base64').toString('utf8');
  if (!caPem.includes('-----BEGIN CERTIFICATE-----'))
    throw new ComputeError(
      'PROVIDER_ERROR',
      `Cluster ${id} has a malformed CA certificate`,
      undefined,
      {
        provider: 'gcp',
        reason: 'certificateAuthority',
      },
    );
  return { server: `https://${family === 6 ? `[${endpoint}]` : endpoint}`, caPem, caData };
}

/** Creates the service account and binding (idempotently) and mints a bound token. */
export async function mintCredentials(options: {
  id: string;
  cluster: GkeCluster;
  request: KubernetesCredentialRequest;
  /** The account's Google access token: the bearer on the cluster's Kubernetes API. */
  googleToken: string;
  transport: KubeTransport;
  signal: AbortSignal;
  clock: Clock;
}): Promise<KubernetesCredentials> {
  const { id, request, transport, signal } = options;
  const { server, caPem, caData } = endpointOf(id, options.cluster);
  const { subject, ttlSeconds } = request;
  const role = clusterRoles[request.role];

  const send = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    what: string,
    body?: unknown,
  ): Promise<KubeResponse> => {
    try {
      return await transport({
        url: `${server}${path}`,
        method,
        ...(body !== undefined ? { body } : {}),
        caPem,
        token: options.googleToken,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComputeError(
        'UNAVAILABLE',
        `${what} on cluster ${id}: the Kubernetes API is unreachable`,
        undefined,
        { provider: 'gcp', status: 0, reason: 'network' },
      );
    }
  };
  const expect = (response: KubeResponse, what: string, ...allowed: number[]): KubeResponse => {
    if ((response.status >= 200 && response.status < 300) || allowed.includes(response.status))
      return response;
    throw kubeError(id, what, response);
  };

  // 1. The namespace (409: it is there).
  expect(
    await send('POST', '/api/v1/namespaces', `Creating namespace ${accessNamespace}`, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: accessNamespace, labels: managedBy },
    }),
    `Creating namespace ${accessNamespace}`,
    409,
  );

  // 2. The service account.
  expect(
    await send(
      'POST',
      `/api/v1/namespaces/${accessNamespace}/serviceaccounts`,
      `Creating service account ${subject}`,
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: subject, namespace: accessNamespace, labels: managedBy },
      },
    ),
    `Creating service account ${subject}`,
    409,
  );

  // 3. The binding. Its roleRef is immutable: a binding to another role is deleted and recreated.
  const bindingName = `${accessNamespace}:${subject}`;
  const bindings = `/apis/${rbacGroup}/v1/clusterrolebindings`;
  const binding = {
    apiVersion: `${rbacGroup}/v1`,
    kind: 'ClusterRoleBinding',
    metadata: { name: bindingName, labels: managedBy },
    roleRef: { apiGroup: rbacGroup, kind: 'ClusterRole', name: role },
    subjects: [{ kind: 'ServiceAccount', name: subject, namespace: accessNamespace }],
  };
  const matches = (found: unknown): boolean => {
    const current = found as
      | {
          roleRef?: { kind?: string; name?: string };
          subjects?: { kind?: string; name?: string; namespace?: string }[];
        }
      | undefined;
    const subjects = current?.subjects ?? [];
    return (
      current?.roleRef?.kind === 'ClusterRole' &&
      current.roleRef.name === role &&
      subjects.length === 1 &&
      subjects[0]!.kind === 'ServiceAccount' &&
      subjects[0]!.name === subject &&
      subjects[0]!.namespace === accessNamespace
    );
  };
  const reading = `Reading binding ${bindingName}`;
  const current = expect(await send('GET', `${bindings}/${bindingName}`, reading), reading, 404);
  if (current.status === 404 || !matches(current.body)) {
    if (current.status !== 404) {
      const deleting = `Replacing binding ${bindingName}`;
      expect(await send('DELETE', `${bindings}/${bindingName}`, deleting), deleting, 404);
    }
    const creating = `Creating binding ${bindingName}`;
    const created = expect(await send('POST', bindings, creating, binding), creating, 409);
    if (created.status === 409) {
      // Another caller created it meanwhile: use it only if it grants the same role.
      const again = expect(await send('GET', `${bindings}/${bindingName}`, reading), reading);
      if (!matches(again.body))
        throw new ComputeError(
          'CONFLICT',
          `Binding ${bindingName} on cluster ${id} changed while it was being replaced`,
          undefined,
          { provider: 'gcp', status: 409, reason: 'bindingChanged' },
        );
    }
  }

  // 4. A bound token for the service account.
  const minting = `Minting a token for ${subject}`;
  const minted = expect(
    await send(
      'POST',
      `/api/v1/namespaces/${accessNamespace}/serviceaccounts/${subject}/token`,
      minting,
      {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: { expirationSeconds: ttlSeconds },
      },
    ),
    minting,
  );
  const status = (
    minted.body as { status?: { token?: unknown; expirationTimestamp?: unknown } } | undefined
  )?.status;
  if (typeof status?.token !== 'string' || !status.token)
    throw new ComputeError(
      'PROVIDER_ERROR',
      `${minting} on cluster ${id}: no token in the answer`,
      undefined,
      {
        provider: 'gcp',
        reason: 'noToken',
      },
    );
  const expiry =
    typeof status.expirationTimestamp === 'string' ? Date.parse(status.expirationTimestamp) : NaN;
  return {
    server,
    certificateAuthorityData: caData,
    token: status.token,
    expiresAt: Number.isFinite(expiry) ? expiry : options.clock.now() + ttlSeconds * 1000,
  };
}
