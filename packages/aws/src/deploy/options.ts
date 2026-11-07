import { ComputeError } from '@better-compute/core';
import { checkDeploymentName } from './cfn.js';

/** Structural choices for the deployment templates; runtime values are CloudFormation parameters. */
export interface AwsDeploymentOptions {
  /** The deployment name: tags, log groups, aliases and the ECS cluster (default `better-compute`). */
  name?: string;
  /** Availability zones the VPC and services span: 2 or 3 (default 3). */
  zones?: 2 | 3;
  /**
   * NAT gateways: `per-zone` (default; egress survives a zone outage) or `single` (cheaper; one
   * zone's failure cuts every private subnet's egress).
   */
  natGateways?: 'per-zone' | 'single';
  /** Aurora reader instances beside the writer: 0, 1 or 2 (default 1). */
  readers?: 0 | 1 | 2;
}

export interface ResolvedDeploymentOptions {
  name: string;
  zones: 2 | 3;
  natGateways: 'per-zone' | 'single';
  readers: 0 | 1 | 2;
}

export function resolveDeploymentOptions(options: AwsDeploymentOptions = {}): ResolvedDeploymentOptions {
  const name = checkDeploymentName(options.name ?? 'better-compute');
  const zones = options.zones ?? 3;
  if (zones !== 2 && zones !== 3) throw new ComputeError('INVALID_INPUT', 'zones must be 2 or 3');
  const natGateways = options.natGateways ?? 'per-zone';
  if (natGateways !== 'per-zone' && natGateways !== 'single')
    throw new ComputeError('INVALID_INPUT', "natGateways must be 'per-zone' or 'single'");
  const readers = options.readers ?? 1;
  if (readers !== 0 && readers !== 1 && readers !== 2) throw new ComputeError('INVALID_INPUT', 'readers must be 0, 1 or 2');
  return { name, zones, natGateways, readers };
}

/** Indexes 0…zones-1. */
export const zoneIndexes = (options: ResolvedDeploymentOptions): number[] =>
  Array.from({ length: options.zones }, (_, index) => index);
