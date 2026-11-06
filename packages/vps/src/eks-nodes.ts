import { ComputeError, type SqlTx } from '@better-compute/core';
import { eksUserData, poolHostConfig, type EksJoinSettings } from '@better-compute/provision';

// (AWS A9) A provider pool whose policy names an EKS cluster (`policy.kubernetes.eks`, as
// `providerAccounts.clusters` lists it): the machines vps launches for it join that cluster at boot
// through nodeadm, which reads its `NodeConfig` from the user data. The NodeConfig goes first in a
// MIME multipart with the instance's own user data; the provider adds the SSH keys to that multipart.
// Plain values only (cluster name, endpoint, CA, service CIDR, labels, taints): no join credential
// exists for EKS, the node's instance profile is its identity.
//
// Only the pool owner (the cluster's operator) launches nodes of its cluster: an instance's user data
// and SSH keys give its tenant root on the machine, so a tenant the pool is offered to would get a
// node of the operator's cluster (the kubelet's identity, the instance role). Its launch fails closed.

/**
 * The pool's nodeadm settings for an instance of `tenantId`, or undefined when its policy does not join an
 * EKS cluster. ACCESS_DENIED when the instance is not the pool owner's.
 */
export async function poolEksJoin(
  sql: SqlTx,
  poolId: string,
  tenantId: string,
): Promise<EksJoinSettings | undefined> {
  const { rows } = await sql.query<{ kubernetes: Record<string, unknown> | null; owner: string }>(
    `SELECT policy->'kubernetes' AS kubernetes, owner_tenant_id AS owner FROM pools WHERE id = $1`,
    [poolId],
  );
  const kubernetes = rows[0]?.kubernetes;
  if (!kubernetes || typeof kubernetes !== 'object' || kubernetes.eks === undefined) return undefined;
  if (rows[0]!.owner !== tenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Pool ${poolId} joins its machines to an EKS cluster: only the pool owner launches them (an instance's tenant gets root on its machine)`,
      undefined,
      { reason: 'eksNodeTenant', poolId },
    );
  // As every node of the pool gets it (poolHostConfig validates the shape); eksUserData checks the values.
  const join = poolHostConfig({ kubernetes })['k8s-join'];
  return join?.mode === 'eks' ? (join as unknown as EksJoinSettings) : undefined;
}

/** The user data of a machine of an EKS pool: the NodeConfig, then `userData` (a multipart is refused). */
export function eksNodeUserData(settings: EksJoinSettings | undefined, userData: string): string {
  return settings ? eksUserData(settings, userData) : userData;
}
