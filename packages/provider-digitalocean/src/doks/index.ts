import {
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
  type KubernetesNodePoolSpec,
  type KubernetesVersions,
  type ProviderKubernetes,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoConfig } from '../config.js';
import { checkRegion, fail } from './common.js';
import { httpsKubeTransport, type KubeTransport } from './transport.js';
import { readVersions } from './versions.js';

export { parseClusterId as parseDoksClusterId } from './common.js';
export { compareDoksVersion, parseDoksVersion } from './versions.js';
export {
  httpsKubeTransport,
  type KubeRequest,
  type KubeResponse,
  type KubeTransport,
} from './transport.js';
export type * from './types.js';

// Managed Kubernetes on DigitalOcean Kubernetes (DOKS), over API v2.
//
// Like the networks, every ensure*/delete* call is non-blocking: it reads the resource, starts at
// most one change, and answers `pending`, `updating` or `deleting` while DOKS works. DOKS has no
// operations: the cluster's and its nodes' own states say when a change is done. Nothing is
// persisted beyond a name → uuid cache: after a restart a call re-reads the resources.

export interface DoKubernetesOptions {
  client: DoClient;
  config: DoConfig;
  /** Trust-domain string: hashed into the deployment tag the clusters carry. */
  deployment: string;
  kubeTransport?: KubeTransport;
}

export class DoKubernetes implements ProviderKubernetes {
  readonly #client: DoClient;
  readonly #config: DoConfig;
  readonly #transport: KubeTransport;

  constructor(options: DoKubernetesOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#transport = options.kubeTransport ?? httpsKubeTransport;
  }

  #notYet(): never {
    throw fail('UNSUPPORTED', 'DOKS clusters are not supported yet', 'notYet');
  }

  ensureCluster(
    _spec: KubernetesClusterSpec,
    _context: CallContext,
  ): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  getCluster(_cluster: string, _context: CallContext): Promise<ProviderResourceState | undefined> {
    return Promise.resolve(this.#notYet());
  }

  deleteCluster(_cluster: string, _context: CallContext): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  ensureNodePool(
    _cluster: string,
    _spec: KubernetesNodePoolSpec,
    _context: CallContext,
  ): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  deleteNodePool(
    _cluster: string,
    _name: string,
    _context: CallContext,
  ): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  credentials(
    _cluster: string,
    _request: KubernetesCredentialRequest,
    _context: CallContext,
  ): Promise<KubernetesCredentials> {
    void this.#transport;
    return Promise.resolve(this.#notYet());
  }

  async versions(location: string, context: CallContext): Promise<KubernetesVersions> {
    checkRegion(location, this.#config.regions);
    return readVersions(this.#client, context.signal);
  }
}
