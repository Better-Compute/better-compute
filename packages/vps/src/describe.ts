import { createHash } from 'node:crypto';
import { clip, formatDuration } from '@better-compute/capacity';
import { isSecretRef } from './instances.js';

// What a person asked to confirm an agent's vps request reads (§3.4 step 7,
// `MethodAdmission.describe`): the parameters that change what runs, where and for how long. The
// envelope binds the approval to this text, so it is deterministic and complete. Keys appear only as
// fingerprints, user data only as its size and digest: never the text itself.

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** `ssh-ed25519 AAAA… comment` as `ed25519 SHA256:…` (OpenSSH's fingerprint of the key blob). */
export function sshKeyFingerprint(line: string): string {
  const [type = '', blob = ''] = line.trim().split(/\s+/);
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64');
  return `${clip(type.replace(/^ssh-/, ''), 24)} SHA256:${digest.replace(/=+$/, '')}`;
}

/** User data as the approver may see it: whether there is any, how big, and its digest. */
function describeUserData(userData: string | null | undefined): string {
  if (userData === undefined || userData === null || userData === '') return 'no user data';
  if (isSecretRef(userData)) return `user data from ${clip(userData, 80)}`;
  const bytes = Buffer.byteLength(userData);
  const digest = createHash('sha256').update(userData).digest('hex').slice(0, 12);
  return `user data ${bytes} bytes (sha256 ${digest})`;
}

/** `instances.create`: pool, flavor, image, key fingerprints, user data and power state. */
export function describeCreateInstance(input: {
  poolId: string;
  projectId?: string;
  flavor: string;
  imageId: string;
  sshKeys: readonly string[];
  userData?: string;
  desiredState: string;
}): string {
  const keys = input.sshKeys.length
    ? `ssh keys ${input.sshKeys.map(sshKeyFingerprint).join(', ')}`
    : 'no ssh keys';
  const parts = [
    `pool ${clip(input.poolId)}`,
    `flavor ${clip(input.flavor)}`,
    `image ${clip(input.imageId, 80)}`,
    keys,
    describeUserData(input.userData),
    input.desiredState === 'stopped' ? 'created stopped' : 'started',
  ];
  if (input.projectId) parts.push(`project ${clip(input.projectId)}`);
  return clip(`instances.create: ${parts.join('; ')}`, 1200);
}

/** `sandboxes.create`: template, lifetime and the snapshot it restores. */
export function describeCreateSandbox(input: {
  templateId: string;
  ttlSeconds?: number;
  fromSnapshot?: string;
}): string {
  const parts = [
    `template ${clip(input.templateId)}`,
    input.ttlSeconds === undefined
      ? "the template's default lifetime"
      : `for ${formatDuration(input.ttlSeconds * 1000)}`,
  ];
  if (input.fromSnapshot) parts.push(`restoring ${clip(input.fromSnapshot)}`);
  return `sandboxes.create: ${parts.join('; ')}`;
}

/** `sandboxes.extend`, after `prepare` resolved `by` into the absolute `until`. */
export function describeExtendSandbox(input: {
  sandboxId: string;
  until?: number;
  by?: number;
}): string {
  const to =
    input.until !== undefined ? `until ${iso(input.until)}` : `by ${formatDuration(input.by ?? 0)}`;
  return `sandboxes.extend: ${clip(input.sandboxId)} ${to}`;
}
