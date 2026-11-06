import type { SqlTx } from '@better-compute/core';
import { eksUserData, poolHostConfig, type EksJoinSettings } from '@better-compute/provision';

// (AWS A9) A provider pool whose policy names an EKS cluster (`policy.kubernetes.eks`, as
// `providerAccounts.clusters` lists it): the machines vps launches for it join that cluster at boot
// through nodeadm, which reads its `NodeConfig` from the user data. The NodeConfig goes first in a
// MIME multipart with the instance's own user data; the provider adds the SSH keys to that multipart.
// Plain values only (cluster name, endpoint, CA, service CIDR, labels, taints): no join credential
// exists for EKS, the node's instance profile is its identity.

/** The pool's nodeadm settings, or undefined when its policy does not join an EKS cluster. */
export async function poolEksJoin(
  sql: SqlTx,
  poolId: string,
): Promise<EksJoinSettings | undefined> {
  const { rows } = await sql.query<{ kubernetes: Record<string, unknown> | null }>(
    `SELECT policy->'kubernetes' AS kubernetes FROM pools WHERE id = $1`,
    [poolId],
  );
  const kubernetes = rows[0]?.kubernetes;
  if (!kubernetes || typeof kubernetes !== 'object' || kubernetes.eks === undefined) return undefined;
  // As every node of the pool gets it (poolHostConfig validates the shape); eksUserData checks the values.
  const join = poolHostConfig({ kubernetes })['k8s-join'];
  return join?.mode === 'eks' ? (join as unknown as EksJoinSettings) : undefined;
}

/** The user data of a machine of an EKS pool: the NodeConfig, then `userData` (a multipart is refused). */
export function eksNodeUserData(settings: EksJoinSettings | undefined, userData: string): string {
  return settings ? eksUserData(settings, userData) : userData;
}
