import {
  ComputeError,
  defineMethod,
  type Json,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import { issueJoinToken } from '@better-compute/pki';
import {
  derivedId,
  fields,
  keyReused,
  limit,
  ms,
  notFound,
  page,
  patterns,
  type Page,
} from './common.js';
import { parser, v } from './input.js';

// `joinTokens` (PLAN.md §3.3 step 1, §9.2, module server): single-purpose credentials that let a
// daemon join one pool. The bearer form `bcjt_<id>.<secret>` is shown once; only sha256(secret) is
// stored. Every method is decided on `compute-pool/{poolId}`.

/**
 * What a join token pins a machine to (§3.3 step 4): every identifier given must be among the
 * joining machine's claims (JoinService and pki's `verifyJoinToken` check it the same way).
 */
export interface JoinTokenExpect {
  productUuid?: string;
  serial?: string;
  mac?: string;
  gpuUuid?: string;
}

export interface CreateJoinTokenInput {
  tenantId: string;
  poolId: string;
  /** How many machines may join with it (default 1). */
  maxUses?: number;
  /** At most 86 400 (a day). */
  ttlSeconds: number;
  expect?: JoinTokenExpect;
  /** Lets a known machine with a new key reclaim its node (needs ≥ 2 matching identifiers). */
  allowReclaim?: boolean;
  idempotencyKey: string;
}
export interface ListJoinTokensInput {
  tenantId: string;
  poolId: string;
  /** Also list used-up, expired and revoked tokens. */
  includeInactive?: boolean;
  /** At most 200 (100 by default). */
  limit?: number;
  cursor?: string;
}
export interface RevokeJoinTokenInput {
  tenantId: string;
  poolId: string;
  tokenId: string;
}

/** A join token as the API shows it: never the secret, except `token` once, on creation. */
export interface JoinTokenInfo {
  id: string;
  tenantId: string;
  poolId: string;
  siteId?: string;
  role: 'node' | 'site' | 'provisioned' | 'discovery';
  usesLeft: number;
  expect?: JoinTokenExpect;
  allowReclaim: boolean;
  expiresAt: number;
  revokedAt?: number;
}
export interface CreatedJoinToken extends JoinTokenInfo {
  /** `bcjt_<id>.<secret>`, only in the answer that created the token; a replay omits it. */
  token?: string;
}

export type JoinTokensApi = {
  joinTokens: {
    create: MethodDefinition<CreateJoinTokenInput, CreatedJoinToken>;
    list: MethodDefinition<ListJoinTokensInput, Page<JoinTokenInfo>>;
    revoke: MethodDefinition<RevokeJoinTokenInput, JoinTokenInfo>;
  };
};

// --- The bearer format ---------------------------------------------------------------------------

/** Mints the bearer form of a token for a given id, and the hash stored for it. */
export interface JoinTokenMinter {
  mint(id: string): { token: string; secretHash: Uint8Array };
}

/**
 * The default minter: `@better-compute/pki`'s `issueJoinToken` for the derived id, i.e.
 * `bcjt_<id>.<secret>` with 256 bits of base64url secret; `secret_hash` is sha256 of the secret's
 * UTF-8 bytes, which JoinService checks.
 */
export const defaultJoinTokenMinter: JoinTokenMinter = {
  mint(id) {
    const { token, secretHash } = issueJoinToken({ id });
    return { token, secretHash };
  },
};

// --- Inputs --------------------------------------------------------------------------------------

const expectInput = v.object({
  productUuid: v.optional(v.string({ pattern: /^[0-9A-Fa-f-]{8,64}$/, max: 64 })),
  serial: v.optional(v.string({ pattern: /^[A-Za-z0-9._:/+-]{1,128}$/, max: 128 })),
  mac: v.optional(v.string({ pattern: /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/, max: 17 })),
  gpuUuid: v.optional(v.string({ pattern: /^GPU-[0-9A-Fa-f-]{8,64}$/, max: 68 })),
});
const parseCreate = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  maxUses: v.withDefault(v.int({ min: 1, max: 10_000 }), 1),
  ttlSeconds: v.int({ min: 60, max: 86_400 }),
  expect: v.optional(expectInput),
  allowReclaim: v.withDefault(v.boolean(), false),
  idempotencyKey: fields.idempotencyKey,
});
function createInput(input: unknown): CreateJoinTokenInput {
  const parsed = parseCreate(input);
  if (parsed.expect) {
    const expect: JoinTokenExpect = { ...parsed.expect };
    if (!Object.keys(expect).length)
      throw new ComputeError('INVALID_INPUT', 'expect: name at least one identifier');
    // MACs compare case-insensitively; store the canonical form.
    if (expect.mac !== undefined) expect.mac = expect.mac.toLowerCase();
    parsed.expect = expect;
  }
  return parsed;
}
const listInput: (input: unknown) => ListJoinTokensInput = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  includeInactive: v.withDefault(v.boolean(), false),
  limit: limit(200, 100),
  cursor: v.optional(v.string({ pattern: patterns.joinToken, max: 64 })),
});
const revokeInput: (input: unknown) => RevokeJoinTokenInput = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  tokenId: fields.joinTokenId,
});

// --- Rows ----------------------------------------------------------------------------------------

interface TokenRow {
  id: string;
  tenant_id: string;
  role: JoinTokenInfo['role'];
  pool_id: string | null;
  site_id: string | null;
  uses_left: number;
  expect: JoinTokenExpect | null;
  allow_reclaim: boolean;
  expires_at: Date;
  revoked_at: Date | null;
}
const columns = `t.id, t.tenant_id, t.role, t.pool_id, t.site_id, t.uses_left, t.expect,
  t.allow_reclaim, t.expires_at, t.revoked_at`;

function toToken(row: TokenRow): JoinTokenInfo {
  const token: JoinTokenInfo = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id ?? '',
    role: row.role,
    usesLeft: Number(row.uses_left),
    allowReclaim: row.allow_reclaim,
    expiresAt: ms(row.expires_at)!,
  };
  if (row.site_id !== null) token.siteId = row.site_id;
  if (row.expect !== null) token.expect = row.expect;
  const revokedAt = ms(row.revoked_at);
  if (revokedAt !== undefined) token.revokedAt = revokedAt;
  return token;
}

async function findToken(
  tx: SqlTx,
  tenantId: string,
  id: string,
  poolId?: string,
): Promise<JoinTokenInfo | undefined> {
  const { rows } = await tx.query<TokenRow>(
    `SELECT ${columns} FROM join_tokens t
     WHERE t.id = $1 AND t.tenant_id = $2 AND ($3::text IS NULL OR t.pool_id = $3)`,
    [id, tenantId, poolId ?? null],
  );
  return rows[0] && toToken(rows[0]);
}

const canonical = (expect: JoinTokenExpect | undefined) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(expect ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

/** A retry is the same request when it names the same pool, pins and reclaim rule. */
const sameRequest = (token: JoinTokenInfo, input: CreateJoinTokenInput) =>
  token.poolId === input.poolId &&
  token.allowReclaim === (input.allowReclaim ?? false) &&
  canonical(token.expect) === canonical(input.expect);

export function joinTokensApi(minter: JoinTokenMinter = defaultJoinTokenMinter): JoinTokensApi {
  return {
    joinTokens: {
      create: defineMethod<CreateJoinTokenInput, CreatedJoinToken>({
        action: 'compute:join-tokens:create',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: Object.assign(createInput, { jsonSchema: parseCreate.jsonSchema }),
        admission: {
          // A replay answers with the token's record; the secret was shown once and is gone.
          async prepare(context, input, tx) {
            const id = await derivedId('jt', input.tenantId, context, input.idempotencyKey);
            const existing = await findToken(tx, input.tenantId, id);
            if (existing) {
              if (!sameRequest(existing, input)) throw keyReused();
              return { status: 'replay', result: existing };
            }
            return { status: 'decide', resource: { type: 'pool', id: input.poolId } };
          },
        },
        async handler(context, input) {
          // Only the pool's owner tenant admits machines into it; agentless pools take none.
          const { rows: pools } = await context.sql.query<{ site_id: string; agent: string }>(
            'SELECT site_id, agent FROM pools WHERE id = $1 AND owner_tenant_id = $2 FOR SHARE',
            [input.poolId, input.tenantId],
          );
          const pool = pools[0];
          if (!pool) throw notFound('Pool');
          if (pool.agent !== 'bcd')
            throw new ComputeError('INVALID_STATE', 'Machines in this pool run no daemon to join');
          const id = await derivedId('jt', input.tenantId, context, input.idempotencyKey);
          const { token, secretHash } = minter.mint(id);
          const { rows } = await context.sql.query<TokenRow>(
            `INSERT INTO join_tokens AS t (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left,
               expect, allow_reclaim, expires_at)
             VALUES ($1, $2, 'node', $3, $4, $5, $6, $7::jsonb, $8,
               compute_now() + make_interval(secs => $9::int))
             ON CONFLICT DO NOTHING
             RETURNING ${columns}`,
            [
              id,
              input.tenantId,
              input.poolId,
              pool.site_id,
              secretHash,
              input.maxUses ?? 1,
              input.expect ? JSON.stringify(input.expect) : null,
              input.allowReclaim ?? false,
              input.ttlSeconds,
            ],
          );
          if (!rows[0]) {
            const existing = await findToken(context.sql, input.tenantId, id);
            if (existing && sameRequest(existing, input)) return existing;
            throw keyReused();
          }
          const created = toToken(rows[0]);
          await context.events.publish(context.sql, {
            type: 'security.join-token.created',
            tenantId: input.tenantId,
            subject: `pool/${input.poolId}`,
            data: {
              tokenId: id,
              poolId: input.poolId,
              usesLeft: created.usesLeft,
              expiresAt: new Date(created.expiresAt).toISOString(),
              pinned: input.expect !== undefined,
            } satisfies Json,
          });
          return { ...created, token };
        },
      }),
      list: defineMethod<ListJoinTokensInput, Page<JoinTokenInfo>>({
        action: 'compute:join-tokens:read',
        kind: 'read',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 100;
          const { rows } = await context.sql.query<TokenRow>(
            `SELECT ${columns} FROM join_tokens t
             WHERE t.tenant_id = $1 AND t.pool_id = $2 AND ($3::text IS NULL OR t.id > $3)
               AND ($4 OR (t.revoked_at IS NULL AND t.uses_left > 0 AND t.expires_at > compute_now()))
             ORDER BY t.id LIMIT $5`,
            [
              input.tenantId,
              input.poolId,
              input.cursor ?? null,
              input.includeInactive ?? false,
              size + 1,
            ],
          );
          return page(rows, size, toToken, (row) => row.id);
        },
      }),
      revoke: defineMethod<RevokeJoinTokenInput, JoinTokenInfo>({
        action: 'compute:join-tokens:revoke',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: revokeInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<TokenRow>(
            `UPDATE join_tokens t SET revoked_at = compute_now()
             WHERE t.id = $1 AND t.tenant_id = $2 AND t.pool_id = $3 AND t.revoked_at IS NULL
             RETURNING ${columns}`,
            [input.tokenId, input.tenantId, input.poolId],
          );
          if (!rows[0]) {
            // Revoking twice is not an error; revoking what is not there is.
            const existing = await findToken(
              context.sql,
              input.tenantId,
              input.tokenId,
              input.poolId,
            );
            if (!existing) throw notFound('Join token');
            return existing;
          }
          const revoked = toToken(rows[0]);
          await context.events.publish(context.sql, {
            type: 'security.join-token.revoked',
            tenantId: input.tenantId,
            subject: `pool/${input.poolId}`,
            data: { tokenId: input.tokenId, poolId: input.poolId },
          });
          return revoked;
        },
      }),
    },
  };
}
