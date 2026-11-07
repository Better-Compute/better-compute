import { allowedAwsRole, awsRoleSessionTagClaims } from '@better-compute/capacity';
import {
  isComputeError,
  newId,
  type Clock,
  type EventPublisher,
  type Logger,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  maxWorkloadTokenSeconds,
  openWorkloadTokenRequest,
  refuseWorkloadTokenRequest,
  sealWorkloadTokenResponse,
  type NodeCertLookup,
  type OpenedWorkloadTokenRequest,
  type WorkloadClaimValue,
  type WorkloadIssuer,
  type WorkloadTokenRefusal,
} from '@better-compute/pki';
import type { WorkloadTokenRequest, WorkloadTokenResponse } from '@better-compute/protocol';
import { refusalBucket } from './rate.js';
import type { GatewayCallContext } from './service.js';

// The workload-token broker (PLAN.md §12.2, §13; v0.5): `GatewayServices.workloadToken`. A VPS host's
// IMDS, bound to one instance, asks for that instance's workload JWT. The gateway only relays; the
// answer is the JWT sealed to the request's one-time key (P14). A token is minted only when
//  1. the request is signed by the requesting node's CURRENT key of role `node` without an
//     allowed-kinds restriction (no expiry grace; never `node-tenant`, where the lessee has root,
//     a ramdisk or a site agent) and names the session's node — checked
//     before anything else is looked up;
//  2. the instance is live and placed on that node, with a live allocation there;
//  3. its pool turned workload identity on (`policy.workloadIdentity: true`);
//  4. the audience is the issuer's default ('') or one of the configured audiences, and a token for
//     AWS STS (aud `sts.amazonaws.com`, requested or the issuer's default; AWS A7) only for an
//     instance that names an AWS role its pool still allows (`policy.workloadRoles.aws`, as vps's
//     instance spec), carrying that role as its `bc-role` session tag: every `aws workload-role`
//     trusts the tenant's instances and requires its own tag, so the token assumes only that role,
//     whoever presents it. The audience is decided before the request id or a rate token is spent;
//  5. the request id was not used before, and the instance is within its rate.
// Tokens live at most 15 minutes. The audit row carries the jti, never the token.

export interface WorkloadIdentityOptions {
  /**
   * pki's `createWorkloadIssuer(...)`: its discovery document and JWKS are served by the host. Its
   * `defaultAudience` decides the audience of a request that names none before anything is minted
   * (an issuer without it never hands out a token whose audience turns out to be STS).
   */
  issuer: Pick<WorkloadIssuer, 'issue' | 'issuer'> &
    Partial<Pick<WorkloadIssuer, 'defaultAudience'>>;
  /** Audiences an instance may ask for besides the issuer's default. */
  audiences?: readonly string[];
  /** Token lifetime (default and maximum 900 s). */
  ttlSeconds?: number;
  /** Tokens per instance per minute (default 30). */
  perInstancePerMinute?: number;
}

export interface WorkloadBrokerOptions extends WorkloadIdentityOptions {
  database: SqlExecutor;
  clock: Clock;
  events: EventPublisher;
  rootTenantId?: string;
  log?: Logger;
  /** `security.workload.refused` events per reason per minute (default 60). */
  refusalEventsPerMinute?: number;
}

export interface WorkloadBrokerPort {
  workloadToken(
    request: WorkloadTokenRequest,
    context?: GatewayCallContext,
  ): Promise<WorkloadTokenResponse>;
}

/** AWS STS's web identity audience (AWS A7): minted only for an instance with an allowed role. */
export const stsWorkloadAudience = 'sts.amazonaws.com';

/** A token's `aud` claim, read back (the issuer's default audience is not otherwise known here). */
function tokenAudience(token: string): unknown {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { aud?: unknown })
      .aud;
  } catch {
    return undefined;
  }
}

/** Request ids are remembered this long (well past any retry). */
const replayTtlMs = 15 * 60_000;
const liveInstanceStates = [
  'provisioning',
  'starting',
  'running',
  'stopped',
  'rebooting',
  'resizing',
];

class Refused extends Error {
  constructor(
    readonly refusal: WorkloadTokenRefusal,
    readonly reason: string,
    readonly tenantId?: string,
  ) {
    super(reason);
  }
}

interface CertRow {
  serial: string;
  node_id: string;
  role: string;
  der: Uint8Array;
  not_before: Date | string;
  not_after: Date | string;
  revoked_at: Date | string | null;
}
const ms = (value: Date | string) => (value instanceof Date ? value : new Date(value)).getTime();

/** Node keys for the signature check: only a certificate of the node's CURRENT identity generation. */
function currentCertLookup(tx: SqlTx, restricted: Set<string>): NodeCertLookup {
  return async (spki, nodeId) => {
    const { rows } = await tx.query<CertRow & { restricted: boolean }>(
      `SELECT c.serial, c.node_id, c.role, c.der, c.not_before, c.not_after, c.revoked_at,
              c.allowed_kinds IS NOT NULL AS restricted
         FROM node_certs c JOIN nodes n ON n.id = c.node_id
        WHERE c.spki_sha256 = $1 AND c.node_id = $2 AND c.identity_gen = n.identity_gen
          AND n.provision_state <> 'retired'
        ORDER BY c.not_after DESC LIMIT 1`,
      [spki, nodeId],
    );
    const row = rows[0];
    if (!row) return undefined;
    if (row.restricted) restricted.add(row.serial);
    return {
      serial: row.serial,
      nodeId: row.node_id,
      role: row.role,
      der: new Uint8Array(row.der),
      notBefore: ms(row.not_before),
      notAfter: ms(row.not_after),
      revokedAt: row.revoked_at === null ? null : ms(row.revoked_at),
    };
  };
}

export function createWorkloadBroker(options: WorkloadBrokerOptions): WorkloadBrokerPort {
  const { database, clock, events, log } = options;
  const ttlSeconds = Math.min(
    options.ttlSeconds ?? maxWorkloadTokenSeconds,
    maxWorkloadTokenSeconds,
  );
  const audiences = new Set(options.audiences ?? []);
  const seen = new Map<string, number>();
  const perInstance = refusalBucket(options.perInstancePerMinute ?? 30);
  const refusals = refusalBucket(options.refusalEventsPerMinute ?? 60);

  function remember(key: string, now: number): boolean {
    for (const [stored, expiry] of seen) {
      if (expiry > now) break; // insertion order is expiry order
      seen.delete(stored);
    }
    if (seen.has(key)) return false;
    seen.set(key, now + replayTtlMs);
    return true;
  }

  async function recordRefusal(
    request: WorkloadTokenRequest,
    context: GatewayCallContext,
    refused: Refused,
  ): Promise<void> {
    log?.warn('workload token request refused', {
      reason: refused.reason,
      instanceId: typeof request?.instanceId === 'string' ? request.instanceId.slice(0, 128) : null,
    });
    const tenantId = refused.tenantId ?? options.rootTenantId;
    if (!tenantId) return;
    const admitted = refusals.take(refused.reason, clock.now());
    if (admitted === undefined) return;
    try {
      await database.transaction((tx) =>
        events.publish(tx, {
          type: 'security.workload.refused',
          tenantId,
          subject: context.peerNodeId ? `node/${context.peerNodeId}` : 'workload-identity',
          data: {
            reason: refused.reason,
            refusal: refused.refusal,
            instanceId:
              typeof request?.instanceId === 'string' ? request.instanceId.slice(0, 128) : null,
            audience: typeof request?.audience === 'string' ? request.audience.slice(0, 256) : null,
            requestId:
              typeof request?.requestId === 'string' ? request.requestId.slice(0, 128) : null,
            nodeId: context.peerNodeId ?? null,
            ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
            suppressed: admitted,
          },
        }),
      );
    } catch (error) {
      log?.error('recording a workload token refusal failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function workloadToken(
    request: WorkloadTokenRequest,
    context: GatewayCallContext = {},
  ): Promise<WorkloadTokenResponse> {
    const nodeId = context.peerNodeId;
    try {
      if (!nodeId) throw new Refused('access-denied', 'no-peer');
      const now = clock.now();
      const { opened, instance } = await database.transaction(async (tx) => {
        const node = (
          await tx.query<{ owner_tenant_id: string }>(
            'SELECT owner_tenant_id FROM nodes WHERE id = $1',
            [nodeId],
          )
        ).rows[0];
        if (!node) throw new Refused('access-denied', 'unknown-node');
        // 1. The node's signature first; nothing about the instance is read before it holds.
        let opened: OpenedWorkloadTokenRequest;
        const restricted = new Set<string>();
        try {
          opened = await openWorkloadTokenRequest(request, {
            nodeId,
            lookup: currentCertLookup(tx, restricted),
            now,
            expiredGraceMs: 0,
          });
        } catch (error) {
          if (!isComputeError(error, 'ACCESS_DENIED')) throw error;
          throw new Refused('access-denied', String(error.details?.reason ?? 'bad-signature'));
        }
        // An allowlist: only a VPS host's own node agent serves IMDS. Never node-tenant (the lessee has
        // root there), a ramdisk or site agent, or a certificate restricted to some kinds.
        if (opened.role !== 'node')
          throw new Refused('access-denied', `role-${opened.role}`, node.owner_tenant_id);
        if (restricted.has(opened.serial))
          throw new Refused('access-denied', 'restricted-certificate', node.owner_tenant_id);
        // 2. A live instance placed on this node, with its live allocation here (without the vps
        //    module there are no instances to mint for).
        const tables = (
          await tx.query<{ present: boolean; tenancy: boolean }>(
            `SELECT to_regclass('instances') IS NOT NULL AS present,
                    to_regclass('compute_tenant_states') IS NOT NULL AS tenancy`,
          )
        ).rows[0];
        const hasInstances = tables?.present;
        const { rows } = hasInstances
          ? await tx.query<{
              tenant_id: string;
              enabled: boolean | null;
              aws_role_arn: string | null;
              workload_roles: unknown;
            }>(
              `SELECT i.tenant_id, i.aws_role_arn, p.policy->'workloadRoles' AS workload_roles,
                      CASE WHEN jsonb_typeof(p.policy->'workloadIdentity') = 'boolean'
                           THEN (p.policy->>'workloadIdentity')::boolean END AS enabled
                 FROM instances i
                 JOIN allocations a ON a.id = i.allocation_id AND a.node_id = i.node_id
                                   AND a.released_at IS NULL
                 JOIN pools p ON p.id = i.pool_id
                WHERE i.id = $1 AND i.node_id = $2 AND NOT i.draft AND i.state = ANY($3)`,
              [opened.instanceId, nodeId, liveInstanceStates],
            )
          : { rows: [] };
        const instance = rows[0];
        if (!instance) throw new Refused('not-bound', 'not-placed-here', node.owner_tenant_id);
        // 3. The pool opted in.
        if (instance.enabled !== true)
          throw new Refused('disabled', 'disabled', instance.tenant_id);
        // 4. The instance's tenant is active: a suspended or deleted tenant's workloads get no new
        //    credentials, even while teardown has not reached its instances yet (§12.8).
        if (tables?.tenancy) {
          const blocked = (
            await tx.query<{ state: string }>(
              `SELECT state FROM compute_tenant_states WHERE tenant_id = $1 AND state <> 'active'`,
              [instance.tenant_id],
            )
          ).rows[0];
          if (blocked) throw new Refused('disabled', `tenant-${blocked.state}`, instance.tenant_id);
        }
        return { opened, instance };
      });
      // 5. The audience, decided before anything is spent or signed: the requested one, else the
      //    issuer's default.
      if (opened.audience !== '' && !audiences.has(opened.audience))
        throw new Refused('audience', 'audience', instance.tenant_id);
      const audience = opened.audience || options.issuer.defaultAudience;
      let awsRole: string | undefined;
      let claims: Record<string, WorkloadClaimValue> | undefined;
      if (audience === stsWorkloadAudience) {
        awsRole = allowedAwsRole(
          {
            workloadIdentity: instance.enabled,
            workloadRoles:
              typeof instance.workload_roles === 'string'
                ? JSON.parse(instance.workload_roles)
                : instance.workload_roles,
          },
          instance.aws_role_arn,
        );
        if (awsRole === undefined)
          throw new Refused('audience', 'aws-role-not-allowed', instance.tenant_id);
        // Bound to that role: its trust requires this session tag, so the token assumes no other.
        claims = awsRoleSessionTagClaims(awsRole);
        if (claims === undefined)
          throw new Refused('audience', 'aws-role-untaggable', instance.tenant_id);
      }
      // 6. Replay and rate: a relayed copy of an answered request burns nothing.
      if (!remember(`${nodeId}\0${opened.requestId}`, now))
        throw new Refused('access-denied', 'replayed', instance.tenant_id);
      if (perInstance.take(opened.instanceId, now) === undefined)
        throw new Refused('rate-limited', 'rate-limited', instance.tenant_id);

      const issued = options.issuer.issue({
        tenantId: instance.tenant_id,
        instanceId: opened.instanceId,
        ttlSeconds,
        ...(opened.audience ? { audience: opened.audience } : {}),
        ...(claims ? { claims } : {}),
      });
      // Only an issuer that does not say its default audience gets here unchecked: an untagged STS
      // token is never handed out (AWS would refuse it anyway).
      if (audience === undefined && tokenAudience(issued.token) === stsWorkloadAudience)
        throw new Refused('audience', 'sts-default-audience-unknown', instance.tenant_id);
      await database.transaction((tx) =>
        tx.query(
          `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'workload.token.issued', 'instance', $3, $4)`,
          [
            newId('aud'),
            instance.tenant_id,
            opened.instanceId,
            JSON.stringify({
              nodeId,
              requestId: opened.requestId,
              serial: opened.serial,
              jti: issued.jti,
              audience: opened.audience || null,
              ...(awsRole !== undefined ? { awsRole } : {}),
              issuer: options.issuer.issuer,
              expiresAt: new Date(issued.expiresAt).toISOString(),
              ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
            }),
          ],
        ),
      );
      return sealWorkloadTokenResponse(opened, issued.token, issued.expiresAt);
    } catch (error) {
      if (error instanceof Refused) {
        await recordRefusal(request, context, error);
        return refuseWorkloadTokenRequest({ requestId: request?.requestId ?? '' }, error.refusal);
      }
      log?.error('workload broker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return refuseWorkloadTokenRequest({ requestId: request?.requestId ?? '' }, 'unavailable');
    }
  }

  return { workloadToken };
}
