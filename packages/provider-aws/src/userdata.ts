import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ComputeError } from '@better-compute/core';

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

/**
 * EC2 user data (AD9). With `sshKeys`, a MIME multipart of a `text/cloud-config` part carrying
 * `ssh_authorized_keys` and the payload part (a multipart/mixed payload, such as an EKS node's, gets the
 * keys as one more part, staying one level); the boundary derives from the content, so the same
 * input packs to the same bytes on every host and retry (EC2 compares RunInstances parameters per
 * ClientToken). Gzipped when over 16 384 bytes, and refused with reason `user-data-too-large` when
 * still over.
 */
export function packUserData(
  userData: string,
  sshKeys?: readonly string[],
): { base64: string; gzipped: boolean; bytes: number } {
  let text = userData;
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
    const keysPart = `#cloud-config\nssh_authorized_keys:\n${sshKeys.map((key) => `  - ${JSON.stringify(key.trim())}\n`).join('')}`;
    const flat = intoMultipart(userData, keysPart);
    if (flat !== undefined) return fit(flat);
    const boundary = `bc-${createHash('sha256').update(keysPart).update('\0').update(userData).digest('hex').slice(0, 32)}`;
    const part = (type: string, body: string) =>
      `--${boundary}\nContent-Type: ${type}; charset="utf-8"\nMIME-Version: 1.0\nContent-Transfer-Encoding: 7bit\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
    text =
      `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n` +
      part('text/cloud-config', keysPart) +
      (userData === '' ? '' : part(partType(userData), userData)) +
      `--${boundary}--\n`;
  }
  return fit(text);
}

/**
 * A single-level `multipart/mixed` user data (e.g. an EKS node's, whose first part is nodeadm's
 * NodeConfig) with `part` added as one more `text/cloud-config` part before its closing delimiter, so
 * it stays one level: nodeadm reads only the top-level parts. Undefined when `userData` is not a
 * multipart/mixed whose boundary and closing delimiter are found; the caller then wraps it.
 */
function intoMultipart(userData: string, part: string): string | undefined {
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
  const added =
    `--${boundary}${eol}Content-Type: text/cloud-config; charset="utf-8"${eol}MIME-Version: 1.0${eol}` +
    `Content-Transfer-Encoding: 7bit${eol}${eol}${part.split('\n').join(eol)}`;
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
