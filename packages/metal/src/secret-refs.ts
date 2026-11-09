import { ComputeError, type SecretRef } from '@better-compute/core';

// Whose secrets a machine's BMC credentials may be. The site agent fetches `bmc.credentials` and
// presents it to `bmc.address`, and the enrolling caller chooses both: a ref it could name freely
// would be read out to an address of its choosing. The broker's step binding checks only that a live
// command of the workflow carries the ref, so the tenant is checked here, where the ref is taken.

/** The tenant of a `secret://<tenant>/<id>` ref (pki's `parseSecretRef`); undefined for anything else. */
export function secretRefTenant(ref: string): string | undefined {
  return /^secret:\/\/([A-Za-z0-9._:-]{1,128})\/[A-Za-z0-9._-]{1,128}$/.exec(ref)?.[1];
}

/**
 * Why `tenantId` may not name `ref` for one of its machines, or undefined when it may:
 * - `secret://` refs must be the tenant's own (`secret://<tenantId>/<id>`), whoever calls;
 * - `env://` (the control plane's own environment) and `vault://` only from a root caller.
 */
export function credentialRefRefusal(ref: string, tenantId: string, rootCaller: boolean): string | undefined {
  if (ref.startsWith('secret://'))
    return secretRefTenant(ref) === tenantId ? undefined : `it must be one of the tenant's own secrets, secret://${tenantId}/<id>`;
  const scheme = /^([a-z]+):\/\//.exec(ref)?.[1] ?? 'such';
  return rootCaller ? undefined : `only the root tenant may name ${scheme}:// references; use secret://${tenantId}/<id>`;
}

/** Refuses (`ACCESS_DENIED`) a `bmc.credentials` ref the enrolling tenant may not name. */
export function assertCredentialRef(ref: SecretRef, tenantId: string, rootCaller: boolean): void {
  const refusal = credentialRefRefusal(ref, tenantId, rootCaller);
  if (refusal) throw new ComputeError('ACCESS_DENIED', `bmc.credentials is refused: ${refusal}`);
}

/**
 * Before a stored ref travels in a command (rows enrolled before the check existed): a `secret://`
 * ref of another tenant is never sent. `env://` and `vault://` refs are a root caller's by now.
 */
export function assertStoredCredentialRef(node: { node_id: string; tenant_id: string; bmc_credentials: string | null }): void {
  const ref = node.bmc_credentials;
  if (ref?.startsWith('secret://') && secretRefTenant(ref) !== node.tenant_id)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Node ${node.node_id}'s BMC credentials are not a secret of its tenant (secret://${node.tenant_id}/<id>); enroll the machine again`,
    );
}
