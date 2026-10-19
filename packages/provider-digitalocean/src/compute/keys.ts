import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import type { DoClient } from '../client/http.js';

// SSH keys. DO attaches keys to a Droplet by id and only knows keys that are already in the
// account, so a create first turns each OpenSSH public key into an account key: found by its
// fingerprint, registered as `bc-<fp16>` when missing. Keys are shared by the whole account, so
// the provider never deletes one.

interface DoSshKey {
  id: number;
  fingerprint: string;
  name: string;
  public_key: string;
}

function invalidKey(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, {
    provider: 'digitalocean',
    reason: 'sshKey',
  });
}

const fingerprintPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/;

/** The default key is account configuration, so a bad one is the account's fault. */
function invalidDefault(message: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'digitalocean',
    reason: 'sshKeyFingerprint',
  });
}

const base64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * DO's fingerprint for an OpenSSH public key (`<type> <base64 blob> [comment]`): the MD5 of the
 * decoded blob as colon-separated lowercase hex. A key without a blob, with a blob that isn't
 * base64, or whose blob doesn't open with the type it states is `INVALID_INPUT`.
 */
export function md5Fingerprint(openSshPublicKey: string): string {
  const [type, encoded] = openSshPublicKey.trim().split(/\s+/);
  if (!type || !encoded) throw invalidKey('an SSH public key needs a type and a key blob');
  if (!base64.test(encoded)) throw invalidKey('the SSH public key blob is not valid base64');
  const blob = Buffer.from(encoded, 'base64');
  // The blob starts with its own type as a length-prefixed string.
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  if (typeLength === 0 || blob.subarray(4, 4 + typeLength).toString('latin1') !== type)
    throw invalidKey('the SSH public key blob does not match its stated type');
  return createHash('md5')
    .update(blob)
    .digest('hex')
    .replace(/(..)(?!$)/g, '$1:');
}

/** The account key with this fingerprint, or undefined when there is none. */
async function find(
  client: DoClient,
  fingerprint: string,
  signal: AbortSignal,
): Promise<DoSshKey | undefined> {
  try {
    const reply = await client.request<{ ssh_key: DoSshKey }>(
      'GET',
      `/account/keys/${encodeURIComponent(fingerprint)}`,
      { signal, budget: 'observe' },
    );
    return reply.ssh_key;
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

async function ensureOne(
  client: DoClient,
  publicKey: string,
  fingerprint: string,
  signal: AbortSignal,
) {
  const existing = await find(client, fingerprint, signal);
  if (existing) return existing.id;
  try {
    const created = await client.request<{ ssh_key: DoSshKey }>('POST', '/account/keys', {
      body: {
        name: `bc-${fingerprint.replace(/:/g, '').slice(0, 16)}`,
        public_key: publicKey.trim(),
      },
      signal,
      budget: 'mutate',
    });
    return created.ssh_key.id;
  } catch (error) {
    if (!(error instanceof ComputeError) || error.code !== 'CONFLICT') throw error;
    // Registered by someone else between our lookup and our POST: read theirs. If it still can't
    // be read, the conflict is the answer: no retry loop.
    const raced = await find(client, fingerprint, signal);
    if (raced) return raced.id;
    throw error;
  }
}

/**
 * OpenSSH public keys → DO key ids, registering the ones the account lacks. The ids come in the
 * order given (instance keys first, then `defaultFingerprint`'s key), without duplicates; no keys
 * at all gives `[]`. A default key that isn't in the account is `INVALID_CONFIG`: it is account
 * configuration, not something the caller sent.
 */
export async function ensureSshKeys(
  client: DoClient,
  publicKeys: readonly string[],
  defaultFingerprint: string | undefined,
  signal: AbortSignal,
): Promise<number[]> {
  // Validate everything before the first request, so a bad key sends nothing.
  const wanted = publicKeys.map((key) => ({ key, fingerprint: md5Fingerprint(key) }));
  const fallbackFingerprint = defaultFingerprint?.trim().toLowerCase();
  if (fallbackFingerprint !== undefined && !fingerprintPattern.test(fallbackFingerprint))
    throw invalidDefault(`${JSON.stringify(defaultFingerprint)} is not an MD5 SSH key fingerprint`);
  const ids: number[] = [];
  for (const { key, fingerprint } of wanted)
    ids.push(await ensureOne(client, key, fingerprint, signal));
  if (fallbackFingerprint !== undefined) {
    const fallback = await find(client, fallbackFingerprint, signal);
    if (!fallback)
      throw invalidDefault(
        `the account's sshKeyFingerprint ${fallbackFingerprint} is not an SSH key in this DigitalOcean account`,
      );
    ids.push(fallback.id);
  }
  return [...new Set(ids)];
}
