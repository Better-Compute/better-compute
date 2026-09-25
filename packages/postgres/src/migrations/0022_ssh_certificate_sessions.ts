import type { Migration } from '@better-compute/core';

/**
 * Break-glass SSH certificates follow their IAM session (security review; asked by [402c97]):
 * better-iam emits no event when a binding is deleted or an activation expires, so a tunnels
 * reconciler re-decides every outstanding certificate (every 60 s, like tunnel re-authorization)
 * through `iam.authorizeSession` on the issuing session and revokes those that fail.
 * - `session_id`: the issuing IAM session (NULL: issued before core/0022, or without a session);
 * - `reauthorized_at`: the last successful re-decision;
 * - `ssh_certificates_outstanding`: the unrevoked certificates, by expiry.
 * Additive.
 */
export const sshCertificateSessionsMigration: Migration = {
  name: 'core/0022_ssh_certificate_sessions',
  sql: `
ALTER TABLE ssh_certificates
  ADD COLUMN session_id text,
  ADD COLUMN reauthorized_at timestamptz;
CREATE INDEX ssh_certificates_outstanding ON ssh_certificates (expires_at) WHERE revoked_at IS NULL;
`,
};
