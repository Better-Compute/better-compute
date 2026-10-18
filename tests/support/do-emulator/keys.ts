import { createHash } from 'node:crypto';
import type { DoEmulator } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// The SSH key endpoints under `/v2/account/keys`. A key is addressed by id or by fingerprint
// (MD5, colon-hex, which this file computes itself rather than borrowing the package's function,
// so the two can be checked against each other). `state.sshKeys` is keyed by fingerprint.

/** The shape of an `ssh_key` body, from the fixture. */
const template = fixture('ssh-keys').ssh_key as Json;

/** MD5 colon-hex of an OpenSSH public key's blob, or undefined when it has none. */
function fingerprintOf(publicKey: string): string | undefined {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? '', 'base64');
  if (blob.length === 0) return undefined;
  return createHash('md5')
    .update(blob)
    .digest('hex')
    .replace(/(..)(?!$)/g, '$1:');
}

/** Puts a key in the account, as if registered out of band; returns the stored resource. */
export function seedSshKey(state: DoState, name: string, publicKey: string): Json {
  const fingerprint = fingerprintOf(publicKey);
  if (fingerprint === undefined) throw new Error('seedSshKey: not an OpenSSH public key');
  const key = {
    ...template,
    id: state.nextId(),
    fingerprint,
    public_key: publicKey.trim(),
    name,
  };
  state.sshKeys.set(fingerprint, key);
  return key;
}

export function registerKeys(emulator: DoEmulator): void {
  emulator.route('GET', /^\/account\/keys$/, (context) =>
    emulator.paged(context, 'ssh_keys', [...context.state.sshKeys.values()]),
  );

  emulator.route('GET', /^\/account\/keys\/([^/]+)$/, (context) => {
    const ref = decodeURIComponent(context.match[1]!);
    const key = [...context.state.sshKeys.values()].find(
      (k) => String(k.id) === ref || k.fingerprint === ref,
    );
    if (!key) return emulator.error('not-found');
    return { status: 200, body: { ssh_key: key } };
  });

  emulator.route('POST', /^\/account\/keys$/, (context) => {
    const { name, public_key: publicKey } = context.body ?? {};
    const fingerprint =
      typeof publicKey === 'string' && typeof name === 'string' && name !== ''
        ? fingerprintOf(publicKey)
        : undefined;
    if (fingerprint === undefined) return emulator.error('422-unknown');
    if (context.state.sshKeys.has(fingerprint)) return emulator.error('422-ssh-key-in-use');
    return { status: 201, body: { ssh_key: seedSshKey(context.state, name, publicKey) } };
  });
}
