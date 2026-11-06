import { describe, expect, it } from 'vitest';
import { ComputeError, type InstanceSpec, type Logger } from '@better-compute/core';
import { freshRestoreUrls, type SnapshotStore } from '@better-compute/vps';

const stored = (id: string) => ({ url: `s3://b/acme/sbx/${id}`, sha256: 'ab'.repeat(32), imageId: id });

function specs(): InstanceSpec[] {
  return [
    { id: 'ins_1', restoreFrom: stored('snap_1') } as InstanceSpec,
    { id: 'ins_2' } as InstanceSpec,
  ];
}

function recordingLog() {
  const entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => void entries.push({ level, message, ...(fields ? { fields } : {}) });
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return { log, entries };
}

const pending = (tenantId = 'acme') => ({ tenantId, state: 'provisioning' as const });

describe('SnapshotStore.downloadUrl', () => {
  it('a pending restore uses downloadUrl when the store provides one', async () => {
    const calls: unknown[] = [];
    const store: SnapshotStore = {
      presign: async () => ({ uploadUrl: '', url: '' }),
      downloadUrl: async (input) => {
        calls.push(input);
        return `https://fresh.example/${input.snapshotId}`;
      },
    };
    const out = await freshRestoreUrls(specs(), new Map([['ins_1', pending()], ['ins_2', pending()]]), store);
    expect(out[0]!.restoreFrom).toEqual({ url: 'https://fresh.example/snap_1', sha256: 'ab'.repeat(32), imageId: 'snap_1' });
    expect(out[1]!.restoreFrom).toBeUndefined();
    expect(calls).toEqual([{ tenantId: 'acme', snapshotId: 'snap_1', url: 's3://b/acme/sbx/snap_1' }]);
  });

  it('stores without downloadUrl keep the stored url', async () => {
    const store: SnapshotStore = { presign: async () => ({ uploadUrl: '', url: '' }) };
    const out = await freshRestoreUrls(specs(), new Map([['ins_1', pending()]]), store);
    expect(out[0]!.restoreFrom!.url).toBe('s3://b/acme/sbx/snap_1');
    expect((await freshRestoreUrls(specs(), new Map(), undefined))[0]!.restoreFrom!.url).toBe('s3://b/acme/sbx/snap_1');
  });

  it('a restore the host has done keeps the stable stored url (no presigned link in the spec)', async () => {
    let calls = 0;
    const store: SnapshotStore = {
      presign: async () => ({ uploadUrl: '', url: '' }),
      downloadUrl: async () => `https://fresh.example/${++calls}`,
    };
    for (const state of ['running', 'stopped', 'paused', 'rebooting', 'resizing', 'deleting', 'error', 'lost'] as const) {
      const out = await freshRestoreUrls(specs(), new Map([['ins_1', { tenantId: 'acme', state }]]), store);
      expect(out[0]!.restoreFrom).toEqual(stored('snap_1'));
    }
    expect(calls).toBe(0);
    const starting = await freshRestoreUrls(specs(), new Map([['ins_1', { tenantId: 'acme', state: 'starting' as const }]]), store);
    expect(starting[0]!.restoreFrom!.url).toBe('https://fresh.example/1');
  });

  it('one failing downloadUrl keeps that restore on its stored url and never fails the node', async () => {
    const { log, entries } = recordingLog();
    const store: SnapshotStore = {
      presign: async () => ({ uploadUrl: '', url: '' }),
      downloadUrl: async (input) => {
        if (input.snapshotId === 'snap_1')
          throw new ComputeError('ACCESS_DENIED', 'X-Amz-Security-Token=tok denied', undefined, { token: 'tok' });
        return `https://fresh.example/${input.snapshotId}`;
      },
    };
    const two = [
      { id: 'ins_1', restoreFrom: stored('snap_1') } as InstanceSpec,
      { id: 'ins_2', restoreFrom: stored('snap_2') } as InstanceSpec,
    ];
    const out = await freshRestoreUrls(two, new Map([['ins_1', pending()], ['ins_2', pending()]]), store, log);
    expect(out[0]!.restoreFrom).toEqual(stored('snap_1'));
    expect(out[1]!.restoreFrom!.url).toBe('https://fresh.example/snap_2');
    expect(entries).toEqual([
      { level: 'warn', message: 'snapshot download url unavailable; the restore keeps its stored url', fields: { instanceId: 'ins_1', snapshotId: 'snap_1', code: 'ACCESS_DENIED' } },
    ]);
    expect(JSON.stringify(entries)).not.toContain('tok');
    // A non-ComputeError (a bug, a network TypeError) is contained the same way.
    const broken: SnapshotStore = { presign: async () => ({ uploadUrl: '', url: '' }), downloadUrl: async () => { throw new TypeError('boom'); } };
    await expect(freshRestoreUrls(specs(), new Map([['ins_1', pending()]]), broken)).resolves.toHaveLength(2);
  });
});
