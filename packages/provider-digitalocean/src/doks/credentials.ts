import { createHash } from 'node:crypto';
import {
  ComputeError,
  type Clock,
  type ErrorCode,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { fail, invalid } from './common.js';
import type { KubeResponse, KubeTransport } from './transport.js';
import type { DoksCluster, DoksCredentials } from './types.js';

// Credentials for one principal on a DOKS cluster, minted through the cluster's own Kubernetes
// API (the GKE driver's approach). DOKS hands out a short-lived cluster-admin credential
// (`GET /kubernetes/clusters/{id}/credentials?expiry_seconds=…`); the driver holds it in memory for
// this one call only, to create or reuse the service account of the subject and role in the
// `bc-access` namespace, bind it to the built-in ClusterRole for the role, and ask the TokenRequest
// API for a bound token. Each (subject, role) has its own account and binding, so a token always
// acts with the role it was minted for: a mint of another role for the same subject, concurrent or
// later, never re-scopes it. The connection trusts only the cluster's CA. Neither token is ever
// stored, logged or put in an error.
//
// view and admin bind the built-in `view` and `cluster-admin`. edit does not bind the built-in
// `edit`: it lets a subject impersonate, mint tokens for and run pods as any service account of the
// namespaces it covers, and every subject's service account lives in `bc-access`, so an edit subject
// would be cluster-admin through an admin subject's. `better-compute:edit` is `view` plus edit's
// writes without serviceaccount impersonation or TokenRequest, and before any token is minted the
// cluster gets a ValidatingAdmissionPolicy that refuses every write, delete and connect in
// `bc-access` and `kube-system` by a subject that cannot escalate ClusterRoles (any but
// cluster-admin). Clusters before Kubernetes 1.30 (no ValidatingAdmissionPolicy) get no credentials.
// This is the EKS driver's approach (provider-aws eks/credentials.ts); keep the three drivers alike.

/** The namespace that holds the service accounts better-compute mints credentials for. */
export const accessNamespace = 'bc-access';

/** How long DOKS's cluster-admin credential lives: just long enough for the mint. */
export const adminCredentialSeconds = 300;

const managedBy = { 'app.kubernetes.io/managed-by': 'better-compute' };
const rbacGroup = 'rbac.authorization.k8s.io';
const subjectPattern = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const hostPattern = /^[A-Za-z0-9]([-A-Za-z0-9.]{0,251}[A-Za-z0-9])?$/;
const minTtlSeconds = 600;
const maxTtlSeconds = 86_400;

/** The ClusterRole each role binds to: built-in for view and admin, better-compute's for edit. */
export const clusterRoles = {
  view: 'view',
  edit: 'better-compute:edit',
  admin: 'cluster-admin',
} as const;

/** The ValidatingAdmissionPolicy (and its binding) that keeps subjects out of `guardedNamespaces`. */
export const accessGuard = 'better-compute-access-guard';
/** The namespaces only cluster-admin subjects change: the subjects' own, and the control loops'. */
export const guardedNamespaces = [accessNamespace, 'kube-system'] as const;
const editWritesRole = 'better-compute:edit-writes';
const aggregateToEdit = 'better-compute.dev/aggregate-to-edit';
const writeVerbs = ['create', 'delete', 'deletecollection', 'patch', 'update'];

/**
 * The cluster objects credentials rely on: `better-compute:edit` (aggregating `view` and
 * `better-compute:edit-writes`, the built-in edit's writes without `impersonate` on
 * serviceaccounts and without `serviceaccounts/token`), and the access guard policy and binding.
 */
export function accessManifests(): {
  clusterRoles: Record<string, unknown>[];
  policy: Record<string, unknown>;
  binding: Record<string, unknown>;
} {
  const role = (
    name: string,
    extra: Record<string, unknown>,
    labels: Record<string, string> = {},
  ) => ({
    apiVersion: `${rbacGroup}/v1`,
    kind: 'ClusterRole',
    metadata: { name, labels: { ...managedBy, ...labels } },
    ...extra,
  });
  return {
    clusterRoles: [
      role(
        editWritesRole,
        {
          rules: [
            {
              apiGroups: [''],
              resources: ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets', 'services/proxy'],
              verbs: ['get', 'list', 'watch'],
            },
            {
              apiGroups: [''],
              resources: ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy'],
              verbs: writeVerbs,
            },
            { apiGroups: [''], resources: ['pods/eviction'], verbs: ['create'] },
            {
              apiGroups: [''],
              resources: [
                'configmaps',
                'events',
                'persistentvolumeclaims',
                'replicationcontrollers',
                'replicationcontrollers/scale',
                'secrets',
                'serviceaccounts',
                'services',
                'services/proxy',
              ],
              verbs: writeVerbs,
            },
            {
              apiGroups: ['apps'],
              resources: [
                'daemonsets',
                'deployments',
                'deployments/rollback',
                'deployments/scale',
                'replicasets',
                'replicasets/scale',
                'statefulsets',
                'statefulsets/scale',
              ],
              verbs: writeVerbs,
            },
            { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: writeVerbs },
            { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: writeVerbs },
            { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: writeVerbs },
            {
              apiGroups: ['networking.k8s.io'],
              resources: ['ingresses', 'networkpolicies'],
              verbs: writeVerbs,
            },
            {
              apiGroups: ['coordination.k8s.io'],
              resources: ['leases'],
              verbs: [...writeVerbs, 'get', 'list', 'watch'],
            },
          ],
        },
        { [aggregateToEdit]: 'true' },
      ),
      role(clusterRoles.edit, {
        aggregationRule: {
          clusterRoleSelectors: [
            { matchLabels: { 'rbac.authorization.k8s.io/aggregate-to-view': 'true' } },
            { matchLabels: { [aggregateToEdit]: 'true' } },
          ],
        },
      }),
    ],
    policy: {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: accessGuard, labels: managedBy },
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          namespaceSelector: {
            matchExpressions: [
              { key: 'kubernetes.io/metadata.name', operator: 'In', values: [...guardedNamespaces] },
            ],
          },
          resourceRules: [
            {
              apiGroups: ['*'],
              apiVersions: ['*'],
              operations: ['CREATE', 'UPDATE', 'DELETE', 'CONNECT'],
              resources: ['*', '*/*'],
              scope: 'Namespaced',
            },
          ],
        },
        matchConditions: [
          {
            name: 'better-compute-subject',
            expression: `request.userInfo.groups.exists(g, g == 'system:serviceaccounts:${accessNamespace}')`,
          },
        ],
        validations: [
          {
            expression: `authorizer.group('${rbacGroup}').resource('clusterroles').check('escalate').allowed()`,
            message: `Only cluster-admin subjects change ${guardedNamespaces.join(' or ')}`,
            reason: 'Forbidden',
          },
        ],
      },
    },
    binding: {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: accessGuard, labels: managedBy },
      spec: { policyName: accessGuard, validationActions: ['Deny'] },
    },
  };
}

const roleSuffixes = { view: 'v', edit: 'e', admin: 'a' } as const;

/**
 * The service account of one subject and role: `<subject>-<v|e|a>` (at most 62 characters), or for
 * a subject longer than 60 its first 40 characters, 20 hex of its SHA-256 and the role letter
 * (exactly 63). The two forms never share a length, so no subject can take another's account.
 */
export function serviceAccountName(
  subject: string,
  role: KubernetesCredentialRequest['role'],
): string {
  const suffix = roleSuffixes[role];
  if (subject.length <= 60) return `${subject}-${suffix}`;
  const hash = createHash('sha256').update(subject).digest('hex').slice(0, 20);
  return `${subject.slice(0, 40)}-${hash}-${suffix}`;
}

/** Validates a credential request: subject a DNS-1123 label, role, and a TTL of 600..86400 s. */
export function checkCredentialRequest(request: KubernetesCredentialRequest): void {
  if (typeof request.subject !== 'string' || !subjectPattern.test(request.subject))
    throw invalid(
      `The subject ${JSON.stringify(request.subject)} is not a DNS-1123 label (lowercase letters, digits and hyphens, at most 63)`,
      'subject',
    );
  if (!Object.hasOwn(clusterRoles, request.role))
    throw invalid(`The role ${JSON.stringify(request.role)} is not view, edit or admin`, 'role');
  if (
    !Number.isInteger(request.ttlSeconds) ||
    request.ttlSeconds < minTtlSeconds ||
    request.ttlSeconds > maxTtlSeconds
  )
    throw invalid(
      `ttlSeconds must be a whole number from ${minTtlSeconds} to ${maxTtlSeconds}`,
      'ttlSeconds',
    );
}

function kubeError(id: string, what: string, response: KubeResponse): ComputeError {
  const body = response.body as { message?: unknown; reason?: unknown } | undefined;
  const said =
    typeof body?.message === 'string' ? body.message.slice(0, 300) : `HTTP ${response.status}`;
  const { status } = response;
  const details: Record<string, unknown> = {
    provider: 'digitalocean',
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

/** The control plane's `https://host` from the cluster's endpoint; INVALID_STATE before it runs. */
export function serverOf(id: string, cluster: DoksCluster): string {
  const endpoint = cluster.endpoint;
  if (!endpoint)
    throw fail(
      'INVALID_STATE',
      `Cluster ${id} has no control-plane endpoint yet (${cluster.status?.state ?? 'unknown'})`,
      'notReady',
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw fail('PROVIDER_ERROR', `Cluster ${id} has a malformed endpoint`, 'endpoint');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    !(hostPattern.test(host) || url.hostname.startsWith('['))
  )
    throw fail('PROVIDER_ERROR', `Cluster ${id} has a malformed endpoint`, 'endpoint');
  return url.origin;
}

/**
 * DOKS's short-lived cluster-admin credential for the cluster: its bearer token and the cluster's
 * CA. It must name the cluster's own endpoint; a client certificate alone is not used.
 */
async function adminCredential(
  client: DoClient,
  id: string,
  server: string,
  signal: AbortSignal,
): Promise<{ token: string; caPem: string; caData: string }> {
  const issued = await client.request<DoksCredentials>(
    'GET',
    `/kubernetes/clusters/${id}/credentials`,
    { query: { expiry_seconds: String(adminCredentialSeconds) }, signal, budget: 'observe' },
  );
  let origin: string | undefined;
  try {
    origin = issued.server ? new URL(issued.server).origin : undefined;
  } catch {
    origin = undefined;
  }
  if (origin !== server)
    throw fail(
      'PROVIDER_ERROR',
      `DigitalOcean's credentials for cluster ${id} name another endpoint than the cluster's`,
      'endpoint',
    );
  const caData = issued.certificate_authority_data;
  const caPem = caData ? Buffer.from(caData, 'base64').toString('utf8') : '';
  if (!caData || !caPem.includes('-----BEGIN CERTIFICATE-----'))
    throw fail(
      'PROVIDER_ERROR',
      `Cluster ${id} has a malformed CA certificate`,
      'certificateAuthority',
    );
  if (typeof issued.token !== 'string' || !issued.token)
    throw fail(
      'PROVIDER_ERROR',
      `DigitalOcean's credentials for cluster ${id} carry no bearer token`,
      'noToken',
    );
  return { token: issued.token, caPem, caData };
}

type Send = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  what: string,
  body?: unknown,
) => Promise<KubeResponse>;
type Expect = (response: KubeResponse, what: string, ...allowed: number[]) => KubeResponse;

/** Requests to the cluster's API with DOKS's admin credential, and the check of their answers. */
function connection(options: {
  id: string;
  server: string;
  caPem: string;
  token: string;
  transport: KubeTransport;
  signal: AbortSignal;
}): { send: Send; expect: Expect } {
  const { id, server, caPem, transport, signal } = options;
  const send: Send = async (method, path, what, body) => {
    try {
      return await transport({
        url: `${server}${path}`,
        method,
        ...(body !== undefined ? { body } : {}),
        caPem,
        token: options.token,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComputeError(
        'UNAVAILABLE',
        `${what} on cluster ${id}: the Kubernetes API is unreachable`,
        undefined,
        { provider: 'digitalocean', status: 0, reason: 'network' },
      );
    }
  };
  const expect: Expect = (response, what, ...allowed) => {
    if ((response.status >= 200 && response.status < 300) || allowed.includes(response.status))
      return response;
    throw kubeError(id, what, response);
  };
  return { send, expect };
}

/** Writes better-compute:edit and the access guard: created, or replaced (an unconditional PUT). */
async function writeAccessGuard(id: string, send: Send, expect: Expect): Promise<void> {
  const manifests = accessManifests();
  const admission = '/apis/admissionregistration.k8s.io/v1';
  const write = async (collection: string, object: Record<string, unknown>, what: string) => {
    const name = (object.metadata as { name: string }).name;
    const created = await send('POST', collection, what, object);
    if (created.status === 404 && collection.startsWith(admission))
      throw new ComputeError(
        'INVALID_STATE',
        `Cluster ${id} has no ValidatingAdmissionPolicy API (Kubernetes 1.30 or later): better-compute mints no credentials without its access guard`,
        undefined,
        { provider: 'digitalocean', status: 404, reason: 'accessGuard' },
      );
    if (expect(created, what, 409).status === 409)
      expect(await send('PUT', `${collection}/${encodeURIComponent(name)}`, what, object), what);
  };
  for (const role of manifests.clusterRoles)
    await write(
      `/apis/${rbacGroup}/v1/clusterroles`,
      role,
      `Writing ClusterRole ${(role.metadata as { name: string }).name}`,
    );
  await write(
    `${admission}/validatingadmissionpolicies`,
    manifests.policy,
    `Writing admission policy ${accessGuard}`,
  );
  await write(
    `${admission}/validatingadmissionpolicybindings`,
    manifests.binding,
    `Writing admission policy binding ${accessGuard}`,
  );
}

/** Creates the service account and binding (idempotently) and mints a bound token. */
export async function mintCredentials(options: {
  id: string;
  cluster: DoksCluster;
  request: KubernetesCredentialRequest;
  client: DoClient;
  transport: KubeTransport;
  signal: AbortSignal;
  clock: Clock;
  /** The access guard and better-compute:edit were put in place by this process already. */
  guarded?: boolean;
}): Promise<KubernetesCredentials> {
  const { id, request, transport, signal } = options;
  const server = serverOf(id, options.cluster);
  const admin = await adminCredential(options.client, id, server, signal);
  const { subject, ttlSeconds } = request;
  const role = clusterRoles[request.role];
  const account = serviceAccountName(subject, request.role);
  const { send, expect } = connection({
    id,
    server,
    caPem: admin.caPem,
    token: admin.token,
    transport,
    signal,
  });

  // 0. The access guard and better-compute:edit, before any subject exists.
  if (!options.guarded) await writeAccessGuard(id, send, expect);

  // 1. The namespace (409: it is there).
  const namespacing = `Creating namespace ${accessNamespace}`;
  expect(
    await send('POST', '/api/v1/namespaces', namespacing, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: accessNamespace, labels: managedBy },
    }),
    namespacing,
    409,
  );

  // 2. The service account of this subject and role.
  const accounting = `Creating service account ${account}`;
  expect(
    await send('POST', `/api/v1/namespaces/${accessNamespace}/serviceaccounts`, accounting, {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: account,
        namespace: accessNamespace,
        labels: { ...managedBy, 'better-compute.io/role': request.role },
        annotations: { 'better-compute.io/subject': subject },
      },
    }),
    accounting,
    409,
  );

  // 3. The binding. Its roleRef is immutable: a binding to another role is deleted and recreated.
  const bindingName = `${accessNamespace}:${account}`;
  const bindings = `/apis/${rbacGroup}/v1/clusterrolebindings`;
  const binding = {
    apiVersion: `${rbacGroup}/v1`,
    kind: 'ClusterRoleBinding',
    metadata: { name: bindingName, labels: managedBy },
    roleRef: { apiGroup: rbacGroup, kind: 'ClusterRole', name: role },
    subjects: [{ kind: 'ServiceAccount', name: account, namespace: accessNamespace }],
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
      subjects[0]!.name === account &&
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
        throw fail(
          'CONFLICT',
          `Binding ${bindingName} on cluster ${id} changed while it was being replaced`,
          'bindingChanged',
          { status: 409 },
        );
    }
  }

  // 4. A bound token for the service account.
  const minting = `Minting a token for ${account}`;
  const minted = expect(
    await send(
      'POST',
      `/api/v1/namespaces/${accessNamespace}/serviceaccounts/${account}/token`,
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
    throw fail('PROVIDER_ERROR', `${minting} on cluster ${id}: no token in the answer`, 'noToken');
  const expiry =
    typeof status.expirationTimestamp === 'string' ? Date.parse(status.expirationTimestamp) : NaN;
  return {
    server,
    certificateAuthorityData: admin.caData,
    token: status.token,
    expiresAt: Number.isFinite(expiry) ? expiry : options.clock.now() + ttlSeconds * 1000,
  };
}

/**
 * Removes what `mintCredentials` made for `subject` (the service account and binding of each role),
 * and the `bc-access` namespace once no subject's service account is left in it: tokens minted for
 * the subject stop working with their service accounts. better-compute:edit and the access guard
 * stay (they grant nothing on their own). Idempotent: what is gone already counts as removed; any
 * other failure throws, so a caller that must not leave access behind tries again.
 */
export async function forgetCredentials(options: {
  id: string;
  cluster: DoksCluster;
  subject: string;
  client: DoClient;
  transport: KubeTransport;
  signal: AbortSignal;
}): Promise<void> {
  const { id, subject, signal } = options;
  if (typeof subject !== 'string' || !subjectPattern.test(subject))
    throw invalid(`The subject ${JSON.stringify(subject)} is not a DNS-1123 label`, 'subject');
  const server = serverOf(id, options.cluster);
  const admin = await adminCredential(options.client, id, server, signal);
  const { send, expect } = connection({
    id,
    server,
    caPem: admin.caPem,
    token: admin.token,
    transport: options.transport,
    signal,
  });
  const roles = Object.keys(clusterRoles) as KubernetesCredentialRequest['role'][];
  await forgetAccess(
    send,
    expect,
    roles.map((role) => serviceAccountName(subject, role)),
  );
}

/** Deletes the bindings and service accounts of `accounts`, then the namespace once it is empty. */
async function forgetAccess(send: Send, expect: Expect, accounts: readonly string[]): Promise<void> {
  const bindings = `/apis/${rbacGroup}/v1/clusterrolebindings`;
  const serviceAccounts = `/api/v1/namespaces/${accessNamespace}/serviceaccounts`;
  for (const account of accounts) {
    const bindingName = `${accessNamespace}:${account}`;
    const unbinding = `Deleting binding ${bindingName}`;
    expect(await send('DELETE', `${bindings}/${bindingName}`, unbinding), unbinding, 404);
    const deleting = `Deleting service account ${account}`;
    expect(await send('DELETE', `${serviceAccounts}/${account}`, deleting), deleting, 404);
  }
  const listing = `Listing the service accounts of ${accessNamespace}`;
  const listed = expect(await send('GET', serviceAccounts, listing), listing, 404);
  if (listed.status === 404) return;
  const items = (listed.body as { items?: { metadata?: { name?: string } }[] } | undefined)?.items;
  // Kubernetes gives every namespace a `default` service account: that one is no subject's.
  if (!Array.isArray(items) || items.some((item) => item.metadata?.name !== 'default')) return;
  const namespacePath = `/api/v1/namespaces/${accessNamespace}`;
  const reading = `Reading namespace ${accessNamespace}`;
  const namespace = expect(await send('GET', namespacePath, reading), reading, 404);
  if (namespace.status === 404) return;
  const labels = (namespace.body as { metadata?: { labels?: Record<string, string> } } | undefined)
    ?.metadata?.labels;
  // Only a namespace better-compute made goes.
  if (labels?.['app.kubernetes.io/managed-by'] !== managedBy['app.kubernetes.io/managed-by']) return;
  const removing = `Deleting namespace ${accessNamespace}`;
  expect(await send('DELETE', namespacePath, removing), removing, 404);
}
