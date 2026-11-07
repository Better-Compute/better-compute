import { ComputeError } from '@better-compute/core';
import type { QueryClient } from '@better-compute/aws-core';
import { invalid } from './client.js';

// The subnets an EKS cluster and its node groups use, as EC2 describes them: their VPC, their
// Availability Zone and whether they give instances public addresses.

export interface SubnetInfo {
  subnetId: string;
  vpcId: string;
  zone: string;
  mapPublicIpOnLaunch: boolean;
}

/** DescribeSubnets of `ids`; NOT_FOUND names a missing one. */
export async function describeSubnets(
  ec2: QueryClient,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<SubnetInfo[]> {
  if (ids.length === 0) return [];
  const doc = await ec2.call('DescribeSubnets', { SubnetId: [...ids] }, { signal });
  const out: SubnetInfo[] = [];
  for (const item of doc.items('subnetSet')) {
    const subnetId = item.textOf('subnetId');
    const vpcId = item.textOf('vpcId');
    const zone = item.textOf('availabilityZone');
    if (!subnetId || !vpcId || !zone) continue;
    out.push({
      subnetId,
      vpcId,
      zone,
      mapPublicIpOnLaunch: item.textOf('mapPublicIpOnLaunch') === 'true',
    });
  }
  for (const id of ids)
    if (!out.some((subnet) => subnet.subnetId === id))
      throw new ComputeError('NOT_FOUND', `Subnet ${id} does not exist`, undefined, {
        provider: 'aws',
        service: 'ec2',
        reason: 'subnet',
      });
  return out;
}

/**
 * Checks the subnets of a new cluster: one VPC (the spec's, when it names one), at least two
 * Availability Zones (EKS's rule), and with private nodes no subnet that gives public addresses.
 */
export function checkClusterSubnets(
  subnets: readonly SubnetInfo[],
  options: { vpcId?: string; privateNodes: boolean },
): void {
  const vpcs = new Set(subnets.map((subnet) => subnet.vpcId));
  if (vpcs.size > 1) throw invalid(`The cluster subnets are in several VPCs (${[...vpcs].join(', ')})`);
  const [vpc] = vpcs;
  if (options.vpcId && vpc && vpc !== options.vpcId)
    throw invalid(`The cluster subnets are in ${vpc}, not ${options.vpcId}`);
  if (new Set(subnets.map((subnet) => subnet.zone)).size < 2)
    throw invalid('EKS needs cluster subnets in at least two Availability Zones');
  if (options.privateNodes) {
    const open = subnets.filter((subnet) => subnet.mapPublicIpOnLaunch);
    if (open.length)
      throw invalid(
        `privateNodes: subnet ${open[0]!.subnetId} gives instances public addresses (MapPublicIpOnLaunch); use private subnets`,
      );
  }
}

/**
 * The subnets a node group uses: the cluster's, limited to `zones` when given (each zone must have
 * one), and how many zones they span.
 */
export function nodegroupSubnets(
  subnets: readonly SubnetInfo[],
  zones: readonly string[] | undefined,
): { subnets: string[]; zones: number } {
  const chosen = zones?.length ? subnets.filter((subnet) => zones.includes(subnet.zone)) : [...subnets];
  for (const zone of zones ?? [])
    if (!chosen.some((subnet) => subnet.zone === zone))
      throw invalid(`The cluster has no subnet in ${zone}`);
  if (chosen.length === 0) throw invalid('The cluster has no subnets for the node group');
  return {
    subnets: chosen.map((subnet) => subnet.subnetId).sort(),
    zones: new Set(chosen.map((subnet) => subnet.zone)).size,
  };
}
