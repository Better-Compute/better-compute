import {
  ComputeError,
  defineMethod,
  fleetResourceId,
  type MethodContext,
  type MethodDefinition,
  type SecretRef,
  type SecretStore,
  type SqlTx,
} from '@better-compute/core';
import { admittedOf, fields, int, ms, notFound } from './common.js';
import { parser, v } from './input.js';

// `secrets` (PLAN.md §6 "Secrets", §9.2, §13, module server, v0.2): write-only secret storage.
// `put` hands the value to the SecretStore (sealed at rest) and answers with its `secret://` ref and
// version. No method ever reads a value back. Events and audit rows carry only the ref, name and
// version. Values reach agents through the broker (SecretRequest → JWE to a one-time key), never
// through the API. Decided on `compute-tenant/{t}`, or on `compute-fleet/global` for platform
// secrets (BMC credentials of shared sites) with `scope: 'fleet'` in the root tenant.

export interface PutSecretInput {
  tenantId: string;
  /** A stable name within the tenant: a second put with the same name makes a new version. */
  name: string;
  /** The secret; never returned, logged or published. At most 64 KiB. */
  value: string;
  /** `fleet` for platform secrets, decided on `compute-fleet/global` (root tenant only). */
  scope?: 'tenant' | 'fleet';
  /** A retry with the same key and name answers with the version it wrote, without writing again. */
  idempotencyKey: string;
}
export interface DeleteSecretInput {
  tenantId: string;
  name: string;
  scope?: 'tenant' | 'fleet';
}

/** What the API tells about a secret: never its value. */
export interface SecretInfo {
  ref: SecretRef;
  tenantId: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type SecretsApi = {
  secrets: {
    put: MethodDefinition<PutSecretInput, SecretInfo>;
    delete: MethodDefinition<DeleteSecretInput, { deleted: boolean }>;
  };
};

/** Where `secrets` keeps values: the configured SecretStore (e.g. pki's `localSealedSecretStore`). */
export type SecretStoreSource = SecretStore | ((context: MethodContext) => SecretStore | undefined);

export const maxSecretBytes = 64 * 1024;
const name = v.string({ pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, max: 128 });
const scope = v.withDefault(v.option(['tenant', 'fleet'] as const), 'tenant' as const);
const parsePut = parser({
  tenantId: fields.tenantId,
  name,
  value: v.string({ min: 1, max: maxSecretBytes }),
  scope,
  idempotencyKey: fields.idempotencyKey,
});
function putInput(input: unknown): PutSecretInput {
  const parsed = parsePut(input);
  if (Buffer.byteLength(parsed.value, 'utf8') > maxSecretBytes)
    throw new ComputeError('INVALID_INPUT', `value: at most ${maxSecretBytes} bytes`);
  return parsed;
}
const deleteInput: (input: unknown) => DeleteSecretInput = parser({ tenantId: fields.tenantId, name, scope });

const scopeOf = (input: { tenantId: string; scope?: 'tenant' | 'fleet' }) =>
  input.scope === 'fleet'
    ? { type: 'fleet' as const, id: fleetResourceId }
    : { type: 'tenant' as const, id: input.tenantId };

interface RefRow {
  ref: string;
  tenant_id: string;
  name: string;
  version: unknown;
  store: string;
  last_idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}
const toInfo = (row: RefRow): SecretInfo => ({
  ref: row.ref as SecretRef,
  tenantId: row.tenant_id,
  name: row.name,
  version: int(row.version),
  createdAt: ms(row.created_at)!,
  updatedAt: ms(row.updated_at)!,
});

async function findRef(tx: SqlTx, tenantId: string, secretName: string, lock = '') {
  const { rows } = await tx.query<RefRow>(
    `SELECT ref, tenant_id, name, version, store, last_idempotency_key, created_at, updated_at
       FROM secret_refs WHERE tenant_id = $1 AND name = $2 ${lock}`,
    [tenantId, secretName],
  );
  return rows[0];
}

/** Fleet decisions are made in the root tenant, which owns every platform secret. */
function checkScope(context: MethodContext, input: { tenantId: string; scope?: 'tenant' | 'fleet' }) {
  if (input.scope === 'fleet' && admittedOf(context).tenantId !== input.tenantId)
    throw new ComputeError('INVALID_INPUT', 'tenantId: fleet secrets belong to the root tenant');
}

export function secretsApi(source?: SecretStoreSource): SecretsApi {
  const storeOf = (context: MethodContext): SecretStore => {
    const store = typeof source === 'function' ? source(context) : source;
    if (!store) throw new ComputeError('UNAVAILABLE', 'No secret store is configured');
    return store;
  };
  return {
    secrets: {
      put: defineMethod<PutSecretInput, SecretInfo>({
        action: 'compute:secrets:manage',
        kind: 'mutation',
        resource: scopeOf,
        validate: Object.assign(putInput, { jsonSchema: parsePut.jsonSchema }),
        async handler(context, input) {
          checkScope(context, input);
          const store = storeOf(context);
          const existing = await findRef(context.sql, input.tenantId, input.name, 'FOR UPDATE');
          // A retry of the put that wrote the current version answers with it and writes nothing.
          // Unlike derived-id creates, the key is not scoped to the caller, so replays are decided too.
          if (existing?.last_idempotency_key === input.idempotencyKey) return toInfo(existing);
          if (existing && existing.store !== store.id)
            throw new ComputeError(
              'INVALID_STATE',
              `The secret lives in store ${existing.store}, which is not the configured one`,
            );
          const ref = await store.put(
            input.tenantId,
            input.value,
            existing ? { ref: existing.ref as SecretRef } : undefined,
          );
          const { rows } = await context.sql.query<RefRow>(
            `INSERT INTO secret_refs (ref, tenant_id, name, version, store, last_idempotency_key)
             VALUES ($1, $2, $3, 1, $4, $5)
             ON CONFLICT (tenant_id, name) DO UPDATE
               SET version = secret_refs.version + 1, last_idempotency_key = EXCLUDED.last_idempotency_key,
                   updated_at = compute_now()
             RETURNING ref, tenant_id, name, version, store, last_idempotency_key, created_at, updated_at`,
            [ref, input.tenantId, input.name, store.id, input.idempotencyKey],
          );
          const info = toInfo(rows[0]!);
          await context.events.publish(context.sql, {
            type: 'security.secret.put',
            tenantId: input.tenantId,
            subject: `secret/${info.name}`,
            data: { ref: info.ref, name: info.name, version: info.version },
          });
          return info;
        },
      }),
      delete: defineMethod<DeleteSecretInput, { deleted: boolean }>({
        action: 'compute:secrets:manage',
        kind: 'mutation',
        resource: scopeOf,
        validate: deleteInput,
        async handler(context, input) {
          checkScope(context, input);
          const existing = await findRef(context.sql, input.tenantId, input.name, 'FOR UPDATE');
          // Deleting what is gone is not an error; the answer says whether this call deleted it.
          if (!existing) return { deleted: false };
          const store = storeOf(context);
          if (existing.store !== store.id)
            throw new ComputeError(
              'INVALID_STATE',
              `The secret lives in store ${existing.store}, which is not the configured one`,
            );
          await store.delete(existing.ref as SecretRef);
          await context.sql.query('DELETE FROM secret_refs WHERE ref = $1', [existing.ref]);
          await context.events.publish(context.sql, {
            type: 'security.secret.deleted',
            tenantId: input.tenantId,
            subject: `secret/${existing.name}`,
            data: { ref: existing.ref, name: existing.name, version: int(existing.version) },
          });
          return { deleted: true };
        },
      }),
    },
  };
}

/** For tests and callers that only have the ref: its row, or NOT_FOUND. */
export async function secretInfo(tx: SqlTx, tenantId: string, secretName: string): Promise<SecretInfo> {
  const row = await findRef(tx, tenantId, secretName);
  if (!row) throw notFound('Secret');
  return toInfo(row);
}
