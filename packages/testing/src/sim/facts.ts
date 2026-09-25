import type { DaemonFact, FactSink } from '../daemon/facts.js';
import type { ExecutionFact, JournalLossFact, NodeBinding } from './invariants.js';

/**
 * Collects FakeDaemon facts (the ground truth of what nodes did) into the rows the invariant
 * checkers take: executions (I2), journal losses (I2) and node bindings (I1).
 */
export class FleetFacts implements FactSink {
  readonly executions: ExecutionFact[] = [];
  readonly journalLosses: JournalLossFact[] = [];
  /** Every CDI hold interval; `to` is unset while still bound. */
  readonly bindings: NodeBinding[] = [];
  /** Process starts and stops. */
  readonly processes: Extract<DaemonFact, { type: 'process.started' | 'process.stopped' }>[] = [];
  /** I4 ground truth: per node, when a gateway received one of its frames (sim time, ascending). */
  readonly heard = new Map<string, number[]>();
  private readonly open = new Map<string, NodeBinding>();

  /** A gateway received a frame from `nodeId` at `at` (called by the simulator's links). */
  heardFrom(nodeId: string, at: number): void {
    const times = this.heard.get(nodeId);
    if (!times) this.heard.set(nodeId, [at]);
    // One entry per instant is enough; frames arrive in time order.
    else if (times.at(-1) !== at) times.push(at);
  }

  record(fact: DaemonFact): void {
    switch (fact.type) {
      case 'command.accepted':
      case 'execution.started':
      case 'execution.ended': {
        const { type, ...identity } = fact;
        const phase =
          type === 'command.accepted'
            ? 'accepted'
            : type === 'execution.started'
              ? 'started'
              : 'ended';
        const row: ExecutionFact = {
          phase,
          at: identity.at,
          nodeId: identity.nodeId,
          commandId: identity.commandId,
          kind: identity.kind,
          retrySafe: identity.retrySafe,
          selfTerminating: identity.selfTerminating,
          journalId: identity.journalId,
          incarnation: identity.incarnation,
          bootId: identity.bootId,
        };
        if (fact.type === 'execution.ended') row.outcome = fact.outcome;
        this.executions.push(row);
        return;
      }
      case 'allocation.bound': {
        const key = `${fact.nodeId}/${fact.allocationId}`;
        const previous = this.open.get(key);
        if (previous) previous.to = fact.at;
        const binding: NodeBinding = {
          nodeId: fact.nodeId,
          allocationId: fact.allocationId,
          deviceIds: [...fact.deviceIds],
          from: fact.at,
        };
        this.bindings.push(binding);
        this.open.set(key, binding);
        return;
      }
      case 'allocation.unbound': {
        const key = `${fact.nodeId}/${fact.allocationId}`;
        const binding = this.open.get(key);
        if (binding) binding.to = fact.at;
        this.open.delete(key);
        return;
      }
      case 'journal.lost':
        this.journalLosses.push({
          nodeId: fact.nodeId,
          at: fact.at,
          oldJournalId: fact.oldJournalId,
          newJournalId: fact.newJournalId,
        });
        return;
      case 'process.started':
      case 'process.stopped':
        this.processes.push(fact);
        return;
    }
  }

  /** Side effects started per command id. */
  startsPerCommand(): Map<string, number> {
    const out = new Map<string, number>();
    for (const fact of this.executions)
      if (fact.phase === 'started') out.set(fact.commandId, (out.get(fact.commandId) ?? 0) + 1);
    return out;
  }
}
