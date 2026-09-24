import { ComputeError, defineMethod, type MethodDefinition, type SqlTx } from '@better-compute/core';
import { derivedId, fields, int, keyReused, ms, notFound } from './common.js';
import { parser, v } from './input.js';
import { defaultJoinTokenMinter, type JoinTokenMinter } from './join-tokens.js';

// `siteTokens` (PLAN.md §3.3 step 0, §9.2, module server, v0.2): role-`site` join tokens that
// enroll `bcd site` agents on one site. The agents then contend for the site's boot lease
// (`site:<id>:boot`, controllers/site-boot.ts). Same bearer format and storage as join tokens: the
// secret is shown once, and only its hash is kept. Decided on `compute-site/{siteId}` with
// `compute:sites:manage`.

export interface CreateSiteTokenInput {
  tenantId: string;
  siteId: string;
  /** At most 86 400 (a day). */
  ttlSeconds: number;
  /** How many site agents may enroll with it (default 1, at most 16). */
  maxUses?: number;
  idempotencyKey: string;
}
export interface RevokeSiteTokenInput {
  tenantId: string;
  siteId: string;
  tokenId: string;
}

export interface SiteTokenInfo {
  id: string;
  tenantId: string;
  siteId: string;
  role: 'site';
  usesLeft: number;
  expiresAt: number;
  revokedAt?: number;
}
export interface CreatedSiteToken extends SiteTokenInfo {
  /** `bcjt_<id>.<secret>`, only in the answer that created the token; a replay omits it. */
  token?: string;
}

export type SiteTokensApi = {
  siteTokens: {
    create: MethodDefinition<CreateSiteTokenInput, CreatedSiteToken>;
    revoke: MethodDefinition<RevokeSiteTokenInput, SiteTokenInfo>;
  };
};

const createInput: (input: unknown) => CreateSiteTokenInput = parser({
  tenantId: fields.tenantId,
  siteId: fields.siteId,
  ttlSeconds: v.int({ min: 60, max: 86_400 }),
  maxUses: v.withDefault(v.int({ min: 1, max: 16 }), 1),
  idempotencyKey: fields.idempotencyKey,
});
const revokeInput: (input: unknown) => RevokeSiteTokenInput = parser({
  tenantId: fields.tenantId,
  siteId: fields.siteId,
  tokenId: fields.joinTokenId,
});

interface TokenRow {
  id: string;
  tenant_id: string;
  site_id: string;
  uses_left: unknown;
  expires_at: Date;
  revoked_at: Date | null;
}
const columns = 't.id, t.tenant_id, t.site_id, t.uses_left, t.expires_at, t.revoked_at';

function toToken(row: TokenRow): SiteTokenInfo {
  const token: SiteTokenInfo = {
    id: row.id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    role: 'site',
    usesLeft: int(row.uses_left),
    expiresAt: ms(row.expires_at)!,
  };
  const revokedAt = ms(row.revoked_at);
  if (revokedAt !== undefined) token.revokedAt = revokedAt;
  return token;
}

async function findToken(tx: SqlTx, tenantId: string, id: string, siteId?: string) {
  const { rows } = await tx.query<TokenRow>(
    `SELECT ${columns} FROM join_tokens t
      WHERE t.id = $1 AND t.tenant_id = $2 AND t.role = 'site' AND ($3::text IS NULL OR t.site_id = $3)`,
    [id, tenantId, siteId ?? null],
  );
  return rows[0] && toToken(rows[0]);
}

const sameRequest = (token: SiteTokenInfo, input: CreateSiteTokenInput) => token.siteId === input.siteId;

export function siteTokensApi(minter: JoinTokenMinter = defaultJoinTokenMinter): SiteTokensApi {
  return {
    siteTokens: {
      create: defineMethod<CreateSiteTokenInput, CreatedSiteToken>({
        action: 'compute:sites:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'site', id: input.siteId }),
        validate: createInput,
        admission: {
          async prepare(context, input, tx) {
            const id = await derivedId('jt', input.tenantId, context, input.idempotencyKey);
            const existing = await findToken(tx, input.tenantId, id);
            if (existing) {
              if (!sameRequest(existing, input)) throw keyReused();
              return { status: 'replay', result: existing };
            }
            return { status: 'decide', resource: { type: 'site', id: input.siteId } };
          },
        },
        async handler(context, input) {
          // Only the site's owner enrolls its agents (the root tenant for platform sites).
          const { rows: sites } = await context.sql.query<{ deleted: boolean }>(
            'SELECT deleted_at IS NOT NULL AS deleted FROM sites WHERE id = $1 AND owner_tenant_id = $2 FOR SHARE',
            [input.siteId, input.tenantId],
          );
          if (!sites[0]) throw notFound('Site');
          if (sites[0].deleted) throw new ComputeError('INVALID_STATE', 'The site is deleted');
          const id = await derivedId('jt', input.tenantId, context, input.idempotencyKey);
          const { token, secretHash } = minter.mint(id);
          const { rows } = await context.sql.query<TokenRow>(
            `INSERT INTO join_tokens AS t (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left,
               expect, allow_reclaim, expires_at)
             VALUES ($1, $2, 'site', NULL, $3, $4, $5, NULL, false,
               compute_now() + make_interval(secs => $6::int))
             ON CONFLICT DO NOTHING
             RETURNING ${columns}`,
            [id, input.tenantId, input.siteId, secretHash, input.maxUses ?? 1, input.ttlSeconds],
          );
          if (!rows[0]) {
            const existing = await findToken(context.sql, input.tenantId, id);
            if (existing && sameRequest(existing, input)) return existing;
            throw keyReused();
          }
          const created = toToken(rows[0]);
          await context.events.publish(context.sql, {
            type: 'security.site-token.created',
            tenantId: input.tenantId,
            subject: `site/${input.siteId}`,
            data: {
              tokenId: id,
              siteId: input.siteId,
              usesLeft: created.usesLeft,
              expiresAt: new Date(created.expiresAt).toISOString(),
            },
          });
          return { ...created, token };
        },
      }),
      revoke: defineMethod<RevokeSiteTokenInput, SiteTokenInfo>({
        action: 'compute:sites:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'site', id: input.siteId }),
        validate: revokeInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<TokenRow>(
            `UPDATE join_tokens t SET revoked_at = compute_now()
              WHERE t.id = $1 AND t.tenant_id = $2 AND t.site_id = $3 AND t.role = 'site'
                AND t.revoked_at IS NULL
              RETURNING ${columns}`,
            [input.tokenId, input.tenantId, input.siteId],
          );
          if (!rows[0]) {
            const existing = await findToken(context.sql, input.tenantId, input.tokenId, input.siteId);
            if (!existing) throw notFound('Site token');
            return existing;
          }
          await context.events.publish(context.sql, {
            type: 'security.site-token.revoked',
            tenantId: input.tenantId,
            subject: `site/${input.siteId}`,
            data: { tokenId: input.tokenId, siteId: input.siteId },
          });
          return toToken(rows[0]);
        },
      }),
    },
  };
}
