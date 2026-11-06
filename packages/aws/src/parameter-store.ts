import { randomUUID } from 'node:crypto';
import { ComputeError, type SecretRef, type SecretStore } from '@better-compute/core';
import { transportFor, type AwsServiceOptions } from './common.js';
import { jsonClient } from './internal/transport.js';
import {
  checkNamePrefix,
  checkSegment,
  formatAwsSecretRef,
  parseAwsSecretRef,
  utf8Bytes,
} from './secret-refs.js';

export interface AwsParameterStoreOptions extends AwsServiceOptions {
  /** Parameter path prefix (default '/better-compute'); names are `${prefix}/${tenantId}/${id}`. */
  prefix?: string;
  kmsKeyId?: string;
  /** Standard (4 KiB values) or Advanced (8 KiB). Default Standard. */
  tier?: 'Standard' | 'Advanced';
}

const storeName = 'aws-ssm';

/** id 'aws-parameter-store', schemes ['secret']; refs `secret://aws-ssm/<tenantId>/<id>`; SecureString parameters. */
export function awsParameterStore(options: AwsParameterStoreOptions): SecretStore {
  const prefix = checkNamePrefix(options.prefix ?? '/better-compute', true);
  const tier = options.tier ?? 'Standard';
  if (tier !== 'Standard' && tier !== 'Advanced')
    throw new ComputeError('INVALID_CONFIG', 'tier is Standard or Advanced');
  const maxValueBytes = tier === 'Advanced' ? 8192 : 4096;
  const client = jsonClient(transportFor(options), {
    hostPrefix: 'ssm',
    jsonVersion: '1.1',
    targetPrefix: 'AmazonSSM',
  });
  const nameOf = (tenantId: string, id: string) => `${prefix}/${tenantId}/${id}`;

  function checkValue(value: string): void {
    if (typeof value !== 'string' || value.length === 0)
      throw new ComputeError('INVALID_INPUT', 'a parameter value is a non-empty string');
    if (utf8Bytes(value) > maxValueBytes)
      throw new ComputeError('PAYLOAD_TOO_LARGE', `${tier} parameters hold at most ${maxValueBytes / 1024} KiB`);
  }

  return {
    id: 'aws-parameter-store',
    schemes: ['secret'],

    async put(tenantId, value, putOptions) {
      checkSegment(tenantId, 'tenant id');
      checkValue(value);
      const rotating = putOptions?.ref !== undefined;
      const parsed = rotating
        ? parseAwsSecretRef(storeName, putOptions!.ref!, { tenantId })
        : { tenantId, id: randomUUID() };
      const ref = rotating ? putOptions!.ref! : formatAwsSecretRef(storeName, tenantId, parsed.id);
      await client.call('PutParameter', {
        Name: nameOf(parsed.tenantId, parsed.id),
        Value: value,
        Type: 'SecureString',
        Overwrite: rotating,
        ...(options.kmsKeyId ? { KeyId: options.kmsKeyId } : {}),
        Tier: tier,
        // PutParameter refuses Tags together with Overwrite; the tag was set at creation.
        ...(rotating ? {} : { Tags: [{ Key: 'better-compute:tenant', Value: tenantId }] }),
      });
      return ref;
    },

    async resolve(ref, context) {
      const parsed = parseAwsSecretRef(storeName, ref, context);
      const result = await client.call<{ Parameter?: { Value?: string } }>('GetParameter', {
        Name: nameOf(parsed.tenantId, parsed.id),
        WithDecryption: true,
      });
      const value = result.Parameter?.Value;
      if (typeof value !== 'string')
        throw new ComputeError('PROVIDER_ERROR', 'Parameter Store returned no value');
      return value;
    },

    async delete(ref: SecretRef) {
      const parsed = parseAwsSecretRef(storeName, ref);
      try {
        await client.call('DeleteParameter', { Name: nameOf(parsed.tenantId, parsed.id) });
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'NOT_FOUND') return;
        throw error;
      }
    },
  };
}
