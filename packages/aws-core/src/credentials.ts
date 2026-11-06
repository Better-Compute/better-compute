import type { Clock } from '@better-compute/core';

/** AWS credentials as they are signed with. Never logged, never put in an error. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch ms after which the credentials no longer work (temporary credentials only). */
  readonly expiresAt?: number;
}

/** What a credential source may use while it resolves: the caller's signal and business time. */
export interface CredentialContext {
  signal: AbortSignal;
  clock: Clock;
}

/** Where credentials come from. `invalidate` drops cached credentials (after `ExpiredToken`). */
export interface CredentialSource {
  readonly kind: string;
  credentials(context: CredentialContext): Promise<AwsCredentials>;
  invalidate?(): void;
}
