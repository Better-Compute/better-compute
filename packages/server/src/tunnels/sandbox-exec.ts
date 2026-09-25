import {
  ComputeError,
  defineMethod,
  describedBy,
  newId,
  strictObject,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import {
  parseSshPublicKey,
  type ExecTicketIssuer,
  type SshCertificateAuthority,
} from '@better-compute/pki';

// `sandboxes.exec` (PLAN.md §3.7, v0.5): a sandbox has no in-guest agent, so exec is SSH through a
// tunnel. One call decides `compute:sandboxes:exec` on the sandbox and returns both halves:
// - an `ssh` exec ticket for the sandbox's instance (the node's daemon dials the instance's own
//   address, so it needs `tunnel.instance-dial`), stamped with the decided action and the sandbox
//   (`sbx`), so gateway re-authorization decides the same action on the same sandbox;
// - a short user certificate from the sandbox SSH CA for `<account>@<instanceId>`: the instance's
//   sshd trusts that CA and accepts only its own principal (vps renders both into its user data), so
//   a certificate for one sandbox opens no other.
// Guests have no agent to receive a KRL, so the certificate's short lifetime (≤ 15 min, never past
// the caller's session) is the revocation control; tunnel re-authorization closes the transport.

export interface SandboxExecInput {
  tenantId: string;
  sandboxId: string;
  /** The caller's OpenSSH public key line (Ed25519 or ECDSA P-256). */
  publicKey: string;
  /** Certificate lifetime, 60 to 900 (default 600). */
  ttlSeconds?: number;
}

export interface SandboxExec {
  sandboxId: string;
  instanceId: string;
  nodeId: string;
  tunnelId: string;
  /** Single use, valid until `expiresAt`: open `GET {basePath}/{path}` with it, then speak SSH. */
  ticket: string;
  path: string;
  expiresAt: number;
  /** The OpenSSH certificate line: save it as `<key>-cert.pub`. */
  certificate: string;
  serial: string;
  keyId: string;
  /** Instance-bound: `<account>@<instanceId>`. */
  principal: string;
  /** Log in as this account. */
  account: string;
  validBefore: number;
  /**
   * The host name the guest's host certificate names (its instance, or the original one for a memory
   * restore): pin it with `@cert-authority <hostPrincipal> <sandbox CA key>` and `HostKeyAlias`.
   */
  hostPrincipal: string;
  /** The guest presents a host certificate from the sandbox CA (else: no pinning is possible). */
  hostCertified: boolean;
}

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const sandboxPattern = /^sbx_[0-9a-z]{26,52}$/;

function invalid(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}

export const sandboxExecSchema = strictObject(
  {
    tenantId: { type: 'string', pattern: tenantPattern.source, maxLength: 128 },
    sandboxId: {
      type: 'string',
      pattern: sandboxPattern.source,
      maxLength: 56,
      description: 'The sandbox to exec into',
    },
    publicKey: {
      type: 'string',
      maxLength: 4096,
      description: 'Your OpenSSH public key line (Ed25519 or ECDSA P-256)',
    },
    ttlSeconds: {
      type: 'integer',
      minimum: 60,
      maximum: 900,
      default: 600,
      description: 'Certificate lifetime in seconds; never past your session',
    },
  },
  ['tenantId', 'sandboxId', 'publicKey'],
);

export function parseSandboxExec(raw: unknown): SandboxExecInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalid('input must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!['tenantId', 'sandboxId', 'publicKey', 'ttlSeconds'].includes(key))
      invalid(`${key} is not a known field`);
  if (typeof input.tenantId !== 'string' || !tenantPattern.test(input.tenantId))
    invalid('tenantId is invalid');
  if (typeof input.sandboxId !== 'string' || !sandboxPattern.test(input.sandboxId))
    invalid('sandboxId is invalid');
  if (typeof input.publicKey !== 'string' || input.publicKey.length > 4096)
    invalid('publicKey must be an OpenSSH public key line');
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isInteger(input.ttlSeconds) ||
      (input.ttlSeconds as number) < 60 ||
      (input.ttlSeconds as number) > 900)
  )
    invalid('ttlSeconds must be 60 to 900');
  return {
    tenantId: input.tenantId,
    sandboxId: input.sandboxId,
    publicKey: input.publicKey,
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds as number } : {}),
  };
}

/** The sandbox's running instance and its node, or the reason there is none to exec into. */
async function sandboxInstance(
  tx: SqlTx,
  tenantId: string,
  sandboxId: string,
): Promise<{
  instanceId: string;
  nodeId: string;
  principalInstanceId: string;
  expiresAt: number | null;
  hostCertified: boolean;
}> {
  const present = await tx.query<{ found: string | null }>(
    `SELECT to_regclass('sandboxes')::text AS found`,
  );
  if (!present.rows[0]?.found)
    throw new ComputeError('NOT_FOUND', `Sandbox ${sandboxId} not found`);
  const { rows } = await tx.query<{
    instance_id: string;
    draft: boolean;
    deleting: boolean;
    node_id: string | null;
    state: string | null;
    principal_instance_id: string | null;
    expires_ms: number | null;
    host_certified: boolean | null;
  }>(
    `SELECT s.instance_id, s.draft, s.deleting_at IS NOT NULL AS deleting, i.node_id, i.state,
            i.restore_from->>'principalInstanceId' AS principal_instance_id,
            (extract(epoch FROM s.expires_at) * 1000)::float8 AS expires_ms, i.host_certified
       FROM sandboxes s LEFT JOIN instances i ON i.id = s.instance_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [sandboxId, tenantId],
  );
  const row = rows[0];
  if (!row || row.draft) throw new ComputeError('NOT_FOUND', `Sandbox ${sandboxId} not found`);
  if (row.deleting)
    throw new ComputeError('INVALID_STATE', `Sandbox ${sandboxId} is being deleted`);
  if (row.state !== 'running' || !row.node_id)
    throw new ComputeError(
      'INVALID_STATE',
      `Sandbox ${sandboxId} is not ready (its instance is ${row.state ?? 'gone'})`,
    );
  return {
    instanceId: row.instance_id,
    nodeId: row.node_id,
    // A memory restore resumed without cloud-init: its sshd still accepts the original principal.
    principalInstanceId: row.principal_instance_id ?? row.instance_id,
    expiresAt: row.expires_ms === null ? null : Number(row.expires_ms),
    hostCertified: row.host_certified === true,
  };
}

export interface SandboxExecDeps {
  issuer: ExecTicketIssuer;
  /** The sandbox SSH CA (`TunnelsOptions.sandboxSsh`); without it the method is `UNSUPPORTED`. */
  ca?: SshCertificateAuthority;
  /** The guest account (`vps({ sandboxExec: { account } })`, default `sandbox`). */
  account: string;
  /** The node must be connected and its daemon advertise `needs` (tunnels' `checkReachable`). */
  checkReachable(tx: SqlTx, nodeId: string, needs: string): Promise<void>;
  /** The per-identity tunnel limit, shared with `tunnels.open`. */
  limitTunnels(identityId: string, now: number): void;
  instanceDialCapability: string;
}

/** `sandboxes.exec`, contributed to the vps module's `sandboxes` group by tunnels. */
export function sandboxExecMethod(
  deps: SandboxExecDeps,
): MethodDefinition<SandboxExecInput, SandboxExec> {
  return defineMethod<SandboxExecInput, SandboxExec>({
    action: 'compute:sandboxes:exec',
    kind: 'mutation',
    resource: (input) => ({ type: 'sandbox', id: input.sandboxId }),
    validate: describedBy(sandboxExecSchema, parseSandboxExec),
    async handler(context, input) {
      const ca = deps.ca;
      if (!ca) throw new ComputeError('UNSUPPORTED', 'No sandbox SSH CA is configured');
      const caller = context.caller;
      if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
      // Re-authorization decides the session that asked: an API key has none to withdraw.
      if (!caller.sessionId)
        throw new ComputeError(
          'ACCESS_DENIED',
          'Sandbox exec is issued to a signed-in session, not an API key',
          undefined,
          { reason: 'session-required' },
        );
      try {
        parseSshPublicKey(input.publicKey);
      } catch {
        invalid('publicKey must be an Ed25519 or ECDSA P-256 OpenSSH public key');
      }
      const tx = context.sql as SqlTx;
      const { instanceId, nodeId, principalInstanceId, expiresAt, hostCertified } =
        await sandboxInstance(tx, input.tenantId, input.sandboxId);
      await deps.checkReachable(tx, nodeId, deps.instanceDialCapability);
      const now = context.clock.now();
      // Past its expiry a sandbox is on its way out, even before the reconciler deletes it; a
      // certificate never outlives the sandbox.
      if (expiresAt !== null && expiresAt - now < 60_000)
        throw new ComputeError(
          'INVALID_STATE',
          `Sandbox ${input.sandboxId} expires within a minute; extend it first`,
          undefined,
          { reason: 'sandbox-expiring' },
        );
      let validBefore = now + (input.ttlSeconds ?? 600) * 1000;
      if (expiresAt !== null) validBefore = Math.min(validBefore, expiresAt);
      if (caller.sessionExpiresAt !== undefined) {
        if (caller.sessionExpiresAt - now < 60_000)
          throw new ComputeError(
            'ACCESS_DENIED',
            'Your session ends within a minute; sign in again to exec into a sandbox',
            undefined,
            { reason: 'session-ending' },
          );
        validBefore = Math.min(validBefore, caller.sessionExpiresAt);
      }
      deps.limitTunnels(caller.identityId, now);
      const tunnelId = newId('tun');
      const ticket = deps.issuer.issue({
        nodeId,
        sid: tunnelId,
        op: 'ssh',
        subject: caller.identityId,
        sessionId: caller.sessionId,
        action: 'compute:sandboxes:exec',
        ...(caller.agentId ? { agentId: caller.agentId } : {}),
        ...(caller.delegationId ? { delegationId: caller.delegationId } : {}),
        tenantId: input.tenantId,
        instanceId,
        sandboxId: input.sandboxId,
      });
      const principal = `${deps.account}@${principalInstanceId}`;
      const keyId = `bc:${caller.identityId}:${input.sandboxId}:${newId('ssh')}`;
      const issued = ca.issueUserCertificate({
        publicKey: input.publicKey,
        principals: [principal],
        keyId,
        validBefore,
      });
      const serial = issued.serial.toString();
      await context.events.publish(tx, {
        type: 'tunnel.issued',
        tenantId: input.tenantId,
        subject: `instance/${instanceId}`,
        data: {
          tunnelId,
          nodeId,
          op: 'ssh',
          identityId: caller.identityId,
          expiresAt: ticket.expiresAt,
          sandboxId: input.sandboxId,
        },
      });
      await context.events.publish(tx, {
        type: 'sandbox.exec.issued',
        tenantId: input.tenantId,
        subject: `sandbox/${input.sandboxId}`,
        data: {
          instanceId,
          tunnelId,
          serial,
          keyId,
          principal,
          identityId: caller.identityId,
          validBefore: issued.validBefore,
        },
      });
      return {
        sandboxId: input.sandboxId,
        instanceId,
        nodeId,
        tunnelId,
        ticket: ticket.token,
        path: `tunnels/${ticket.token}`,
        expiresAt: ticket.expiresAt,
        certificate: issued.certificate,
        serial,
        keyId,
        principal,
        account: deps.account,
        validBefore: issued.validBefore,
        hostPrincipal: principalInstanceId,
        hostCertified,
      };
    },
  });
}
