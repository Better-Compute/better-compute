import { ComputeError, isId, type PoolPolicyValidator } from '@better-compute/core';
import { canonical } from './input.js';
import {
  acceleratorPattern,
  authorizedNetworks,
  autoscaling,
  kubernetesVersion,
  location,
  machineTypePattern,
  maxNodePoolsPerCluster,
  oneOf,
  releaseChannels,
  resource,
  zones,
} from './parse.js';
import type { KubernetesReleaseChannel } from './types.js';

// `policy.substrate` (core `KubernetesPoolSubstrate`): a pool whose machines are the nodes of a managed Kubernetes
// cluster on one of the owner's provider accounts. Parsed strictly: an unknown field, a substrate a reconciler could
// not converge, or a pool that could not take bcd's DaemonSet is INVALID_INPUT at pools.create/update.

/** A flavor as the reconciler uses it: one node pool. */
export interface SubstrateFlavor {
  name: string;
  machineType: string;
  nodes: number;
  autoscaling?: { minNodes: number; maxNodes: number };
  gpus?: { type: string; count: number };
  diskGiB?: number;
  zones?: string[];
  spot: boolean;
}

export interface SubstrateCreate {
  location: string;
  releaseChannel: KubernetesReleaseChannel;
  version?: string;
  authorizedNetworks: string[];
  privateNodes: boolean;
}

/** A parsed `policy.substrate`. */
export interface PoolSubstrate {
  kind: 'kubernetes';
  account: string;
  cluster: { create: SubstrateCreate } | { adopt: string };
  flavors: SubstrateFlavor[];
  allowSpot: boolean;
}

/** A provider cluster id to adopt: printable, no whitespace (GKE `projects/…/clusters/…`, a DOKS or EKS id). */
const adoptPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;

function refuse(message: string): never {
  throw new ComputeError('INVALID_INPUT', `policy.substrate${message}`);
}

function record(raw: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse(`${what} must be an object`);
  for (const key of Object.keys(raw as object))
    if (!allowed.includes(key)) refuse(`${what}: unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}

/** Runs a parse helper of parse.ts, prefixing its message with the field path. */
function at<T>(what: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'INVALID_INPUT')
      refuse(`${what}: ${error.message}`);
    throw error;
  }
}

function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    refuse(`${what} must be an integer from ${min} to ${max}`);
  return value as number;
}

function flag(value: unknown, what: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') refuse(`${what} must be true or false`);
  return value as boolean;
}

const flavorFields = ['name', 'machineType', 'nodes', 'autoscaling', 'gpus', 'diskGiB', 'zones', 'spot'];

function flavorOf(raw: unknown, index: number): SubstrateFlavor {
  const what = `.flavors[${index}]`;
  const input = record(raw, what, flavorFields);
  const name = at(`${what}.name`, () => resource(input.name, 'name'));
  if (typeof input.machineType !== 'string' || !machineTypePattern.test(input.machineType))
    refuse(`${what}.machineType must be a provider machine type`);
  const flavor: SubstrateFlavor = {
    name,
    machineType: input.machineType as string,
    nodes: int(input.nodes, `${what}.nodes`, 0, 1000),
    spot: flag(input.spot, `${what}.spot`),
  };
  if (input.autoscaling !== undefined)
    flavor.autoscaling = at(`${what}`, () => autoscaling(input.autoscaling, 'autoscaling'));
  if (input.gpus !== undefined) {
    const gpus = record(input.gpus, `${what}.gpus`, ['type', 'count']);
    if (typeof gpus.type !== 'string' || !acceleratorPattern.test(gpus.type))
      refuse(`${what}.gpus.type must be a provider accelerator type such as nvidia-l4`);
    flavor.gpus = { type: gpus.type as string, count: int(gpus.count, `${what}.gpus.count`, 1, 16) };
  }
  if (input.diskGiB !== undefined) flavor.diskGiB = int(input.diskGiB, `${what}.diskGiB`, 10, 65_536);
  if (input.zones !== undefined) {
    const list = at(what, () => zones(input.zones, 'zones'));
    if (list.length > 0) flavor.zones = list;
  }
  return flavor;
}

function clusterOf(raw: unknown): PoolSubstrate['cluster'] {
  const input = record(raw, '.cluster', ['create', 'adopt']);
  if ((input.create === undefined) === (input.adopt === undefined))
    refuse('.cluster must name exactly one of create or adopt');
  if (input.adopt !== undefined) {
    if (typeof input.adopt !== 'string' || !adoptPattern.test(input.adopt))
      refuse('.cluster.adopt must be the provider id of an existing cluster');
    return { adopt: input.adopt as string };
  }
  const spec = record(input.create, '.cluster.create', [
    'location',
    'releaseChannel',
    'version',
    'authorizedNetworks',
    'privateNodes',
  ]);
  const create: SubstrateCreate = {
    location: at('.cluster.create', () => location(spec.location)),
    releaseChannel:
      spec.releaseChannel === undefined
        ? 'regular'
        : at('.cluster.create', () => oneOf(spec.releaseChannel, releaseChannels, 'releaseChannel')),
    authorizedNetworks:
      spec.authorizedNetworks === undefined
        ? []
        : at('.cluster.create', () => authorizedNetworks(spec.authorizedNetworks)),
    privateNodes: flag(spec.privateNodes, '.cluster.create.privateNodes'),
  };
  if (spec.version !== undefined) create.version = at('.cluster.create', () => kubernetesVersion(spec.version));
  return { create };
}

/**
 * `policy.kubernetes` as a substrate pool needs it: present (reservations then may use `binding: 'kubernetes'`),
 * without the `k8s-join` settings (bcd runs inside the cluster), and GPUs through bcd's device plugin only.
 */
function checkKubernetesPolicy(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ComputeError(
      'INVALID_INPUT',
      'policy.substrate needs policy.kubernetes (an object, e.g. {}): the nodes join a Kubernetes cluster',
    );
  const kubernetes = raw as Record<string, unknown>;
  if (['apiServer', 'caCertSha256', 'joinTokenRef'].some((key) => kubernetes[key] !== undefined))
    throw new ComputeError(
      'INVALID_INPUT',
      'policy.substrate runs bcd inside the cluster: policy.kubernetes takes none of the k8s-join settings (apiServer, caCertSha256, joinTokenRef)',
    );
  if (kubernetes.gpuApi !== undefined && kubernetes.gpuApi !== 'device-plugin')
    throw new ComputeError(
      'INVALID_INPUT',
      "policy.substrate books GPUs through bcd's device plugin only: policy.kubernetes.gpuApi must be device-plugin",
    );
}

/** The substrate of a pool policy, checked; undefined when the policy has none. */
export function parsePoolSubstrate(policy: Readonly<Record<string, unknown>>): PoolSubstrate | undefined {
  if (policy.substrate === undefined) return undefined;
  const input = record(policy.substrate, '', ['kind', 'account', 'cluster', 'flavors', 'allowSpot']);
  if (input.kind !== 'kubernetes') refuse('.kind must be kubernetes');
  if (!isId(input.account, 'pacct')) refuse('.account must be a provider account id (pacct_…)');
  const cluster = clusterOf(input.cluster);
  if (input.flavors !== undefined && !Array.isArray(input.flavors)) refuse('.flavors must be a list');
  const list = (input.flavors as unknown[] | undefined) ?? [];
  if (list.length > maxNodePoolsPerCluster) refuse(`.flavors lists at most ${maxNodePoolsPerCluster} flavors`);
  const flavors = list.map(flavorOf);
  const names = new Set<string>();
  for (const flavor of flavors) {
    if (names.has(flavor.name)) refuse(`.flavors names ${flavor.name} twice`);
    names.add(flavor.name);
  }
  if ('create' in cluster && flavors.length === 0)
    refuse('.flavors: a created cluster needs at least one flavor (its first node pool)');
  const allowSpot = flag(input.allowSpot, '.allowSpot');
  for (const flavor of flavors)
    if (flavor.spot && !allowSpot) refuse(`.flavors: ${flavor.name} asks for Spot nodes; set allowSpot`);
  checkKubernetesPolicy(policy.kubernetes);
  return { kind: 'kubernetes', account: input.account as string, cluster, flavors, allowSpot };
}

/**
 * What a substrate is, as opposed to how it is sized: the account, and the cluster (created where, with private
 * nodes or not; or adopted, by id). A change of it is never converged in place (K-D8).
 */
export function substrateIdentity(substrate: PoolSubstrate): string {
  return canonical(
    'create' in substrate.cluster
      ? {
          account: substrate.account,
          mode: 'create',
          location: substrate.cluster.create.location,
          privateNodes: substrate.cluster.create.privateNodes,
        }
      : { account: substrate.account, mode: 'adopt', adopt: substrate.cluster.adopt },
  );
}

/** `pools.create` / `pools.update` refuse a substrate the module could not converge. */
export const substratePolicyValidator: PoolPolicyValidator = Object.freeze({
  extension: 'pool-policy' as const,
  id: 'kubernetes.substrate',
  async validate(policy: Readonly<Record<string, unknown>>, pool: { class: string; sharing?: string }) {
    if (policy.substrate === undefined) return;
    if (pool.class === 'provider')
      throw new ComputeError(
        'INVALID_INPUT',
        "policy.substrate: a provider pool's machines run no daemon; a substrate pool runs bcd (class metal-host or vps-host)",
      );
    parsePoolSubstrate(policy);
  },
});
