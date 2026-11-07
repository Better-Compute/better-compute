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
// families only, so only running EFA-capable machines are asked about, up to 100 in one read (get,
// list and discover all label the same way). A failed read leaves the labels out (they are a
// preference, never a fact anything relies on) and is asked again after a minute, or after the
// hour when the account may not read topology at all.

export const topologyLabelPrefix = 'topology.aws/network-node-';
const ttlMs = 3_600_000;
/** A failed read (throttled, unavailable) is asked again after this long. */
const failedTtlMs = 60_000;
/** Failures no retry within the hour fixes: the account may not read topology. */
const lastingFailures: ReadonlySet<string> = new Set([
  'ACCESS_DENIED',
  'UNAUTHENTICATED',
  'UNSUPPORTED',
]);
/** DescribeInstanceTopology takes this many instance ids at once. */
const perRead = 100;
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
  readonly #cache = new Map<string, { nodes: readonly string[] | undefined; until: number }>();
  #warned = false;

  constructor(
    private readonly call: Call,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** The machine with its topology labels (and no tag posing as one). */
  async label(machine: ExternalMachine, signal: AbortSignal): Promise<ExternalMachine> {
    return (await this.labelAll([machine], signal))[0]!;
  }

  /** Every machine with its topology labels; the ones not cached are read together. */
  async labelAll(
    machines: readonly ExternalMachine[],
    signal: AbortSignal,
  ): Promise<ExternalMachine[]> {
    const now = this.clock.now();
    const stale = [
      ...new Set(
        machines
          .map((machine) => machine.id)
          .filter((id) => (this.#cache.get(id)?.until ?? 0) <= now),
      ),
    ];
    for (let at = 0; at < stale.length; at += perRead)
      await this.#read(stale.slice(at, at + perRead), now, signal);
    return machines.map((machine) => {
      const labels = withoutTopology(machine.labels ?? {});
      this.#cache.get(machine.id)?.nodes?.forEach((node, index) => {
        labels[`${topologyLabelPrefix}${index + 1}`] = node;
      });
      return { ...machine, labels };
    });
  }

  async #read(ids: readonly string[], now: number, signal: AbortSignal): Promise<void> {
    let answer: Map<string, string[] | undefined>;
    try {
      const doc = await this.call('DescribeInstanceTopology', { InstanceId: [...ids] }, signal);
      answer = new Map(
        doc.items('instanceSet').map((entry) => {
          const read = entry.items('networkNodeSet').map((node) => node.text ?? '');
          // Every node or none: a malformed answer is no topology.
          return [
            entry.textOf('instanceId') ?? '',
            read.length > 0 && read.every((node) => nodeId.test(node)) ? read : undefined,
          ];
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const code = isComputeError(error) ? error.code : 'error';
      if (!this.#warned) {
        this.#warned = true;
        this.log.warn('aws: instance topology unreadable; machines go without its labels', {
          provider: 'aws',
          reason: code,
        });
      }
      const until = now + (lastingFailures.has(code) ? ttlMs : failedTtlMs);
      for (const id of ids) this.#set(id, { nodes: undefined, until });
      return;
    }
    for (const id of ids) this.#set(id, { nodes: answer.get(id), until: now + ttlMs });
  }

  #set(id: string, entry: { nodes: readonly string[] | undefined; until: number }): void {
    this.#cache.delete(id);
    this.#cache.set(id, entry);
    if (this.#cache.size > 10_000) this.#cache.delete(this.#cache.keys().next().value!);
  }
}
