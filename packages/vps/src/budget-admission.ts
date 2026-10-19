// Budget checks on the billable paths besides `instances.create` (D16): `instances.attach` and `networks.create`.
// Both run as `MethodAdmission.check`, after the IAM decision with no transaction open, through capacity's
// `budgetAdmissionCheck`. A caller from another tenant (the platform issuing into a customer) is checked against the
// TARGET tenant's budgets, with no identity: that is `budgetAdmissionCheck`'s rule for every path.

import { budgetAdmissionCheck, offerAdmissionCheck } from '@better-compute/capacity';
import type { MethodContext, PoolPolicy } from '@better-compute/core';
import { billingModeOf, type BillingMode } from './billing.js';

/**
 * The billing mode of a provider pool (`billingModeOf` over its owner and provider account), or `undefined` when
 * the pool does not exist. Without a known root tenant every provider pool reads as a tenant's own (BYO), as
 * where usage is metered: it fails closed.
 */
export async function poolBillingMode(
  context: Pick<MethodContext, 'sql' | 'iam'>,
  poolId: string,
): Promise<BillingMode | undefined> {
  const { rows } = await context.sql.query<{
    owner_tenant_id: string;
    class: string;
    policy: PoolPolicy | string;
    account_tenant: string | null;
  }>(
    `SELECT p.owner_tenant_id, p.class, p.policy, a.tenant_id AS account_tenant
       FROM pools p LEFT JOIN provider_accounts a ON a.id = p.provider_account_id
      WHERE p.id = $1`,
    [poolId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return billingModeOf(
    {
      ownerTenantId: row.owner_tenant_id,
      class: row.class,
      policy: typeof row.policy === 'string' ? (JSON.parse(row.policy) as PoolPolicy) : row.policy,
    },
    row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
    context.iam.rootTenantId ?? '',
  );
}

/**
 * `instances.attach`: the offer's own refusals (suspended, region) always; the tenant's budget when the attached
 * machine is billed, i.e. unless the platform attaches it with `billing: 'none'` or the pool's mode is `none`
 * (`metered` and `platform-fee` are billed).
 */
export async function attachBudgetCheck(
  context: MethodContext,
  input: { tenantId: string; poolId: string; billing?: 'metered' | 'none' },
): Promise<void> {
  if (input.billing === 'none') return offerAdmissionCheck(context, input.tenantId, input.poolId);
  const mode = await poolBillingMode(context, input.poolId);
  if (mode === undefined || mode === 'none')
    return offerAdmissionCheck(context, input.tenantId, input.poolId);
  return budgetAdmissionCheck(context, input.tenantId, input.poolId);
}

/**
 * `networks.create`: the offer's own refusals always; the tenant's budget when the pool's mode is `metered` (the
 * only mode that prices networks, Task 12).
 */
export async function networkBudgetCheck(
  context: MethodContext,
  input: { tenantId: string; poolId: string },
): Promise<void> {
  if ((await poolBillingMode(context, input.poolId)) === 'metered')
    return budgetAdmissionCheck(context, input.tenantId, input.poolId);
  return offerAdmissionCheck(context, input.tenantId, input.poolId);
}
