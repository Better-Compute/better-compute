import type { Outcome } from './journal.js';

/** Who ran a command, as a FakeDaemon reports it to the fact sink (the simulator's ground truth). */
export interface ExecutionIdentity {
  /** Scheduler (sim) time of the fact. */
  at: number;
  nodeId: string;
  commandId: string;
  kind: string;
  /** Flags of the CommandBody that was accepted. */
  retrySafe: boolean;
  selfTerminating: boolean;
  journalId: string;
  incarnation: string;
  bootId: string;
}

/**
 * What really happened on a fake node, recorded as it happens and independent of any frame getting
 * through: the facts the invariant checkers (I1, I2, I5) run over.
 */
export type DaemonFact =
  /** `accepted` was journaled (before any side effect). */
  | ({ type: 'command.accepted' } & ExecutionIdentity)
  /** The side effect started (`running{boot_id}` journaled). */
  | ({ type: 'execution.started' } & ExecutionIdentity)
  /** The side effect finished and its result was journaled. */
  | ({ type: 'execution.ended'; outcome: Outcome; rebooted: boolean } & ExecutionIdentity)
  /** The CDI hold for an allocation was written (the devices are bound on the node). */
  | {
      type: 'allocation.bound' | 'allocation.unbound';
      at: number;
      nodeId: string;
      allocationId: string;
      deviceIds: string[];
      generation: number;
    }
  /**
   * A Kubernetes-bound hold's devices were offered to the node's kubelet (bcd's device plugin or DRA
   * slice), or withdrawn: withdrawn at the release, while pods may keep them (knobs.kubePodReleaseMs).
   */
  | {
      type: 'kube.advertised' | 'kube.withdrawn';
      at: number;
      nodeId: string;
      allocationId: string;
      deviceIds: string[];
    }
  /** The journal was lost and a new one (new journal_id) started. */
  | { type: 'journal.lost'; at: number; nodeId: string; oldJournalId: string; newJournalId: string }
  /** A daemon process started or died. */
  | {
      type: 'process.started' | 'process.stopped';
      at: number;
      nodeId: string;
      bootId: string;
      incarnation: string;
      reason: string;
    };

/** Receives a FakeDaemon's facts. */
export interface FactSink {
  record(fact: DaemonFact): void;
}
