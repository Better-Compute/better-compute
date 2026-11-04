import { createHash } from 'node:crypto';
import type { KubernetesCredentials } from '@better-compute/core';
import type { KubernetesRole } from './types.js';

/**
 * The Kubernetes service account a caller's credential is minted for: `bc-u-`, 16 hex digits of the sha256 of the
 * IAM identity id, and the role (a DNS-1123 label). One subject per role, so a `view` token is never minted for a
 * service account that an earlier `admin` request bound to `cluster-admin`.
 */
export function credentialSubject(identityId: string, role: KubernetesRole): string {
  return `bc-u-${createHash('sha256').update(identityId).digest('hex').slice(0, 16)}-${role}`;
}

/** A YAML double-quoted scalar (JSON strings are valid YAML). */
const quote = (value: string) => JSON.stringify(value);

/**
 * A kubeconfig with one cluster, one user (a bearer token), one context, and `current-context` set. `name` is the
 * cluster's name, used for the cluster and context entries; the user entry is `<subject>@<name>`.
 */
export function renderKubeconfig(
  name: string,
  subject: string,
  credentials: Pick<KubernetesCredentials, 'server' | 'certificateAuthorityData' | 'token'>,
): string {
  const user = `${subject}@${name}`;
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `- name: ${quote(name)}`,
    '  cluster:',
    `    server: ${quote(credentials.server)}`,
    `    certificate-authority-data: ${quote(credentials.certificateAuthorityData)}`,
    'users:',
    `- name: ${quote(user)}`,
    '  user:',
    `    token: ${quote(credentials.token)}`,
    'contexts:',
    `- name: ${quote(name)}`,
    '  context:',
    `    cluster: ${quote(name)}`,
    `    user: ${quote(user)}`,
    `current-context: ${quote(name)}`,
    'preferences: {}',
    '',
  ].join('\n');
}
