import { fail } from './input.js';
import { guestMountPath } from './volumes.js';

// (DO P6) How a guest mounts a shared provider volume (a network file share): the view's `mount.source` (the NFS
// source `<host>:<path>` the provider reported) at a path the tenant picks. Pure: it makes the cloud-config `mounts`
// entry and the fstab line, which a tenant puts in an instance's user data or a pool member's bootstrap. The daemon
// mount hook that would apply it is deferred, as P2's block volume mount is.

/** A share mounted from cloud-init or fstab. */
export interface SharedVolumeMount {
  /** The NFS source, `<host>:<path>`. */
  source: string;
  /** Where the guest mounts it (normalised: no trailing `/`). */
  mountPath: string;
  type: 'nfs4';
  /** `_netdev` waits for the network; `nofail` lets a boot finish while the share is unreachable. */
  options: string;
  /** The cloud-config `mounts:` entry: `[source, mountPath, type, options, dump, pass]`. */
  cloudConfig: [string, string, 'nfs4', string, '0', '0'];
  /** The `/etc/fstab` line. */
  fstab: string;
}

// A host name or IPv4 address, then an absolute export path: nothing a mount table or YAML would read as more.
const sourcePattern = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*):(\/[A-Za-z0-9._\-/]{0,254})$/;

function sourceOf(value: unknown): string {
  const match = typeof value === 'string' ? sourcePattern.exec(value) : null;
  if (!match || match[1]!.length > 253 || /(^|\/)\.\.?(\/|$)/.test(match[2]!) || match[2]!.includes('//'))
    return fail('source must be an NFS source <host>:<absolute path> (the shared volume view’s mount.source)');
  return value as string;
}

/**
 * The cloud-config and fstab mount of a shared volume. INVALID_INPUT for a source that is not `<host>:<path>` or a
 * mount path that is relative, has `.`/`..` segments or would cover part of the system (`/`, `/etc`, `/usr`, …), as
 * for a sandbox volume's mount.
 */
export function sharedVolumeMount(
  source: string,
  mountPath: string,
  options: { readOnly?: boolean } = {},
): SharedVolumeMount {
  const from = sourceOf(source);
  const at = guestMountPath(mountPath, 'shared volume');
  const flags = `${options.readOnly === true ? 'ro' : 'defaults'},_netdev,nofail`;
  return {
    source: from,
    mountPath: at,
    type: 'nfs4',
    options: flags,
    cloudConfig: [from, at, 'nfs4', flags, '0', '0'],
    fstab: `${from} ${at} nfs4 ${flags} 0 0`,
  };
}
