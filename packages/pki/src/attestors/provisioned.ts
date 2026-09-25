import {
  defineAttestor,
  type AttestationResult,
  type AttestorVerifier,
  type SqlTx,
} from '@better-compute/core';
import { normalizeClaim, type JoinClaims } from '../claims.js';
import { refuser, spendSingleUseToken, tokenOf, type AttestorBaseOptions } from './common.js';

/**
 * The machine a `provisioned` token was minted for, as the host knows it (e.g. the provision
 * engine's `userdata.render` step result `joinTokenId` → `workflows.node_id`, or a provider's
 * bootstrap record of the server's SMBIOS UUID). `productUuid`, when known, must equal the agent's
 * claim; `nodeId` makes the join re-key that node instead of creating one.
 */
export interface ProvisionedTarget {
  nodeId?: string;
  productUuid?: string;
}

export type ProvisionedTargetResolver = (
  tx: SqlTx,
  token: { id: string; tenantId: string; poolId?: string; siteId?: string },
) => Promise<ProvisionedTarget | undefined>;

export interface ProvisionedAttestorOptions extends AttestorBaseOptions {
  /**
   * Finds the node a token was minted for. Without it (or when it returns undefined) the machine
   * joins as a new node, as a provider bootstrap (Hetzner Robot installimage) does.
   */
  resolveTarget?: ProvisionedTargetResolver;
}

/**
 * The `provisioned` attestor (v0.2, PLAN.md §3.6, §11): the OS an image deploy or a provider
 * bootstrap installed joins with the single-use token rendered into its user data. The token must
 * be a `provisioned` token with exactly one use left, and the agent must claim a product UUID:
 * the token is bound to it, either through the token's `expect` or through the target node the
 * host resolves. With a target, the result names that node, so JoinService re-keys it in place
 * and keeps its provisioning state.
 */
export function provisionedAttestor(options: ProvisionedAttestorOptions = {}): AttestorVerifier {
  return defineAttestor({
    id: 'provisioned',
    version: '1.0.0',
    roles: ['node'],
    async verify(evidence, context): Promise<AttestationResult> {
      const refuse = refuser('provisioned', options.onRefusal);
      const token = tokenOf(evidence);
      if (!token) return refuse('no-token');
      const claims = context.claims as JoinClaims;
      if (!claims.productUuid || normalizeClaim.uuid(claims.productUuid) === '')
        return refuse('no-product-uuid');
      const { record } = await spendSingleUseToken(
        context.tx,
        token,
        { role: 'provisioned', agentRole: context.role, claims, now: context.clock.now() },
        refuse,
      );
      const ids = { tokenId: record.id, tenantId: record.tenantId };
      const target = await options.resolveTarget?.(context.tx, {
        id: record.id,
        tenantId: record.tenantId,
        ...(record.poolId ? { poolId: record.poolId } : {}),
        ...(record.siteId ? { siteId: record.siteId } : {}),
      });
      // Bound to the machine: by the token's expect (already checked), the target node, or its UUID.
      if (!target?.nodeId && !target?.productUuid && !record.expect?.productUuid)
        return refuse('unbound', ids);
      if (
        target?.productUuid !== undefined &&
        normalizeClaim.uuid(target.productUuid) !== normalizeClaim.uuid(claims.productUuid)
      )
        return refuse('product-uuid-mismatch', {
          ...ids,
          ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        });
      return {
        tenantId: record.tenantId,
        role: 'node',
        tokenId: record.id,
        ...(record.poolId ? { poolId: record.poolId } : {}),
        ...(record.siteId ? { siteId: record.siteId } : {}),
        ...(target?.nodeId ? { nodeId: target.nodeId } : {}),
      };
    },
  });
}
