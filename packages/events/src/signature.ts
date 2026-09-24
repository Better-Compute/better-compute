// Webhook signatures, the same scheme as better-iam's (PLAN.md §9.3): `X-Better-Compute-Signature: v1=<hex>`,
// an HMAC-SHA256 over `${timestamp}.${body}` with `timestamp` in epoch seconds (`X-Better-Compute-Timestamp`),
// accepted within 5 minutes. While a secret rotates, deliveries carry one `v1=` per live secret.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The headers a webhook delivery carries. */
export const webhookHeaders = {
  event: 'x-better-compute-event',
  delivery: 'x-better-compute-delivery',
  webhook: 'x-better-compute-webhook',
  timestamp: 'x-better-compute-timestamp',
  signature: 'x-better-compute-signature',
} as const;

/** One `v1=<hex>` value. */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')}`;
}

/** The signature header for every live secret (current first), comma-separated. */
export function signatureHeader(
  secrets: readonly string[],
  timestampSeconds: number,
  body: string,
): string {
  return secrets.map((secret) => signPayload(secret, timestampSeconds, body)).join(',');
}

export interface VerifyWebhookInput {
  secret: string;
  /** `X-Better-Compute-Signature`. */
  signature: string;
  /** `X-Better-Compute-Timestamp` (epoch seconds). */
  timestamp: string | number;
  /** The raw request body, exactly as received. */
  body: string;
  /** Default 300. */
  toleranceSeconds?: number;
  /** Epoch milliseconds; default now. */
  now?: number;
}

/**
 * For receivers: true when one of the header's `v1=` values is the HMAC of this body and timestamp under
 * `secret`, and the timestamp is within the tolerance.
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp)) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(Math.floor((input.now ?? Date.now()) / 1000) - timestamp) > tolerance) return false;
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest();
  return input.signature
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .some(
      (hex) => /^[0-9a-f]{64}$/.test(hex) && timingSafeEqual(expected, Buffer.from(hex, 'hex')),
    );
}
