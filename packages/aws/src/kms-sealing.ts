import { ComputeError } from '@better-compute/core';
import type { SealingKeys } from '@better-compute/pki';
import { transportFor, wipe, type AwsServiceOptions } from './common.js';
import { jsonClient, type JsonClient } from './internal/transport.js';

/** The encryption context sealing keys are wrapped under unless the host picks another. */
export const defaultSealingContext: Readonly<Record<string, string>> = Object.freeze({
  purpose: 'better-compute-sealing',
});

const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

function kms(options: AwsServiceOptions): JsonClient {
  return jsonClient(transportFor(options), { hostPrefix: 'kms', jsonVersion: '1.1', targetPrefix: 'TrentService' });
}

function checkContext(context: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(context);
  if (entries.length === 0) throw new ComputeError('INVALID_CONFIG', 'the KMS encryption context must not be empty');
  for (const [key, value] of entries)
    if (typeof value !== 'string' || key.length === 0)
      throw new ComputeError('INVALID_CONFIG', 'the KMS encryption context maps strings to strings');
  return { ...context };
}

/**
 * Decrypts KMS-wrapped data keys into the `SealingKeys` shape `localSealedSecretStore` accepts. Use
 * it as `localSealedSecretStore({ sql, keys: await kmsSealingKeys({ …, current: 'k2', wrapped: { k1, k2 } }) })`;
 * rotation is local-sealed's own `keys` set. The plaintext keys live only in the returned object.
 */
export async function kmsSealingKeys(
  options: AwsServiceOptions & {
    current: string;
    /** key id → base64 CiphertextBlob from GenerateDataKey (AES_256). */
    wrapped: Readonly<Record<string, string>>;
    /** Must match the context used at generation (default { purpose: 'better-compute-sealing' }). */
    encryptionContext?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  },
): Promise<SealingKeys> {
  const context = checkContext(options.encryptionContext ?? defaultSealingContext);
  const ids = Object.keys(options.wrapped);
  if (ids.length === 0) throw new ComputeError('INVALID_CONFIG', 'no wrapped sealing keys');
  for (const id of ids)
    if (!keyIdPattern.test(id)) throw new ComputeError('INVALID_CONFIG', 'a sealing key id is [A-Za-z0-9_-]{1,64}');
  if (!Object.hasOwn(options.wrapped, options.current))
    throw new ComputeError('INVALID_CONFIG', 'the current sealing key is not among the wrapped keys');
  const client = kms(options);
  const keys: Record<string, Uint8Array> = {};
  try {
    for (const id of ids) {
      const blob = options.wrapped[id]!;
      if (typeof blob !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob))
        throw new ComputeError('INVALID_CONFIG', `wrapped sealing key ${id} is not base64`);
      let result: { Plaintext?: string };
      try {
        result = await client.call<{ Plaintext?: string }>(
          'Decrypt',
          { CiphertextBlob: blob, EncryptionContext: context },
          { signal: options.signal },
        );
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'ACCESS_DENIED')
          throw new ComputeError('ACCESS_DENIED', `KMS refused to unwrap sealing key ${id} (key policy or encryption context)`, undefined, error.details);
        throw error;
      }
      const plaintext = Buffer.from(result.Plaintext ?? '', 'base64');
      if (plaintext.length !== 32) {
        wipe(plaintext);
        throw new ComputeError('INVALID_CONFIG', `wrapped sealing key ${id} is not an AES-256 data key`);
      }
      keys[id] = new Uint8Array(plaintext);
      wipe(plaintext);
    }
  } catch (error) {
    for (const key of Object.values(keys)) wipe(key);
    throw error;
  }
  return { current: options.current, keys };
}

/** A new AES-256 data key under `keyId`, returned ONLY as its KMS ciphertext (base64). */
export async function generateKmsSealingKey(
  options: AwsServiceOptions & {
    keyId: string;
    encryptionContext?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (typeof options.keyId !== 'string' || !/^[A-Za-z0-9:/_+=.@-]{1,2048}$/.test(options.keyId))
    throw new ComputeError('INVALID_INPUT', 'keyId is a KMS key id, ARN or alias');
  const context = checkContext(options.encryptionContext ?? defaultSealingContext);
  // WithoutPlaintext: KMS never sends the plaintext, so there is nothing to zero or leak.
  const result = await kms(options).call<{ CiphertextBlob?: string }>(
    'GenerateDataKeyWithoutPlaintext',
    { KeyId: options.keyId, KeySpec: 'AES_256', EncryptionContext: context },
    { signal: options.signal },
  );
  if (typeof result.CiphertextBlob !== 'string' || result.CiphertextBlob.length === 0)
    throw new ComputeError('PROVIDER_ERROR', 'KMS returned no ciphertext');
  return result.CiphertextBlob;
}
