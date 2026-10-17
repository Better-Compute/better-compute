import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ProviderFirewallSpec,
  type ProviderNetworks,
  type ProviderNetworkSpec,
  type ProviderNetworkState,
  type ProviderSubnetSpec,
} from '@better-compute/core';
import {
  getOperation,
  operationFailure,
  waitForOperation,
  type GceClient,
  type GceOperation,
} from './client.js';
import type { GcpProviderOptions } from './config.js';
import { labels, parseMachineId, requestIdFor } from './ids.js';
import type { GceInstance } from './shapes.js';

// Tenant networking on Compute Engine: custom-mode VPC networks, subnets, firewall rules, and the
// network tags on instances. Names (and tags) come from the vps layer and are used as given.
//
// Every ensure*/delete* call is non-blocking. It starts the operation if the resource is not as
// wanted, reads that operation once, and answers `pending` (`deleting`) while it runs. The
// operation is remembered in memory, so the next call polls it first and then re-reads the
// resource; nothing is persisted, so a restart simply re-reads the resource.

type Kind = 'net' | 'subnet' | 'fw';

interface GceNetwork {
  name: string;
}

interface GceSubnetwork {
  name: string;
  ipCidrRange?: string;
  network?: string;
  privateIpGoogleAccess?: boolean;
}

interface GceFirewall {
  name: string;
  network?: string;
  direction?: string;
  priority?: number;
  allowed?: { IPProtocol: string; ports?: string[] }[];
  denied?: { IPProtocol: string; ports?: string[] }[];
  sourceRanges?: string[];
  destinationRanges?: string[];
  targetTags?: string[];
  disabled?: boolean;
}

const managedTagPrefix = 'bc-';
const tagPattern = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const instanceWaitMs = 20_000;

const state = (id: string, value: ProviderNetworkState['state'], message?: string) =>
  ({ id, state: value, ...(message !== undefined ? { message } : {}) }) as ProviderNetworkState;

function failureMessage(operation: GceOperation): string {
  return (
    operation.error?.errors?.[0]?.message ??
    operation.httpErrorMessage ??
    operation.error?.errors?.[0]?.code ??
    'The operation failed'
  );
}

function lastSegment(value: string | undefined): string {
  return (value ?? '').split('/').pop() ?? '';
}

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

function rules(list: { IPProtocol: string; ports?: readonly string[] }[] | undefined): string {
  return JSON.stringify(
    (list ?? [])
      .map((rule) => ({ p: rule.IPProtocol, ports: sorted(rule.ports) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** The comparable form of a firewall: what this provider manages, as GCE returns it. */
function comparable(rule: GceFirewall): string {
  return JSON.stringify({
    network: lastSegment(rule.network),
    direction: rule.direction ?? 'INGRESS',
    priority: rule.priority ?? 1000,
    allowed: rules(rule.allowed),
    denied: rules(rule.denied),
    sourceRanges: sorted(rule.sourceRanges),
    destinationRanges: sorted(rule.destinationRanges),
    targetTags: sorted(rule.targetTags),
    disabled: rule.disabled === true,
  });
}

export class GcpNetworks implements ProviderNetworks {
  readonly #client: GceClient;
  readonly #options: GcpProviderOptions;
  readonly #running = new Map<string, GceOperation>();
  readonly #failures = new Map<string, number>();

  constructor(client: GceClient, options: GcpProviderOptions) {
    this.#client = client;
    this.#options = options;
  }

  // -------------------------------------------------------------------------------- plumbing

  /** `requestId` for a create; varies after a failure seen by this process, so a retry is not deduplicated into the failed operation. */
  #requestId(kind: Kind, key: string): string {
    const failures = this.#failures.get(`${kind}:${key}`) ?? 0;
    return requestIdFor(`${kind}:${key}${failures ? `:${failures}` : ''}`);
  }

  /**
   * Polls the operation remembered for this resource. `running`: it has not finished; `failed`: it
   * finished with an error (and is forgotten); `done`: it succeeded; undefined: nothing remembered.
   */
  async #poll(
    memory: string,
    signal: AbortSignal,
  ): Promise<{ running: true } | { failed: GceOperation } | { done: true } | undefined> {
    const remembered = this.#running.get(memory);
    if (!remembered) return undefined;
    return (
      this.#settle(memory, await getOperation(this.#client, remembered, signal)) ?? { done: true }
    );
  }

  /** Remembers a running operation, forgets a finished one. */
  #settle(
    memory: string,
    operation: GceOperation,
  ): { running: true } | { failed: GceOperation } | undefined {
    if (operation.status !== 'DONE') {
      this.#running.set(memory, operation);
      return { running: true };
    }
    this.#running.delete(memory);
    if (operation.error) {
      this.#failures.set(memory, (this.#failures.get(memory) ?? 0) + 1);
      return { failed: operation };
    }
    this.#failures.delete(memory);
    return undefined;
  }

  /** Starts a mutation and reads its operation once. */
  async #start(
    memory: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { body?: unknown; requestId?: string; signal: AbortSignal },
  ): Promise<{ running: true } | { failed: GceOperation } | undefined> {
    const operation = await this.#client.request<GceOperation>(method, path, {
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.requestId ? { query: { requestId: options.requestId } } : {}),
      signal: options.signal,
    });
    const first = this.#settle(memory, operation);
    if (first && 'failed' in first) return first;
    if (operation.status === 'DONE') return first;
    return this.#settle(memory, await getOperation(this.#client, operation, options.signal));
  }

  async #find<T>(path: string, signal: AbortSignal): Promise<T | undefined> {
    try {
      return await this.#client.request<T>('GET', path, { signal });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /**
   * The shared ensure flow: poll what is running, read the resource, create it if absent, and map
   * the outcome. `reconcile` decides what to do with a resource that exists.
   */
  async #ensure<T>(
    kind: Kind,
    id: string,
    path: string,
    create: { path: string; body: unknown },
    reconcile: (found: T) => Promise<ProviderNetworkState | undefined>,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    const memory = `${kind}:${id}`;
    const running = await this.#poll(memory, signal);
    if (running && 'running' in running) return state(id, 'pending');
    if (running && 'failed' in running) return state(id, 'error', failureMessage(running.failed));
    const found = await this.#find<T>(path, signal);
    if (found) return (await reconcile(found)) ?? state(id, 'ready');
    try {
      const started = await this.#start(memory, 'POST', create.path, {
        body: create.body,
        requestId: this.#requestId(kind, id),
        signal,
      });
      if (started && 'running' in started) return state(id, 'pending');
      if (started) return state(id, 'error', failureMessage(started.failed));
      return state(id, 'ready');
    } catch (error) {
      // Lost a race with another creator: the resource is there now.
      if (isComputeError(error, 'CONFLICT')) return state(id, 'pending');
      throw error;
    }
  }

  /** The shared delete flow. */
  async #delete(
    kind: Kind,
    id: string,
    path: string,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    const memory = `${kind}:${id}:delete`;
    const running = await this.#poll(memory, signal);
    if (running && 'running' in running) return state(id, 'deleting');
    if (running && 'done' in running) return state(id, 'deleted');
    if (running) {
      const failure = operationFailure(running.failed);
      if (failure?.code === 'INVALID_STATE') return state(id, 'pending', failure.message);
      return state(id, 'error', failureMessage(running.failed));
    }
    try {
      const started = await this.#start(memory, 'DELETE', path, { signal });
      if (started && 'running' in started) return state(id, 'deleting');
      if (started) {
        const failure = operationFailure(started.failed);
        if (failure?.code === 'INVALID_STATE') return state(id, 'pending', failure.message);
        if (failure?.code === 'NOT_FOUND') return state(id, 'deleted');
        return state(id, 'error', failureMessage(started.failed));
      }
      return state(id, 'deleted');
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return state(id, 'deleted');
      // Still referenced (by subnets, instances or routes): not an error, try again later.
      if (isComputeError(error, 'INVALID_STATE')) return state(id, 'pending', error.message);
      throw error;
    }
  }

  // ----------------------------------------------------------------------------------- ensure

  async ensureNetwork(
    spec: ProviderNetworkSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    return this.#ensure<GceNetwork>(
      'net',
      spec.name,
      `/global/networks/${spec.name}`,
      {
        path: '/global/networks',
        body: {
          name: spec.name,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: 'REGIONAL' },
          ...(spec.mtu !== undefined ? { mtu: spec.mtu } : {}),
        },
      },
      async () => undefined,
      context.signal,
    );
  }

  async ensureSubnet(
    spec: ProviderSubnetSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const id = `${spec.region}/${spec.name}`;
    return this.#ensure<GceSubnetwork>(
      'subnet',
      id,
      `/regions/${spec.region}/subnetworks/${spec.name}`,
      {
        path: `/regions/${spec.region}/subnetworks`,
        body: {
          name: spec.name,
          network: `global/networks/${spec.network}`,
          ipCidrRange: spec.cidr,
          privateIpGoogleAccess: spec.privateGoogleAccess === true,
        },
      },
      async (found) =>
        found.ipCidrRange !== undefined && found.ipCidrRange !== spec.cidr
          ? state(
              id,
              'error',
              `Subnetwork ${spec.name} exists with range ${found.ipCidrRange}, not ${spec.cidr}`,
            )
          : undefined,
      context.signal,
    );
  }

  async ensureFirewall(
    spec: ProviderFirewallSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const body = this.#firewallBody(spec);
    const path = `/global/firewalls/${spec.name}`;
    return this.#ensure<GceFirewall>(
      'fw',
      spec.name,
      path,
      { path: '/global/firewalls', body },
      async (found) => {
        if (comparable(found) === comparable(body)) return undefined;
        if (
          (spec.action === 'allow') !==
          (found.allowed !== undefined && found.denied === undefined)
        )
          return state(
            spec.name,
            'error',
            `Firewall rule ${spec.name} exists with the opposite action; delete it to change allow to deny`,
          );
        const started = await this.#start(`fw:${spec.name}`, 'PATCH', path, {
          body,
          signal: context.signal,
        });
        if (started && 'running' in started) return state(spec.name, 'pending');
        if (started) return state(spec.name, 'error', failureMessage(started.failed));
        return undefined;
      },
      context.signal,
    );
  }

  #firewallBody(spec: ProviderFirewallSpec): GceFirewall & Record<string, unknown> {
    const entries = spec.rules.map((rule) => ({
      IPProtocol: rule.protocol,
      ...(rule.ports?.length ? { ports: [...rule.ports] } : {}),
    }));
    return {
      name: spec.name,
      network: `global/networks/${spec.network}`,
      direction: spec.direction === 'egress' ? 'EGRESS' : 'INGRESS',
      priority: spec.priority,
      ...(spec.action === 'allow' ? { allowed: entries } : { denied: entries }),
      ...(spec.sources ? { sourceRanges: [...spec.sources] } : {}),
      ...(spec.destinations ? { destinationRanges: [...spec.destinations] } : {}),
      ...(spec.targetTags ? { targetTags: [...spec.targetTags] } : {}),
      disabled: spec.disabled === true,
    };
  }

  // ----------------------------------------------------------------------------------- delete

  deleteNetwork(name: string, context: CallContext): Promise<ProviderNetworkState> {
    return this.#delete('net', name, `/global/networks/${name}`, context.signal);
  }

  deleteSubnet(region: string, name: string, context: CallContext): Promise<ProviderNetworkState> {
    return this.#delete(
      'subnet',
      `${region}/${name}`,
      `/regions/${region}/subnetworks/${name}`,
      context.signal,
    );
  }

  deleteFirewall(name: string, context: CallContext): Promise<ProviderNetworkState> {
    return this.#delete('fw', name, `/global/firewalls/${name}`, context.signal);
  }

  // ------------------------------------------------------------------------------------ tags

  async setTags(machineId: string, tags: readonly string[], context: CallContext): Promise<void> {
    for (const tag of tags)
      if (!tag.startsWith(managedTagPrefix) || !tagPattern.test(tag))
        throw new ComputeError(
          'INVALID_INPUT',
          `${JSON.stringify(tag)} is not a managed network tag (bc- and GCE tag characters)`,
        );
    const { zone, name } = parseMachineId(machineId);
    const path = `/zones/${zone}/instances/${name}`;
    for (let attempt = 0; ; attempt++) {
      const instance = await this.#client.request<GceInstance>('GET', path, {
        signal: context.signal,
      });
      if (!instance.labels?.[labels.instance])
        throw new ComputeError(
          'INVALID_STATE',
          `${machineId} is not an instance of better-compute; its tags are not touched`,
          undefined,
          { provider: 'gcp', reason: 'notAttached' },
        );
      const current = instance.tags?.items ?? [];
      const items = [
        ...current.filter((tag) => !tag.startsWith(managedTagPrefix)),
        ...new Set(tags),
      ];
      if (JSON.stringify(sorted(items)) === JSON.stringify(sorted(current))) return;
      try {
        const operation = await this.#client.request<GceOperation>('POST', `${path}/setTags`, {
          body: { items, fingerprint: instance.tags?.fingerprint },
          signal: context.signal,
        });
        const done = await waitForOperation(this.#client, operation, {
          signal: context.signal,
          pollMs: this.#options.operationPollMs ?? 2000,
          maxMs: instanceWaitMs,
          what: `Tagging ${machineId}`,
        });
        if (done.status !== 'DONE')
          throw new ComputeError(
            'UNAVAILABLE',
            `Tagging ${machineId} has not finished yet`,
            undefined,
            {
              provider: 'gcp',
              reason: 'operationRunning',
              retryAfterMs: 5000,
            },
          );
        return;
      } catch (error) {
        if (!isComputeError(error) || error.details?.status !== 412) throw error;
        if (attempt > 0)
          throw new ComputeError('CONFLICT', `The tags of ${machineId} keep changing`, undefined, {
            provider: 'gcp',
            status: 412,
            reason: 'conditionNotMet',
          });
      }
    }
  }
}
