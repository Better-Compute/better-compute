import { createHash } from 'node:crypto';
import { defineModule, type ComputeModule, type Migration, type SqlExecutor } from '@better-compute/core';

// Approvals bound to the request a person saw (security review 14 M1). better-iam keeps an approval
// open, keyed by (action, resource), for its whole validity: after one approved extend of rsv_X an
// agent could extend rsv_X again, by more, and IAM would allow it. The envelope therefore records,
// for every confirmation it asks for, the digest of the text the person is shown (first text wins),
// and later admits a delegated call on that (delegation, action, resource) only when the call's own
// text has the same digest. A different request under a still-open approval is refused.

export const confirmationBindingsModuleName = 'confirmations';

export const confirmationBindingsMigration: Migration = {
  name: 'confirmations/0001_bindings',
  sql: `
CREATE TABLE confirmation_bindings (
  confirmation_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  delegation_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  digest bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now()
);
CREATE INDEX confirmation_bindings_decision
  ON confirmation_bindings (tenant_id, delegation_id, action, resource_type, resource_id);
`,
};

/** The built-in module that owns the table (always hosted, like quorum). */
export function createConfirmationBindingsModule(): ComputeModule<typeof confirmationBindingsModuleName> {
  return Object.freeze(
    defineModule<typeof confirmationBindingsModuleName>({
      name: confirmationBindingsModuleName,
      migrations: [confirmationBindingsMigration],
    }),
  );
}

export interface BoundDecision {
  tenantId: string;
  delegationId: string;
  action: string;
  resource: { type: string; id: string };
}

const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/** Records the text a confirmation shows; the first one wins (a reused pending confirmation keeps its text). */
export async function bindConfirmation(
  database: Pick<SqlExecutor, 'query'>,
  confirmationId: string,
  decision: BoundDecision,
  text: string,
  expiresAt: number,
): Promise<void> {
  await database.query(
    `INSERT INTO confirmation_bindings (confirmation_id, tenant_id, delegation_id, action, resource_type,
                                        resource_id, digest, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::float8 / 1000))
     ON CONFLICT (confirmation_id) DO NOTHING`,
    [
      confirmationId,
      decision.tenantId,
      decision.delegationId,
      decision.action,
      decision.resource.type,
      decision.resource.id,
      digestOf(text),
      expiresAt,
    ],
  );
}

/**
 * Whether a delegated call IAM allowed may go ahead: yes without any open binding on its decision,
 * else only when one of them was made for this exact text.
 */
export async function matchesBinding(
  database: Pick<SqlExecutor, 'query'>,
  decision: BoundDecision,
  text: string,
): Promise<boolean> {
  const { rows } = await database.query<{ digest: Uint8Array }>(
    `SELECT digest FROM confirmation_bindings
      WHERE tenant_id = $1 AND delegation_id = $2 AND action = $3 AND resource_type = $4
        AND resource_id = $5 AND expires_at > compute_now()`,
    [decision.tenantId, decision.delegationId, decision.action, decision.resource.type, decision.resource.id],
  );
  if (rows.length === 0) return true;
  const wanted = digestOf(text);
  return rows.some((row) => Buffer.from(row.digest).equals(wanted));
}
