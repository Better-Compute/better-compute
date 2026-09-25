'use server';

import { iamNext, currentSession } from '@/lib/iam';

// Advisory permission checks for console-kit's `createPermissions`: which buttons to enable. One batched
// `authorizeMany` for the signed-in tenant; the compute API still decides every call.

interface Check {
  action: string;
  resource: { type: string; id: string };
}

const valid = (check: unknown): check is Check => {
  const value = check as Check | null;
  return (
    typeof value?.action === 'string' &&
    /^compute:[a-z-]+:[a-z-]+$/.test(value.action) &&
    typeof value.resource?.type === 'string' &&
    value.resource.type.length <= 64 &&
    typeof value.resource.id === 'string' &&
    value.resource.id.length <= 200
  );
};

export async function checkPermissions(checks: unknown): Promise<boolean[]> {
  if (!Array.isArray(checks) || checks.length > 50 || !checks.every(valid))
    throw new Error('Up to 50 compute permission checks');
  const session = await currentSession();
  if (!session) return checks.map(() => false);
  const answers = await iamNext.can({ tenantId: session.tenantId, checks });
  return checks.map(
    (check) => answers[`${check.action}@${check.resource.type}/${check.resource.id}`] === true,
  );
}
