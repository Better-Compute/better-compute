import { createHash, randomUUID } from 'node:crypto';
import { ComputeError, systemClock, type SecretRef, type SecretStore } from '@better-compute/core';
import { transportFor, type AwsServiceOptions } from './common.js';
import { jsonClient } from './internal/transport.js';
import {
  checkNamePrefix,
  checkSegment,
  formatAwsSecretRef,
  parseAwsSecretRef,
  utf8Bytes,
} from './secret-refs.js';

export interface AwsSecretsManagerStoreOptions extends AwsServiceOptions {
  /** Secret name prefix (default 'better-compute'); names are `${prefix}/${tenantId}/${id}`. */
  prefix?: string;
  kmsKeyId?: string;
  /** DeleteSecret recovery window (default 7, min 7, max 30); 0 = ForceDeleteWithoutRecovery. */
  recoveryWindowDays?: number;
  /** Cache resolved values for this long (default 0 = no cache). */
  cacheTtlMs?: number;
}

/** What `put` of the Secrets Manager store takes on top of the `SecretStore` contract. */
export interface AwsSecretPutOptions {
  /** Rotate this ref in place instead of creating a secret. */
  ref?: SecretRef;
  /**
   * The caller's key for this put (1 to 256 characters). The secret's name and the request token
   * are derived from it and the tenant, so a put that is retried with the same key (its answer was
   * lost, the caller restarted) answers with the same ref and creates nothing new. The same key
   * with another value is `CONFLICT`. Never part of a name or a log as it is (only its SHA-256).
   */
  idempotencyKey?: string;
}

/** The Secrets Manager `SecretStore`, whose `put` also takes an idempotency key. */
export interface AwsSecretsManagerStore extends SecretStore {
  put(tenantId: string, value: string, options?: AwsSecretPutOptions): Promise<SecretRef>;
}

const storeName = 'aws-sm';
/** Secrets Manager's SecretString limit. */
const maxValueBytes = 64 * 1024;

/** A UUID-shaped SHA-256 of the parts: a stable secret id or ClientRequestToken (32 to 64 characters). */
function derivedId(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part.length}:${part}`);
  const hex = hash.digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Whether a failed CreateSecret may have created the secret all the same: no answer (a timeout, a
 * dropped connection), a 5xx, or an answer this code cannot place. A refusal (4xx) created nothing.
 */
function mayHaveCreated(error: unknown): boolean {
  if (!(error instanceof ComputeError)) return true;
  return error.code === 'UNAVAILABLE' || error.code === 'PROVIDER_ERROR';
}

/** id 'aws-secrets-manager', schemes ['secret']; refs look like `secret://aws-sm/<tenantId>/<id>`. */
export function awsSecretsManagerStore(options: AwsSecretsManagerStoreOptions): AwsSecretsManagerStore {
  const prefix = checkNamePrefix(options.prefix ?? 'better-compute', false);
  const recovery = options.recoveryWindowDays ?? 7;
  if (recovery !== 0 && !(Number.isInteger(recovery) && recovery >= 7 && recovery <= 30))
    throw new ComputeError('INVALID_CONFIG', 'recoveryWindowDays is 0 or 7..30');
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const clock = options.clock ?? systemClock;
  const client = jsonClient(transportFor(options), {
    hostPrefix: 'secretsmanager',
    jsonVersion: '1.1',
    targetPrefix: 'secretsmanager',
  });
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const nameOf = (tenantId: string, id: string) => `${prefix}/${tenantId}/${id}`;

  function checkValue(value: string): void {
    if (typeof value !== 'string') throw new ComputeError('INVALID_INPUT', 'a secret value is a string');
    if (utf8Bytes(value) > maxValueBytes)
      throw new ComputeError('PAYLOAD_TOO_LARGE', 'Secrets Manager values are at most 64 KiB');
  }

  return {
    id: 'aws-secrets-manager',
    schemes: ['secret'],

    async put(tenantId, value, putOptions: AwsSecretPutOptions = {}) {
      checkSegment(tenantId, 'tenant id');
      checkValue(value);
      const key = putOptions.idempotencyKey;
      if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 256))
        throw new ComputeError('INVALID_INPUT', 'an idempotency key is 1 to 256 characters');
      if (putOptions.ref) {
        // Rotate in place, only for a ref of this tenant.
        const parsed = parseAwsSecretRef(storeName, putOptions.ref, { tenantId });
        cache.delete(putOptions.ref);
        await client.call('PutSecretValue', {
          SecretId: nameOf(parsed.tenantId, parsed.id),
          SecretString: value,
          // With the caller's key a retried rotation is the same version, not one more.
          ClientRequestToken:
            key === undefined ? randomUUID() : derivedId('rotate', putOptions.ref, key),
        });
        return putOptions.ref;
      }
      // With the caller's key the name and the token are the same on every attempt: Secrets Manager
      // answers a repeated CreateSecret (same name, token and value) with the secret it made, so a
      // retry after a lost answer returns the same ref instead of a second secret.
      const id = key === undefined ? randomUUID() : derivedId('secret', tenantId, key);
      const token = key === undefined ? randomUUID() : derivedId('create', tenantId, key);
      const ref = formatAwsSecretRef(storeName, tenantId, id);
      try {
        await client.call('CreateSecret', {
          Name: nameOf(tenantId, id),
          SecretString: value,
          ...(options.kmsKeyId ? { KmsKeyId: options.kmsKeyId } : {}),
          ClientRequestToken: token,
          Tags: [{ Key: 'better-compute:tenant', Value: tenantId }],
        });
      } catch (error) {
        // Without a key the caller's retry uses another name, and nobody holds a ref to this one:
        // if the request created the secret after all, tenant plaintext would stay behind with
        // nothing to delete it by. It is removed here, best effort (the name is known only now).
        if (key === undefined && mayHaveCreated(error))
          await client
            .call('DeleteSecret', { SecretId: nameOf(tenantId, id), ForceDeleteWithoutRecovery: true })
            .catch(() => undefined);
        throw error;
      }
      return ref;
    },

    async resolve(ref, context) {
      const parsed = parseAwsSecretRef(storeName, ref, context);
      const cached = cache.get(ref);
      if (cached && cached.expiresAt > clock.now()) return cached.value;
      const result = await client.call<{ SecretString?: string }>('GetSecretValue', {
        SecretId: nameOf(parsed.tenantId, parsed.id),
      });
      if (typeof result.SecretString !== 'string')
        throw new ComputeError('INVALID_STATE', 'the secret has no string value (SecretBinary is not served)');
      if (cacheTtlMs > 0) cache.set(ref, { value: result.SecretString, expiresAt: clock.now() + cacheTtlMs });
      return result.SecretString;
    },

    async delete(ref: SecretRef) {
      const parsed = parseAwsSecretRef(storeName, ref);
      cache.delete(ref);
      try {
        await client.call('DeleteSecret', {
          SecretId: nameOf(parsed.tenantId, parsed.id),
          ...(recovery === 0 ? { ForceDeleteWithoutRecovery: true } : { RecoveryWindowInDays: recovery }),
        });
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'NOT_FOUND') return;
        throw error;
      }
    },
  };
}
