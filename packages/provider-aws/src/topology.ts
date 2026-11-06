import {
  isComputeError,
  type Clock,
  type ExternalMachine,
  type Logger,
} from '@better-compute/core';
import type { QueryParams, XmlElement } from '@better-compute/aws-core';

// The network topology of an EC2 instance (AWS A10): DescribeInstanceTopology names the three
// network nodes above it, top to bottom. They become the labels `topology.aws/network-node-1..3`,
// so gang placement can prefer machines under the same nodes. The read covers the EFA instance
// families only, so only running EFA-capable machines are asked about; a failed read leaves the
// labels out (they are a preference, never a fact anything relies on).

export const topologyLabelPrefix = 'topology.aws/network-node-';
const ttlMs = 3_600_000;
const nodeId = /^nn-[0-9a-f]{1,32}$/;

type Call = (action: string, params: QueryParams, signal: AbortSignal) => Promise<XmlElement>;

/** Tags never pose as topology labels: drops every `topology.aws/network-node-*` label. */
export function withoutTopology(labels: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels))
    if (!key.startsWith(topologyLabelPrefix)) out[key] = value;
  return out;
}

export class InstanceTopology {
  readonly #cache = new Map<string, { nodes: readonly string[] | undefined; at: number }>();
  #warned = false;

  constructor(
    private readonly call: Call,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** The machine with its topology labels (and no tag posing as one). */
  async label(machine: ExternalMachine, signal: AbortSignal): Promise<ExternalMachine> {
    const labels = withoutTopology(machine.labels ?? {});
    const nodes = await this.#nodes(machine.id, signal);
    nodes?.forEach((node, index) => {
      labels[`${topologyLabelPrefix}${index + 1}`] = node;
    });
    return { ...machine, labels };
  }

  async #nodes(id: string, signal: AbortSignal): Promise<readonly string[] | undefined> {
    const now = this.clock.now();
    const hit = this.#cache.get(id);
    if (hit && now - hit.at < ttlMs) return hit.nodes;
    let nodes: string[] | undefined;
    try {
      const doc = await this.call('DescribeInstanceTopology', { InstanceId: [id] }, signal);
      const item = doc.items('instanceSet').find((entry) => entry.textOf('instanceId') === id);
      const read = item?.items('networkNodeSet').map((node) => node.text ?? '');
      // Every node or none: a malformed answer is no topology.
      nodes = read && read.length > 0 && read.every((node) => nodeId.test(node)) ? read : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      if (!this.#warned) {
        this.#warned = true;
        this.log.warn('aws: instance topology unreadable; machines go without its labels', {
          provider: 'aws',
          reason: isComputeError(error) ? error.code : 'error',
        });
      }
    }
    this.#cache.set(id, { nodes, at: now });
    if (this.#cache.size > 10_000) this.#cache.delete(this.#cache.keys().next().value!);
    return nodes;
  }
}
