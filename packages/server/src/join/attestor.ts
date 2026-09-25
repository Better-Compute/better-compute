import {
  ComputeError,
  defineAttestor,
  type AgentRole,
  type AttestationResult,
  type AttestorVerifier,
} from '@better-compute/core';
import { hashJoinTokenSecret, parseJoinToken, sameDigest } from './token.js';

/** Why a token was refused; for logs and audit only, never shown to the agent. */
export type JoinTokenRefusal =
  | 'malformed'
  | 'unknown'
  | 'secret-mismatch'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'role-mismatch';

/** The agent role each token role admits through this attestor (v0.1: `node` and `site`). */
const admits: Readonly<Record<string, AgentRole>> = { node: 'node', site: 'site' };

interface TokenRow {
  id: string;
  tenant_id: string;
  role: string;
  pool_id: string | null;
  site_id: string | null;
  secret_hash: Uint8Array;
  uses_left: number;
  live: boolean;
  revoked: boolean;
}

const dummyHash = new Uint8Array(32);

export interface JoinTokenAttestorOptions {
  /** Called with every refusal (JoinService logs it); the agent always gets one generic denial. */
  onRefusal?(refusal: { reason: JoinTokenRefusal; tokenId?: string }): void;
}

/**
 * The v0.1 `join-token` attestor (PLAN.md §3.3 step 4). Its evidence is the plain token, which
 * JoinService opens from `JoinRequest.sealed_token` (checking the seal's CSR binding) first. Inside
 * JoinService's transaction it locks the `join_tokens` row, checks the secret in constant time,
 * revocation, expiry at `compute_now()`, the remaining uses and the role, then consumes one use.
 * Every refusal is the same `ACCESS_DENIED`. The token's `expect` binding and reclaim flag are
 * JoinService's, which also enforces them for token-based attestors registered through options.
 */
export function joinTokenAttestor(options: JoinTokenAttestorOptions = {}): AttestorVerifier {
  return defineAttestor({
    id: 'join-token',
    version: '1.0.0',
    roles: ['node', 'site'],
    async verify(evidence, context): Promise<AttestationResult> {
      // `tenantId` only once the secret matched: `security.join.refused` goes to that tenant, and an
      // unauthenticated caller must not choose whose event stream it lands in.
      const refuse = (reason: JoinTokenRefusal, tokenId?: string, tenantId?: string): never => {
        options.onRefusal?.({ reason, ...(tokenId ? { tokenId } : {}) });
        throw new ComputeError('ACCESS_DENIED', 'Join refused', undefined, {
          reason: 'token',
          refusal: `join-token:${reason}`,
          ...(tokenId ? { tokenId } : {}),
          ...(tenantId ? { tenantId } : {}),
        });
      };
      const parsed = parseJoinToken(new TextDecoder().decode(evidence.payload));
      if (!parsed) return refuse('malformed');
      const { rows } = await context.tx.query<TokenRow>(
        `SELECT id, tenant_id, role, pool_id, site_id, secret_hash, uses_left,
                expires_at > compute_now() AS live, revoked_at IS NOT NULL AS revoked
           FROM join_tokens WHERE id = $1 FOR UPDATE`,
        [parsed.id],
      );
      const row = rows[0];
      const presented = hashJoinTokenSecret(parsed.secret);
      if (!row) {
        sameDigest(presented, dummyHash); // the same work as a known id
        return refuse('unknown', parsed.id);
      }
      if (!sameDigest(presented, new Uint8Array(row.secret_hash)))
        return refuse('secret-mismatch', row.id);
      if (row.revoked) return refuse('revoked', row.id, row.tenant_id);
      if (!row.live) return refuse('expired', row.id, row.tenant_id);
      if (!(Number(row.uses_left) > 0)) return refuse('exhausted', row.id, row.tenant_id);
      if (admits[row.role] !== context.role) return refuse('role-mismatch', row.id, row.tenant_id);
      const consumed = await context.tx.query(
        'UPDATE join_tokens SET uses_left = uses_left - 1 WHERE id = $1 AND uses_left > 0',
        [row.id],
      );
      if (consumed.rowCount !== 1) return refuse('exhausted', row.id, row.tenant_id);
      return {
        tenantId: row.tenant_id,
        role: context.role,
        tokenId: row.id,
        ...(row.pool_id ? { poolId: row.pool_id } : {}),
        ...(row.site_id ? { siteId: row.site_id } : {}),
      };
    },
  });
}
