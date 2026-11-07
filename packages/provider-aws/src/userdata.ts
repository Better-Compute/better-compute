import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ComputeError, type ProviderMount } from '@better-compute/core';

/** EC2's limit on user data, in bytes before base64. */
export const userDataLimit = 16_384;

function partType(payload: string): string {
  if (payload.startsWith('#cloud-config')) return 'text/cloud-config';
  if (payload.startsWith('#!')) return 'text/x-shellscript';
  if (payload.startsWith('#cloud-boothook')) return 'text/cloud-boothook';
  if (payload.startsWith('#include')) return 'text/x-include-url';
  return 'text/plain';
}

/** `gzipSync` with MTIME 0 (zlib's default) and the OS byte pinned to 0xff, so bytes never vary by host. */
function deterministicGzip(data: Buffer): Buffer {
  const out = gzipSync(data, { level: 9 });
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[9] = 0xff;
  return out;
}

/** (A10) The mounts a machine may perform; more is refused. */
export const maxMounts = 16;

const region = '[a-z]{2}(?:-gov)?-[a-z]+-\\d{1,2}';
const mountSources: Readonly<Record<ProviderMount['fstype'], RegExp>> = {
  nfs4: new RegExp(`^fs-[0-9a-f]{8,40}\\.efs\\.${region}\\.amazonaws\\.com(?:\\.cn)?:/$`),
  lustre: new RegExp(
    `^fs-[0-9a-f]{8,40}\\.fsx\\.${region}\\.amazonaws\\.com(?:\\.cn)?@tcp:/[a-z0-9]{1,16}$`,
  ),
};
/** Top-level directories a filesystem never mounts over. */
const reservedRoots = new Set([
  'bin',
  'boot',
  'dev',
  'etc',
  'lib',
  'lib32',
  'lib64',
  'proc',
  'root',
  'run',
  'sbin',
  'snap',
  'sys',
  'tmp',
  'usr',
  'var',
]);
/** How each kind gets its client: whichever package manager the image has. */
const mountClients: Readonly<Record<ProviderMount['fstype'], string>> = {
  nfs4:
    'command -v mount.nfs4 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq nfs-common) || dnf install -y -q nfs-utils || yum install -y -q nfs-utils',
  lustre:
    'command -v mount.lustre >/dev/null 2>&1 || dnf install -y -q lustre-client || yum install -y -q lustre-client || (apt-get update -qq && apt-get install -y -qq lustre-client-modules-aws lustre-client-utils)',
};

const mountError = (message: string) =>
  new ComputeError('INVALID_INPUT', message, undefined, { provider: 'aws', reason: 'mount' });

/**
 * (A10) Checks mounts against what `AwsFilesystems` renders: an EFS or FSx for Lustre source of the
 * right kind, an absolute path of plain segments outside the system directories, and plain
 * options. Anything else is `INVALID_INPUT` (reason `mount`), so no text from a request reaches
 * the machine's shell unchecked.
 */
export function checkMounts(mounts: readonly ProviderMount[]): void {
  if (mounts.length > maxMounts) throw mountError(`a machine takes at most ${maxMounts} mounts`);
  const paths = new Set<string>();
  for (const mount of mounts) {
    const pattern = mountSources[mount?.fstype as ProviderMount['fstype']];
    if (!pattern) throw mountError('a mount is nfs4 or lustre');
    if (typeof mount.source !== 'string' || !pattern.test(mount.source))
      throw mountError(`not a ${mount.fstype} source this provider made`);
    const path = mount.path;
    if (
      typeof path !== 'string' ||
      path.length > 200 ||
      !/^(?:\/[A-Za-z0-9._-]+)+$/.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..') ||
      reservedRoots.has(path.split('/')[1]!)
    )
      throw mountError('a mount path is absolute, plain, and outside the system directories');
    if (typeof mount.options !== 'string' || !/^[a-z0-9_=.,]{1,200}$/.test(mount.options))
      throw mountError('mount options are plain comma-separated words');
    if (paths.has(path)) throw mountError(`${path} is mounted twice`);
    paths.add(path);
  }
}

/**
 * (A10) The user-data part that mounts `mounts` (checked): a shell script, installing each kind's
 * client first, then an fstab line (`nofail`, so a missing filesystem never blocks a boot) and a
 * mount. A shell part, not cloud-config: cloud-config parts merge with replace by default, so a
 * tenant's own `runcmd` or `mounts` would drop ours. It comes before the tenant's part, so a
 * tenant script finds its filesystems mounted.
 */
export function mountsPart(mounts: readonly ProviderMount[]): string {
  checkMounts(mounts);
  const lines = mounts.map((mount) => {
    const entry = `${mount.source} ${mount.path} ${mount.fstype} ${mount.options},nofail 0 0`;
    return (
      `${mountClients[mount.fstype]}\n` +
      `mkdir -p '${mount.path}' && ` +
      `{ grep -qsF '${mount.source} ${mount.path} ' /etc/fstab || echo '${entry}' >> /etc/fstab; } && ` +
      `mount '${mount.path}'\n`
    );
  });
  return `#!/bin/sh\n# better-compute: filesystem mounts\n${lines.join('')}`;
}

/**
 * EC2 user data (AD9). With `sshKeys` or `mounts`, a MIME multipart of a `text/cloud-config` part
 * carrying `ssh_authorized_keys`, (A10) a `text/x-shellscript` part that mounts the filesystems,
 * and the payload part (a multipart/mixed payload, such as an EKS node's, gets those parts added to
 * it, staying one level); the boundary derives from the content, so the same input packs to the same
 * bytes on every host and retry (EC2 compares RunInstances parameters per ClientToken). Gzipped
 * when over 16 384 bytes, and refused with reason `user-data-too-large` when still over.
 */
export function packUserData(
  userData: string,
  sshKeys?: readonly string[],
  mounts?: readonly ProviderMount[],
): { base64: string; gzipped: boolean; bytes: number } {
  let text = userData;
  const parts: string[] = [];
  if (sshKeys && sshKeys.length > 0) {
    for (const key of sshKeys)
      if (typeof key !== 'string' || key.trim() === '' || /[\u0000-\u001f\u007f]/.test(key))
        throw new ComputeError(
          'INVALID_INPUT',
          'an SSH public key is one line of printable text',
          undefined,
          {
            provider: 'aws',
            reason: 'ssh-key',
          },
        );
    parts.push(
      `#cloud-config\nssh_authorized_keys:\n${sshKeys.map((key) => `  - ${JSON.stringify(key.trim())}\n`).join('')}`,
    );
  }
  if (mounts && mounts.length > 0) parts.push(mountsPart(mounts));
  if (parts.length > 0) {
    const flat = intoMultipart(userData, parts);
    if (flat !== undefined) return fit(flat);
    const hash = createHash('sha256');
    for (const body of parts) hash.update(body).update('\0');
    const boundary = `bc-${hash.update(userData).digest('hex').slice(0, 32)}`;
    const part = (type: string, body: string) =>
      `--${boundary}\nContent-Type: ${type}; charset="utf-8"\nMIME-Version: 1.0\nContent-Transfer-Encoding: 7bit\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
    text =
      `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n` +
      parts.map((body) => part(partType(body), body)).join('') +
      (userData === '' ? '' : part(partType(userData), userData)) +
      `--${boundary}--\n`;
  }
  return fit(text);
}

/**
 * A single-level `multipart/mixed` user data (e.g. an EKS node's, whose first part is nodeadm's
 * NodeConfig) with `parts` added (each typed by its first line) before its closing delimiter, so
 * it stays one level: nodeadm reads only the top-level parts. Undefined when `userData` is not a
 * multipart/mixed whose boundary and closing delimiter are found; the caller then wraps it.
 */
function intoMultipart(userData: string, parts: readonly string[]): string | undefined {
  const headerEnd = userData.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return undefined;
  const header = userData.slice(0, headerEnd);
  if (!/^(MIME-Version:|Content-Type:)/i.test(header)) return undefined;
  const type = /^Content-Type:\s*multipart\/mixed;\s*boundary="?([0-9A-Za-z'()+_,./:=?-]{1,70})"?\s*$/im.exec(header);
  if (!type) return undefined;
  const boundary = type[1]!;
  const closing = userData.lastIndexOf(`\n--${boundary}--`);
  if (closing < 0) return undefined;
  const eol = userData.includes('\r\n') ? '\r\n' : '\n';
  const added = parts
    .map(
      (part) =>
        `--${boundary}${eol}Content-Type: ${partType(part)}; charset="utf-8"${eol}MIME-Version: 1.0${eol}` +
        `Content-Transfer-Encoding: 7bit${eol}${eol}${part.split('\n').join(eol)}${part.endsWith('\n') ? '' : eol}`,
    )
    .join('');
  return `${userData.slice(0, closing + 1)}${added}${userData.slice(closing + 1)}`;
}

/** The packed text as EC2 takes it: gzipped when over the limit, refused when still over. */
function fit(text: string): { base64: string; gzipped: boolean; bytes: number } {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length <= userDataLimit)
    return { base64: raw.toString('base64'), gzipped: false, bytes: raw.length };
  const gzipped = deterministicGzip(raw);
  if (gzipped.length > userDataLimit)
    throw new ComputeError(
      'INVALID_INPUT',
      `user data is ${gzipped.length} bytes after gzip; EC2 takes at most ${userDataLimit}`,
      undefined,
      { provider: 'aws', reason: 'user-data-too-large', bytes: gzipped.length },
    );
  return { base64: gzipped.toString('base64'), gzipped: true, bytes: gzipped.length };
}
