import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ComputeError, defineSink, systemClock, type AuditRecord, type AuditSink } from '@better-compute/core';
import { s3Access, type S3StoreOptions } from './s3.js';

export interface S3AuditSinkOptions extends S3StoreOptions {
  /** Default 's3-audit'. */
  id?: string;
  /** S3 Object Lock retention per object (the bucket must have Object Lock enabled). */
  objectLock?: { mode: 'GOVERNANCE' | 'COMPLIANCE'; retainDays: number };
}

const safeId = /^[A-Za-z0-9_-]{1,100}$/;

/** `year=YYYY/month=MM/day=DD/<first>_<last>_<n>.jsonl.gz`: the same batch always maps to the same key. */
export function auditObjectKey(records: readonly AuditRecord[]): string {
  const first = records[0]!;
  const last = records.at(-1)!;
  const day = new Date(first.time);
  if (Number.isNaN(day.getTime())) throw new ComputeError('INVALID_INPUT', 'an audit record has no valid time');
  const pad = (value: number) => String(value).padStart(2, '0');
  const partition = `year=${day.getUTCFullYear()}/month=${pad(day.getUTCMonth() + 1)}/day=${pad(day.getUTCDate())}`;
  const name =
    safeId.test(first.id) && safeId.test(last.id)
      ? `${first.id}_${last.id}_${records.length}`
      : // Ids that are not key-safe: a digest of every id, still deterministic.
        createHash('sha256').update(records.map((record) => record.id).join('\n')).digest('hex').slice(0, 40);
  return `${partition}/${name}.jsonl.gz`;
}

/**
 * The audit archive: one gzipped JSON Lines object per batch under a Hive-style date partition
 * (Athena partition projection on year/month/day), with an SHA-256 checksum and optional Object
 * Lock retention. Idempotent: a redelivered batch rewrites the same key with the same bytes.
 */
export function s3AuditSink(options: S3AuditSinkOptions): AuditSink {
  const s3 = s3Access(options);
  const clock = options.clock ?? systemClock;
  const lock = options.objectLock;
  if (lock) {
    if (lock.mode !== 'GOVERNANCE' && lock.mode !== 'COMPLIANCE')
      throw new ComputeError('INVALID_CONFIG', 'objectLock.mode is GOVERNANCE or COMPLIANCE');
    if (!Number.isInteger(lock.retainDays) || lock.retainDays < 1 || lock.retainDays > 36_500)
      throw new ComputeError('INVALID_CONFIG', 'objectLock.retainDays is 1..36500');
  }
  return defineSink({
    kind: 'audit',
    id: options.id ?? 's3-audit',
    async write(records) {
      if (records.length === 0) return;
      const key = s3.fullKey(auditObjectKey(records));
      const body = gzipSync(Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8'));
      const headers: Record<string, string> = {
        ...s3.sseHeaders(),
        'content-type': 'application/gzip',
        'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64'),
      };
      if (lock) {
        headers['x-amz-object-lock-mode'] = lock.mode;
        headers['x-amz-object-lock-retain-until-date'] = new Date(
          clock.now() + lock.retainDays * 24 * 3600_000,
        ).toISOString();
      }
      const response = await s3.request({ method: 'PUT', key, operation: 'PutObject', headers, body });
      await response.body?.cancel();
    },
  });
}
