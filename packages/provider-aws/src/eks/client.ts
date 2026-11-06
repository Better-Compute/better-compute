import { ComputeError, isComputeError, type ProviderResourceState } from '@better-compute/core';
import type { RestClient } from '@better-compute/aws-core';

// The Amazon EKS REST client (rest-json over aws-core's restClient, SigV4 service `eks`), the
// resource shapes the driver reads, cluster ids, and the in-memory record of running updates.

export interface EksIssue {
  code?: string;
  message?: string;
}

export interface EksCluster {
  name: string;
  arn?: string;
  version?: string;
  platformVersion?: string;
  endpoint?: string;
  roleArn?: string;
  status?: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'UPDATING' | 'PENDING';
  certificateAuthority?: { data?: string };
  resourcesVpcConfig?: {
    subnetIds?: string[];
    securityGroupIds?: string[];
    clusterSecurityGroupId?: string;
    vpcId?: string;
    endpointPublicAccess?: boolean;
    endpointPrivateAccess?: boolean;
    publicAccessCidrs?: string[];
  };
  kubernetesNetworkConfig?: {
    serviceIpv4Cidr?: string;
    serviceIpv6Cidr?: string;
    ipFamily?: string;
    elasticLoadBalancing?: { enabled?: boolean };
  };
  accessConfig?: { authenticationMode?: 'API' | 'API_AND_CONFIG_MAP' | 'CONFIG_MAP' };
  upgradePolicy?: { supportType?: 'STANDARD' | 'EXTENDED' };
  computeConfig?: { enabled?: boolean; nodePools?: string[]; nodeRoleArn?: string };
  tags?: Record<string, string>;
  health?: { issues?: EksIssue[] };
}

export interface EksNodegroup {
  nodegroupName: string;
  clusterName?: string;
  status?:
    | 'CREATING'
    | 'ACTIVE'
    | 'UPDATING'
    | 'DELETING'
    | 'CREATE_FAILED'
    | 'DELETE_FAILED'
    | 'DEGRADED';
  version?: string;
  releaseVersion?: string;
  capacityType?: 'ON_DEMAND' | 'SPOT' | 'CAPACITY_BLOCK';
  scalingConfig?: { minSize?: number; maxSize?: number; desiredSize?: number };
  instanceTypes?: string[];
  subnets?: string[];
  amiType?: string;
  nodeRole?: string;
  diskSize?: number;
  labels?: Record<string, string>;
  taints?: { key?: string; value?: string; effect?: string }[];
  tags?: Record<string, string>;
  health?: { issues?: EksIssue[] };
}

export interface EksUpdate {
  id: string;
  status?: 'InProgress' | 'Failed' | 'Cancelled' | 'Successful';
  type?: string;
  errors?: { errorCode?: string; errorMessage?: string }[];
}

/** EKS cluster names: a letter or digit, then letters, digits, `-` and `_`, at most 100. */
export const eksNamePattern = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
/** Node group names: the same alphabet, at most 63. */
export const nodegroupNamePattern = /^[0-9A-Za-z][A-Za-z0-9_-]{0,62}$/;

export function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, { provider: 'aws', service: 'eks' });
}

export function checkName(value: unknown, what: string, pattern = eksNamePattern): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw invalid(
      `${what} ${JSON.stringify(value)} is not an EKS name (a letter or digit, then letters, digits, - and _)`,
    );
  return value;
}

/** A cluster's id: `<region>/<name>`. */
export function clusterId(region: string, name: string): string {
  return `${region}/${name}`;
}

/** Splits a cluster id; it must name the account's own region (an account is one region). */
export function parseClusterId(id: string, region: string): { region: string; name: string } {
  const parts = typeof id === 'string' ? id.split('/') : [];
  const [location, name] = parts;
  if (parts.length !== 2 || location !== region || !name || !eksNamePattern.test(name))
    throw invalid(`${JSON.stringify(id)} is not an EKS cluster id of ${region} (<region>/<name>)`);
  return { region: location, name };
}

export const resourceState = (
  id: string,
  value: ProviderResourceState['state'],
  extra: { message?: string; outputs?: Record<string, string> } = {},
): ProviderResourceState => ({
  id,
  state: value,
  ...(extra.outputs && Object.keys(extra.outputs).length ? { outputs: extra.outputs } : {}),
  ...(extra.message !== undefined ? { message: extra.message } : {}),
});

/** The first health issue's words, at most 300 characters. */
export function issueMessage(health: { issues?: EksIssue[] } | undefined): string | undefined {
  const issue = health?.issues?.find((entry) => entry.message || entry.code);
  if (!issue) return undefined;
  return `${issue.code ? `${issue.code}: ` : ''}${issue.message ?? ''}`.slice(0, 300);
}

/**
 * EKS runs one update per cluster (and per node group) at a time, and refuses changes while the
 * resource is not ACTIVE: ResourceInUseException (INVALID_STATE) or a 409. That is "try again
 * later", not a failure.
 */
export function isBusy(error: unknown): error is ComputeError {
  if (!isComputeError(error)) return false;
  if (error.code === 'CONFLICT') return true;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return error.code === 'INVALID_STATE' && code === 'ResourceInUseException';
}

const segment = (value: string) => encodeURIComponent(value);

export class EksClient {
  readonly #rest: RestClient;

  constructor(rest: RestClient) {
    this.#rest = rest;
  }

  /** One call; the body is JSON, the answer parsed JSON (`{}` when empty). */
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      body?: unknown;
      query?: Readonly<Record<string, string>>;
      signal: AbortSignal;
      what: string;
    },
  ): Promise<T> {
    let response;
    try {
      response = await this.#rest.request(method, path, {
        protocol: 'rest-json',
        signal: options.signal,
        ...(options.query ? { query: options.query } : {}),
        ...(options.body !== undefined
          ? {
              body: JSON.stringify(options.body),
              headers: { 'content-type': 'application/json' },
            }
          : {}),
      });
    } catch (error) {
      if (isComputeError(error))
        throw new ComputeError(
          error.code,
          `${options.what}: ${error.message}`,
          undefined,
          error.details,
        );
      throw error;
    }
    const text = new TextDecoder().decode(response.body);
    if (text.trim() === '') return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ComputeError(
        'PROVIDER_ERROR',
        `${options.what}: EKS answered something that is not JSON`,
        undefined,
        { provider: 'aws', service: 'eks', reason: 'unreadable' },
      );
    }
  }

  /** The resource; undefined on NOT_FOUND. */
  async find<T>(
    path: string,
    signal: AbortSignal,
    what: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<T | undefined> {
    try {
      return await this.request<T>('GET', path, { signal, what, ...(query ? { query } : {}) });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  cluster(name: string, signal: AbortSignal): Promise<EksCluster | undefined> {
    return this.find<{ cluster: EksCluster }>(
      `/clusters/${segment(name)}`,
      signal,
      `Reading EKS cluster ${name}`,
    ).then((found) => found?.cluster);
  }

  nodegroup(cluster: string, name: string, signal: AbortSignal): Promise<EksNodegroup | undefined> {
    return this.find<{ nodegroup: EksNodegroup }>(
      `/clusters/${segment(cluster)}/node-groups/${segment(name)}`,
      signal,
      `Reading EKS node group ${cluster}/${name}`,
    ).then((found) => found?.nodegroup);
  }

  /** Every name a paginated list answers (`clusters`, `nodegroups`), at most `limit`. */
  async names(
    path: string,
    key: 'clusters' | 'nodegroups',
    signal: AbortSignal,
    what: string,
    limit = 1000,
  ): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.request<Record<string, unknown> & { nextToken?: string }>(
        'GET',
        path,
        { signal, what, query: { maxResults: '100', ...(token ? { nextToken: token } : {}) } },
      );
      for (const name of (page[key] as unknown[] | undefined) ?? [])
        if (typeof name === 'string') out.push(name);
      token = typeof page.nextToken === 'string' && page.nextToken ? page.nextToken : undefined;
      if (token && seen.has(token))
        throw new ComputeError('PROVIDER_ERROR', `${what}: EKS repeated a page token`, undefined, {
          provider: 'aws',
          service: 'eks',
          reason: 'pagination-loop',
        });
      if (token) seen.add(token);
    } while (token && out.length < limit);
    return out;
  }
}

export type UpdateKind = 'create' | 'update' | 'delete';

interface Remembered {
  cluster: string;
  nodegroup?: string;
  id: string;
}

export type Polled = { running: true } | { failed: string } | { done: true };

export function updateMessage(update: EksUpdate): string {
  const error = update.errors?.find((entry) => entry.errorMessage || entry.errorCode);
  return (
    `${error?.errorCode ? `${error.errorCode}: ` : ''}${error?.errorMessage ?? ''}`.slice(0, 300) ||
    `The EKS update ${update.id} ${update.status === 'Cancelled' ? 'was cancelled' : 'failed'}`
  );
}

/**
 * The updates this process started, by resource. Nothing is persisted: after a restart a call
 * re-reads the resource, whose status shows a running update as well (UPDATING).
 */
export class Updates {
  readonly #client: EksClient;
  readonly #running = new Map<string, Remembered>();

  constructor(client: EksClient) {
    this.#client = client;
  }

  remember(memory: string, update: Remembered): void {
    this.#running.set(memory, update);
  }

  forget(prefix: string): void {
    for (const key of [...this.#running.keys()])
      if (key === prefix || key.startsWith(`${prefix}:`)) this.#running.delete(key);
  }

  async poll(memory: string, signal: AbortSignal): Promise<Polled | undefined> {
    const remembered = this.#running.get(memory);
    if (!remembered) return undefined;
    const found = await this.#client.find<{ update: EksUpdate }>(
      `/clusters/${segment(remembered.cluster)}/updates/${segment(remembered.id)}`,
      signal,
      `Reading EKS update ${remembered.id}`,
      remembered.nodegroup ? { nodegroupName: remembered.nodegroup } : undefined,
    );
    // An update EKS no longer knows (its resource is gone): re-read the resource.
    const update = found?.update;
    if (!update || update.status === 'Successful') {
      this.#running.delete(memory);
      return { done: true };
    }
    if (update.status === 'InProgress' || update.status === undefined) return { running: true };
    this.#running.delete(memory);
    return { failed: updateMessage(update) };
  }
}
