import {
  ComputeError,
  type Clock,
  type Logger,
  type Migration,
  type ProviderDefinition,
  type Reconciler,
  type SecretBroker,
  type SecretRef,
  type SqlTx,
} from '@better-compute/core';
import { connectStageMs } from './connect.js';

// The credentials `providerAccounts.connect` sealed (P9) are vps's for their whole lifecycle: vps sealed them, so vps
// deletes them. A marker row is written as the credential is sealed (the connect's admission check, no transaction
// open), claimed by the transaction that stores its account, and the credential is revoked at the provider
// (`ProviderConnect.revoke`, best effort) and deleted from the secret store once nothing uses it:
// - the account was deleted (right after the delete commits, and by the sweep should that fail), or no account names
//   the ref any more;
// - the connect failed after sealing (a refused account check, a failed store: released at once);
// - the connect never reached its handler (a cancelled request, a crash, a restart: the in-memory staging is gone),
//   once the unclaimed marker is older than `connectStageMs`.
// `vps.connect-secrets` (every 5 minutes, registered only when a provider has a connect flow) sweeps them. A marker
// is first marked released, then the credential is revoked and deleted, then the marker goes, so a crash in between
// leaves a released marker the next sweep finishes. A claim needs an unreleased marker, so a sweep and a handler
// never both win. A ref any provider account still names (one stored by hand with the same ref) is never deleted.

export const connectSecretsMigration: Migration = {
  name: 'vps/0076_provider_connect_secrets',
  sql: `
-- (P9) Credentials providerAccounts.connect sealed, owned by vps until revoked and deleted (vps.connect-secrets).
CREATE TABLE provider_connect_secrets (
  ref text PRIMARY KEY,
  tenant_id text NOT NULL,
  provider text NOT NULL,
  -- Set by the transaction that stores the account.
  claimed boolean NOT NULL DEFAULT false,
  sealed_at timestamptz NOT NULL DEFAULT compute_now(),
  -- Nothing uses it: revoke and delete it (set before either, so a crash in between is finished later).
  released_at timestamptz
);
`,
};

/** The sweep's work name. */
export const connectSecretsWork = 'vps.connect-secrets';

/** What a sweep needs: the store, the secret broker (it deletes) and the providers (they revoke). */
export interface ConnectSecretsDeps {
  sql: SqlTx;
  secrets?: SecretBroker | undefined;
  providers: ReadonlyMap<string, ProviderDefinition>;
  clock: Clock;
  log: Logger;
}

const revokeTimeoutMs = 30_000;
const sweepBatch = 100;

/** Records a credential the connect check just sealed (no transaction open: it must outlive a rollback). */
export async function recordSealed(
  sql: SqlTx,
  input: { ref: string; tenantId: string; provider: string },
): Promise<void> {
  await sql.query(
    `INSERT INTO provider_connect_secrets (ref, tenant_id, provider) VALUES ($1, $2, $3)`,
    [input.ref, input.tenantId, input.provider],
  );
}

/** Claims a sealed credential for the account being stored (in its transaction); refused once it was released. */
export async function claimSealed(sql: SqlTx, ref: string): Promise<void> {
  const { rows } = await sql.query<{ ref: string }>(
    `UPDATE provider_connect_secrets SET claimed = true
      WHERE ref = $1 AND NOT claimed AND released_at IS NULL RETURNING ref`,
    [ref],
  );
  if (rows.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      'The connect request waited too long and its credential was discarded: connect the account again',
    );
}

/** Releases an unclaimed credential (its connect failed): the next sweep of it revokes and deletes it. */
export async function releaseSealed(sql: SqlTx, ref: string): Promise<void> {
  await sql.query(
    `UPDATE provider_connect_secrets SET released_at = coalesce(released_at, compute_now())
      WHERE ref = $1 AND NOT claimed`,
    [ref],
  );
}

/** Whether a marker's credential is unused (`m` the marker; `$2` the stage in seconds). */
const unused = `(m.released_at IS NOT NULL
   OR (NOT m.claimed AND m.sealed_at < compute_now() - make_interval(secs => $2::float8))
   OR (m.claimed AND NOT EXISTS (
         SELECT 1 FROM provider_accounts a, jsonb_each_text(a.config) c WHERE c.value = m.ref)))`;

/**
 * Revokes and deletes the unused connected credentials (all of them, or those of `refs`), a batch at a time. Each
 * failure is logged without the credential and left for the next sweep; nothing here throws.
 */
export async function sweepConnectSecrets(
  deps: ConnectSecretsDeps,
  refs?: readonly string[],
): Promise<number> {
  const deleteSecret = deps.secrets?.delete?.bind(deps.secrets);
  if (!deps.secrets || !deleteSecret) {
    deps.log.warn(
      'vps.connectSecrets: no secret broker that deletes; connected credentials are kept',
    );
    return 0;
  }
  const stage = connectStageMs / 1000;
  let done = 0;
  try {
    const { rows } = await deps.sql.query<{ ref: string; tenant_id: string; provider: string }>(
      `SELECT m.ref, m.tenant_id, m.provider FROM provider_connect_secrets m
        WHERE ($1::text[] IS NULL OR m.ref = ANY($1::text[])) AND ${unused}
        ORDER BY m.ref LIMIT ${sweepBatch}`,
      [refs ? [...refs] : null, stage],
    );
    for (const row of rows) {
      const ref = row.ref as SecretRef;
      const released = await deps.sql.query<{ ref: string }>(
        `UPDATE provider_connect_secrets m SET released_at = coalesce(m.released_at, compute_now())
          WHERE m.ref = $1 AND ${unused} RETURNING m.ref`,
        [ref, stage],
      );
      if (released.rows.length === 0) continue;
      const revoke = deps.providers.get(row.provider)?.connect?.revoke;
      if (revoke) {
        const secret = await deps.secrets.resolve(ref).catch(() => undefined);
        try {
          await revoke({
            ref,
            ...(secret !== undefined ? { secret } : {}),
            clock: deps.clock,
            signal: AbortSignal.timeout(revokeTimeoutMs),
          });
        } catch (error) {
          // The grant may stay live at the provider; the credential is deleted here regardless.
          deps.log.warn('vps.connectSecrets: the provider did not revoke a connected credential', {
            provider: row.provider,
            tenantId: row.tenant_id,
            code: error instanceof ComputeError ? error.code : 'ERROR',
          });
        }
      }
      try {
        await deleteSecret(ref);
      } catch {
        deps.log.warn('vps.connectSecrets: deleting a connected credential failed; retried later', {
          provider: row.provider,
          tenantId: row.tenant_id,
        });
        continue;
      }
      await deps.sql.query(`DELETE FROM provider_connect_secrets WHERE ref = $1`, [ref]);
      done++;
    }
  } catch (error) {
    deps.log.warn('vps.connectSecrets: the sweep failed; retried later', {
      code: error instanceof ComputeError ? error.code : 'ERROR',
    });
  }
  return done;
}

/** The secret refs an account's config names (top-level `secret://` values). */
export function configRefs(config: Record<string, unknown>): string[] {
  return Object.values(config).filter(
    (value): value is string => typeof value === 'string' && value.startsWith('secret://'),
  );
}

/** `vps.connect-secrets`: the periodic sweep (key `all`). */
export function connectSecretsReconciler(
  deps: (context: Parameters<Reconciler['run']>[0]) => ConnectSecretsDeps,
): Reconciler {
  return {
    name: connectSecretsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: '5m' }],
    async run(context) {
      const resolved = deps(context);
      // Batches until a sweep finds nothing more to do.
      while ((await sweepConnectSecrets(resolved)) >= sweepBatch) {
        if (context.signal.aborted) break;
      }
      return 'DONE';
    },
  };
}
