import {
  ComputeError,
  isComputeError,
  type Clock,
  type ErrorCode,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
} from '@better-compute/core';
import { parseArn, type AwsPartition } from '@better-compute/aws-core';
import { tags } from '../ids.js';
import { invalid, type EksClient, type EksCluster } from './client.js';
import type { KubeResponse, KubeTransport } from './transport.js';

// Credentials for one principal on an EKS cluster, minted through the cluster's own Kubernetes API.
//
// The driver reaches the API as the account's own IAM principal: its bearer is an eksToken (a
// presigned STS GetCallerIdentity), which EKS resolves through the principal's access entry. That
// entry carries AmazonEKSClusterAdminPolicy at cluster scope: CreateCluster makes it
// (bootstrapClusterCreatorAdminPermissions), and the driver creates it (CreateAccessEntry +
// AssociateAccessPolicy) on a cluster another principal created. There is no aws-auth ConfigMap.
//
// Each subject then gets a service account in `bc-access`, bound to a ClusterRole for its role, and
// a bound token from the TokenRequest API, which honours the requested lifetime (an eksToken lasts 15
// minutes at most). Nothing is stored; neither token is ever logged or put in an error.
//
// view and admin bind the built-in `view` and `cluster-admin`. edit does not bind the built-in
// `edit`: it lets a subject impersonate, mint tokens for and run pods as any service account of the
// namespaces it covers, and every subject's service account lives in `bc-access`, so an edit subject
// would be cluster-admin through an admin subject's. `better-compute:edit` is `view` plus edit's
// writes without serviceaccount impersonation or TokenRequest, and before any token is minted the
// cluster gets a ValidatingAdmissionPolicy that refuses every write, delete and connect in
// `bc-access` and `kube-system` (whose service accounts run the control loops) by a subject that
// cannot escalate ClusterRoles (any but cluster-admin). Clusters before Kubernetes 1.30 (no
// ValidatingAdmissionPolicy) get no credentials.

/** The namespace that holds the service accounts better-compute mints credentials for. */
export const accessNamespace = 'bc-access';

const managedBy = { 'app.kubernetes.io/managed-by': 'better-compute' };
const managedTag = tags.managed;
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

/** The EKS access policy that grants the same as each role's ClusterRole. */
export const accessPolicies = {
  view: 'AmazonEKSViewPolicy',
  edit: 'AmazonEKSEditPolicy',
  admin: 'AmazonEKSClusterAdminPolicy',
} as const;

/** `arn:<partition>:eks::aws:cluster-access-policy/<name>`. */
export function accessPolicyArn(partition: AwsPartition, role: keyof typeof accessPolicies): string {
  return `arn:${partition}:eks::aws:cluster-access-policy/${accessPolicies[role]}`;
}

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

/**
 * The IAM principal an access entry names for a caller ARN: an assumed role's role (EKS matches
 * the role, not the session), or an IAM user. The account root is refused. `knownRoles` are role ARNs
 * the account names (its `assumeRoleArn`): one of the session's role gives the path the session drops.
 */
export function principalArnOf(callerArn: string, knownRoles: readonly string[] = []): string {
  let arn;
  try {
    arn = parseArn(callerArn);
  } catch {
    arn = undefined;
  }
  const refuse = () =>
    new ComputeError(
      'ACCESS_DENIED',
      'The account identity is not an IAM role or user, so it cannot hold an EKS access entry',
      undefined,
      { provider: 'aws', service: 'eks', reason: 'principal' },
    );
  if (!arn) throw refuse();
  if (arn.service === 'sts') {
    const match = /^assumed-role\/([\w+=,.@-]{1,64})\/[\w+=,.@-]{2,64}$/.exec(arn.resource);
    if (!match) throw refuse();
    // A session ARN drops the role's path, which an access entry needs: a role the account names
    // (its assumeRoleArn) with the same partition, account and name is that role, path included.
    // Role names are unique in an account whatever the path.
    for (const role of knownRoles) {
      let known;
      try {
        known = parseArn(role);
      } catch {
        continue;
      }
      if (
        known.service === 'iam' &&
        known.partition === arn.partition &&
        known.account === arn.account &&
        /^role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/.test(known.resource) &&
        known.resource.split('/').at(-1) === match[1]
      )
        return role;
    }
    return `arn:${arn.partition}:iam::${arn.account}:role/${match[1]}`;
  }
  if (arn.service === 'iam' && /^(role|user)\/[\w+=,.@/-]{1,512}$/.test(arn.resource))
    return callerArn;
  throw refuse();
}

interface AccessEntry {
  principalArn?: string;
  type?: string;
}
interface AssociatedPolicy {
  policyArn?: string;
  accessScope?: { type?: string };
}

/**
 * Makes sure `principalArn` holds an access entry with the cluster-admin access policy at cluster
 * scope. Returns true when it had to create or associate something (EKS takes a few seconds to
 * honour a new entry).
 */
export async function ensureAdminAccess(options: {
  client: EksClient;
  cluster: string;
  principalArn: string;
  partition: AwsPartition;
  signal: AbortSignal;
}): Promise<boolean> {
  const { client, cluster, principalArn, signal } = options;
  const base = `/clusters/${encodeURIComponent(cluster)}/access-entries`;
  const entryPath = `${base}/${encodeURIComponent(principalArn)}`;
  const policyArn = accessPolicyArn(options.partition, 'admin');
  let changed = false;
  const entry = await client.find<{ accessEntry: AccessEntry }>(
    entryPath,
    signal,
    `Reading the EKS access entry of the account principal on ${cluster}`,
  );
  if (!entry) {
    try {
      await client.request('POST', base, {
        // Tagged managed: the IAM policy lets the role associate access policies only with such entries.
        body: { principalArn, type: 'STANDARD', tags: { [managedTag]: 'true' } },
        signal,
        what: `Creating the EKS access entry of the account principal on ${cluster}`,
      });
    } catch (error) {
      // Created meanwhile: what is there is used.
      if (!isComputeError(error, 'CONFLICT') && !isComputeError(error, 'INVALID_STATE')) throw error;
    }
    changed = true;
  } else if (entry.accessEntry.type !== undefined && entry.accessEntry.type !== 'STANDARD')
    throw new ComputeError(
      'INVALID_STATE',
      `The account principal's access entry on ${cluster} is of type ${entry.accessEntry.type}, not STANDARD`,
      undefined,
      { provider: 'aws', service: 'eks', reason: 'accessEntryType' },
    );
  if (!changed) {
    const listed = await client.request<{ associatedAccessPolicies?: AssociatedPolicy[] }>(
      'GET',
      `${entryPath}/access-policies`,
      { signal, what: `Reading the access policies of the account principal on ${cluster}` },
    );
    const admin = (listed.associatedAccessPolicies ?? []).some(
      (policy) => policy.policyArn === policyArn && policy.accessScope?.type === 'cluster',
    );
    if (admin) return false;
  }
  await client.request('POST', `${entryPath}/access-policies`, {
    body: { policyArn, accessScope: { type: 'cluster' } },
    signal,
    what: `Associating the cluster-admin access policy with the account principal on ${cluster}`,
  });
  return true;
}

function kubeError(id: string, what: string, response: KubeResponse, fresh: boolean): ComputeError {
  const body = response.body as { message?: unknown; reason?: unknown } | undefined;
  const said =
    typeof body?.message === 'string' ? body.message.slice(0, 300) : `HTTP ${response.status}`;
  const { status } = response;
  const details: Record<string, unknown> = {
    provider: 'aws',
    service: 'eks',
    status,
    reason: typeof body?.reason === 'string' ? body.reason : 'kubernetes',
  };
  let code: ErrorCode;
  if ((status === 401 || status === 403) && fresh) {
    // A just-created access entry takes a few seconds to reach the API server.
    code = 'UNAVAILABLE';
    details.retryAfterMs = 5000;
    details.reason = 'accessEntryPropagating';
  } else if (status === 401 || status === 403) code = 'ACCESS_DENIED';
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
export function endpointOf(
  id: string,
  cluster: EksCluster,
): { server: string; caPem: string; caData: string } {
  const caData = cluster.certificateAuthority?.data;
  let url: URL | undefined;
  try {
    url = cluster.endpoint ? new URL(cluster.endpoint) : undefined;
  } catch {
    url = undefined;
  }
  if (!cluster.endpoint || !caData || cluster.status !== 'ACTIVE')
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${id} has no control-plane endpoint yet (${cluster.status ?? 'unknown'})`,
      undefined,
      { provider: 'aws', service: 'eks', reason: 'notReady' },
    );
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    !hostPattern.test(url.hostname)
  )
    throw new ComputeError('PROVIDER_ERROR', `Cluster ${id} has a malformed endpoint`, undefined, {
      provider: 'aws',
      service: 'eks',
      reason: 'endpoint',
    });
  const caPem = Buffer.from(caData, 'base64').toString('utf8');
  if (!caPem.includes('-----BEGIN CERTIFICATE-----'))
    throw new ComputeError(
      'PROVIDER_ERROR',
      `Cluster ${id} has a malformed CA certificate`,
      undefined,
      { provider: 'aws', service: 'eks', reason: 'certificateAuthority' },
    );
  return { server: url.origin, caPem, caData };
}

/** Creates the service account and binding (idempotently) and mints a bound token. */
export async function mintCredentials(options: {
  id: string;
  cluster: EksCluster;
  request: KubernetesCredentialRequest;
  /** The account principal's eksToken: the bearer on the cluster's Kubernetes API. */
  token: string;
  /** The access entry was created just now (an authorization failure is then transient). */
  fresh: boolean;
  transport: KubeTransport;
  signal: AbortSignal;
  clock: Clock;
  /** The access guard and better-compute:edit were put in place by this process already. */
  guarded?: boolean;
}): Promise<KubernetesCredentials> {
  const { id, request, transport, signal } = options;
  const { server, caPem, caData } = endpointOf(id, options.cluster);
  const { subject, ttlSeconds } = request;
  const role = clusterRoles[request.role];

  const send = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
        token: options.token,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComputeError(
        'UNAVAILABLE',
        `${what} on cluster ${id}: the Kubernetes API is unreachable`,
        undefined,
        { provider: 'aws', service: 'eks', status: 0, reason: 'network' },
      );
    }
  };
  const expect = (response: KubeResponse, what: string, ...allowed: number[]): KubeResponse => {
    if ((response.status >= 200 && response.status < 300) || allowed.includes(response.status))
      return response;
    throw kubeError(id, what, response, options.fresh);
  };

  // 0. The access guard and better-compute:edit, before any subject exists: created, or replaced
  // with what this version wants (an unconditional PUT).
  if (!options.guarded) {
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
          { provider: 'aws', service: 'eks', status: 404, reason: 'accessGuard' },
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
    await write(`${admission}/validatingadmissionpolicies`, manifests.policy, `Writing admission policy ${accessGuard}`);
    await write(
      `${admission}/validatingadmissionpolicybindings`,
      manifests.binding,
      `Writing admission policy binding ${accessGuard}`,
    );
  }

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
          { provider: 'aws', service: 'eks', status: 409, reason: 'bindingChanged' },
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
      { provider: 'aws', service: 'eks', reason: 'noToken' },
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

/**
 * Removes what `mintCredentials` made for `subject` (its binding and service account), and the
 * `bc-access` namespace once no subject's service account is left in it: tokens minted for the
 * subject stop working with its service account. better-compute:edit and the access guard stay
 * (they grant nothing on their own), and so does the account principal's access entry. Idempotent:
 * what is gone already counts as removed; any other failure throws, so a caller that must not leave
 * access behind tries again.
 */
export async function forgetCredentials(options: {
  id: string;
  cluster: EksCluster;
  subject: string;
  /** The account principal's eksToken. */
  token: string;
  /** The access entry was created just now (an authorization failure is then transient). */
  fresh: boolean;
  transport: KubeTransport;
  signal: AbortSignal;
}): Promise<void> {
  const { id, subject, transport, signal } = options;
  if (typeof subject !== 'string' || !subjectPattern.test(subject))
    throw invalid(`The subject ${JSON.stringify(subject)} is not a DNS-1123 label`);
  const { server, caPem } = endpointOf(id, options.cluster);
  const send = async (method: 'GET' | 'DELETE', path: string, what: string): Promise<KubeResponse> => {
    try {
      return await transport({ url: `${server}${path}`, method, caPem, token: options.token, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComputeError(
        'UNAVAILABLE',
        `${what} on cluster ${id}: the Kubernetes API is unreachable`,
        undefined,
        { provider: 'aws', service: 'eks', status: 0, reason: 'network' },
      );
    }
  };
  const expect = (response: KubeResponse, what: string, ...allowed: number[]): KubeResponse => {
    if ((response.status >= 200 && response.status < 300) || allowed.includes(response.status))
      return response;
    throw kubeError(id, what, response, options.fresh);
  };
  await forgetAccess(send, expect, [subject]);
}

/** Deletes the bindings and service accounts of `accounts`, then the namespace once it is empty. */
async function forgetAccess(
  send: (method: 'GET' | 'DELETE', path: string, what: string) => Promise<KubeResponse>,
  expect: (response: KubeResponse, what: string, ...allowed: number[]) => KubeResponse,
  accounts: readonly string[]): Promise<void> {
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
