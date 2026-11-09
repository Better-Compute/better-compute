// The SigV4 signer is aws-core's: one implementation signs for every AWS package. This module used
// to carry a private copy that had drifted from it; it now only re-exports what this package uses
// and keeps the one helper aws-core does not export. It is not exported from the package.
export {
  canonicalRequest,
  presignUrl,
  signRequest,
  type AwsCredentials,
  type PresignInput,
  type SigningInput,
} from '@better-compute/aws-core';

/** RFC 3986 percent-encoding: only `A-Za-z0-9-._~` stays literal. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
