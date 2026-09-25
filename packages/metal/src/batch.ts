import {
  ComputeError,
  provisionStateTable,
  type ProfileDocument,
  type ProvisionState,
  type ProvisionVerb,
  type RegistryView,
  type SqlTx,
} from '@better-compute/core';
import { profileCommandKinds, type StepRegistry } from '@better-compute/provision';
import { stateProfile, workflowStates } from './profiles.js';
import type { MetalNodeRow } from './store.js';

// The approval scope of a metal batch (PLAN.md §13, the v1.0 quorum): one leaf per (subject, kind)
// for the destructive kinds its workflows can send. The subject is what the executing agent checks
// from the signed command body: the node itself for work it runs on itself (disk.wipe, deploy.image,
// boot.kexec, node.reboot, gpu.reset), the BMC address (`bmc:<address>`) for BMC operations a site
// agent relays, the target node (`node:<id>`) for site.httpProxy. A site agent can then only act
// on the machines the operators approved, not on every machine it reaches.

/** One leaf of a batch's approval scope. */
export interface BatchLeaf {
  subject: string;
  kind: string;
}

/**
 * The workflow states a verb runs a node through: its first state, then each `complete` while that
 * state runs a workflow too (enrolling → inspecting → commissioning). Empty when the verb starts no
 * workflow; `INVALID_STATE` when the node's state does not allow it.
 */
export function verbChain(from: ProvisionState, verb: ProvisionVerb): ProvisionState[] {
  const transitions = provisionStateTable.transitions as Partial<Record<ProvisionState, Partial<Record<ProvisionVerb, ProvisionState>>>>;
  const first = transitions[from]?.[verb];
  if (!first) throw new ComputeError('INVALID_STATE', `A ${from} node cannot ${verb}`);
  return stateChain(first);
}

/** `first` and each state its `complete` leads to while that state runs a workflow too. */
export function stateChain(first: ProvisionState): ProvisionState[] {
  const transitions = provisionStateTable.transitions as Partial<Record<ProvisionState, Partial<Record<ProvisionVerb, ProvisionState>>>>;
  const chain: ProvisionState[] = [];
  for (let state: ProvisionState | undefined = first; state && workflowStates.includes(state) && chain.length < 8; state = transitions[state]?.complete)
    chain.push(state);
  return chain;
}

/** The profiles a verb runs `node` through (see `verbChain`); a state no profile serves is skipped. */
export function verbProfiles(node: Pick<MetalNodeRow, 'provision_state' | 'pool_agent' | 'tenant_root'>, verb: ProvisionVerb): ProfileDocument[] {
  return verbChain(node.provision_state, verb).flatMap((state) => stateProfile(state, node.pool_agent, { tenantRoot: node.tenant_root }) ?? []);
}

/**
 * The approval scope of `verb` over `nodes` (metal.bulk): every destructive kind the verb's chain of
 * profiles can send, per node, as `metalBatchScope` leaves.
 */
export async function verbBatchScope(
  tx: SqlTx,
  registry: Pick<RegistryView, 'commandKind'>,
  steps: StepRegistry,
  nodes: readonly Pick<MetalNodeRow, 'node_id' | 'provision_state' | 'pool_agent' | 'tenant_root'>[],
  verb: ProvisionVerb,
): Promise<BatchLeaf[]> {
  const leaves = new Map<string, BatchLeaf>();
  const kindsOf = new Map<string, string[]>();
  for (const node of nodes) {
    const kinds = new Set<string>();
    for (const profile of verbProfiles(node, verb)) {
      const key = `${profile.id}@${profile.version}`;
      if (!kindsOf.has(key)) kindsOf.set(key, await profileCommandKinds(profile, steps));
      for (const kind of kindsOf.get(key)!) kinds.add(kind);
    }
    for (const leaf of await metalBatchScope(tx, registry, [node.node_id], [...kinds])) leaves.set(`${leaf.subject}\u0000${leaf.kind}`, leaf);
  }
  return sortLeaves([...leaves.values()]);
}

const sortLeaves = (leaves: BatchLeaf[]) =>
  leaves.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

/**
 * The subject an agent checks for `kind` sent about `node` (pki's batchSubject, from the body): the
 * relaying site agent and the BMC address for bmc.* kinds (BMC addresses are site-local), the target
 * node for site.httpProxy, else the node itself.
 */
export function batchSubject(kind: string, node: { nodeId: string; bmcAddress: string }, siteAgent?: string): string {
  if (kind.startsWith('bmc.')) {
    if (!siteAgent) throw new ComputeError('INVALID_INPUT', `${kind} for ${node.nodeId}: no site agent to relay it`);
    return `bmc:${siteAgent}/${node.bmcAddress}`;
  }
  if (kind === 'site.httpProxy') return `node:${node.nodeId}`;
  return node.nodeId;
}

/**
 * The scope of a batch over `nodeIds` running workflows that can send `kinds` (from
 * `profileCommandKinds`): the destructive ones only (the quorum holds nothing else), per node,
 * sorted and without duplicates. A BMC kind gets one leaf per site agent of the node's site, since a
 * site agent failover reroutes the command (`awaitCommand` `reroutable`). Payloads are left unbound:
 * the workflow builds them later. Every node must be a metal node.
 */
export async function metalBatchScope(
  tx: SqlTx,
  registry: Pick<RegistryView, 'commandKind'>,
  nodeIds: readonly string[],
  kinds: readonly string[],
): Promise<BatchLeaf[]> {
  const destructive = kinds.filter((kind) => registry.commandKind(kind)?.destructive === true);
  const { rows } = await tx.query<{ node_id: string; bmc_address: string; agents: string[] | null }>(
    `SELECT m.node_id, m.bmc_address,
            (SELECT array_agg(agent.id ORDER BY agent.id) FROM nodes agent
              WHERE agent.site_id = n.site_id AND agent.role = 'site' AND agent.deleted_at IS NULL) AS agents
       FROM metal_nodes m JOIN nodes n ON n.id = m.node_id WHERE m.node_id = ANY($1::text[])`,
    [[...nodeIds]],
  );
  const known = new Map(rows.map((row) => [row.node_id, row]));
  const missing = nodeIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new ComputeError('NOT_FOUND', `Not metal nodes: ${missing.slice(0, 10).join(', ')}`);
  const leaves = new Map<string, BatchLeaf>();
  const add = (leaf: BatchLeaf) => leaves.set(`${leaf.subject}\u0000${leaf.kind}`, leaf);
  for (const nodeId of nodeIds) {
    const row = known.get(nodeId)!;
    const node = { nodeId, bmcAddress: row.bmc_address };
    for (const kind of destructive) {
      if (!kind.startsWith('bmc.')) add({ subject: batchSubject(kind, node), kind });
      else for (const agent of row.agents ?? []) add({ subject: batchSubject(kind, node, agent), kind });
    }
  }
  return sortLeaves([...leaves.values()]);
}
