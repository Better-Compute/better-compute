import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Clock,
  type KubernetesClusterSpec,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
  type KubernetesNodePoolSpec,
  type KubernetesVersions,
  type ProviderKubernetes,
  type ProviderKubernetesCluster,
  type ProviderResourceState,
} from '@better-compute/core';
import {
  eksToken,
  partitionOf,
  type CredentialSource,
  type QueryClient,
} from '@better-compute/aws-core';
import type { AwsConfig } from '../config.js';
import { clientToken } from '../ids.js';
import type { InstanceTypeCache, InstanceTypeInfo } from '../shapes.js';
import {
  checkName,
  clusterId,
  isBusy,
  parseClusterId,
  resourceState,
  Updates,
  type EksClient,
  type EksCluster,
  type EksNodegroup,
  type EksUpdate,
} from './client.js';
import {
  checkClusterSpec,
  checkImmutable,
  clusterBody,
  clusterState,
  clusterTags,
  nextClusterChange,
  subnetsOf,
} from './clusters.js';
import {
  checkCredentialRequest,
  endpointOf,
  ensureAdminAccess,
  mintCredentials,
  principalArnOf,
} from './credentials.js';
import {
  checkAccelerators,
  checkNodePoolSpec,
  checkNodegroupImmutable,
  nodegroupBody,
  nodegroupState,
  scalingChange,
} from './node-groups.js';
import { checkClusterSubnets, describeSubnets, nodegroupSubnets } from './subnets.js';
import { httpsKubeTransport, type KubeTransport } from './transport.js';
import { readVersions } from './versions.js';

export {
  EksClient,
  parseClusterId,
  type EksCluster,
  type EksNodegroup,
  type EksUpdate,
} from './client.js';
export { compareMinor, minorOf } from './clusters.js';
export {
  accessNamespace,
  accessPolicies,
  accessPolicyArn,
  clusterRoles,
  principalArnOf,
} from './credentials.js';
export { amiTypeOf, gpuTaint, scalingOf } from './node-groups.js';
export {
  httpsKubeTransport,
  type KubeRequest,
  type KubeResponse,
  type KubeTransport,
} from './transport.js';

// Managed Kubernetes on Amazon EKS (managed node groups and EKS Auto Mode) over the EKS REST API.
//
// Like the GKE driver, every ensure*/delete* call is non-blocking: it polls the update this process
// started for the resource (if any), re-reads the resource, and starts at most one change,
// answering `pending`, `updating` or `deleting` while it runs. EKS runs one update per cluster at a
// time and refuses changes while a resource is not ACTIVE; such a refusal answers the in-progress
// state, never an error. Nothing is persisted: after a restart a call re-reads the resource.

export interface AwsKubernetesOptions {
  client: EksClient;
  /** EC2: the subnets' zones and VPC, and instance types (GPUs, architecture). */
  ec2: QueryClient;
  types: InstanceTypeCache;
  config: AwsConfig;
  /** The account's credentials: they sign EKS calls and the eksToken. */
  credentials: CredentialSource;
  /** The account's IAM identity (GetCallerIdentity), memoized by the caller. */
  identity: (context: CallContext) => Promise<{ arn: string }>;
  clock: Clock;
  kubeTransport?: KubeTransport;
  /** Host option only: the STS endpoint eksTokens are presigned for. */
  stsEndpoint?: string;
}

const busyState: Record<'create' | 'update' | 'delete', ProviderResourceState['state']> = {
  create: 'pending',
  update: 'updating',
  delete: 'deleting',
};

const segment = (value: string) => encodeURIComponent(value);

export class AwsKubernetes implements ProviderKubernetes {
  /** EKS clusters are regional (D-EKS-4): the module refuses a zone as their location at create. */
  readonly regionalOnly = true;
  readonly #client: EksClient;
  readonly #ec2: QueryClient;
  readonly #types: InstanceTypeCache;
  readonly #config: AwsConfig;
  readonly #credentials: CredentialSource;
  readonly #identity: AwsKubernetesOptions['identity'];
  readonly #clock: Clock;
  readonly #transport: KubeTransport;
  readonly #stsEndpoint: string | undefined;
  readonly #updates: Updates;
  /** Clusters (by ARN) where the account principal's admin access entry was seen. */
  readonly #admitted = new Set<string>();

  constructor(options: AwsKubernetesOptions) {
    this.#client = options.client;
    this.#ec2 = options.ec2;
    this.#types = options.types;
    this.#config = options.config;
    this.#credentials = options.credentials;
    this.#identity = options.identity;
    this.#clock = options.clock;
    this.#transport = options.kubeTransport ?? httpsKubeTransport;
    this.#stsEndpoint = options.stsEndpoint;
    this.#updates = new Updates(options.client);
  }

  get #region(): string {
    return this.#config.region;
  }

  #configMissing(field: string, why: string): ComputeError {
    return new ComputeError(
      'INVALID_CONFIG',
      `The AWS account needs ${field} ${why}`,
      undefined,
      { provider: 'aws', service: 'eks', reason: field },
    );
  }

  /** Starts an update; a refusal because the resource is busy answers `busy`. */
  async #update(
    memory: string,
    id: string,
    target: { cluster: string; nodegroup?: string },
    request: { path: string; body: Record<string, unknown>; what: string },
    context: CallContext,
  ): Promise<ProviderResourceState> {
    let answer: { update?: EksUpdate };
    try {
      answer = await this.#client.request<{ update?: EksUpdate }>('POST', request.path, {
        body: { ...request.body, clientRequestToken: clientToken(`${context.idempotencyKey}:${memory}:${JSON.stringify(request.body)}`) },
        signal: context.signal,
        what: request.what,
      });
    } catch (error) {
      if (isBusy(error)) return resourceState(id, 'updating', { message: error.message });
      throw error;
    }
    if (answer.update?.id)
      this.#updates.remember(memory, {
        cluster: target.cluster,
        ...(target.nodegroup ? { nodegroup: target.nodegroup } : {}),
        id: answer.update.id,
      });
    return resourceState(id, 'updating');
  }

  // ---------------------------------------------------------------------------------- clusters

  async ensureCluster(
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    checkClusterSpec(spec, this.#region, false);
    const { signal } = context;
    const id = clusterId(this.#region, spec.name);
    const memory = `cluster:${id}`;
    const polled = await this.#updates.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(id, 'updating');
    if (polled && 'failed' in polled) return resourceState(id, 'error', { message: polled.failed });

    const found = await this.#client.cluster(spec.name, signal);
    if (!found) return this.#createCluster(id, spec, context);
    if (found.status === 'DELETING') return clusterState(id, this.#region, found);
    checkImmutable(id, spec, found);
    if (found.status !== 'ACTIVE') return clusterState(id, this.#region, found);
    const change = nextClusterChange(id, spec, found);
    if (!change) return clusterState(id, this.#region, found);
    context.log.info('eks.cluster.update', {
      cluster: id,
      kind: change.kind,
      fields: Object.keys(change.body),
    });
    return this.#update(
      memory,
      id,
      { cluster: spec.name },
      {
        path: `/clusters/${segment(spec.name)}/${change.kind === 'version' ? 'updates' : 'update-config'}`,
        body: change.body,
        what: `Updating EKS cluster ${id}`,
      },
      context,
    );
  }

  async #createCluster(
    id: string,
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    checkClusterSpec(spec, this.#region, true);
    const roleArn = this.#config.eksClusterRoleArn;
    if (!roleArn) throw this.#configMissing('eksClusterRoleArn', 'to create EKS clusters (the cluster IAM role)');
    const autoMode = spec.mode === 'autopilot';
    const nodeRoleArn = this.#config.eksNodeRoleArn;
    if (autoMode && !nodeRoleArn)
      throw this.#configMissing('eksNodeRoleArn', 'to create EKS Auto Mode clusters (the node IAM role)');
    const subnetIds =
      spec.network?.subnet !== undefined ? subnetsOf(spec.network.subnet) : (this.#config.eksSubnetIds ?? []);
    if (subnetIds.length < 2 && spec.network?.subnet !== undefined)
      throw new ComputeError(
        'INVALID_INPUT',
        'EKS needs at least two cluster subnets, in two Availability Zones (network.subnet lists them, comma-separated)',
        undefined,
        { provider: 'aws', service: 'eks', reason: 'subnets' },
      );
    if (subnetIds.length < 2)
      throw this.#configMissing(
        'eksSubnetIds',
        '(at least two subnets in two Availability Zones) unless the cluster network names its subnets',
      );
    const subnets = await describeSubnets(this.#ec2, subnetIds, context.signal);
    checkClusterSubnets(subnets, {
      ...(spec.network ? { vpcId: spec.network.network } : {}),
      privateNodes: spec.privateNodes === true,
    });
    context.log.info('eks.cluster.create', { cluster: id, mode: spec.mode });
    try {
      await this.#client.request('POST', '/clusters', {
        body: clusterBody(spec, {
          roleArn,
          subnetIds,
          ...(nodeRoleArn ? { nodeRoleArn } : {}),
          clientRequestToken: clientToken(`${context.idempotencyKey}:create:${id}`),
        }),
        signal: context.signal,
        what: `Creating EKS cluster ${id}`,
      });
    } catch (error) {
      // Created meanwhile (a retry, or another creator): what is there is the answer.
      if (!isComputeError(error, 'INVALID_STATE') && !isComputeError(error, 'CONFLICT')) throw error;
      const found = await this.#client.cluster(spec.name, context.signal);
      if (!found) throw error;
      return clusterState(id, this.#region, found);
    }
    return resourceState(id, 'pending');
  }

  async getCluster(
    cluster: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    const { name } = parseClusterId(cluster, this.#region);
    const found = await this.#client.cluster(name, context.signal);
    return found ? clusterState(cluster, this.#region, found) : undefined;
  }

  /**
   * Deletes the cluster's node groups first (EKS refuses to delete a cluster that has any), then
   * the cluster.
   */
  async deleteCluster(cluster: string, context: CallContext): Promise<ProviderResourceState> {
    const { name } = parseClusterId(cluster, this.#region);
    const { signal } = context;
    const found = await this.#client.cluster(name, signal);
    if (!found) {
      this.#updates.forget(`cluster:${cluster}`);
      this.#updates.forget(`pool:${cluster}`);
      return resourceState(cluster, 'deleted');
    }
    if (found.status === 'DELETING') return resourceState(cluster, 'deleting');
    const groups = await this.#client.names(
      `/clusters/${segment(name)}/node-groups`,
      'nodegroups',
      signal,
      `Listing the node groups of EKS cluster ${cluster}`,
    );
    if (groups.length > 0) {
      for (const group of groups) {
        const current = await this.#client.nodegroup(name, group, signal);
        if (!current || current.status === 'DELETING') continue;
        context.log.info('eks.nodegroup.delete', { nodePool: `${cluster}/${group}`, reason: 'cluster' });
        await this.#deleteGroup(name, group, signal);
      }
      return resourceState(cluster, 'deleting');
    }
    context.log.info('eks.cluster.delete', { cluster });
    try {
      await this.#client.request('DELETE', `/clusters/${segment(name)}`, {
        signal,
        what: `Deleting EKS cluster ${cluster}`,
      });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return resourceState(cluster, 'deleted');
      if (isBusy(error)) return resourceState(cluster, 'deleting', { message: error.message });
      throw error;
    }
    if (found.arn) this.#admitted.delete(found.arn);
    return resourceState(cluster, 'deleting');
  }

  async #deleteGroup(cluster: string, group: string, signal: AbortSignal): Promise<'deleting' | 'deleted' | 'busy'> {
    try {
      await this.#client.request('DELETE', `/clusters/${segment(cluster)}/node-groups/${segment(group)}`, {
        signal,
        what: `Deleting EKS node group ${cluster}/${group}`,
      });
      return 'deleting';
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return 'deleted';
      if (isBusy(error)) return 'busy';
      throw error;
    }
  }

  // -------------------------------------------------------------------------------- node pools

  /** The cluster a node pool call names; UNSUPPORTED on Auto Mode. */
  async #standardCluster(name: string, id: string, signal: AbortSignal): Promise<EksCluster | undefined> {
    const found = await this.#client.cluster(name, signal);
    if (found?.computeConfig?.enabled === true)
      throw new ComputeError(
        'UNSUPPORTED',
        `Cluster ${id} is an EKS Auto Mode (autopilot) cluster: EKS runs its nodes, it has no node pools`,
        undefined,
        { provider: 'aws', service: 'eks', reason: 'autopilot' },
      );
    return found;
  }

  async #typeInfo(machineType: string, signal: AbortSignal): Promise<InstanceTypeInfo | undefined> {
    try {
      return (await this.#types.get([machineType], signal)).get(machineType);
    } catch (error) {
      // Without ec2:DescribeInstanceTypes (or for a type EC2 does not know) EKS decides.
      if (isComputeError(error, 'ACCESS_DENIED') || isComputeError(error, 'INVALID_INPUT') || isComputeError(error, 'PROVIDER_ERROR'))
        return undefined;
      throw error;
    }
  }

  async ensureNodePool(
    cluster: string,
    spec: KubernetesNodePoolSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { name: clusterName } = parseClusterId(cluster, this.#region);
    checkNodePoolSpec(spec);
    const { signal } = context;
    const id = `${cluster}/${spec.name}`;
    const parent = await this.#standardCluster(clusterName, cluster, signal);
    if (!parent)
      throw new ComputeError('NOT_FOUND', `EKS cluster ${cluster} does not exist`, undefined, {
        provider: 'aws',
        service: 'eks',
        reason: 'clusterNotFound',
      });
    const memory = `pool:${id}`;
    const polled = await this.#updates.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(id, 'updating');
    if (polled && 'failed' in polled) return resourceState(id, 'error', { message: polled.failed });

    const group = await this.#client.nodegroup(clusterName, spec.name, signal);
    if (!group) {
      if (parent.status === 'DELETING')
        throw new ComputeError('INVALID_STATE', `EKS cluster ${cluster} is being deleted`, undefined, {
          provider: 'aws',
          service: 'eks',
          reason: 'clusterDeleting',
        });
      const nodeRole = this.#config.eksNodeRoleArn;
      if (!nodeRole) throw this.#configMissing('eksNodeRoleArn', 'to create EKS node groups (the node IAM role)');
      const info = await this.#typeInfo(spec.machineType, signal);
      checkAccelerators(spec, info);
      const clusterSubnets = await describeSubnets(
        this.#ec2,
        parent.resourcesVpcConfig?.subnetIds ?? [],
        signal,
      );
      const { subnets, zones } = nodegroupSubnets(clusterSubnets, spec.zones);
      context.log.info('eks.nodegroup.create', { nodePool: id, machineType: spec.machineType, zones });
      try {
        await this.#client.request('POST', `/clusters/${segment(clusterName)}/node-groups`, {
          body: nodegroupBody(spec, {
            subnets,
            zones,
            nodeRole,
            info,
            clientRequestToken: clientToken(`${context.idempotencyKey}:create:${id}`),
          }),
          signal,
          what: `Creating EKS node group ${id}`,
        });
      } catch (error) {
        if (!isComputeError(error, 'INVALID_STATE') && !isComputeError(error, 'CONFLICT')) throw error;
        const found = await this.#client.nodegroup(clusterName, spec.name, signal);
        // The cluster is busy (updating): try again later.
        if (!found) return resourceState(id, 'pending', { message: error.message });
        return nodegroupState(id, found);
      }
      return resourceState(id, 'pending');
    }
    if (group.status === 'DELETING') return nodegroupState(id, group);
    const zonesSubnets = spec.zones?.length
      ? nodegroupSubnets(
          await describeSubnets(this.#ec2, parent.resourcesVpcConfig?.subnetIds ?? [], signal),
          spec.zones,
        ).subnets
      : undefined;
    checkNodegroupImmutable(id, spec, group, zonesSubnets);
    if (group.status !== 'ACTIVE' && group.status !== 'DEGRADED') return nodegroupState(id, group);
    const scaling = scalingChange(spec, group);
    if (!scaling) return nodegroupState(id, group);
    context.log.info('eks.nodegroup.scale', { nodePool: id, ...scaling });
    return this.#update(
      memory,
      id,
      { cluster: clusterName, nodegroup: spec.name },
      {
        path: `/clusters/${segment(clusterName)}/node-groups/${segment(spec.name)}/update-config`,
        body: { scalingConfig: scaling },
        what: `Scaling EKS node group ${id}`,
      },
      context,
    );
  }

  async deleteNodePool(
    cluster: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { name: clusterName } = parseClusterId(cluster, this.#region);
    checkName(name, 'The node pool name');
    const { signal } = context;
    const id = `${cluster}/${name}`;
    const parent = await this.#standardCluster(clusterName, cluster, signal);
    const group = parent ? await this.#client.nodegroup(clusterName, name, signal) : undefined;
    if (!group) {
      this.#updates.forget(`pool:${id}`);
      return resourceState(id, 'deleted');
    }
    if (group.status === 'DELETING') return resourceState(id, 'deleting');
    context.log.info('eks.nodegroup.delete', { nodePool: id });
    const outcome = await this.#deleteGroup(clusterName, name, signal);
    if (outcome === 'deleted') return resourceState(id, 'deleted');
    return resourceState(id, outcome === 'busy' ? 'updating' : busyState.delete);
  }

  // ------------------------------------------------------------------------------ credentials

  async credentials(
    cluster: string,
    request: KubernetesCredentialRequest,
    context: CallContext,
  ): Promise<KubernetesCredentials> {
    const { name } = parseClusterId(cluster, this.#region);
    checkCredentialRequest(request);
    const { signal } = context;
    const found = await this.#client.cluster(name, signal);
    if (!found)
      throw new ComputeError('NOT_FOUND', `EKS cluster ${cluster} does not exist`, undefined, {
        provider: 'aws',
        service: 'eks',
        reason: 'clusterNotFound',
      });
    endpointOf(cluster, found);
    if (found.accessConfig?.authenticationMode === 'CONFIG_MAP')
      throw new ComputeError(
        'INVALID_STATE',
        `EKS cluster ${cluster} authenticates through the aws-auth ConfigMap only; better-compute uses access entries (set authenticationMode to API_AND_CONFIG_MAP or API)`,
        undefined,
        { provider: 'aws', service: 'eks', reason: 'authenticationMode' },
      );
    const key = found.arn ?? cluster;
    let fresh = false;
    if (!this.#admitted.has(key)) {
      const principalArn = principalArnOf(
        (await this.#identity(context)).arn,
        this.#config.assumeRoleArn !== undefined ? [this.#config.assumeRoleArn] : [],
      );
      fresh = await ensureAdminAccess({
        client: this.#client,
        cluster: name,
        principalArn,
        partition: partitionOf(this.#region).partition,
        signal,
      });
      this.#admitted.add(key);
    }
    const token = await eksToken({
      cluster: name,
      credentials: this.#credentials,
      region: this.#region,
      signal,
      clock: this.#clock,
      ...(this.#stsEndpoint !== undefined ? { stsEndpoint: this.#stsEndpoint } : {}),
    });
    let credentials: KubernetesCredentials;
    try {
      credentials = await mintCredentials({
        id: cluster,
        cluster: found,
        request,
        token,
        fresh,
        transport: this.#transport,
        signal,
        clock: this.#clock,
      });
    } catch (error) {
      // Check the access entry again next time.
      if (isComputeError(error, 'ACCESS_DENIED') || isComputeError(error, 'UNAVAILABLE'))
        this.#admitted.delete(key);
      throw error;
    }
    context.log.info('eks.credentials', {
      cluster,
      subject: request.subject,
      role: request.role,
      expiresAt: credentials.expiresAt,
    });
    return credentials;
  }

  // -------------------------------------------------------------------------------- discovery

  /**
   * Every cluster of the account's region (ListClusters, DescribeCluster each), with the nodeadm
   * cluster (`policy.kubernetes.eks`) of those that are ready: machines join them through
   * `k8s-join` mode `eks`. At most 100 clusters.
   */
  async listClusters(context: CallContext): Promise<ProviderKubernetesCluster[]> {
    const { signal } = context;
    const names = await this.#client.names('/clusters', 'clusters', signal, 'Listing the EKS clusters', 100);
    const out: ProviderKubernetesCluster[] = [];
    for (const name of names.slice(0, 100)) {
      const found = await this.#client.cluster(name, signal);
      if (!found) continue;
      const id = clusterId(this.#region, name);
      const state = clusterState(id, this.#region, found).state;
      const cidr =
        found.kubernetesNetworkConfig?.serviceIpv4Cidr ?? found.kubernetesNetworkConfig?.serviceIpv6Cidr;
      let eks: ProviderKubernetesCluster['eks'];
      if (found.endpoint && found.certificateAuthority?.data && cidr && found.status === 'ACTIVE') {
        try {
          const { server, caData } = endpointOf(id, found);
          eks = { name, apiServerEndpoint: server, certificateAuthority: caData, cidr };
        } catch {
          eks = undefined; // A malformed endpoint or CA: listed, but nothing to join with.
        }
      }
      out.push({
        name,
        id,
        location: this.#region,
        state,
        ...(found.version ? { version: found.version } : {}),
        ...(found.endpoint ? { endpoint: found.endpoint } : {}),
        managed: found.tags?.[clusterTags.managed] === 'true',
        ...(eks ? { eks } : {}),
      });
    }
    return out;
  }

  // --------------------------------------------------------------------------------- versions

  async versions(location: string, context: CallContext): Promise<KubernetesVersions> {
    if (location !== this.#region)
      throw new ComputeError(
        'INVALID_INPUT',
        `EKS versions are per region and this account is ${this.#region}, not ${JSON.stringify(location)}`,
        undefined,
        { provider: 'aws', service: 'eks' },
      );
    return readVersions(this.#client, context.signal);
  }
}
