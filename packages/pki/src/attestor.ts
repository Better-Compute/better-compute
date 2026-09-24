import {
  ComputeError,
  defineAttestor,
  type AttestationResult,
  type AttestorVerifier,
} from '@better-compute/core';
import {
  parseJoinToken,
  verifyJoinToken,
  type JoinTokenExpect,
  type JoinTokenRecord,
  type JoinTokenRefusal,
  type JoinTokenRole,
} from './join-token.js';

interface JoinTokenRow {
  id: string;
  tenant_id: string;
  role: JoinTokenRole;
  pool_id: string | null;
  site_id: string | null;
  secret_hash: Uint8Array;
  uses_left: number;
  expect: JoinTokenExpect | string | null;
  allow_reclaim: boolean;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  now: Date | string;
}

const ms = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

export interface JoinTokenAttestorOptions {
  /** Called with every refusal, for audit (`security.join.refused`); never shown to the agent. */
  onRefusal?(refusal: { tokenId?: string; reason: JoinTokenRefusal }): void;
}

/**
 * The v0.1 `join-token` attestor (PLAN.md §3.3 step 4). Evidence is the plain token, which
 * JoinService obtains with `openSealedToken` (checking the CSR binding) before running the chain.
 * Inside JoinService's transaction it locks the `join_tokens` row, verifies it at `compute_now()`
 * and decrements `uses_left`. Every refusal is the same `ACCESS_DENIED`.
 */
export function joinTokenAttestor(options: JoinTokenAttestorOptions = {}): AttestorVerifier {
  return defineAttestor({
    id: 'join-token',
    version: '1.0.0',
    roles: ['node', 'site', 'ramdisk'],
    async verify(evidence, context): Promise<AttestationResult> {
      const refuse = (reason: JoinTokenRefusal, tokenId?: string): never => {
        options.onRefusal?.({ reason, ...(tokenId ? { tokenId } : {}) });
        throw new ComputeError('ACCESS_DENIED', 'Join refused');
      };
      const token = new TextDecoder().decode(evidence.payload);
      const parsed = parseJoinToken(token);
      if (!parsed) return refuse('malformed');
      const { rows } = await context.tx.query<JoinTokenRow>(
        `SELECT id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect, allow_reclaim,
                expires_at, revoked_at, compute_now() AS now
           FROM join_tokens WHERE id = $1 FOR UPDATE`,
        [parsed.id],
      );
      const row = rows[0];
      const record: JoinTokenRecord | undefined = row && {
        id: row.id,
        tenantId: row.tenant_id,
        role: row.role,
        poolId: row.pool_id,
        siteId: row.site_id,
        secretHash: new Uint8Array(row.secret_hash),
        usesLeft: Number(row.uses_left),
        expect:
          typeof row.expect === 'string' ? (JSON.parse(row.expect) as JoinTokenExpect) : row.expect,
        allowReclaim: row.allow_reclaim,
        expiresAt: ms(row.expires_at),
        revokedAt: row.revoked_at === null ? null : ms(row.revoked_at),
      };
      const now = row ? ms(row.now) : context.clock.now();
      const verdict = verifyJoinToken(token, record, {
        now,
        role: context.role,
        claims: context.claims,
      });
      if (!verdict.ok) return refuse(verdict.reason, parsed.id);
      const updated = await context.tx.query(
        'UPDATE join_tokens SET uses_left = uses_left - 1 WHERE id = $1 AND uses_left > 0',
        [verdict.tokenId],
      );
      if (updated.rowCount !== 1) return refuse('exhausted', parsed.id);
      return {
        tenantId: verdict.tenantId,
        role: verdict.role,
        tokenId: verdict.tokenId,
        ...(verdict.poolId ? { poolId: verdict.poolId } : {}),
        ...(verdict.siteId ? { siteId: verdict.siteId } : {}),
      };
    },
  });
}
