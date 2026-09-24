import { publicJwk, type PkiBundle } from '@better-compute/pki';

/**
 * The join keys `/.well-known/better-compute` publishes (PLAN.md §6 Install): the install script writes the
 * encryption key and pins; bcd falls back to these only when they match its pins, so publishing them is safe.
 */
export function joinKeysWellKnown(
  bundle: Pick<PkiBundle, 'trustDomain' | 'joinEncryption' | 'joinSigning'>,
): Record<string, unknown> {
  return {
    trustDomain: bundle.trustDomain,
    joinEncryptionJwk: publicJwk(bundle.joinEncryption.publicKey),
    joinSigningCertificate: Buffer.from(bundle.joinSigning.certificate).toString('base64'),
  };
}
