import { ComputeError, isComputeError, type ProviderResourceState } from '@better-compute/core';
import type { GoogleClient } from '@better-compute/gcp-common';

// The GKE REST v1 client (container.googleapis.com/v1) over the shared googleClient, the resource
// shapes the driver reads, cluster ids, and the in-memory record of running operations.

/** A container `Operation` (not a google.longrunning one). */
export interface GkeOperation {
  name: string;
  status?: 'STATUS_UNSPECIFIED' | 'PENDING' | 'RUNNING' | 'DONE' | 'ABORTING';
  operationType?: string;
  statusMessage?: string;
  error?: { code?: number; message?: string; details?: unknown[] };
}

export interface GkeNodePoolConfig {
  machineType?: string;
  diskSizeGb?: number;
  diskType?: string;
  spot?: boolean;
  accelerators?: { acceleratorType?: string; acceleratorCount?: string | number }[];
  labels?: Record<string, string>;
  taints?: { key?: string; value?: string; effect?: string }[];
}

export interface GkeNodePool {
  name: string;
  status?: string;
  statusMessage?: string;
  version?: string;
  initialNodeCount?: number;
  locations?: string[];
  instanceGroupUrls?: string[];
  autoscaling?: { enabled?: boolean; minNodeCount?: number; maxNodeCount?: number };
  config?: GkeNodePoolConfig;
}

export interface GkeCluster {
  name: string;
  location?: string;
  status?: string;
  statusMessage?: string;
  conditions?: { message?: string }[];
  endpoint?: string;
  currentMasterVersion?: string;
  currentNodeVersion?: string;
  network?: string;
  subnetwork?: string;
  autopilot?: { enabled?: boolean };
  releaseChannel?: { channel?: string };
  privateClusterConfig?: { enablePrivateNodes?: boolean };
  networkConfig?: { defaultEnablePrivateNodes?: boolean };
  masterAuthorizedNetworksConfig?: { enabled?: boolean; cidrBlocks?: { cidrBlock?: string }[] };
  masterAuth?: { clusterCaCertificate?: string };
  nodePools?: GkeNodePool[];
}

/** GKE names (clusters and node pools): a lowercase letter, then `[-a-z0-9]`, at most 40. */
export const gkeNamePattern = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
/** A region (`us-central1`) or a zone (`us-central1-a`). */
export const locationPattern = /^[a-z]+-[a-z]+[0-9]+(-[a-z])?$/;

export function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, { provider: 'gcp' });
}

export function checkName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !gkeNamePattern.test(value))
    throw invalid(
      `${what} ${JSON.stringify(value)} is not a GKE name (a lowercase letter, then letters, digits and hyphens, at most 40)`,
    );
  return value;
}

export function checkLocation(value: unknown): string {
  if (typeof value !== 'string' || !locationPattern.test(value))
    throw invalid(`${JSON.stringify(value)} is not a GCP region or zone`);
  return value;
}

/** A cluster's id: `<location>/<name>`. */
export function clusterId(location: string, name: string): string {
  return `${location}/${name}`;
}

/** Splits a cluster id; anything that is not `<location>/<name>` is INVALID_INPUT. */
export function parseClusterId(id: string): { location: string; name: string } {
  const parts = typeof id === 'string' ? id.split('/') : [];
  const [location, name] = parts;
  if (
    parts.length !== 2 ||
    !location ||
    !name ||
    !locationPattern.test(location) ||
    !gkeNamePattern.test(name)
  )
    throw invalid(`${JSON.stringify(id)} is not a GKE cluster id (<location>/<name>)`);
  return { location, name };
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

export const lastSegment = (value: string | undefined): string =>
  (value ?? '').split('/').pop() ?? '';

/**
 * GKE runs one operation per cluster at a time: another mutation meanwhile is refused with 400
 * FAILED_PRECONDITION (or 409) naming the running operation. That is "try again later", not a
 * failure.
 */
export function isBusy(error: unknown, what = ''): error is ComputeError {
  if (!isComputeError(error) || (error.code !== 'INVALID_STATE' && error.code !== 'CONFLICT'))
    return false;
  // Only GKE's own words count, not the request's description (which names the resource).
  const said = error.message.startsWith(what) ? error.message.slice(what.length) : error.message;
  return /\boperation\b/i.test(said);
}

export class GkeClient {
  readonly #google: GoogleClient;
  readonly #base: string;

  constructor(google: GoogleClient, endpoint: string, projectId: string) {
    this.#google = google;
    this.#base = `${endpoint.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/locations`;
  }

  /** `path` is relative to `projects/<p>/locations/<location>/`. */
  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    location: string,
    path: string,
    options: { body?: unknown; signal: AbortSignal; what: string },
  ): Promise<T> {
    return this.#google.request<T>({
      method,
      url: `${this.#base}/${location}/${path}`,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: options.signal,
      what: options.what,
    });
  }

  /** The resource; undefined on NOT_FOUND. */
  async find<T>(
    location: string,
    path: string,
    signal: AbortSignal,
    what: string,
  ): Promise<T | undefined> {
    try {
      return await this.request<T>('GET', location, path, { signal, what });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }
}

export type OperationKind = 'create' | 'update' | 'delete';

interface Remembered {
  name: string;
  location: string;
  kind: OperationKind;
}

export type Polled =
  | { running: OperationKind }
  | { failed: string; kind: OperationKind }
  | { done: OperationKind };

export function operationMessage(operation: GkeOperation): string {
  return operation.error?.message || operation.statusMessage || 'The GKE operation failed';
}

/**
 * The operations this process started, by resource. Nothing is persisted: after a restart a call
 * simply re-reads the resource (whose status shows a running operation as well).
 */
export class Operations {
  readonly #client: GkeClient;
  readonly #running = new Map<string, Remembered>();

  constructor(client: GkeClient) {
    this.#client = client;
  }

  remember(memory: string, location: string, kind: OperationKind, operation: GkeOperation): void {
    if (operation.status === 'DONE') this.#running.delete(memory);
    else this.#running.set(memory, { name: operation.name, location, kind });
  }

  forget(prefix: string): void {
    for (const key of [...this.#running.keys()])
      if (key === prefix || key.startsWith(`${prefix}:`)) this.#running.delete(key);
  }

  /** Reads the remembered operation of a resource; undefined when none is remembered. */
  async poll(memory: string, signal: AbortSignal): Promise<Polled | undefined> {
    const remembered = this.#running.get(memory);
    if (!remembered) return undefined;
    let operation: GkeOperation | undefined;
    try {
      operation = await this.#client.request<GkeOperation>(
        'GET',
        remembered.location,
        `operations/${encodeURIComponent(remembered.name)}`,
        { signal, what: `Reading GKE ${remembered.kind} ${remembered.name}` },
      );
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    // An operation GKE no longer knows has long finished: re-read the resource.
    if (!operation) {
      this.#running.delete(memory);
      return { done: remembered.kind };
    }
    if (operation.status !== 'DONE') return { running: remembered.kind };
    this.#running.delete(memory);
    if (operation.error && (operation.error.code ?? 1) !== 0)
      return { failed: operationMessage(operation), kind: remembered.kind };
    return { done: remembered.kind };
  }
}
