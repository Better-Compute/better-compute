import { ComputeError, type SecretBroker, type SecretRef } from '@better-compute/core';

// An in-memory SecretBroker for module tests: what was sealed, for whom, and what was destroyed.

export interface MemorySecrets extends SecretBroker {
  values: Map<SecretRef, { tenantId: string; value: string }>;
  deleted: SecretRef[];
  delete(ref: SecretRef): Promise<void>;
}

export function memorySecrets(): MemorySecrets {
  let next = 0;
  const values = new Map<SecretRef, { tenantId: string; value: string }>();
  const deleted: SecretRef[] = [];
  return {
    values,
    deleted,
    async put(tenantId, value) {
      const ref = `secret://mem/${tenantId}/${++next}` as SecretRef;
      values.set(ref, { tenantId, value });
      return ref;
    },
    async resolve(ref, context) {
      const entry = values.get(ref);
      if (!entry) throw new ComputeError('NOT_FOUND', 'No such secret');
      if (context && context.tenantId !== entry.tenantId)
        throw new ComputeError('ACCESS_DENIED', 'This secret is another tenant’s');
      return entry.value;
    },
    async delete(ref) {
      values.delete(ref);
      deleted.push(ref);
    },
  };
}
