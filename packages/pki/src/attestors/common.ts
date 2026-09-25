import {
  ComputeError,
  type AgentRole,
  type AttestationContext,
  type AttestationEvidence,
  type SqlTx,
} from '@better-compute/core';
import type { JoinClaims } from '../claims.js';
import {
  parseJoinToken,
  verifyJoinToken,
  type JoinTokenExpect,
  type JoinTokenRecord,
  type JoinTokenRole,
} from '../join-token.js';

// Shared by the v0.2+ attestors (PLAN.md §3.3 step 4, §15). JoinService runs each inside its
// transaction; every refusal reaches the agent as the same `ACCESS_DENIED`, and the reason goes only
// to `onRefusal` (audit, `security.join.refused`).

/** Called with every refusal, for audit; never shown to the agent. */
export type AttestorRefusalHook = (refusal: {
  attestor: string;
  reason: string;
  tokenId?: string;
  nodeId?: string;
  tenantId?: string;
}) => void;

export interface AttestorBaseOptions {
  onRefusal?: AttestorRefusalHook;
}

/** Throws the one generic denial after telling the hook why. */
export function refuser(attestor: string, hook: AttestorRefusalHook | undefined) {
  /**
   * `tenantId` only for refusals after the token's secret verified: JoinService attributes the
   * `security.join.refused` event to it, and an unauthenticated caller must not pick a tenant.
   */
  return (
    reason: string,
    ids: { tokenId?: string; nodeId?: string; tenantId?: string } = {},
  ): never => {
    hook?.({ attestor, reason, ...ids });
    // `details` stay server-side (the gateway answers with the message only): JoinService records
    // them in `security.join.refused`.
    throw new ComputeError('ACCESS_DENIED', 'Join refused', undefined, {
      reason: attestor,
      refusal: `${attestor}:${reason}`,
      ...ids,
    });
  };
}

/**
 * SHA-256 of `JoinRequest.csr` (`AttestationContext.csrSha256`, set by JoinService). Attestors that
 * bind a proof to the CSR refuse without it.
 */
export function csrSha256Of(context: AttestationContext): Uint8Array | undefined {
  const value = context.csrSha256;
  return value instanceof Uint8Array && value.length === 32 ? value : undefined;
}

/** The opened sealed token (`AttestationEvidence.token`, CSR-bound by JoinService), if any. */
export function tokenOf(evidence: AttestationEvidence): string | undefined {
  return typeof evidence.token === 'string' ? evidence.token : undefined;
}

export const ms = (value: Date | string | number): number =>
  value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : new Date(value).getTime();

interface TokenRow {
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

export interface SpentToken {
  record: JoinTokenRecord;
  /** Database time of the check, epoch milliseconds. */
  now: number;
}

/**
 * Locks, verifies and spends a single-use token of `role` (`provisioned`, `discovery`): the
 * join-token checks at `compute_now()`, plus the token's role and `uses_left = 1` (a token minted
 * for more than one use is never a machine credential).
 */
export async function spendSingleUseToken(
  tx: SqlTx,
  token: string,
  input: { role: JoinTokenRole; agentRole: AgentRole; claims: JoinClaims; now: number },
  refuse: ReturnType<typeof refuser>,
): Promise<SpentToken> {
  const checked = await checkSingleUseToken(tx, token, input, refuse);
  await spendToken(tx, checked.record.id, refuse);
  return checked;
}

/**
 * Decrements a checked token (locked by `checkSingleUseToken` in the same transaction). Separate so
 * an attestor can defer (JoinService commits a deferral) without spending the token.
 */
export async function spendToken(
  tx: SqlTx,
  tokenId: string,
  refuse: ReturnType<typeof refuser>,
): Promise<void> {
  const updated = await tx.query(
    'UPDATE join_tokens SET uses_left = uses_left - 1 WHERE id = $1 AND uses_left = 1',
    [tokenId],
  );
  if (updated.rowCount !== 1) refuse('exhausted', { tokenId });
}

/**
 * Records that `subject` (a SHA-256 of what must be used once: a cloud instance identity, a signed
 * discovery assertion) admitted a join; false when it already did (`attestation_uses`). Call it
 * only on the final round: a deferral commits the transaction.
 */
export async function useOnce(
  tx: SqlTx,
  attestor: string,
  subject: Uint8Array,
  expiresAt?: number,
): Promise<boolean> {
  const inserted = await tx.query(
    `INSERT INTO attestation_uses (attestor, subject, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [attestor, subject, expiresAt === undefined ? null : new Date(expiresAt)],
  );
  return inserted.rowCount === 1;
}

/** `spendSingleUseToken` without the spend: locks the row and runs every check. */
export async function checkSingleUseToken(
  tx: SqlTx,
  token: string,
  input: { role: JoinTokenRole; agentRole: AgentRole; claims: JoinClaims; now: number },
  refuse: ReturnType<typeof refuser>,
): Promise<SpentToken> {
  const parsed = parseJoinToken(token);
  if (!parsed) return refuse('malformed');
  const { rows } = await tx.query<TokenRow>(
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
  const now = row ? ms(row.now) : input.now;
  const verdict = verifyJoinToken(token, record, {
    now,
    role: input.agentRole,
    claims: input.claims,
  });
  if (!verdict.ok) {
    const authenticated = !['malformed', 'unknown', 'secret-mismatch'].includes(verdict.reason);
    return refuse(verdict.reason, {
      tokenId: parsed.id,
      ...(authenticated ? { tenantId: record!.tenantId } : {}),
    });
  }
  const owned = { tokenId: parsed.id, tenantId: record!.tenantId };
  if (record!.role !== input.role) return refuse('token-role', owned);
  if (record!.usesLeft !== 1) return refuse('not-single-use', owned);
  return { record: record!, now };
}
