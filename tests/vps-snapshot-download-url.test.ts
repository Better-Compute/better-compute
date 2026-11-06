import { describe, expect, it } from 'vitest';
import type { InstanceSpec } from '@better-compute/core';
import { freshRestoreUrls, type SnapshotStore } from '@better-compute/vps';

function specs(): InstanceSpec[] {
  return [
    { id: 'ins_1', restoreFrom: { url: 's3://b/acme/sbx/snap_1', sha256: 'ab'.repeat(32), imageId: 'snap_1' } } as InstanceSpec,
    { id: 'ins_2' } as InstanceSpec,
  ];
}

describe('SnapshotStore.downloadUrl', () => {
  it('restore uses downloadUrl when the store provides one', async () => {
    const calls: unknown[] = [];
    const store: SnapshotStore = {
      presign: async () => ({ uploadUrl: '', url: '' }),
      downloadUrl: async (input) => {
        calls.push(input);
        return `https://fresh.example/${input.snapshotId}`;
      },
    };
    const out = await freshRestoreUrls(specs(), new Map([['ins_1', 'acme'], ['ins_2', 'acme']]), store);
    expect(out[0]!.restoreFrom).toEqual({ url: 'https://fresh.example/snap_1', sha256: 'ab'.repeat(32), imageId: 'snap_1' });
    expect(out[1]!.restoreFrom).toBeUndefined();
    expect(calls).toEqual([{ tenantId: 'acme', snapshotId: 'snap_1', url: 's3://b/acme/sbx/snap_1' }]);
  });

  it('stores without downloadUrl keep the stored url', async () => {
    const store: SnapshotStore = { presign: async () => ({ uploadUrl: '', url: '' }) };
    const out = await freshRestoreUrls(specs(), new Map([['ins_1', 'acme']]), store);
    expect(out[0]!.restoreFrom!.url).toBe('s3://b/acme/sbx/snap_1');
    expect((await freshRestoreUrls(specs(), new Map(), undefined))[0]!.restoreFrom!.url).toBe('s3://b/acme/sbx/snap_1');
  });
});
