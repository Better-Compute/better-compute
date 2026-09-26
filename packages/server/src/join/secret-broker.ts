import {
  isComputeError,
  newId,
  type Clock,
  type EventPublisher,
  type Logger,
  type SecretRef,
  type SecretStore,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  openSecretRequest,
  parseSecretRef,
  refuseSecretRequest,
  sealSecretResponse,
  type NodeCertLookup,
  type OpenedSecretRequest,
  type SecretRefusal,
} from '@better-compute/pki';
import type { SecretRequest, SecretResponse } from '@better-compute/protocol';
import { refusalBucket } from './rate.js';
import type { GatewayCallContext } from './service.js';

// The secret broker (PLAN.md §6 "Secrets", §7.7, §13; v0.2): `GatewayServices.secret`. It runs in
// `api`; the gateway only relays ciphertext (P14). A value leaves the SecretStore only when
//  1. the request is signed by the requesting node's CURRENT key (unrevoked certificate of the
//     node's current identity generation, no expiry grace) and names the session's node;
//  2. the certificate is a platform identity (never `node-tenant`: the tenant has root there);
//  3. the ref is bound to work that node is doing right now — a non-terminal command of the named
//     workflow step addressed to it that carries the ref, or an allocation placed on it whose
//     instance/telemetry references it, or a config unit of its current NodeSpec `host` section
//     that names it as its credential (`k8s-join.tokenRef`, the bootstrap token; the request names
//     workflow `host:k8s-join`, step `tokenRef`);
//  4. the request id was not used before.
// The answer is a JWE to the request's one-time key with a short `exp`. The audit row and events
// carry the ref (and its version), never the value.

export interface SecretBrokerOptions {
  database: SqlExecutor;
  clock: Clock;
  events: EventPublisher;
  /** Where values live, by URI scheme (`secret`, `vault`, `env`): the host's SecretStores. */
  stores: readonly SecretStore[];
  /** The IAM root tenant, for refusals of unauthenticated requests. */
  rootTenantId?: string;
  log?: Logger;
  /** Lifetime of a released value's JWE (default and maximum 300 s). */
  ttlSeconds?: number;
  /**
   * Extra allocation-bound refs a module knows about (e.g. telemetry `headers_ref`): true when
   * `ref` belongs to the allocation, which the broker has already checked is live on this node.
   */
  allocationRefs?(
    tx: SqlTx,
    input: { allocationId: string; ownerKind: string; ownerId: string; ref: string },
  ): Promise<boolean>;
  /** `security.secret.refused` events per (reason) per minute (default 60). */
  refusalEventsPerMinute?: number;
  /**
   * The config-unit settings fields that name a credential the node fetches for itself (binding
   * rule 3). Default: only `k8s-join.tokenRef`; `[]` turns the rule off.
   */
  hostUnitRefs?: readonly HostUnitRef[];
}

/** A config unit's settings field holding a secret ref its node may fetch. */
export interface HostUnitRef {
  unit: string;
  field: string;
}

export const defaultHostUnitRefs: readonly HostUnitRef[] = Object.freeze([
  { unit: 'k8s-join', field: 'tokenRef' },
]);

export interface SecretBrokerPort {
  secret(request: SecretRequest, context?: GatewayCallContext): Promise<SecretResponse>;
}

export const maxSecretTtlSeconds = 300;
/** Request ids are remembered this long (well past any retry). */
const replayTtlMs = 15 * 60_000;
const liveCommandStates = ['pending', 'dispatched', 'acked', 'running'];

class Refused extends Error {
  constructor(
    readonly refusal: SecretRefusal,
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

/**
 * Node keys for the signature check: only a certificate of the node's CURRENT identity generation.
 * Revoked rows are returned so the verifier says why it refuses.
 */
function currentCertLookup(tx: SqlTx, roles: Map<string, string>): NodeCertLookup {
  return async (spki, nodeId) => {
    const { rows } = await tx.query<CertRow>(
      `SELECT c.serial, c.node_id, c.role, c.der, c.not_before, c.not_after, c.revoked_at
         FROM node_certs c JOIN nodes n ON n.id = c.node_id
        WHERE c.spki_sha256 = $1 AND c.node_id = $2 AND c.identity_gen = n.identity_gen
          AND n.provision_state <> 'retired'
        ORDER BY c.not_after DESC LIMIT 1`,
      [spki, nodeId],
    );
    const row = rows[0];
    if (!row) return undefined;
    roles.set(row.serial, row.role);
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

/**
 * Binding rule 1: a live command of `wf:<workflow>:<step>[#n][:key]` for this node whose body
 * carries the ref (payload strings are verbatim UTF-8 in the encoded CommandBody).
 */
async function boundToStep(
  tx: SqlTx,
  nodeId: string,
  opened: OpenedSecretRequest,
): Promise<boolean> {
  if (!opened.workflowId || !opened.stepId) return false;
  const key = `wf:${opened.workflowId}:${opened.stepId}`;
  const { rows } = await tx.query(
    `SELECT 1 FROM commands c
      WHERE c.node_id = $1 AND c.state = ANY($2)
        AND (c.idempotency_key = $3 OR left(c.idempotency_key, length($3) + 1) IN ($3 || '#', $3 || ':'))
        AND position(convert_to($4, 'UTF8') IN c.body) > 0
      LIMIT 1`,
    [nodeId, liveCommandStates, key, opened.ref],
  );
  return rows.length > 0;
}

/** Binding rule 2: a live allocation on this node whose instance (or a module) references the ref. */
async function boundToAllocation(
  tx: SqlTx,
  nodeId: string,
  opened: OpenedSecretRequest,
  extra: SecretBrokerOptions['allocationRefs'],
): Promise<boolean> {
  if (!opened.allocationId) return false;
  const { rows } = await tx.query<{ owner_kind: string; owner_id: string; has_instances: boolean }>(
    `SELECT a.owner_kind, a.owner_id, to_regclass('instances') IS NOT NULL AS has_instances
       FROM allocations a
      WHERE a.id = $1 AND a.node_id = $2 AND a.released_at IS NULL`,
    [opened.allocationId, nodeId],
  );
  const allocation = rows[0];
  if (!allocation) return false;
  if (allocation.owner_kind === 'instance' && allocation.has_instances) {
    const instance = await tx.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM instances WHERE id = $1 AND user_data = $2',
      [allocation.owner_id, opened.ref],
    );
    // Defence in depth (vps refuses them at admission too): an instance may only name a secret of
    // its own tenant, so tenant A's VM can never boot with tenant B's secret:// as its user data.
    const owner = instance.rows[0]?.tenant_id;
    if (owner !== undefined && parseSecretRef(opened.ref)?.tenantId === owner) return true;
  }
  return (
    (await extra?.(tx, {
      allocationId: opened.allocationId,
      ownerKind: allocation.owner_kind,
      ownerId: allocation.owner_id,
      ref: opened.ref,
    })) ?? false
  );
}

/** A host unit's request names `host:<unit>` as its workflow and the settings field as its step. */
export const hostUnitWorkflowPrefix = 'host:';

/**
 * Binding rule 3: the request names `workflowId: host:<unit>`, `stepId: <field>` (both signed) for
 * an allowed (unit, field); the node's current spec (`nodes.spec`, rewritten with every generation)
 * has that unit naming the ref in that field; and the ref is the node owner's or its pool's tenant's.
 * The certificate is checked again in the same statement, so the spec and the key are read together.
 * Returns the unit.
 */
async function boundToHostUnit(
  tx: SqlTx,
  nodeId: string,
  opened: OpenedSecretRequest,
  allowed: readonly HostUnitRef[],
): Promise<string | undefined> {
  if (opened.allocationId || !opened.workflowId.startsWith(hostUnitWorkflowPrefix)) return undefined;
  const unit = opened.workflowId.slice(hostUnitWorkflowPrefix.length);
  const refs = allowed.filter((r) => r.unit === unit && r.field === opened.stepId);
  const refTenant = parseSecretRef(opened.ref)?.tenantId;
  if (!refs.length || refTenant === undefined) return undefined;
  const { rows } = await tx.query<{ unit: string }>(
    `SELECT u.value->>'unit' AS unit
       FROM nodes n
       JOIN node_certs c ON c.node_id = n.id AND c.identity_gen = n.identity_gen AND c.serial = $2
                        AND c.revoked_at IS NULL
       LEFT JOIN pools p ON p.id = n.pool_id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(n.spec->'host'->'units') = 'array' THEN n.spec->'host'->'units' ELSE '[]'::jsonb END
       ) u
      WHERE n.id = $1 AND n.provision_state <> 'retired'
        AND $5 IN (n.owner_tenant_id, p.owner_tenant_id)
        AND jsonb_typeof(u.value->'configJson') = 'string'
        AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS allowed(unit text, field text)
           WHERE allowed.unit = u.value->>'unit'
             AND ((u.value->>'configJson')::jsonb)->>allowed.field = $4)
      LIMIT 1`,
    [nodeId, opened.serial, JSON.stringify(refs), opened.ref, refTenant],
  );
  return rows[0]?.unit;
}

export function createSecretBroker(options: SecretBrokerOptions): SecretBrokerPort {
  const { database, clock, events, log } = options;
  const ttlMs = Math.min(options.ttlSeconds ?? maxSecretTtlSeconds, maxSecretTtlSeconds) * 1000;
  const stores = new Map<string, SecretStore>();
  for (const store of options.stores) for (const scheme of store.schemes) stores.set(scheme, store);
  const seen = new Map<string, number>();
  const refusals = refusalBucket(options.refusalEventsPerMinute ?? 60);
  const hostUnitRefs = options.hostUnitRefs ?? defaultHostUnitRefs;

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
    request: SecretRequest,
    context: GatewayCallContext,
    refused: Refused,
  ): Promise<void> {
    log?.warn('secret request refused', { reason: refused.reason, ref: request?.ref });
    const tenantId = refused.tenantId ?? options.rootTenantId;
    if (!tenantId) return;
    const admitted = refusals.take(refused.reason, clock.now());
    if (admitted === undefined) return;
    try {
      await database.transaction((tx) =>
        events.publish(tx, {
          type: 'security.secret.refused',
          tenantId,
          subject: context.peerNodeId ? `node/${context.peerNodeId}` : 'secrets',
          data: {
            reason: refused.reason,
            refusal: refused.refusal,
            ref: typeof request?.ref === 'string' ? request.ref.slice(0, 512) : null,
            requestId:
              typeof request?.requestId === 'string' ? request.requestId.slice(0, 128) : null,
            workflowId: request?.workflowId || null,
            stepId: request?.stepId || null,
            allocationId: request?.allocationId || null,
            nodeId: context.peerNodeId ?? null,
            ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
            suppressed: admitted,
          },
        }),
      );
    } catch (error) {
      log?.error('recording a secret refusal failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function secret(
    request: SecretRequest,
    context: GatewayCallContext = {},
  ): Promise<SecretResponse> {
    const nodeId = context.peerNodeId;
    try {
      if (!nodeId) throw new Refused('access-denied', 'no-peer');
      const now = clock.now();
      const roles = new Map<string, string>();
      let hostUnit: string | undefined;
      const { opened, owner } = await database.transaction(async (tx) => {
        const node = (
          await tx.query<{ owner_tenant_id: string }>(
            'SELECT owner_tenant_id FROM nodes WHERE id = $1',
            [nodeId],
          )
        ).rows[0];
        if (!node) throw new Refused('access-denied', 'unknown-node');
        let opened: OpenedSecretRequest;
        try {
          opened = await openSecretRequest(request, {
            nodeId,
            lookup: currentCertLookup(tx, roles),
            now,
            expiredGraceMs: 0,
            isBound: async (candidate) => {
              // A lessee's OS (node-tenant) never gets platform secrets (§13).
              if (roles.get(candidate.serial) === 'node-tenant') return false;
              if (
                (await boundToStep(tx, nodeId, candidate)) ||
                (await boundToAllocation(tx, nodeId, candidate, options.allocationRefs))
              )
                return true;
              hostUnit = await boundToHostUnit(tx, nodeId, candidate, hostUnitRefs);
              return hostUnit !== undefined;
            },
          });
        } catch (error) {
          if (!isComputeError(error, 'ACCESS_DENIED')) throw error;
          const refusal = (error.details?.refusal as SecretRefusal | undefined) ?? 'access-denied';
          const signed = refusal === 'not-bound' && roles.size > 0;
          const tenantControlled = [...roles.values()].includes('node-tenant');
          throw new Refused(
            tenantControlled ? 'access-denied' : refusal,
            tenantControlled ? 'node-tenant' : String(error.details?.reason ?? refusal),
            // A signed but unbound request is the node's own: record it in its tenant.
            signed ? node.owner_tenant_id : undefined,
          );
        }
        // The ref's tenant is active: a suspended or deleted tenant's secrets are not released, even
        // while teardown has not reached its instances yet (§12.8; the workload broker does the same).
        const refTenant = parseSecretRef(opened.ref)?.tenantId;
        const tenancy =
          refTenant !== undefined &&
          (
            await tx.query<{ present: boolean }>(
              `SELECT to_regclass('compute_tenant_states') IS NOT NULL AS present`,
            )
          ).rows[0]?.present;
        if (tenancy) {
          const blocked = (
            await tx.query<{ state: string }>(
              `SELECT state FROM compute_tenant_states WHERE tenant_id = $1 AND state <> 'active'`,
              [refTenant],
            )
          ).rows[0];
          if (blocked)
            throw new Refused('access-denied', `tenant-${blocked.state}`, node.owner_tenant_id);
        }
        return { opened, owner: node.owner_tenant_id };
      });
      // After the signature: a relayed copy of an answered request is refused, and burns nothing.
      if (!remember(`${nodeId}\0${opened.requestId}`, now))
        throw new Refused('access-denied', 'replayed', owner);

      const scheme = opened.ref.slice(0, Math.max(0, opened.ref.indexOf(':')));
      const store = stores.get(scheme);
      if (!store) throw new Refused('unavailable', 'no-store', owner);
      let value: string;
      try {
        value = await store.resolve(opened.ref as SecretRef);
      } catch (error) {
        throw new Refused(
          isComputeError(error, 'NOT_FOUND') ? 'not-found' : 'unavailable',
          isComputeError(error, 'NOT_FOUND') ? 'not-found' : 'store-error',
          owner,
        );
      }
      const expiresAt = now + ttlMs;
      const response = sealSecretResponse(opened, value, { expiresAt });
      await audit(opened, nodeId, owner, context, expiresAt, hostUnit);
      return response;
    } catch (error) {
      if (error instanceof Refused) {
        await recordRefusal(request, context, error);
        return refuseSecretRequest(
          { ref: request?.ref ?? '', requestId: request?.requestId ?? '' },
          error.refusal,
        );
      }
      log?.error('secret broker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return refuseSecretRequest(
        { ref: request?.ref ?? '', requestId: request?.requestId ?? '' },
        'unavailable',
      );
    }
  }

  /** The release, in the ref's tenant (else the node owner's): ref and version, never the value. */
  async function audit(
    opened: OpenedSecretRequest,
    nodeId: string,
    owner: string,
    context: GatewayCallContext,
    expiresAt: number,
    hostUnit: string | undefined,
  ): Promise<void> {
    const tenantId = parseSecretRef(opened.ref)?.tenantId ?? owner;
    await database.transaction(async (tx) => {
      const version = (
        await tx.query<{ version: number | string }>(
          `SELECT version FROM secret_refs WHERE ref = $1`,
          [opened.ref],
        )
      ).rows[0]?.version;
      await tx.query(
        `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'secret.released', 'secret', $3, $4)`,
        [
          newId('aud'),
          tenantId,
          opened.ref,
          JSON.stringify({
            nodeId,
            requestId: opened.requestId,
            serial: opened.serial,
            workflowId: opened.workflowId || null,
            stepId: opened.stepId || null,
            allocationId: opened.allocationId || null,
            ...(hostUnit ? { hostUnit } : {}),
            version: version === undefined ? null : Number(version),
            expiresAt: new Date(expiresAt).toISOString(),
            ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
          }),
        ],
      );
    });
  }

  return { secret };
}
