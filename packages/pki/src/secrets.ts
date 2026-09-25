import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  ComputeError,
  newId,
  type Migration,
  type SecretRef,
  type SecretStore,
  type SqlTx,
} from '@better-compute/core';
import {
  SecretRequestSchema,
  SecretResponseSchema,
  secretRequestSigningInput,
  type SecretRequest,
  type SecretResponse,
} from '@better-compute/protocol';
import { openJwe, sealJwe } from './jwe.js';
import { p256Point, p256PublicKeyFromPoint } from './keys.js';
import {
  signNodeStatement,
  verifyNodeStatement,
  type VerifyNodeStatementOptions,
} from './node-signatures.js';

// Secrets (PLAN.md §6 "Secrets", §13): Postgres holds only `secret://` refs; values are sealed at
// rest, never read back through the API, and reach an agent only as a JWE to a key it made for
// that one request, after `api` checked the request's node signature and binding.

// --- secret:// refs -----------------------------------------------------------------------------

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const idPattern = /^[A-Za-z0-9._-]{1,128}$/;

/** `secret://<tenantId>/<id>`: the refs the local sealed store hands out. */
export function parseSecretRef(ref: string): { tenantId: string; id: string } | undefined {
  const match = /^secret:\/\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match || !tenantPattern.test(match[1]!) || !idPattern.test(match[2]!)) return undefined;
  return { tenantId: match[1]!, id: match[2]! };
}

export function formatSecretRef(tenantId: string, id: string): SecretRef {
  if (!tenantPattern.test(tenantId) || !idPattern.test(id))
    throw new ComputeError('INVALID_INPUT', 'A secret ref is secret://<tenant>/<id>');
  return `secret://${tenantId}/${id}`;
}

// --- The local sealed store ---------------------------------------------------------------------

/** The table behind `localSealedSecretStore`, as a pki-owned module migration. */
export const sealedSecretsMigration: Migration = {
  name: 'pki/0001_sealed_secrets',
  sql: `
CREATE TABLE sealed_secrets (
  ref text PRIMARY KEY CHECK (ref LIKE 'secret://%'),
  tenant_id text NOT NULL,
  -- Which sealing key (keys.current when written); old keys stay listed until reseal() ran.
  key_id text NOT NULL,
  iv bytea NOT NULL CHECK (length(iv) = 12),
  -- AES-256-GCM ciphertext followed by its 16-byte tag; the AAD binds ref and tenant.
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
CREATE INDEX sealed_secrets_tenant ON sealed_secrets (tenant_id);
CREATE INDEX sealed_secrets_key ON sealed_secrets (key_id);
`,
};

/** Sealing keys by id; `current` seals new values, the others only open old ones. */
export interface SealingKeys {
  current: string;
  keys: Readonly<Record<string, string | Uint8Array>>;
}

export interface LocalSealedSecretStoreOptions {
  /** The database (or a transaction) holding `sealed_secrets`. */
  sql: SqlTx;
  /** One secret (at least 32 bytes), or several for rotation. */
  keys: string | Uint8Array | SealingKeys;
  /** Largest value accepted (default 64 KiB). */
  maxValueBytes?: number;
}

export interface LocalSealedSecretStore extends SecretStore {
  /**
   * Re-seals up to `limit` rows written under an old key with `keys.current`, in ref order after
   * `after`. Rows that no longer open (damaged, moved or under an unlisted key) are skipped and
   * reported; `last` is the cursor for the next page (undefined when this page was the last).
   */
  reseal(options?: { limit?: number; after?: string }): Promise<{
    resealed: number;
    unreadable: string[];
    last?: string;
  }>;
}

interface SealedRow {
  ref: string;
  tenant_id: string;
  key_id: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function deriveKey(secret: string | Uint8Array): Buffer {
  const material = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (material.length < 32)
    throw new ComputeError('INVALID_CONFIG', 'A sealing key must be at least 32 bytes');
  return Buffer.from(
    hkdfSync('sha256', material, 'better-compute', 'better-compute/sealed-secrets/v1', 32),
  );
}

function aad(ref: string, tenantId: string): Buffer {
  return Buffer.from(`better-compute/sealed-secret/v1\0${ref}\0${tenantId}`, 'utf8');
}

/**
 * The `local-sealed` SecretStore: AES-256-GCM under an HKDF-derived key, one row per ref in
 * `sealed_secrets`. The AAD binds each ciphertext to its ref and tenant, so copying a row under
 * another ref or tenant makes it unreadable. `put` never lets one tenant overwrite another's ref.
 */
export function localSealedSecretStore(
  options: LocalSealedSecretStoreOptions,
): LocalSealedSecretStore {
  const keySet: SealingKeys =
    typeof options.keys === 'string' || options.keys instanceof Uint8Array
      ? { current: 'k1', keys: { k1: options.keys } }
      : options.keys;
  const derived = new Map<string, Buffer>();
  for (const [id, secret] of Object.entries(keySet.keys)) derived.set(id, deriveKey(secret));
  if (!derived.has(keySet.current))
    throw new ComputeError(
      'INVALID_CONFIG',
      `The current sealing key ${keySet.current} is not listed`,
    );
  const maxValueBytes = options.maxValueBytes ?? 64 * 1024;
  const sql = options.sql;

  const seal = (ref: string, tenantId: string, value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derived.get(keySet.current)!, iv);
    cipher.setAAD(aad(ref, tenantId));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      keyId: keySet.current,
      iv: new Uint8Array(iv),
      ciphertext: new Uint8Array(ciphertext),
    };
  };
  const open = (row: SealedRow): string => {
    const key = derived.get(row.key_id);
    if (!key)
      throw new ComputeError(
        'INVALID_CONFIG',
        `Secret ${row.ref} is sealed under unknown key ${row.key_id}`,
      );
    const data = Buffer.from(row.ciphertext);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv));
      decipher.setAAD(aad(row.ref, row.tenant_id));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([
        decipher.update(data.subarray(0, data.length - 16)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ComputeError(
        'INVALID_STATE',
        `Secret ${row.ref} cannot be unsealed (damaged or moved)`,
      );
    }
  };
  const checkRef = (ref: string) => {
    const parsed = parseSecretRef(ref);
    if (!parsed)
      throw new ComputeError('INVALID_INPUT', 'This store serves secret://<tenant>/<id> refs');
    return parsed;
  };

  return {
    id: 'local-sealed',
    schemes: ['secret'],
    async put(tenantId, value, putOptions = {}) {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxValueBytes)
        throw new ComputeError(
          'INVALID_INPUT',
          `A secret value is a string of at most ${maxValueBytes} bytes`,
        );
      const ref = putOptions.ref ?? formatSecretRef(tenantId, newId('sec'));
      if (checkRef(ref).tenantId !== tenantId)
        throw new ComputeError('INVALID_INPUT', 'The ref names another tenant');
      const sealed = seal(ref, tenantId, value);
      const { rowCount } = await sql.query(
        `INSERT INTO sealed_secrets (ref, tenant_id, key_id, iv, ciphertext)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ref) DO UPDATE
           SET key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext,
               updated_at = compute_now()
         WHERE sealed_secrets.tenant_id = EXCLUDED.tenant_id`,
        [ref, tenantId, sealed.keyId, sealed.iv, sealed.ciphertext],
      );
      if (rowCount !== 1) throw new ComputeError('CONFLICT', 'The ref belongs to another tenant');
      return ref as SecretRef;
    },
    async resolve(ref) {
      checkRef(ref);
      const { rows } = await sql.query<SealedRow>(
        'SELECT ref, tenant_id, key_id, iv, ciphertext FROM sealed_secrets WHERE ref = $1',
        [ref],
      );
      const row = rows[0];
      if (!row) throw new ComputeError('NOT_FOUND', `Secret ${ref} not found`);
      return open(row);
    },
    async delete(ref) {
      checkRef(ref);
      await sql.query('DELETE FROM sealed_secrets WHERE ref = $1', [ref]);
    },
    async reseal(resealOptions = {}) {
      const limit = resealOptions.limit ?? 1000;
      const { rows } = await sql.query<SealedRow>(
        `SELECT ref, tenant_id, key_id, iv, ciphertext FROM sealed_secrets
          WHERE key_id <> $1 AND ref > $2 ORDER BY ref LIMIT $3`,
        [keySet.current, resealOptions.after ?? '', limit],
      );
      let resealed = 0;
      const unreadable: string[] = [];
      for (const row of rows) {
        let value: string;
        try {
          value = open(row);
        } catch {
          unreadable.push(row.ref);
          continue;
        }
        const sealed = seal(row.ref, row.tenant_id, value);
        const updated = await sql.query(
          `UPDATE sealed_secrets SET key_id = $2, iv = $3, ciphertext = $4, updated_at = compute_now()
            WHERE ref = $1 AND key_id = $5`,
          [row.ref, sealed.keyId, sealed.iv, sealed.ciphertext, row.key_id],
        );
        resealed += updated.rowCount;
      }
      const last = rows.length === limit ? rows[rows.length - 1]!.ref : undefined;
      return { resealed, unreadable, ...(last !== undefined ? { last } : {}) };
    },
  };
}

// --- SecretRequest / SecretResponse -------------------------------------------------------------

/** `typ` of a SecretResponse JWE: it never opens as anything else. */
export const secretResponseType = 'bcsecret+jwe';

/** The refusal codes `SecretResponse.error` carries. */
export type SecretRefusal = 'not-found' | 'not-bound' | 'access-denied' | 'unavailable';

export interface OpenedSecretRequest {
  ref: string;
  requestId: string;
  workflowId: string;
  stepId: string;
  allocationId: string;
  /** The one-time key the response is sealed to. */
  recipient: KeyObject;
  /** The node certificate that signed the request. */
  serial: string;
}

export interface OpenSecretRequestOptions extends VerifyNodeStatementOptions {
  /**
   * Whether the ref is bound to the agent's current step or allocation (the broker's check against
   * workflows and allocations). A false answer refuses with `not-bound`.
   */
  isBound(request: OpenedSecretRequest): boolean | Promise<boolean>;
}

/**
 * The broker's check of a `SecretRequest` (§6): the node signature over every field (against
 * `node_certs`, for the session's node), a valid one-time P-256 key, and the binding. Throws
 * `ACCESS_DENIED` with `details.refusal` set to the `SecretResponse.error` to send.
 */
export async function openSecretRequest(
  request: SecretRequest,
  options: OpenSecretRequestOptions,
): Promise<OpenedSecretRequest> {
  const refuse = (refusal: SecretRefusal, reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Secret request refused', undefined, { refusal, reason });
  if (!request.ref || !request.requestId)
    throw refuse('access-denied', 'missing ref or request id');
  if (!request.workflowId && !request.allocationId)
    throw refuse('not-bound', 'the request names no workflow step or allocation');
  let verified;
  try {
    verified = await verifyNodeStatement(
      secretRequestSigningInput(request),
      request.nodeSig,
      options,
    );
  } catch (error) {
    throw refuse(
      'access-denied',
      String((error as ComputeError).details?.reason ?? 'bad signature'),
    );
  }
  let recipient: KeyObject;
  try {
    recipient = p256PublicKeyFromPoint(request.epk);
  } catch {
    throw refuse('access-denied', 'epk is not a P-256 point');
  }
  const opened: OpenedSecretRequest = {
    ref: request.ref,
    requestId: request.requestId,
    workflowId: request.workflowId,
    stepId: request.stepId,
    allocationId: request.allocationId,
    recipient,
    serial: verified.serial,
  };
  if (!(await options.isBound(opened)))
    throw refuse('not-bound', 'the ref is not bound to current work');
  return opened;
}

/**
 * A `SecretResponse` carrying `value` as a JWE to the request's one-time key. With `expiresAt`
 * (epoch ms) the authenticated header carries `exp` (seconds), and agents refuse it afterwards.
 */
export function sealSecretResponse(
  request: OpenedSecretRequest,
  value: string,
  options: { expiresAt?: number } = {},
): SecretResponse {
  return create(SecretResponseSchema, {
    ref: request.ref,
    requestId: request.requestId,
    jwe: sealJwe(value, request.recipient, {
      typ: secretResponseType,
      ref: request.ref,
      rid: request.requestId,
      ...(options.expiresAt !== undefined ? { exp: Math.floor(options.expiresAt / 1000) } : {}),
    }),
  });
}

/** A refusal `SecretResponse` (no value, no hint beyond the code). */
export function refuseSecretRequest(
  request: Pick<SecretRequest, 'ref' | 'requestId'>,
  refusal: SecretRefusal,
): SecretResponse {
  return create(SecretResponseSchema, {
    ref: request.ref,
    requestId: request.requestId,
    error: refusal,
  });
}

/** The agent side: a signed `SecretRequest` with a fresh one-time key (keep the private half). */
export function createSecretRequest(options: {
  nodeKey: KeyObject;
  ref: string;
  requestId?: string;
  workflowId?: string;
  stepId?: string;
  allocationId?: string;
}): { request: SecretRequest; ephemeralKey: KeyObject } {
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fields = {
    ref: options.ref,
    requestId: options.requestId ?? newId('req'),
    workflowId: options.workflowId ?? '',
    stepId: options.stepId ?? '',
    allocationId: options.allocationId ?? '',
    epk: p256Point(ephemeral.publicKey),
  };
  return {
    request: create(SecretRequestSchema, {
      ...fields,
      nodeSig: signNodeStatement(options.nodeKey, secretRequestSigningInput(fields)),
    }),
    ephemeralKey: ephemeral.privateKey,
  };
}

/**
 * The agent side: the value of a `SecretResponse`, opened with the request's one-time key. The JWE
 * must name the same ref and request. Throws `ACCESS_DENIED` for a refusal.
 */
export function openSecretResponse(
  response: SecretResponse,
  ephemeralKey: KeyObject,
  expect: { ref: string; requestId: string; now?: number },
): string {
  if (response.error)
    throw new ComputeError('ACCESS_DENIED', `Secret refused: ${response.error}`, undefined, {
      refusal: response.error,
    });
  const opened = openJwe(response.jwe, ephemeralKey, { typ: secretResponseType });
  if (opened.header.ref !== expect.ref || opened.header.rid !== expect.requestId)
    throw new ComputeError('ACCESS_DENIED', 'The secret response answers another request');
  const exp = opened.header.exp;
  if (exp !== undefined) {
    if (typeof exp !== 'number' || (expect.now ?? Date.now()) > exp * 1000)
      throw new ComputeError('ACCESS_DENIED', 'The secret response has expired');
  }
  return new TextDecoder().decode(opened.plaintext);
}
