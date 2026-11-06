import { presignUrl } from '@better-compute/aws-core';
import type { KubeRequest, KubeTransport } from '@better-compute/provider-aws';
import type { AwsEmulator, EmulatorRequest } from './aws-emulator/index.js';
import { requestId, restJsonError } from './aws-emulator/xml.js';

// An in-process emulator of the Amazon EKS REST API (rest-json, SigV4 service `eks`) as provider-aws
// drives it: clusters (CreateCluster, DescribeCluster, ListClusters, UpdateClusterVersion,
// UpdateClusterConfig, DeleteCluster), managed node groups (Create/Describe/List/UpdateConfig/
// Delete), updates (DescribeUpdate), access entries and access policies, and DescribeClusterVersions.
// It registers on an AwsEmulator, so requests are SigV4-checked and recorded there. Resources stay
// in their transitional state (CREATING, UPDATING, DELETING) for `delayTicks` reads of themselves,
// then settle, as on EKS (but none of its timing). Like EKS: one update per cluster at a time, no
// changes while a resource is not ACTIVE, a version upgrade moves exactly one minor, and a cluster
// with node groups cannot be deleted.
//
// EksKubeApi is the clusters' own Kubernetes API behind a KubeTransport: it verifies the eksToken
// (the presigned STS URL, re-signed with the key STS knows, the cluster header, the expiry) and the
// principal's access entry and access policy, then serves the namespace, service account,
// ClusterRoleBinding and TokenRequest calls the driver makes.

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const caPem = '-----BEGIN CERTIFICATE-----\nMIIBemulatedeksclusterca\n-----END CERTIFICATE-----\n';
export const emulatedEksCaPem = caPem;
export const emulatedEksCaData = Buffer.from(caPem).toString('base64');
export const adminPolicy = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';

export interface EmuCluster {
  name: string;
  arn: string;
  version: string;
  platformVersion: string;
  status: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'UPDATING';
  endpoint: string;
  roleArn: string;
  subnetIds: string[];
  vpcId: string;
  publicAccessCidrs: string[];
  endpointPublicAccess: boolean;
  endpointPrivateAccess: boolean;
  serviceIpv4Cidr: string;
  authenticationMode: 'API' | 'API_AND_CONFIG_MAP' | 'CONFIG_MAP';
  supportType: 'STANDARD' | 'EXTENDED';
  computeConfig?: { enabled: boolean; nodePools: string[]; nodeRoleArn?: string };
  tags: Record<string, string>;
  clientRequestToken?: string;
  remaining: number;
  /** Applied when the transitional state settles. */
  settle?: () => void;
  health?: { issues: { code: string; message: string }[] };
}

export interface EmuNodegroup {
  cluster: string;
  nodegroupName: string;
  status: 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING' | 'CREATE_FAILED' | 'DEGRADED';
  scalingConfig: { minSize: number; maxSize: number; desiredSize: number };
  instanceTypes: string[];
  amiType: string;
  capacityType: 'ON_DEMAND' | 'SPOT';
  subnets: string[];
  nodeRole: string;
  diskSize: number;
  labels: Record<string, string>;
  taints: { key: string; value?: string; effect: string }[];
  tags: Record<string, string>;
  version: string;
  releaseVersion: string;
  remaining: number;
  settle?: () => void;
}

export interface EmuUpdate {
  id: string;
  cluster: string;
  nodegroup?: string;
  type: string;
  status: 'InProgress' | 'Failed' | 'Successful';
  params: Json;
  errors: { errorCode: string; errorMessage: string }[];
}

export interface EmuAccessEntry {
  principalArn: string;
  type: string;
  policies: { policyArn: string; accessScope: { type: string; namespaces?: string[] } }[];
}

const segments = (url: URL) => url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

/** The operation a method and path are. */
export function eksOperation(method: string, url: URL): string {
  const p = segments(url);
  if (p[0] === 'cluster-versions') return 'DescribeClusterVersions';
  if (p[0] !== 'clusters') return `${method} ${url.pathname}`;
  if (p.length === 1) return method === 'POST' ? 'CreateCluster' : 'ListClusters';
  if (p.length === 2)
    return method === 'GET' ? 'DescribeCluster' : method === 'DELETE' ? 'DeleteCluster' : '?';
  if (p[2] === 'updates')
    return p.length === 3 ? (method === 'POST' ? 'UpdateClusterVersion' : 'ListUpdates') : 'DescribeUpdate';
  if (p[2] === 'update-config') return 'UpdateClusterConfig';
  if (p[2] === 'node-groups') {
    if (p.length === 3) return method === 'POST' ? 'CreateNodegroup' : 'ListNodegroups';
    if (p.length === 4)
      return method === 'GET' ? 'DescribeNodegroup' : method === 'DELETE' ? 'DeleteNodegroup' : '?';
    if (p[4] === 'update-config') return 'UpdateNodegroupConfig';
    if (p[4] === 'update-version') return 'UpdateNodegroupVersion';
  }
  if (p[2] === 'access-entries') {
    if (p.length === 3) return method === 'POST' ? 'CreateAccessEntry' : 'ListAccessEntries';
    if (p.length === 4)
      return method === 'GET' ? 'DescribeAccessEntry' : method === 'DELETE' ? 'DeleteAccessEntry' : '?';
    if (p[4] === 'access-policies')
      return method === 'POST' ? 'AssociateAccessPolicy' : 'ListAssociatedAccessPolicies';
  }
  return `${method} ${url.pathname}`;
}

/** An assumed role's role, or the ARN itself. */
function principalOf(arn: string): string {
  const match = /^arn:([a-z-]+):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(arn);
  return match ? `arn:${match[1]}:iam::${match[2]}:role/${match[3]}` : arn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': requestId() },
  });

export class EksEmulator {
  readonly clusters = new Map<string, EmuCluster>();
  /** `cluster/nodegroup`. */
  readonly nodegroups = new Map<string, EmuNodegroup>();
  readonly updates = new Map<string, EmuUpdate>();
  /** `cluster|principalArn`. */
  readonly accessEntries = new Map<string, EmuAccessEntry>();
  /** Transitional states last this many reads of the resource. */
  delayTicks = 1;
  /** The next update (cluster or node group) fails with this message, its effect not applied. */
  failNextUpdate?: string;
  /** The next CreateCluster ends FAILED with this health issue. */
  failNextCreate?: string;
  /** List page size (small, so the driver pages). */
  pageSize = 2;
  versions: { clusterVersion: string; status: string; defaultVersion?: boolean }[] = [
    { clusterVersion: '1.34', status: 'STANDARD_SUPPORT' },
    { clusterVersion: '1.33', status: 'STANDARD_SUPPORT', defaultVersion: true },
    { clusterVersion: '1.32', status: 'STANDARD_SUPPORT' },
    { clusterVersion: '1.31', status: 'EXTENDED_SUPPORT' },
    { clusterVersion: '1.28', status: 'UNSUPPORTED' },
  ];
  #seq = 0;
  /** Update calls by clientRequestToken: a repeated token answers the earlier update, as on EKS. */
  readonly updateTokens = new Map<string, string>();
  /** The clientRequestToken of the request being handled. */
  #token: string | undefined;

  constructor(
    private readonly emu: AwsEmulator,
    readonly region = 'us-east-1',
    readonly account = '222222222222',
  ) {
    emu.register(/^eks\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'eks',
      protocol: 'rest-json',
      operationOf: eksOperation,
      handle: (request) => this.#handle(request),
    });
  }

  /** Requests for one operation (the AwsEmulator's record). */
  calls(operation: string): EmulatorRequest[] {
    return this.emu.calls(operation);
  }

  /** Settles every transitional resource now. */
  settleAll(): void {
    for (const cluster of [...this.clusters.values()]) this.#settle(cluster, true);
    for (const group of [...this.nodegroups.values()]) this.#settleGroup(group, true);
  }

  #error(code: string, message: string, status = 400): Response {
    return restJsonError(code, message, status);
  }

  #principal(request: EmulatorRequest): string {
    const identity = request.accessKeyId ? this.emu.sts.identities.get(request.accessKeyId) : undefined;
    return identity ? principalOf(identity.arn) : 'arn:aws:iam::000000000000:user/unknown';
  }

  #settle(cluster: EmuCluster, now = false): void {
    if (cluster.status === 'ACTIVE' || cluster.status === 'FAILED') return;
    if (!now && --cluster.remaining > 0) return;
    const settle = cluster.settle;
    delete cluster.settle;
    if (settle) settle();
  }

  #settleGroup(group: EmuNodegroup, now = false): void {
    if (group.status === 'ACTIVE' || group.status === 'CREATE_FAILED' || group.status === 'DEGRADED') return;
    if (!now && --group.remaining > 0) return;
    const settle = group.settle;
    delete group.settle;
    if (settle) settle();
  }

  #clusterJson(cluster: EmuCluster): Json {
    return {
      name: cluster.name,
      arn: cluster.arn,
      version: cluster.version,
      platformVersion: cluster.platformVersion,
      status: cluster.status,
      roleArn: cluster.roleArn,
      ...(cluster.status === 'CREATING' ? {} : { endpoint: cluster.endpoint, certificateAuthority: { data: emulatedEksCaData } }),
      resourcesVpcConfig: {
        subnetIds: [...cluster.subnetIds],
        securityGroupIds: [],
        clusterSecurityGroupId: 'sg-0000000000000eks0',
        vpcId: cluster.vpcId,
        endpointPublicAccess: cluster.endpointPublicAccess,
        endpointPrivateAccess: cluster.endpointPrivateAccess,
        publicAccessCidrs: [...cluster.publicAccessCidrs],
      },
      kubernetesNetworkConfig: { serviceIpv4Cidr: cluster.serviceIpv4Cidr, ipFamily: 'ipv4' },
      accessConfig: { authenticationMode: cluster.authenticationMode },
      upgradePolicy: { supportType: cluster.supportType },
      ...(cluster.computeConfig ? { computeConfig: cluster.computeConfig } : {}),
      tags: { ...cluster.tags },
      ...(cluster.health ? { health: cluster.health } : {}),
    };
  }

  #groupJson(group: EmuNodegroup): Json {
    return {
      nodegroupName: group.nodegroupName,
      clusterName: group.cluster,
      status: group.status,
      version: group.version,
      releaseVersion: group.releaseVersion,
      capacityType: group.capacityType,
      scalingConfig: { ...group.scalingConfig },
      instanceTypes: [...group.instanceTypes],
      subnets: [...group.subnets],
      amiType: group.amiType,
      nodeRole: group.nodeRole,
      diskSize: group.diskSize,
      labels: { ...group.labels },
      taints: group.taints.map((taint) => ({ ...taint })),
      tags: { ...group.tags },
    };
  }

  #page(names: string[], url: URL): { page: string[]; nextToken?: string } {
    const start = Number(url.searchParams.get('nextToken')?.replace(/^tok-/, '') ?? '0');
    const max = Math.min(Number(url.searchParams.get('maxResults') ?? 100), this.pageSize);
    const page = names.slice(start, start + max);
    return { page, ...(start + max < names.length ? { nextToken: `tok-${start + max}` } : {}) };
  }

  #newUpdate(cluster: string, type: string, params: Json, nodegroup?: string): EmuUpdate {
    const update: EmuUpdate = {
      id: `00000000-0000-4000-9000-${String(++this.#seq).padStart(12, '0')}`,
      cluster,
      ...(nodegroup ? { nodegroup } : {}),
      type,
      status: 'InProgress',
      params,
      errors: [],
    };
    this.updates.set(update.id, update);
    if (this.#token !== undefined) this.updateTokens.set(`${cluster}|${this.#token}`, update.id);
    return update;
  }

  #updateJson(update: EmuUpdate): Json {
    return {
      id: update.id,
      status: update.status,
      type: update.type,
      params: update.params,
      errors: update.errors,
    };
  }

  /** Runs an update on a cluster: UPDATING for delayTicks reads, then applies (or fails). */
  #clusterUpdate(cluster: EmuCluster, type: string, params: Json, apply: () => void): Response {
    const update = this.#newUpdate(cluster.name, type, params);
    const failure = this.failNextUpdate;
    delete this.failNextUpdate;
    cluster.status = 'UPDATING';
    cluster.remaining = this.delayTicks;
    cluster.settle = () => {
      cluster.status = 'ACTIVE';
      if (failure) {
        update.status = 'Failed';
        update.errors = [{ errorCode: 'Unknown', errorMessage: failure }];
      } else {
        apply();
        update.status = 'Successful';
      }
    };
    if (this.delayTicks <= 0) this.#settle(cluster, true);
    return json(200, { update: this.#updateJson(update) });
  }

  #handle(request: EmulatorRequest): Response {
    const { url } = request;
    const p = segments(url);
    const body: Json = request.body ? JSON.parse(request.body) : {};
    const op = request.operation;
    const clusterName = p[1];
    const cluster = clusterName ? this.clusters.get(clusterName) : undefined;
    const noCluster = () => this.#error('ResourceNotFoundException', `No cluster found for name: ${clusterName}.`, 404);
    if (
      ['UpdateClusterVersion', 'UpdateClusterConfig', 'UpdateNodegroupConfig', 'UpdateNodegroupVersion'].includes(op) &&
      typeof body.clientRequestToken === 'string'
    ) {
      const earlier = this.updates.get(this.updateTokens.get(`${clusterName}|${body.clientRequestToken}`) ?? '');
      // EKS takes a repeated token as a retry: it answers the original update and changes nothing.
      if (earlier) return json(200, { update: this.#updateJson(earlier) });
    }
    this.#token = typeof body.clientRequestToken === 'string' ? body.clientRequestToken : undefined;
    switch (op) {
      case 'DescribeClusterVersions': {
        if (url.searchParams.get('clusterType') !== 'eks')
          return this.#error('InvalidParameterException', 'clusterType must be eks');
        const all = this.versions.map((entry) => entry.clusterVersion);
        const { page, nextToken } = this.#page(all, url);
        return json(200, {
          clusterVersions: page.map((version) => {
            const entry = this.versions.find((v) => v.clusterVersion === version)!;
            return {
              clusterVersion: version,
              clusterType: 'eks',
              defaultPlatformVersion: 'eks.1',
              defaultVersion: entry.defaultVersion === true,
              versionStatus: entry.status,
            };
          }),
          ...(nextToken ? { nextToken } : {}),
        });
      }
      case 'ListClusters': {
        const { page, nextToken } = this.#page([...this.clusters.keys()].sort(), url);
        return json(200, { clusters: page, ...(nextToken ? { nextToken } : {}) });
      }
      case 'CreateCluster':
        return this.#createCluster(request, body);
      case 'DescribeCluster': {
        if (!cluster) return noCluster();
        this.#settle(cluster);
        if (!this.clusters.has(cluster.name)) return noCluster();
        return json(200, { cluster: this.#clusterJson(cluster) });
      }
      case 'DeleteCluster': {
        if (!cluster) return noCluster();
        if ([...this.nodegroups.values()].some((group) => group.cluster === cluster.name))
          return this.#error('ResourceInUseException', `Cluster has nodegroups attached`, 409);
        if (cluster.status !== 'ACTIVE' && cluster.status !== 'FAILED')
          return this.#error('ResourceInUseException', `Cluster ${cluster.name} is ${cluster.status}`, 409);
        cluster.status = 'DELETING';
        cluster.remaining = this.delayTicks;
        cluster.settle = () => {
          this.clusters.delete(cluster.name);
          for (const key of [...this.accessEntries.keys()])
            if (key.startsWith(`${cluster.name}|`)) this.accessEntries.delete(key);
        };
        return json(200, { cluster: this.#clusterJson(cluster) });
      }
      case 'UpdateClusterVersion': {
        if (!cluster) return noCluster();
        if (cluster.status !== 'ACTIVE')
          return this.#error('ResourceInUseException', `Cluster ${cluster.name} has an update in progress`, 409);
        const [major, minor] = cluster.version.split('.').map(Number);
        if (body.version !== `${major}.${minor! + 1}`)
          return this.#error('InvalidParameterException', `Unsupported Kubernetes minor version update from ${cluster.version} to ${body.version}`);
        return this.#clusterUpdate(cluster, 'VersionUpdate', [{ type: 'Version', value: body.version }], () => {
          cluster.version = body.version;
          cluster.platformVersion = 'eks.1';
        });
      }
      case 'UpdateClusterConfig': {
        if (!cluster) return noCluster();
        if (cluster.status !== 'ACTIVE')
          return this.#error('ResourceInUseException', `Cluster ${cluster.name} has an update in progress`, 409);
        const changes = Object.keys(body).filter((key) => key !== 'clientRequestToken');
        if (changes.length !== 1)
          return this.#error('InvalidParameterException', 'Only one type of update can be allowed.');
        return this.#clusterUpdate(cluster, changes[0] === 'upgradePolicy' ? 'UpgradePolicyUpdate' : 'EndpointAccessUpdate', body, () => {
          if (body.upgradePolicy) cluster.supportType = body.upgradePolicy.supportType;
          if (body.resourcesVpcConfig) {
            const vpc = body.resourcesVpcConfig;
            if (vpc.publicAccessCidrs) cluster.publicAccessCidrs = [...vpc.publicAccessCidrs];
            if (vpc.endpointPublicAccess !== undefined) cluster.endpointPublicAccess = vpc.endpointPublicAccess;
            if (vpc.endpointPrivateAccess !== undefined) cluster.endpointPrivateAccess = vpc.endpointPrivateAccess;
          }
        });
      }
      case 'DescribeUpdate': {
        const update = this.updates.get(p[3] ?? '');
        if (!cluster || !update || update.cluster !== cluster.name)
          return this.#error('ResourceNotFoundException', 'No update found', 404);
        const nodegroup = url.searchParams.get('nodegroupName') ?? undefined;
        if (nodegroup !== update.nodegroup) return this.#error('ResourceNotFoundException', 'No update found', 404);
        if (nodegroup) {
          const group = this.nodegroups.get(`${cluster.name}/${nodegroup}`);
          if (group) this.#settleGroup(group);
        } else this.#settle(cluster);
        return json(200, { update: this.#updateJson(update) });
      }
      case 'CreateNodegroup':
        return this.#createNodegroup(cluster, clusterName ?? '', body);
      case 'ListNodegroups': {
        if (!cluster) return noCluster();
        const names = [...this.nodegroups.values()]
          .filter((group) => group.cluster === cluster.name)
          .map((group) => group.nodegroupName)
          .sort();
        const { page, nextToken } = this.#page(names, url);
        return json(200, { nodegroups: page, ...(nextToken ? { nextToken } : {}) });
      }
      case 'UpdateNodegroupVersion': {
        if (!cluster) return noCluster();
        const group = this.nodegroups.get(`${cluster.name}/${p[3]}`);
        if (!group) return this.#error('ResourceNotFoundException', `No node group found for name: ${p[3]}.`, 404);
        if (group.status !== 'ACTIVE' || cluster.status !== 'ACTIVE')
          return this.#error('ResourceInUseException', `Nodegroup ${group.nodegroupName} or its cluster is busy`, 409);
        const version = body.version ?? cluster.version;
        const [cMajor, cMinor] = cluster.version.split('.').map(Number);
        const [gMajor, gMinor] = group.version.split('.').map(Number);
        const [vMajor, vMinor] = String(version).split('.').map(Number);
        if (vMajor !== cMajor || vMinor! > cMinor! || vMajor !== gMajor || vMinor! < gMinor! || vMinor! > gMinor! + 1)
          return this.#error('InvalidParameterException', `Cannot update node group ${group.nodegroupName} from ${group.version} to ${version}`);
        const update = this.#newUpdate(cluster.name, 'VersionUpdate', [{ type: 'Version', value: version }], group.nodegroupName);
        group.status = 'UPDATING';
        group.remaining = this.delayTicks;
        group.settle = () => {
          group.status = 'ACTIVE';
          group.version = version;
          group.releaseVersion = `${version}.0-20261101`;
          update.status = 'Successful';
        };
        return json(200, { update: this.#updateJson(update) });
      }
      case 'DescribeNodegroup':
      case 'DeleteNodegroup':
      case 'UpdateNodegroupConfig': {
        if (!cluster) return noCluster();
        const key = `${cluster.name}/${p[3]}`;
        const group = this.nodegroups.get(key);
        const noGroup = () => this.#error('ResourceNotFoundException', `No node group found for name: ${p[3]}.`, 404);
        if (!group) return noGroup();
        if (op === 'DescribeNodegroup') {
          this.#settleGroup(group);
          if (!this.nodegroups.has(key)) return noGroup();
          return json(200, { nodegroup: this.#groupJson(group) });
        }
        if (op === 'DeleteNodegroup') {
          if (group.status === 'CREATING' || group.status === 'UPDATING')
            return this.#error('ResourceInUseException', `Nodegroup ${group.nodegroupName} is ${group.status}`, 409);
          group.status = 'DELETING';
          group.remaining = this.delayTicks;
          group.settle = () => void this.nodegroups.delete(key);
          return json(200, { nodegroup: this.#groupJson(group) });
        }
        if (group.status !== 'ACTIVE' && group.status !== 'DEGRADED')
          return this.#error('ResourceInUseException', `Nodegroup ${group.nodegroupName} is ${group.status}`, 409);
        const scaling = body.scalingConfig;
        if (scaling) {
          const next = { ...group.scalingConfig, ...scaling };
          if (next.maxSize < 1 || next.minSize > next.desiredSize || next.desiredSize > next.maxSize)
            return this.#error('InvalidParameterException', 'Invalid scaling configuration');
        }
        const update = this.#newUpdate(cluster.name, 'ConfigUpdate', body, group.nodegroupName);
        const failure = this.failNextUpdate;
        delete this.failNextUpdate;
        group.status = 'UPDATING';
        group.remaining = this.delayTicks;
        group.settle = () => {
          group.status = 'ACTIVE';
          if (failure) {
            update.status = 'Failed';
            update.errors = [{ errorCode: 'Unknown', errorMessage: failure }];
            return;
          }
          if (scaling) group.scalingConfig = { ...group.scalingConfig, ...scaling };
          update.status = 'Successful';
        };
        return json(200, { update: this.#updateJson(update) });
      }
      case 'CreateAccessEntry': {
        if (!cluster) return noCluster();
        if (cluster.authenticationMode === 'CONFIG_MAP')
          return this.#error('InvalidRequestException', 'The cluster authentication mode does not support access entries');
        const key = `${cluster.name}|${body.principalArn}`;
        if (this.accessEntries.has(key))
          return this.#error('ResourceInUseException', 'The specified access entry resource is already in use on this cluster.', 409);
        if (!/^arn:aws:iam::\d{12}:(role|user)\//.test(body.principalArn ?? ''))
          return this.#error('InvalidParameterException', 'The principalArn is not an IAM role or user');
        this.accessEntries.set(key, { principalArn: body.principalArn, type: body.type ?? 'STANDARD', policies: [] });
        return json(200, { accessEntry: { principalArn: body.principalArn, type: body.type ?? 'STANDARD', clusterName: cluster.name } });
      }
      case 'DescribeAccessEntry':
      case 'AssociateAccessPolicy':
      case 'ListAssociatedAccessPolicies': {
        if (!cluster) return noCluster();
        const entry = this.accessEntries.get(`${cluster.name}|${p[3]}`);
        if (!entry) return this.#error('ResourceNotFoundException', 'The specified principalArn could not be found.', 404);
        if (op === 'DescribeAccessEntry')
          return json(200, { accessEntry: { principalArn: entry.principalArn, type: entry.type, clusterName: cluster.name } });
        if (op === 'ListAssociatedAccessPolicies')
          return json(200, { clusterName: cluster.name, principalArn: entry.principalArn, associatedAccessPolicies: entry.policies });
        if (!/^arn:aws:eks::aws:cluster-access-policy\/[A-Za-z]+$/.test(body.policyArn ?? ''))
          return this.#error('InvalidParameterException', 'Not an access policy ARN');
        entry.policies = entry.policies.filter((policy) => policy.policyArn !== body.policyArn);
        entry.policies.push({ policyArn: body.policyArn, accessScope: body.accessScope ?? { type: 'cluster' } });
        return json(200, { clusterName: cluster.name, principalArn: entry.principalArn, associatedAccessPolicy: body });
      }
      default:
        return this.#error('UnknownOperationException', `emulated EKS has no ${op}`, 404);
    }
  }

  #createCluster(request: EmulatorRequest, body: Json): Response {
    const name = body.name as string;
    if (!/^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name ?? ''))
      return this.#error('InvalidParameterException', 'Invalid cluster name');
    const existing = this.clusters.get(name);
    if (existing) {
      if (body.clientRequestToken && existing.clientRequestToken === body.clientRequestToken)
        return json(200, { cluster: this.#clusterJson(existing) });
      return this.#error('ResourceInUseException', `Cluster already exists with name: ${name}`, 409);
    }
    if (!/^arn:aws:iam::\d{12}:role\//.test(body.roleArn ?? ''))
      return this.#error('InvalidParameterException', 'roleArn is required');
    const subnetIds: string[] = body.resourcesVpcConfig?.subnetIds ?? [];
    if (subnetIds.length < 2)
      return this.#error('InvalidParameterException', 'Subnets specified must be in at least two different AZs');
    const version = body.version ?? this.versions.find((v) => v.defaultVersion)!.clusterVersion;
    if (!this.versions.some((v) => v.clusterVersion === version && v.status !== 'UNSUPPORTED'))
      return this.#error('InvalidParameterException', `unsupported Kubernetes version ${version}`);
    const auto = body.computeConfig?.enabled === true;
    if (auto && (body.accessConfig?.authenticationMode ?? 'API_AND_CONFIG_MAP') === 'CONFIG_MAP')
      return this.#error('InvalidParameterException', 'EKS Auto Mode needs access entries');
    if (auto && !body.computeConfig.nodeRoleArn)
      return this.#error('InvalidParameterException', 'nodeRoleArn is required with computeConfig');
    const id = (++this.#seq).toString(16).toUpperCase().padStart(32, '0');
    const cluster: EmuCluster = {
      name,
      arn: `arn:aws:eks:${this.region}:${this.account}:cluster/${name}`,
      version,
      platformVersion: 'eks.1',
      status: 'CREATING',
      endpoint: `https://${id}.gr7.${this.region}.eks.amazonaws.com`,
      roleArn: body.roleArn,
      subnetIds: [...subnetIds],
      vpcId: 'vpc-0000000000000000a',
      publicAccessCidrs: body.resourcesVpcConfig?.publicAccessCidrs ?? ['0.0.0.0/0'],
      endpointPublicAccess: body.resourcesVpcConfig?.endpointPublicAccess ?? true,
      endpointPrivateAccess: body.resourcesVpcConfig?.endpointPrivateAccess ?? false,
      serviceIpv4Cidr: '172.20.0.0/16',
      authenticationMode: body.accessConfig?.authenticationMode ?? 'API_AND_CONFIG_MAP',
      supportType: body.upgradePolicy?.supportType ?? 'EXTENDED',
      ...(auto ? { computeConfig: { enabled: true, nodePools: body.computeConfig.nodePools ?? [], nodeRoleArn: body.computeConfig.nodeRoleArn } } : {}),
      tags: { ...(body.tags ?? {}) },
      ...(body.clientRequestToken ? { clientRequestToken: body.clientRequestToken } : {}),
      remaining: this.delayTicks,
    };
    const failure = this.failNextCreate;
    delete this.failNextCreate;
    cluster.settle = () => {
      if (failure) {
        cluster.status = 'FAILED';
        cluster.health = { issues: [{ code: 'InsufficientFreeAddresses', message: failure }] };
        return;
      }
      cluster.status = 'ACTIVE';
    };
    this.clusters.set(name, cluster);
    // The creator's access entry, as bootstrapClusterCreatorAdminPermissions (default true) makes it.
    if (body.accessConfig?.bootstrapClusterCreatorAdminPermissions !== false && cluster.authenticationMode !== 'CONFIG_MAP') {
      const principalArn = this.#principal(request);
      this.accessEntries.set(`${name}|${principalArn}`, {
        principalArn,
        type: 'STANDARD',
        policies: [{ policyArn: adminPolicy, accessScope: { type: 'cluster' } }],
      });
    }
    return json(200, { cluster: this.#clusterJson(cluster) });
  }

  #createNodegroup(cluster: EmuCluster | undefined, clusterName: string, body: Json): Response {
    if (!cluster) return this.#error('ResourceNotFoundException', `No cluster found for name: ${clusterName}.`, 404);
    if (cluster.computeConfig?.enabled)
      return this.#error('InvalidRequestException', 'Auto Mode clusters have no managed node groups');
    if (cluster.status !== 'ACTIVE')
      return this.#error('ResourceInUseException', `Cluster ${cluster.name} is ${cluster.status}`, 409);
    const name = body.nodegroupName as string;
    const key = `${cluster.name}/${name}`;
    if (this.nodegroups.has(key))
      return this.#error('ResourceInUseException', `NodeGroup already exists with name ${name}`, 409);
    const scaling = body.scalingConfig ?? { minSize: 1, maxSize: 2, desiredSize: 2 };
    if (scaling.maxSize < 1 || scaling.minSize > scaling.desiredSize || scaling.desiredSize > scaling.maxSize)
      return this.#error('InvalidParameterException', 'Invalid scaling configuration');
    if (!/^arn:aws:iam::\d{12}:role\//.test(body.nodeRole ?? ''))
      return this.#error('InvalidParameterException', 'nodeRole is required');
    const subnets: string[] = body.subnets ?? [];
    if (!subnets.length || subnets.some((subnet) => !cluster.subnetIds.includes(subnet)))
      return this.#error('InvalidParameterException', 'Subnets must be the cluster subnets');
    for (const taint of body.taints ?? [])
      if (!['NO_SCHEDULE', 'NO_EXECUTE', 'PREFER_NO_SCHEDULE'].includes(taint.effect))
        return this.#error('InvalidParameterException', `Invalid taint effect ${taint.effect}`);
    const group: EmuNodegroup = {
      cluster: cluster.name,
      nodegroupName: name,
      status: 'CREATING',
      scalingConfig: { ...scaling },
      instanceTypes: body.instanceTypes ?? ['t3.medium'],
      amiType: body.amiType ?? 'AL2023_x86_64_STANDARD',
      capacityType: body.capacityType ?? 'ON_DEMAND',
      subnets: [...subnets],
      nodeRole: body.nodeRole,
      diskSize: body.diskSize ?? 20,
      labels: { ...(body.labels ?? {}) },
      taints: (body.taints ?? []).map((taint: Json) => ({ ...taint })),
      tags: { ...(body.tags ?? {}) },
      version: cluster.version,
      releaseVersion: `${cluster.version}.0-20261101`,
      remaining: this.delayTicks,
    };
    group.settle = () => {
      group.status = 'ACTIVE';
    };
    this.nodegroups.set(key, group);
    return json(200, { nodegroup: this.#groupJson(group) });
  }

  /** The Kubernetes API of the emulated clusters, behind a KubeTransport. */
  kubeApi(): EksKubeApi {
    return new EksKubeApi(this, this.emu);
  }
}

/** The clusters' own Kubernetes API: eksToken and access entry checks, then the access calls. */
export class EksKubeApi {
  calls: KubeRequest[] = [];
  namespaces = new Set<string>();
  serviceAccounts = new Set<string>();
  bindings = new Map<string, Json>();
  clusterRoles = new Map<string, Json>();
  admissionPolicies = new Map<string, Json>();
  admissionBindings = new Map<string, Json>();
  /** A cluster before Kubernetes 1.30: no ValidatingAdmissionPolicy API. */
  noAdmissionApi = false;
  issued: string[] = [];
  /** The principals each call authenticated as. */
  principals: string[] = [];
  /** Answers every request with this status instead. */
  failWith?: number;
  unreachable = false;

  constructor(
    private readonly eks: EksEmulator,
    private readonly emu: AwsEmulator,
  ) {}

  /**
   * Whether the bound ValidatingAdmissionPolicies refuse a request, as the API server would decide
   * for what the driver installs: the namespace selector (In on kubernetes.io/metadata.name), the
   * operations, a matchCondition on the requester's groups, and a validation on whether the
   * requester may escalate ClusterRoles (`canEscalate`, what RBAC says for its bindings).
   */
  admissionDenies(request: { namespace: string; operation: string; groups: string[]; canEscalate: boolean }): boolean {
    for (const binding of this.admissionBindings.values()) {
      if (!binding.spec?.validationActions?.includes('Deny')) continue;
      const policy = this.admissionPolicies.get(binding.spec.policyName);
      if (!policy) continue;
      const constraints = policy.spec.matchConstraints;
      const selected = (constraints.namespaceSelector?.matchExpressions ?? []).every(
        (expression: Json) =>
          expression.key === 'kubernetes.io/metadata.name' &&
          expression.operator === 'In' &&
          expression.values.includes(request.namespace),
      );
      const operation = constraints.resourceRules.some((rule: Json) => rule.operations.includes(request.operation));
      const conditions = (policy.spec.matchConditions ?? []).every((condition: Json) => {
        const group = /g == '([^']+)'/.exec(condition.expression)?.[1];
        return group !== undefined && request.groups.includes(group);
      });
      if (!selected || !operation || !conditions) continue;
      for (const validation of policy.spec.validations) {
        const escalate = validation.expression.endsWith(".resource('clusterroles').check('escalate').allowed()");
        if (!escalate || !request.canEscalate) return true;
      }
    }
    return false;
  }

  routes(): string[] {
    return this.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
  }

  /** The principal an eksToken proves for `cluster`, or a reason it does not. */
  verify(token: string, cluster: string): { principal: string } | { refused: string } {
    if (!token.startsWith('k8s-aws-v1.')) return { refused: 'not an eksToken' };
    let url: URL;
    try {
      url = new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString('utf8'));
    } catch {
      return { refused: 'unreadable token' };
    }
    if (!/^sts\.[a-z0-9-]+\.amazonaws\.com$/.test(url.host)) return { refused: 'not an STS host' };
    if (url.searchParams.get('Action') !== 'GetCallerIdentity') return { refused: 'not GetCallerIdentity' };
    if (url.searchParams.get('X-Amz-SignedHeaders') !== 'host;x-k8s-aws-id') return { refused: 'cluster header not signed' };
    const [keyId, , region] = (url.searchParams.get('X-Amz-Credential') ?? '').split('/');
    const identity = keyId ? this.emu.sts.identities.get(keyId) : undefined;
    if (!identity || !region) return { refused: 'unknown key' };
    const date = url.searchParams.get('X-Amz-Date') ?? '';
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m) return { refused: 'bad date' };
    const signedAt = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    // EKS accepts a token for 15 minutes from its signature, whatever X-Amz-Expires says.
    if (this.emu.now() > signedAt + Math.min(expires, 900) * 1000 + 14 * 60_000) return { refused: 'expired' };
    const base = new URL(`${url.origin}/?Action=GetCallerIdentity&Version=2011-06-15`);
    const again = new URL(
      presignUrl({
        method: 'GET',
        url: base,
        headers: { 'x-k8s-aws-id': cluster },
        service: 'sts',
        region,
        credentials: {
          accessKeyId: keyId!,
          secretAccessKey: identity.secret,
          ...(identity.sessionToken ? { sessionToken: identity.sessionToken } : {}),
        },
        now: signedAt,
        expiresInSeconds: expires,
        unsignedPayload: false,
      }),
    );
    if (again.searchParams.get('X-Amz-Signature') !== url.searchParams.get('X-Amz-Signature'))
      return { refused: 'signature mismatch (another cluster, or a forged token)' };
    return { principal: principalOf(identity.arn) };
  }

  transport: KubeTransport = async (request) => {
    this.calls.push(request);
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    const ok = (status: number, payload: unknown) => ({ status, body: payload });
    const host = new URL(request.url).host;
    const cluster = [...this.eks.clusters.values()].find((c) => new URL(c.endpoint).host === host);
    if (!cluster) throw new Error('getaddrinfo ENOTFOUND');
    if (request.caPem !== emulatedEksCaPem) throw new Error('self-signed certificate in chain');
    const proven = this.verify(request.token, cluster.name);
    if ('refused' in proven) return ok(401, { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' });
    const entry = this.eks.accessEntries.get(`${cluster.name}|${proven.principal}`);
    if (!entry) return ok(401, { kind: 'Status', reason: 'Unauthorized', message: 'Unauthorized' });
    if (!entry.policies.some((policy) => policy.policyArn === adminPolicy && policy.accessScope.type === 'cluster'))
      return ok(403, { kind: 'Status', reason: 'Forbidden', message: 'forbidden' });
    this.principals.push(proven.principal);
    if (this.failWith) return ok(this.failWith, { kind: 'Status', message: 'refused', reason: 'Forbidden' });
    const path = new URL(request.url).pathname;
    const body = request.body as Json;
    const exists = { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' };
    const missing = { kind: 'Status', reason: 'NotFound', message: 'not found' };
    let m: RegExpExecArray | null;
    if (request.method === 'POST' && path === '/api/v1/namespaces') {
      if (this.namespaces.has(body.metadata.name)) return ok(409, exists);
      this.namespaces.add(body.metadata.name);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path)) && request.method === 'POST') {
      if (!this.namespaces.has(m[1]!)) return ok(404, missing);
      const key = `${m[1]}/${body.metadata.name}`;
      if (this.serviceAccounts.has(key)) return ok(409, exists);
      this.serviceAccounts.add(key);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)\/token$/.exec(path))) {
      if (!this.serviceAccounts.has(`${m[1]}/${m[2]}`)) return ok(404, missing);
      const token = `eks-sa-token-${this.issued.length + 1}`;
      this.issued.push(token);
      const ttl = body.spec.expirationSeconds as number;
      return ok(201, {
        ...body,
        status: { token, expirationTimestamp: new Date(this.emu.now() + ttl * 1000).toISOString() },
      });
    }
    for (const [collection, store] of [
      ['/apis/rbac.authorization.k8s.io/v1/clusterroles', this.clusterRoles],
      ['/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies', this.admissionPolicies],
      ['/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings', this.admissionBindings],
    ] as const) {
      if (this.noAdmissionApi && collection.includes('admissionregistration') && path.startsWith(collection))
        return ok(404, { kind: 'Status', reason: 'NotFound', message: 'the server could not find the requested resource' });
      if (path === collection && request.method === 'POST') {
        if (store.has(body.metadata.name)) return ok(409, exists);
        store.set(body.metadata.name, body);
        return ok(201, body);
      }
      if (path.startsWith(`${collection}/`) && request.method === 'PUT') {
        const name = decodeURIComponent(path.slice(collection.length + 1));
        if (!store.has(name) || body.metadata.name !== name) return ok(404, missing);
        store.set(name, body);
        return ok(200, body);
      }
    }
    const bindings = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
    if (path === bindings && request.method === 'POST') {
      if (this.bindings.has(body.metadata.name)) return ok(409, exists);
      this.bindings.set(body.metadata.name, body);
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
}
