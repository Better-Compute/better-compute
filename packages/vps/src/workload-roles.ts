import { ComputeError, type Migration } from '@better-compute/core';
import {
  allowedAwsRole,
  awsRoleArnPattern,
  type PoolWorkloadPolicy,
} from '@better-compute/capacity';
import { object } from './input.js';

// The allow-list and its linear matcher live in capacity, shared with pools.create/update and the
// workload broker.
export {
  allowedAwsRole,
  awsRoleAllowed,
  awsRoleArnPattern,
  awsRoleGlobMatches,
  awsRoleGlobPattern,
  awsRoleSessionTag,
  awsRoleSessionTagClaims,
  awsRoleSessionTagKey,
  awsSessionTagsClaim,
  isAwsRoleGlob,
  maxAwsRoleGlobs,
  maxAwsRoleGlobStars,
  type PoolWorkloadPolicy,
} from '@better-compute/capacity';

// AWS A7 workload identity, vps's half: an instance on a hosted pool may name the AWS IAM role its
// workloads assume (`instances.create` `workloadIdentity.awsRoleArn`). The pool must have turned
// workload identity on (`policy.workloadIdentity: true`, the broker's own gate) and list the role in
// `policy.workloadRoles.aws` (ARN globs). vps passes it to the host as `InstanceSpec.awsRole`, and
// checks the pool again whenever it builds the spec (fail closed); pools.update invalidates the
// desired spec of every host running a role-bearing instance of the pool when its workload settings
// change, so the host converges on that invalidation rather than at the level-triggered resync.
// Credentials bcd already obtained stay valid until they expire. bcd exchanges the instance's
// workload token for the role's credentials. The role's trust pins the tenant
// (`t:<tenantId>:instance:*`) and its own `bc-role` session tag; the workload broker mints a token
// for `sts.amazonaws.com` only for an instance whose pool still allows its role, tagged with that
// role, so the token assumes no other workload role of the tenant even if a guest obtains it.

/** `instances.create`'s `workloadIdentity`. */
export interface InstanceWorkloadIdentity {
  awsRoleArn: string;
}

function fail(message: string, reason?: string): never {
  throw new ComputeError(
    'INVALID_INPUT',
    message,
    undefined,
    reason !== undefined ? { reason } : undefined,
  );
}

/** Parses `workloadIdentity` ({ awsRoleArn }); INVALID_INPUT on anything else. */
export function parseWorkloadIdentity(value: unknown): InstanceWorkloadIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('workloadIdentity must be an object');
  const input = object(value, ['awsRoleArn']);
  if (typeof input.awsRoleArn !== 'string' || !awsRoleArnPattern.test(input.awsRoleArn))
    fail(
      'workloadIdentity.awsRoleArn must be an IAM role ARN (arn:aws:iam::<12-digit account>:role/<name>)',
    );
  return { awsRoleArn: input.awsRoleArn };
}

/**
 * `instances.create`'s admission check of `workloadIdentity`: hosted pools only, with workload
 * identity on, and a role the pool lists. INVALID_INPUT with `details.reason` otherwise.
 */
export function assertWorkloadIdentity(
  pool: { id: string; class: string },
  policy: PoolWorkloadPolicy | null | undefined,
  workload: InstanceWorkloadIdentity,
): void {
  if (pool.class !== 'vps-host')
    fail(
      `Pool ${pool.id} is not a hosted pool; workloadIdentity is served by a host's metadata endpoint`,
      'workloadIdentityHostedOnly',
    );
  if (policy?.workloadIdentity !== true)
    fail(
      `Pool ${pool.id} does not turn workload identity on (policy.workloadIdentity)`,
      'workloadIdentityOff',
    );
  if (!allowedAwsRole(policy, workload.awsRoleArn))
    fail(
      `Pool ${pool.id} does not allow the AWS role ${workload.awsRoleArn} (policy.workloadRoles.aws)`,
      'awsRoleNotAllowed',
    );
}

/** The AWS role an instance's workloads assume (AWS A7), NULL when none. */
export const vpsInstanceAwsRoleMigration: Migration = {
  name: 'vps/0096_instance_aws_role',
  sql: `ALTER TABLE instances ADD COLUMN aws_role_arn text
  CHECK (aws_role_arn IS NULL OR length(aws_role_arn) BETWEEN 1 AND 2048);`,
};
