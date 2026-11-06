/** AWS credentials as they are signed with. Never logged, never put in an error. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch ms after which the credentials no longer work (temporary credentials only). */
  readonly expiresAt?: number;
}
