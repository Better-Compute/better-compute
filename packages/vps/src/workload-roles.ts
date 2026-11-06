import { ComputeError, type Migration } from '@better-compute/core';
import { object } from './input.js';

// AWS A7 workload identity, vps's half: an instance on a hosted pool may name the AWS IAM role its
// workloads assume (`instances.create` `workloadIdentity.awsRoleArn`). The pool must have turned
// workload identity on (`policy.workloadIdentity: true`, the broker's own gate) and list the role in
// `policy.workloadRoles.aws` (ARN globs). vps passes it to the host as `InstanceSpec.awsRole`, and
// checks the pool again whenever it builds the spec, so a role the pool stops allowing leaves the
// spec at once (fail closed). bcd exchanges the instance's workload token for the role's
// credentials; the role's trust pins the tenant (`t:<tenantId>:instance:*`), so the allow-list
// narrows which role bcd asks for and never widens who may assume one.

/** A concrete IAM role ARN in a commercial, China or GovCloud partition. */
export const awsRoleArnPattern =
  /^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
/**
 * An allow-list entry: an IAM role ARN whose path and name may use `*` (any run) and `?` (one
 * character), as IAM's own ARN matching does. The account is always literal: a pool never allows
 * roles of any account.
 */
export const awsRoleGlobPattern =
  /^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/*?-]{1,512}$/;
/** Entries a pool's `workloadRoles.aws` may list at most. */
export const maxAwsRoleGlobs = 64;

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

function globRegex(glob: string): RegExp {
  let source = '';
  for (const char of glob)
    source += char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
  return new RegExp(`^${source}$`);
}

/**
 * Whether `arn` matches one of the pool's `workloadRoles.aws` globs. A list that is not an array,
 * and entries that are not valid globs, allow nothing.
 */
export function awsRoleAllowed(list: unknown, arn: string): boolean {
  if (!Array.isArray(list) || !awsRoleArnPattern.test(arn)) return false;
  return list
    .slice(0, maxAwsRoleGlobs)
    .some(
      (entry) =>
        typeof entry === 'string' && awsRoleGlobPattern.test(entry) && globRegex(entry).test(arn),
    );
}

/** A pool policy's workload identity switch and AWS allow-list, as stored. */
export interface PoolWorkloadPolicy {
  workloadIdentity?: unknown;
  workloadRoles?: unknown;
}

/** The role the pool allows the instance to assume, or undefined (fail closed). */
export function allowedAwsRole(
  policy: PoolWorkloadPolicy | null | undefined,
  arn: string | null | undefined,
): string | undefined {
  if (!arn || policy?.workloadIdentity !== true) return undefined;
  const roles = policy.workloadRoles;
  const list =
    typeof roles === 'object' && roles !== null && !Array.isArray(roles)
      ? (roles as { aws?: unknown }).aws
      : undefined;
  return awsRoleAllowed(list, arn) ? arn : undefined;
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
