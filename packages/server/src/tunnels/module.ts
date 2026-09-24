import {
  ComputeError,
  defineMethod,
  newId,
  type ComputeModule,
  type MethodDefinition,
  type MethodResource,
  type SqlTx,
} from '@better-compute/core';
import {
  parseSshPublicKey,
  type ExecTicketIssuer,
  type SshCertificateAuthority,
  type TunnelOp,
} from '@better-compute/pki';

// Tunnels, the API half (PLAN.md §7.6, §13 "Interactive access", v0.3). `tunnels.open` decides the
// caller (`compute:instances:exec` on the instance; `compute:nodes:console` on a node once the
// envelope decides per-input actions), then issues a 60 s single-use exec ticket from pki's issuer
// for the node: `aud=node:<id>`, `sid` = the tunnel id, `sub` = the caller. The caller opens
// `GET {basePath}/tunnels/{ticket}` (`handleTunnel`), which relays to the node's gateway; the
// gateway and then the daemon verify the ticket again. The same issuer's JWKS goes into every
// node's `access.execTicketJwks` and into the gateway's `tunnels.jwks`.

export interface TunnelsOptions {
  /** pki's `createExecTicketIssuer({ issuer })`, shared with the gateway's `tunnels.jwks`. */
  issuer: ExecTicketIssuer;
  /**
   * The compute SSH CA (pki `createSshCertificateAuthority`) for break-glass `nodes.issueSshCert`
   * (§13); its public key goes into every node's `access.sshCaPublicKeys`. Without it the method
   * is `UNSUPPORTED`.
   */
  ssh?: SshCertificateAuthority;
  /** Require an MFA session for `nodes.issueSshCert` (default true, §13). */
  sshRequiresMfa?: boolean;
}

export interface IssueSshCertInput {
  tenantId: string;
  nodeId: string;
  /** The caller's OpenSSH public key line (Ed25519 or ECDSA P-256). */
  publicKey: string;
  /** The Unix account (default `root`). */
  principal?: string;
  /** At most 3600 (default 900). */
  ttlSeconds?: number;
}

export interface IssuedSshCert {
  nodeId: string;
  /** The OpenSSH certificate line: save it as `<key>-cert.pub`. */
  certificate: string;
  serial: string;
  keyId: string;
  principals: string[];
  validBefore: number;
}

export interface OpenTunnelInput {
  tenantId: string;
  /** Exec into this instance (its node's agent runs it). */
  instanceId?: string;
  /** Console of this node (`compute:nodes:console`). */
  nodeId?: string;
  op: TunnelOp;
  /** `tcp`: the port on the instance or node. */
  port?: number;
}

export interface OpenedTunnel {
  tunnelId: string;
  nodeId: string;
  instanceId?: string;
  op: TunnelOp;
  /** Single use, valid until `expiresAt`: open `GET {basePath}/{path}` with it. */
  ticket: string;
  expiresAt: number;
  /** Relative to the API base path: `tunnels/<ticket>`. */
  path: string;
}

export type TunnelsApi = {
  tunnels: { open: MethodDefinition<OpenTunnelInput, OpenedTunnel> };
  nodes: { issueSshCert: MethodDefinition<IssueSshCertInput, IssuedSshCert> };
};

export function parseIssueSshCert(raw: unknown): IssueSshCertInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalid('input must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!['tenantId', 'nodeId', 'publicKey', 'principal', 'ttlSeconds'].includes(key))
      invalid(`${key} is not a known field`);
  if (typeof input.tenantId !== 'string' || !tenantPattern.test(input.tenantId))
    invalid('tenantId is invalid');
  if (typeof input.nodeId !== 'string' || !idPattern('node').test(input.nodeId))
    invalid('nodeId is invalid');
  if (typeof input.publicKey !== 'string' || input.publicKey.length > 4096)
    invalid('publicKey must be an OpenSSH public key line');
  if (
    input.principal !== undefined &&
    (typeof input.principal !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.principal))
  )
    invalid('principal must be a Unix account name');
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isInteger(input.ttlSeconds) ||
      (input.ttlSeconds as number) < 60 ||
      (input.ttlSeconds as number) > 3600)
  )
    invalid('ttlSeconds must be 60 to 3600');
  return {
    tenantId: input.tenantId as string,
    nodeId: input.nodeId as string,
    publicKey: input.publicKey as string,
    ...(input.principal !== undefined ? { principal: input.principal as string } : {}),
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds as number } : {}),
  };
}

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const idPattern = (prefix: string) => new RegExp(`^${prefix}_[0-9a-z]{26,52}$`);
const ops: readonly TunnelOp[] = ['exec', 'console', 'ssh', 'tcp'];

function invalid(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}

export function parseOpenTunnel(raw: unknown): OpenTunnelInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalid('input must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!['tenantId', 'instanceId', 'nodeId', 'op', 'port'].includes(key))
      invalid(`${key} is not a known field`);
  if (typeof input.tenantId !== 'string' || !tenantPattern.test(input.tenantId))
    invalid('tenantId is invalid');
  if ((input.instanceId === undefined) === (input.nodeId === undefined))
    invalid('Give exactly one of instanceId or nodeId');
  if (
    input.instanceId !== undefined &&
    (typeof input.instanceId !== 'string' || !idPattern('inst').test(input.instanceId))
  )
    invalid('instanceId is invalid');
  if (
    input.nodeId !== undefined &&
    (typeof input.nodeId !== 'string' || !idPattern('node').test(input.nodeId))
  )
    invalid('nodeId is invalid');
  if (!ops.includes(input.op as TunnelOp)) invalid(`op must be one of ${ops.join(', ')}`);
  if (input.op === 'tcp') {
    if (
      !Number.isInteger(input.port) ||
      (input.port as number) < 1 ||
      (input.port as number) > 65535
    )
      invalid('A tcp tunnel needs a port from 1 to 65535');
  } else if (input.port !== undefined) invalid('port applies to tcp tunnels only');
  if (input.nodeId !== undefined)
    // §9.2: `nodes:console` @ node is this row's alternative; it needs the envelope to decide
    // per-input actions, which lands in core next. Until then refuse rather than decide wrongly.
    throw new ComputeError('UNSUPPORTED', 'Node console tunnels are not available yet');
  if (input.nodeId === undefined && input.op === 'console')
    invalid('An instance takes exec, ssh or tcp; console is for nodes');
  return {
    tenantId: input.tenantId as string,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId as string } : {}),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId as string } : {}),
    op: input.op as TunnelOp,
    ...(input.port !== undefined ? { port: input.port as number } : {}),
  };
}

const resourceOf = (input: OpenTunnelInput): MethodResource =>
  input.instanceId !== undefined
    ? { type: 'instance', id: input.instanceId }
    : { type: 'node', id: input.nodeId! };

async function tableExists(tx: SqlTx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ found: string | null }>(
    'SELECT to_regclass($1)::text AS found',
    [table],
  );
  return Boolean(rows[0]?.found);
}

/** The node an instance runs on, if it can take a tunnel now. Throws otherwise. */
async function instanceNode(tx: SqlTx, tenantId: string, instanceId: string): Promise<string> {
  if (!(await tableExists(tx, 'instances')))
    throw new ComputeError('NOT_FOUND', `Instance ${instanceId} not found`);
  const { rows } = await tx.query<{ node_id: string | null; state: string; draft: boolean }>(
    'SELECT node_id, state, draft FROM instances WHERE id = $1 AND tenant_id = $2',
    [instanceId, tenantId],
  );
  const row = rows[0];
  if (!row || row.draft) throw new ComputeError('NOT_FOUND', `Instance ${instanceId} not found`);
  if (!row.node_id)
    throw new ComputeError(
      'UNSUPPORTED',
      'Provider instances have no node agent to tunnel through',
    );
  if (row.state !== 'running')
    throw new ComputeError('INVALID_STATE', `Instance ${instanceId} is ${row.state}, not running`);
  return row.node_id;
}

/** The node must be connected to a gateway for its tunnel to open. */
async function checkReachable(tx: SqlTx, nodeId: string): Promise<void> {
  const { rows } = await tx.query<{ connectivity: string; gateway_id: string | null }>(
    `SELECT n.connectivity, s.gateway_id FROM nodes n LEFT JOIN node_sessions s ON s.node_id = n.id
      WHERE n.id = $1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row || row.connectivity !== 'connected' || !row.gateway_id)
    throw new ComputeError('INVALID_STATE', 'The node is not connected; try again when it is');
}

/** The tunnels group and the `access.execTicketJwks` every node pins. */
export function tunnelsModule(options: TunnelsOptions): ComputeModule<'tunnels', TunnelsApi> {
  if (!options?.issuer || typeof options.issuer.issue !== 'function')
    throw new ComputeError(
      'INVALID_CONFIG',
      'tunnels needs an exec ticket issuer (pki createExecTicketIssuer)',
    );
  const api = (): TunnelsApi => ({
    tunnels: {
      open: defineMethod<OpenTunnelInput, OpenedTunnel>({
        action: 'compute:instances:exec',
        kind: 'mutation',
        resource: resourceOf,
        validate: parseOpenTunnel,
        async handler(context, input) {
          const caller = context.caller;
          if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
          const tx = context.sql as SqlTx;
          const nodeId = input.instanceId
            ? await instanceNode(tx, input.tenantId, input.instanceId)
            : input.nodeId!;
          await checkReachable(tx, nodeId);
          const tunnelId = newId('tun');
          const issued = options.issuer.issue({
            nodeId,
            sid: tunnelId,
            op: input.op,
            subject: caller.identityId,
            tenantId: input.tenantId,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            ...(input.port !== undefined ? { port: input.port } : {}),
          });
          await context.events.publish(tx, {
            type: 'tunnel.issued',
            tenantId: input.tenantId,
            subject: input.instanceId ? `instance/${input.instanceId}` : `node/${nodeId}`,
            data: {
              tunnelId,
              nodeId,
              op: input.op,
              identityId: caller.identityId,
              expiresAt: issued.expiresAt,
              ...(input.port !== undefined ? { port: input.port } : {}),
            },
          });
          return {
            tunnelId,
            nodeId,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            op: input.op,
            ticket: issued.token,
            expiresAt: issued.expiresAt,
            path: `tunnels/${issued.token}`,
          };
        },
      }),
    },
    nodes: {
      // Break-glass shells (§13): a short user certificate from the compute SSH CA, only for an
      // MFA session that holds `compute:nodes:ssh-root` on the node; every issue is recorded.
      issueSshCert: defineMethod<IssueSshCertInput, IssuedSshCert>({
        action: 'compute:nodes:ssh-root',
        kind: 'mutation',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: parseIssueSshCert,
        async handler(context, input) {
          const ca = options.ssh;
          if (!ca) throw new ComputeError('UNSUPPORTED', 'No compute SSH CA is configured');
          const caller = context.caller;
          if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
          if ((options.sshRequiresMfa ?? true) && !caller.mfa)
            throw new ComputeError(
              'ACCESS_DENIED',
              'Break-glass SSH needs an MFA session',
              undefined,
              {
                reason: 'mfa-required',
              },
            );
          try {
            parseSshPublicKey(input.publicKey);
          } catch {
            invalid('publicKey must be an Ed25519 or ECDSA P-256 OpenSSH public key');
          }
          const tx = context.sql as SqlTx;
          const { rows } = await tx.query(
            `SELECT 1 FROM nodes n
              WHERE n.id = $1 AND EXISTS (SELECT 1 FROM authz_projection ap
                WHERE ap.type = 'node' AND ap.id = n.id AND ap.tenant_id = $2)`,
            [input.nodeId, input.tenantId],
          );
          if (!rows[0]) throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} not found`);
          const principal = input.principal ?? 'root';
          const keyId = `bc:${caller.identityId}:${input.nodeId}:${newId('ssh')}`;
          const issued = ca.issueUserCertificate({
            publicKey: input.publicKey,
            principals: [principal],
            keyId,
            // The CA bounds lifetimes on its own (server) clock, so the TTL counts from it.
            validBefore: context.clock.now() + (input.ttlSeconds ?? 900) * 1000,
          });
          await context.events.publish(tx, {
            type: 'node.ssh-cert.issued',
            tenantId: input.tenantId,
            subject: `node/${input.nodeId}`,
            data: {
              keyId,
              serial: issued.serial.toString(),
              principals: [principal],
              identityId: caller.identityId,
              validBefore: issued.validBefore,
            },
          });
          return {
            nodeId: input.nodeId,
            certificate: issued.certificate,
            serial: issued.serial.toString(),
            keyId,
            principals: [principal],
            validBefore: issued.validBefore,
          };
        },
      }),
    },
  });
  return {
    name: 'tunnels',
    api,
    // Every node pins the issuer's JWKS (the daemon verifies each ticket against it, P14) and
    // trusts the compute SSH CA for break-glass certificates.
    async nodeSpec() {
      return {
        access: {
          execTicketJwks: JSON.parse(options.issuer.jwksJson()),
          ...(options.ssh ? { sshCaPublicKeys: [options.ssh.publicKey] } : {}),
        },
      };
    },
  };
}
