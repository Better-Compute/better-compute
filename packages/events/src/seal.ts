// Webhook signing secrets at rest: AES-256-GCM under a key derived (HKDF-SHA256) from the deployment secret,
// bound to the webhook id, so a row copied to another webhook does not open. Previous deployment secrets
// still open old rows while the deployment rotates.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

const version = 'v1';

function key(secret: string, context: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'better-compute/events/webhook-secret', context, 32),
  );
}

export function sealSecret(value: string, secret: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, context), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${version}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

export function openSecret(sealed: string, secrets: readonly string[], context: string): string {
  const [prefix, payload] = sealed.split('.');
  if (prefix !== version || !payload)
    throw new ComputeError('INTERNAL_ERROR', 'A webhook secret is sealed in an unknown format');
  const bytes = Buffer.from(payload, 'base64url');
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key(secret, context), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      // Try the next (previous) deployment secret.
    }
  }
  throw new ComputeError(
    'INTERNAL_ERROR',
    'A webhook secret cannot be opened with the configured secrets',
  );
}

/** A new webhook signing secret: `whsec_` + 32 random bytes. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
