import { randomUUID } from 'node:crypto';
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

const storeName = 'aws-sm';
/** Secrets Manager's SecretString limit. */
const maxValueBytes = 64 * 1024;

/** id 'aws-secrets-manager', schemes ['secret']; refs look like `secret://aws-sm/<tenantId>/<id>`. */
export function awsSecretsManagerStore(options: AwsSecretsManagerStoreOptions): SecretStore {
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

    async put(tenantId, value, putOptions) {
      checkSegment(tenantId, 'tenant id');
      checkValue(value);
      if (putOptions?.ref) {
        // Rotate in place, only for a ref of this tenant.
        const parsed = parseAwsSecretRef(storeName, putOptions.ref, { tenantId });
        cache.delete(putOptions.ref);
        await client.call('PutSecretValue', {
          SecretId: nameOf(parsed.tenantId, parsed.id),
          SecretString: value,
          ClientRequestToken: randomUUID(),
        });
        return putOptions.ref;
      }
      const id = randomUUID();
      const ref = formatAwsSecretRef(storeName, tenantId, id);
      await client.call('CreateSecret', {
        Name: nameOf(tenantId, id),
        SecretString: value,
        ...(options.kmsKeyId ? { KmsKeyId: options.kmsKeyId } : {}),
        ClientRequestToken: randomUUID(),
        Tags: [{ Key: 'better-compute:tenant', Value: tenantId }],
      });
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
