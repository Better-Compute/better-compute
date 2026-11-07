import type { SqlTx } from '@better-compute/core';

// AWS A7 workload roles: a pool's `policy.workloadRoles.aws` allow-list and the matcher that every
// reader shares. capacity checks the list at pools.create/update, vps at instances.create admission
// and on every instance spec build, and the workload broker before it mints a token for STS. All of
// them run on the control plane's event loop, so matching is linear (no RegExp built from a glob)
// and an entry holds at most `maxAwsRoleGlobStars` stars.

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
/** `*` an allow-list entry may hold at most. */
export const maxAwsRoleGlobStars = 8;

/** Whether `entry` is a valid allow-list entry (pattern and star cap). */
export function isAwsRoleGlob(entry: unknown): entry is string {
  if (typeof entry !== 'string' || !awsRoleGlobPattern.test(entry)) return false;
  let stars = 0;
  for (const char of entry) if (char === '*' && ++stars > maxAwsRoleGlobStars) return false;
  return true;
}

/**
 * Whether `value` matches `glob` (`*` any run, `?` one character, everything else literal). The
 * two-pointer wildcard match: on a mismatch it backtracks only to the last star, so the worst case
 * is O(glob × value) with no RegExp.
 */
export function awsRoleGlobMatches(glob: string, value: string): boolean {
  let g = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    const char = glob[g];
    if (g < glob.length && char !== '*' && (char === '?' || char === value[v])) {
      g++;
      v++;
    } else if (char === '*') {
      star = g++;
      mark = v;
    } else if (star !== -1) {
      g = star + 1;
      v = ++mark;
    } else return false;
  }
  while (glob[g] === '*') g++;
  return g === glob.length;
}

/**
 * Whether `arn` matches one of the pool's `workloadRoles.aws` globs. A list that is not an array,
 * and entries that are not valid globs, allow nothing.
 */
export function awsRoleAllowed(list: unknown, arn: string): boolean {
  if (!Array.isArray(list) || typeof arn !== 'string' || !awsRoleArnPattern.test(arn)) return false;
  return list
    .slice(0, maxAwsRoleGlobs)
    .some((entry) => isAwsRoleGlob(entry) && awsRoleGlobMatches(entry, arn));
}

/**
 * The AWS session tag that binds a workload token for STS to one role. Every role `aws workload-role`
 * renders trusts the whole tenant's instances (`sub` `t:<tenantId>:instance:*`), so the trust also
 * requires `aws:RequestTag/bc-role` to be the role itself (and allows `sts:TagSession`); the
 * workload broker tags each STS token with the role the instance's pool allows. A token minted for
 * one role therefore assumes no other role of the tenant, whoever presents it.
 */
export const awsRoleSessionTagKey = 'bc-role';
/** The JWT claim AWS STS reads session tags from (AssumeRoleWithWebIdentity). */
export const awsSessionTagsClaim = 'https://aws.amazon.com/tags';
/** A role name a session tag value can carry: IAM's role-name characters without `,`. */
const taggableRoleName = /^[\w+=.@-]{1,64}$/;

/**
 * The `bc-role` tag value of a role: its ARN without the path (`arn:<partition>:iam::<account>:
 * role/<name>`), which a CloudFormation trust can spell with `Fn::Sub` and which stays unique
 * (IAM role names are unique per account, whatever the path). Undefined for anything but a role ARN,
 * or a name a tag value cannot carry (a comma): no tag, no STS token (fail closed).
 */
export function awsRoleSessionTag(arn: string): string | undefined {
  if (typeof arn !== 'string' || !awsRoleArnPattern.test(arn)) return undefined;
  const name = arn.slice(arn.lastIndexOf('/') + 1);
  if (!taggableRoleName.test(name)) return undefined;
  const [, partition, , , account] = arn.split(':');
  return `arn:${partition}:iam::${account}:role/${name}`;
}

/** The claims that tag an STS workload token with `arn` (undefined when it cannot be tagged). */
export function awsRoleSessionTagClaims(
  arn: string,
): { [awsSessionTagsClaim]: { principal_tags: { [awsRoleSessionTagKey]: string[] } } } | undefined {
  const tag = awsRoleSessionTag(arn);
  if (tag === undefined) return undefined;
  return { [awsSessionTagsClaim]: { principal_tags: { [awsRoleSessionTagKey]: [tag] } } };
}

/**
 * The hosts running a pool's role-bearing instances (vps `instances.aws_role_arn`), whose desired
 * spec carries an AWS role. Empty without the vps module (no `instances` table, or no role column).
 */
export async function roleBearingHosts(tx: SqlTx, poolId: string): Promise<string[]> {
  const present = (
    await tx.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'instances'
                         AND column_name = 'aws_role_arn') AS present`,
    )
  ).rows[0]?.present;
  if (!present) return [];
  const { rows } = await tx.query<{ node_id: string }>(
    `SELECT DISTINCT node_id FROM instances
      WHERE pool_id = $1 AND node_id IS NOT NULL AND aws_role_arn IS NOT NULL
        AND state <> 'deleted' AND NOT draft
      ORDER BY node_id`,
    [poolId],
  );
  return rows.map((row) => row.node_id);
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
