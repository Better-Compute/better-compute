import type { Migration } from '@better-compute/core';

/**
 * Who a stored secret is for (sandbox review, asked by [c321a3] for [f85da7] and [097b34]): `tenant`
 * secrets are a tenant's own, `fleet` secrets are the platform's (written by `secrets.put` from the
 * scope it decided on), so vps can refuse fleet secrets in sandbox templates. Existing rows are
 * `tenant`: fleet secrets stored in the root tenant before this cannot be told apart, and staying
 * `tenant` there only keeps them usable by root, as before. Additive.
 */
export const secretScopeMigration: Migration = {
  name: 'core/0025_secret_scope',
  sql: `ALTER TABLE secret_refs ADD COLUMN scope text NOT NULL DEFAULT 'tenant' CHECK (scope IN ('tenant', 'fleet'));`,
};
