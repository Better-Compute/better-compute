import { ComputeError, type RegistryView, type SqlTx } from '@better-compute/core';

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

/** The subject an agent checks for `kind` sent about `node`. */
export function batchSubject(kind: string, node: { nodeId: string; bmcAddress: string }): string {
  if (kind.startsWith('bmc.')) return `bmc:${node.bmcAddress}`;
  if (kind === 'site.httpProxy') return `node:${node.nodeId}`;
  return node.nodeId;
}

/**
 * The scope of a batch over `nodeIds` running workflows that can send `kinds` (from
 * `profileCommandKinds`): the destructive ones only (the quorum holds nothing else), per node,
 * sorted and without duplicates. Every node must be a metal node.
 */
export async function metalBatchScope(
  tx: SqlTx,
  registry: Pick<RegistryView, 'commandKind'>,
  nodeIds: readonly string[],
  kinds: readonly string[],
): Promise<BatchLeaf[]> {
  const destructive = kinds.filter((kind) => registry.commandKind(kind)?.destructive === true);
  const { rows } = await tx.query<{ node_id: string; bmc_address: string }>(
    'SELECT node_id, bmc_address FROM metal_nodes WHERE node_id = ANY($1::text[])',
    [[...nodeIds]],
  );
  const known = new Map(rows.map((row) => [row.node_id, row.bmc_address]));
  const missing = nodeIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new ComputeError('NOT_FOUND', `Not metal nodes: ${missing.slice(0, 10).join(', ')}`);
  const leaves = new Map<string, BatchLeaf>();
  for (const nodeId of nodeIds)
    for (const kind of destructive) {
      const subject = batchSubject(kind, { nodeId, bmcAddress: known.get(nodeId)! });
      leaves.set(`${subject}\u0000${kind}`, { subject, kind });
    }
  return [...leaves.values()].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
