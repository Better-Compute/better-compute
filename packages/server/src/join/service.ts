import {
  ComputeError,
  isAttestationDeferral,
  isComputeError,
  newId,
  shardOf,
  type AgentRole,
  type AttestationDeferral,
  type AttestorVerifier,
  type AuthzWriter,
  type Clock,
  type EventPublisher,
  type Logger,
  type NodeRole,
  type NodeTrust,
  type SqlExecutor,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import {
  AgentRole as WireAgentRole,
  JoinResponseBodySchema,
  encodeMessage,
  renewPopSigningInput,
  type JoinDeferral,
  type JoinRequest,
  type JoinResponse,
  type JoinResponseBody,
  type RenewRequest,
  type RenewResponse,
} from '@better-compute/protocol';
import { requestAcceptance } from '../controllers/lifecycle.js';
import { nodeWorkKind, refreshNodeAuthz } from '../controllers/node-state.js';
import { joinTokenAttestor, type JoinTokenRefusal } from './attestor.js';
import type { JoinCrypto, JoinSignature, JoinTrustBundle } from './crypto.js';
import {
  claimedHardwareKey,
  coreClaims,
  matchesExpect,
  needsBinding,
  parseExpect,
} from './hardware.js';
import { refusalBucket } from './rate.js';
import { sha256, toHex } from './token.js';

// JoinService (PLAN.md §3.3 steps 3-4, §6 Install, §7.7 Join/Renew, §13). It runs in `api`; the
// gateway only relays (P14): it cannot read the sealed token, forge the signed response, or mint a
// certificate without the node key's proof of possession. No step here calls IAM (P7).

/** What the relaying gateway knows about a call (all optional; the proofs stand on their own). */
export interface GatewayCallContext {
  /** The node id of the caller's verified mTLS certificate (Renew, SecretRequest). */
  peerNodeId?: string;
  /** The relaying gateway's id. */
  gatewayId?: string;
}

export interface JoinServiceOptions {
  database: SqlExecutor;
  clock: Clock;
  work: WorkQueue;
  events: EventPublisher;
  /** Keys and CA; without them `join` and `renew` fail `INVALID_CONFIG`. */
  crypto?: JoinCrypto;
  /**
   * Extra attestors (anything with `extension: 'attestor'` is taken from this list, so the
   * registry's extensions can be passed as is). One with id `join-token` replaces the built-in.
   */
  attestors?: readonly unknown[];
  log?: Logger;
  /** Lifetime of node certificates (default and maximum 86 400 s, §13). */
  certTtlSeconds?: number;
  /** Writes the node's `compute-node` projection row at join, so IAM can decide on it (§12.4). */
  authz?: AuthzWriter;
  /**
   * The IAM root tenant: refused joins that name no authenticated tenant are recorded under it
   * (`security.join.refused`). Without it refusals are only logged.
   */
  rootTenantId?: string;
  /** `security.join.refused` events per (attestor, reason) per minute (default 60). */
  refusalEventsPerMinute?: number;
  /**
   * `JoinResponse.trust`: the command-signing roots daemons verify signed intent against (§13),
   * from `pki.commandSigning`. Wins over `crypto.trustBundle`.
   */
  trustBundle?: JoinTrustBundle;
}

/** What JoinService records about a refused join (`security.join.refused`). */
export interface JoinRefusalEvent {
  attestor: string;
  /** `<attestor>:<reason>` from the attestor, or JoinService's own reason. */
  reason: string;
  role: string;
  /** SHA-256 of the request's CSR (hex): correlates retries, reveals nothing. */
  csrSha256: string | null;
  /** SHA-256 hardware key claimed (hex), when the claims make one. */
  hardwareKey: string | null;
  gatewayId?: string;
  /** Only when the token's secret verified (the event is then the token's tenant's). */
  tokenId?: string;
  nodeId?: string;
  /** Refusals of the same (attestor, reason) dropped by the rate bound since the last event. */
  suppressed: number;
}

export interface JoinService {
  join(request: JoinRequest, context?: GatewayCallContext): Promise<JoinResponse>;
  renew(request: RenewRequest, context?: GatewayCallContext): Promise<RenewResponse>;
}

/** `RenewRequest.client_time` is accepted within this distance of server time (§7.7). */
export const renewWindowMs = 60_000;
/** Accepted proofs are remembered this long, which outlasts the window on both sides. */
export const renewReplayTtlMs = 120_000;

const dayS = 86_400;
const ramdiskMaxTtlS = 2 * 3600;

const toWireRole: Readonly<Record<AgentRole, WireAgentRole>> = {
  node: WireAgentRole.NODE,
  site: WireAgentRole.SITE,
  ramdisk: WireAgentRole.RAMDISK,
};

/** `nodes.role` of a machine joining a pool of each class (§2, §11.1). */
const roleOfClass: Readonly<Record<string, NodeRole>> = {
  'metal-host': 'host',
  'vps-host': 'host',
  provider: 'host',
  'metal-dedicated': 'dedicated',
};

const deny = (reason: string) =>
  new ComputeError('ACCESS_DENIED', 'Join refused', undefined, { reason });
const denyRenew = (reason: string) =>
  new ComputeError('ACCESS_DENIED', 'Renew refused', undefined, { reason });

function requestedRole(role: WireAgentRole): AgentRole {
  switch (role) {
    case WireAgentRole.UNSPECIFIED:
    case WireAgentRole.NODE:
      return 'node';
    case WireAgentRole.SITE:
      return 'site';
    case WireAgentRole.RAMDISK:
      return 'ramdisk';
    default:
      throw new ComputeError('INVALID_INPUT', `Unknown agent role ${String(role)}`);
  }
}

type Timestamp = NonNullable<JoinResponseBody['issuedAt']>;

function timestamp(ms: number): Timestamp {
  const seconds = Math.floor(ms / 1000);
  return {
    $typeName: 'google.protobuf.Timestamp',
    seconds: BigInt(seconds),
    nanos: Math.round((ms - seconds * 1000) * 1_000_000),
  };
}

const timestampMs = (value: Timestamp): number =>
  Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);

/** A `Signature` message from the port's answer. */
function signature(value: JoinSignature): NonNullable<JoinResponse['sig']> {
  return {
    $typeName: 'bettercompute.common.v1.Signature',
    kid: value.kid,
    sig: value.sig,
    chain: [...(value.chain ?? [])],
  };
}

const isAttestor = (value: unknown): value is AttestorVerifier =>
  typeof value === 'object' &&
  value !== null &&
  (value as { extension?: unknown }).extension === 'attestor' &&
  typeof (value as { verify?: unknown }).verify === 'function';

/** The canonical serial form: lower-case hex without leading zeros (`node_certs.serial`). */
export function normalizeSerial(serial: string): string {
  const text = serial.trim().toLowerCase().replace(/:/g, '');
  if (!/^[0-9a-f]{1,40}$/.test(text))
    throw new ComputeError('INVALID_INPUT', 'A certificate serial is 1 to 40 hex digits');
  return BigInt(`0x${text}`).toString(16);
}

/**
 * An attestor's `allowedKinds`, checked before it restricts a certificate: exact kinds or
 * `prefix.*` globs. A malformed entry is a bug in the attestor, so the join fails loudly rather
 * than issuing a certificate with a restriction nobody can read.
 */
function checkedKinds(kinds: readonly string[] | undefined): readonly string[] | undefined {
  if (kinds === undefined) return undefined;
  for (const kind of kinds)
    if (typeof kind !== 'string' || !/^[a-z][\w-]*(\.[\w-]+)*(\.\*)?$/.test(kind))
      throw new ComputeError(
        'INVALID_CONFIG',
        `Attestor returned an invalid allowed kind: ${String(kind)}`,
      );
  return kinds;
}

/** `node_bindings` (core/0012_v02_evidence): one node per (attestor, subject); another node is `bound-elsewhere`. */
async function bindSubject(
  tx: SqlTx,
  attestor: string,
  subject: Uint8Array,
  nodeId: string,
): Promise<void> {
  if (!(subject instanceof Uint8Array) || subject.length !== 32)
    throw new ComputeError(
      'INVALID_CONFIG',
      `Attestor ${attestor} returned a bind subject that is not 32 bytes`,
    );
  const { rows } = await tx.query<{ node_id: string }>(
    `WITH ins AS (
       INSERT INTO node_bindings (attestor, subject, node_id) VALUES ($1, $2, $3)
       ON CONFLICT (attestor, subject) DO NOTHING RETURNING node_id)
     SELECT node_id FROM ins
     UNION ALL SELECT node_id FROM node_bindings WHERE attestor = $1 AND subject = $2
     LIMIT 1`,
    [attestor, subject, nodeId],
  );
  if (rows[0]?.node_id !== nodeId) throw deny('bound-elsewhere');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

interface PoolRow {
  id: string;
  owner_tenant_id: string;
  site_id: string;
  class: string;
  agent: string;
}

interface ExistingNode {
  id: string;
  owner_tenant_id: string;
  pool_id: string | null;
  site_id: string;
  role: NodeRole;
  identity_gen: number;
  trust: NodeTrust;
}

/** Builds JoinService over the store, the clock and the crypto port. */
export function createJoinService(options: JoinServiceOptions): JoinService {
  const { database, clock, work, events } = options;
  const log = options.log;
  const certTtlSeconds = Math.min(options.certTtlSeconds ?? dayS, dayS);
  const attestors = new Map<string, AttestorVerifier>();
  const builtIn = joinTokenAttestor({
    onRefusal: (refusal: { reason: JoinTokenRefusal; tokenId?: string }) =>
      log?.warn('join refused', { reason: refusal.reason, tokenId: refusal.tokenId }),
  });
  attestors.set(builtIn.id, builtIn);
  for (const extension of options.attestors ?? [])
    if (isAttestor(extension)) attestors.set(extension.id, extension);
  /** Renew proofs accepted recently: statement digest → expiry. */
  const replay = new Map<string, number>();

  function requireCrypto(): JoinCrypto {
    if (!options.crypto)
      throw new ComputeError(
        'INVALID_CONFIG',
        'JoinService is not configured: pass pki.nodeCa and the JoinService keys (pki.join)',
      );
    return options.crypto;
  }

  function remember(key: string, now: number): boolean {
    for (const [stored, expiry] of replay) {
      if (expiry > now) break; // insertion order is expiry order
      replay.delete(stored);
    }
    const existing = replay.get(key);
    if (existing !== undefined && existing > now) return false;
    replay.set(key, now + renewReplayTtlMs);
    return true;
  }

  async function issue(
    crypto: JoinCrypto,
    tx: SqlTx,
    input: {
      nodeId: string;
      siteId: string;
      role: AgentRole | 'node-tenant';
      identityGen: number;
      csr: Uint8Array;
      spkiSha256: Uint8Array;
      ttlSeconds: number;
      /** `node_certs.allowed_kinds`: exact kinds or `prefix.*`; undefined/null = unrestricted. */
      allowedKinds?: readonly string[] | null;
    },
  ) {
    const issued = await crypto.nodeCa.sign(input.csr, {
      uriSans: [`spiffe://${crypto.trustDomain}/site/${input.siteId}/node/${input.nodeId}`],
      role: input.role,
      usage: 'client',
      ttlSeconds: input.ttlSeconds,
    });
    const serial = normalizeSerial(issued.serial);
    await tx.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after,
         allowed_kinds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        serial,
        input.nodeId,
        input.role,
        input.identityGen,
        input.spkiSha256,
        issued.certificate,
        new Date(issued.notBefore),
        new Date(issued.notAfter),
        input.allowedKinds ? [...input.allowedKinds] : null,
      ],
    );
    return { ...issued, serial, chain: [issued.certificate, ...issued.chain] };
  }

  /** The signed answer to a deferred join: no node, no certificate, the same CSR binding. */
  async function deferred(
    crypto: JoinCrypto,
    attestorId: string,
    csrSha256: Uint8Array,
    deferral: AttestationDeferral,
  ): Promise<JoinResponse> {
    let kind: JoinDeferral['kind'];
    if (deferral.deferred === 'challenge') {
      if (!(deferral.challenge instanceof Uint8Array) || deferral.challenge.length === 0)
        throw new ComputeError(
          'INVALID_CONFIG',
          `Attestor ${attestorId} deferred with no challenge`,
        );
      kind = {
        case: 'challenge',
        value: {
          $typeName: 'bettercompute.agent.v1.JoinChallenge',
          attestor: attestorId,
          payload: deferral.challenge,
          ...(deferral.notAfter ? { notAfter: timestamp(deferral.notAfter.getTime()) } : {}),
        },
      };
    } else {
      kind = {
        case: 'pending',
        value: {
          $typeName: 'bettercompute.agent.v1.JoinPending',
          requestId: deferral.requestId ?? '',
          retryAfterSeconds: Math.max(1, Math.round(deferral.retryAfterSeconds ?? 30)),
        },
      };
    }
    log?.info('join deferred', {
      attestor: attestorId,
      deferred: deferral.deferred,
      ...(deferral.requestId ? { requestId: deferral.requestId } : {}),
    });
    const body: JoinResponseBody = {
      $typeName: 'bettercompute.agent.v1.JoinResponseBody',
      nodeId: '',
      certChain: [],
      csrSha256,
      trustDomain: crypto.trustDomain,
      siteId: '',
      role: WireAgentRole.UNSPECIFIED,
      issuedAt: timestamp(clock.now()),
      deferral: { $typeName: 'bettercompute.agent.v1.JoinDeferral', kind },
    };
    const bytes = encodeMessage(JoinResponseBodySchema, body);
    return {
      $typeName: 'bettercompute.agent.v1.JoinResponse',
      body: bytes,
      sig: signature(await crypto.sign('join-response', [bytes])),
    };
  }

  const refusals = refusalBucket(options.refusalEventsPerMinute ?? 60);

  /**
   * `security.join.refused` (§13), in its own short transaction after the join's rolled back. The
   * tenant is the token's only when the attestor authenticated the token; otherwise the root
   * tenant, so an unauthenticated caller cannot write into another tenant's event stream. No token,
   * CSR bytes or raw claims: hashes only. Rate-bounded per (attestor, reason).
   */
  async function recordRefusal(
    error: unknown,
    request: JoinRequest,
    context: GatewayCallContext,
  ): Promise<void> {
    const attestorId = (request?.attestor as string | undefined) || 'join-token';
    const details = (isComputeError(error) ? error.details : undefined) ?? {};
    const refusal =
      typeof details.refusal === 'string'
        ? details.refusal
        : typeof details.reason === 'string'
          ? `join:${details.reason}`
          : 'join:denied';
    const tenantId = typeof details.tenantId === 'string' ? details.tenantId : options.rootTenantId;
    log?.warn('join refused', { attestor: attestorId, reason: refusal });
    if (!tenantId) return;
    const admitted = refusals.take(`${attestorId}\0${refusal}`, clock.now());
    if (admitted === undefined) return;
    const authenticated = typeof details.tenantId === 'string';
    let hardwareKey: string | null = null;
    try {
      hardwareKey = claimedHardwareKey(request.claims)?.key ?? null;
    } catch {
      hardwareKey = null;
    }
    const data: JoinRefusalEvent = {
      attestor: attestorId,
      reason: refusal,
      role: String(request?.role ?? ''),
      csrSha256: request?.csr instanceof Uint8Array ? toHex(sha256(request.csr)) : null,
      hardwareKey,
      ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
      ...(authenticated && typeof details.tokenId === 'string' ? { tokenId: details.tokenId } : {}),
      ...(authenticated && typeof details.nodeId === 'string' ? { nodeId: details.nodeId } : {}),
      suppressed: admitted,
    };
    try {
      await database.transaction((tx) =>
        events.publish(tx, {
          type: 'security.join.refused',
          tenantId,
          subject: `join/${attestorId}`,
          data: { ...data },
        }),
      );
    } catch (failure) {
      log?.error('recording a join refusal failed', {
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  }

  async function join(
    request: JoinRequest,
    context: GatewayCallContext = {},
  ): Promise<JoinResponse> {
    try {
      return await joinOnce(request, context);
    } catch (error) {
      if (isComputeError(error, 'ACCESS_DENIED')) await recordRefusal(error, request, context);
      throw error;
    }
  }

  async function joinOnce(
    request: JoinRequest,
    context: GatewayCallContext,
  ): Promise<JoinResponse> {
    const crypto = requireCrypto();
    if (!(request?.csr instanceof Uint8Array) || request.csr.length === 0)
      throw new ComputeError('INVALID_INPUT', 'JoinRequest.csr is required');
    const role = requestedRole(request.role);
    const attestorId = request.attestor || 'join-token';
    const attestor = attestors.get(attestorId);
    if (!attestor) throw new ComputeError('UNSUPPORTED', `Attestor ${attestorId} is not available`);
    if (!attestor.roles.includes(role)) throw deny('role');
    let csr;
    try {
      csr = await crypto.inspectCsr(request.csr);
    } catch (error) {
      throw new ComputeError('INVALID_INPUT', 'JoinRequest.csr is not a valid request', undefined, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const now = clock.now();
    // `join-token` gets the opened token as its payload; every other attestor its own evidence
    // (`JoinRequest.attestation`) plus the opened token, when there is one, as `evidence.token`.
    let payload = request.attestation ?? new Uint8Array(0);
    let openedToken: string | undefined;
    if (request.sealedToken?.length) {
      try {
        openedToken = await crypto.openSealedToken(request.sealedToken, request.csr, now);
      } catch (error) {
        log?.warn('join refused', {
          reason: 'sealed-token',
          detail: isComputeError(error) ? error.details?.reason : undefined,
        });
        throw deny('token');
      }
      if (attestorId === 'join-token') payload = new TextEncoder().encode(openedToken);
    } else if (attestorId === 'join-token') throw deny('token');

    const key = claimedHardwareKey(request.claims);
    const revoked: string[] = [];
    const response = await database.transaction(async (tx) => {
      const result = await attestor.verify(
        { attestor: attestorId, payload, ...(openedToken ? { token: openedToken } : {}) },
        { tx, clock, claims: coreClaims(request.claims), role, csrSha256: csr.sha256 },
      );
      // A two-round join: the attestor's rows commit, nothing is issued, the agent comes back.
      if (isAttestationDeferral(result)) return deferred(crypto, attestorId, csr.sha256, result);
      if (result.role !== role) throw deny('role');

      const token = result.tokenId
        ? (
            await tx.query<{ expect: unknown; allow_reclaim: boolean }>(
              'SELECT expect, allow_reclaim FROM join_tokens WHERE id = $1',
              [result.tokenId],
            )
          ).rows[0]
        : undefined;
      const expect = parseExpect(token?.expect);
      if (expect && !matchesExpect(expect, request.claims)) throw deny('expect');
      if (needsBinding(key) && !expect && !result.nodeId) throw deny('placeholder-hardware');

      // Where the node lands.
      let pool: PoolRow | undefined;
      if (result.poolId) {
        pool = (
          await tx.query<PoolRow>(
            'SELECT id, owner_tenant_id, site_id, class, agent FROM pools WHERE id = $1 FOR SHARE',
            [result.poolId],
          )
        ).rows[0];
        if (!pool) throw deny('pool');
        if (pool.agent !== 'bcd') throw deny('pool');
        if (pool.owner_tenant_id !== result.tenantId) throw deny('tenant');
        if (result.siteId && result.siteId !== pool.site_id) throw deny('site');
      }
      if (role === 'site' && pool) throw deny('pool');
      const siteId = pool?.site_id ?? result.siteId;
      if (!siteId) throw deny('site');
      const site = (
        await tx.query<{ id: string; kind: string }>('SELECT id, kind FROM sites WHERE id = $1', [
          siteId,
        ])
      ).rows[0];
      if (!site) throw deny('site');
      const ownerTenantId = pool?.owner_tenant_id ?? result.tenantId;
      const nodeRole: NodeRole =
        role === 'site' ? 'site' : pool ? (roleOfClass[pool.class] ?? 'unassigned') : 'unassigned';
      const trust: NodeTrust =
        result.trust ?? (site.kind === 'custom' ? 'tenant-owned' : 'platform');

      // Reclaim (§3.3 step 4): a trusted key already enrolled, proven again with a new node key.
      let existing: ExistingNode | undefined;
      if (result.nodeId) {
        existing = (
          await tx.query<ExistingNode>(
            `SELECT id, owner_tenant_id, pool_id, site_id, role, identity_gen, trust FROM nodes
              WHERE id = $1 FOR UPDATE`,
            [result.nodeId],
          )
        ).rows[0];
        if (!existing) throw deny('node');
      } else if (key?.trusted) {
        existing = (
          await tx.query<ExistingNode>(
            `SELECT id, owner_tenant_id, pool_id, site_id, role, identity_gen, trust FROM nodes
              WHERE hardware_key = decode($1, 'hex') AND hardware_key_trusted FOR UPDATE`,
            [key.key],
          )
        ).rows[0];
        if (existing && !token?.allow_reclaim) throw deny('reclaim');
      }
      if (
        existing &&
        (existing.owner_tenant_id !== ownerTenantId ||
          existing.site_id !== siteId ||
          (existing.pool_id ?? undefined) !== pool?.id ||
          existing.role !== nodeRole)
      )
        throw deny('reclaim');

      let nodeId: string;
      let identityGen: number;
      if (existing) {
        nodeId = existing.id;
        identityGen = Number(existing.identity_gen) + 1;
        // A reclaimed machine is re-accepted: INVALID_STATE unless it is adopting or adopted. An
        // attestor that proved the node itself (v0.2 `provisioned`, `x509pop`) keeps its state.
        if (result.nodeId) await work.enqueue(tx, nodeWorkKind, nodeId);
        else await requestAcceptance(tx, work, nodeId);
        await tx.query('UPDATE nodes SET identity_gen = $2, version = version + 1 WHERE id = $1', [
          nodeId,
          identityGen,
        ]);
        const { rows } = await tx.query<{ serial: string }>(
          `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = 'reclaimed'
            WHERE node_id = $1 AND revoked_at IS NULL RETURNING serial`,
          [nodeId],
        );
        revoked.push(...rows.map((row) => row.serial));
        await tx.query(
          `INSERT INTO node_sessions (node_id, session_epoch, last_seen)
           VALUES ($1, 0, compute_now()) ON CONFLICT (node_id) DO NOTHING`,
          [nodeId],
        );
      } else {
        nodeId = newId('node');
        identityGen = 1;
        // The partial unique index on trusted keys decides a concurrent join of the same machine.
        const inserted = await tx.query(
          `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state,
             maintenance, cordoned, connectivity, trust, no_schedule_reasons, hardware_key,
             hardware_key_trusted, spec, generation, observed_generation, next_cmd_seq,
             identity_gen, shard, version)
           VALUES ($1, $2, $3, $4, $5, 'adopting', false, false, 'disconnected', $6, '{}',
             decode($7, 'hex'), $8, NULL, 0, 0, 1, $9, $10, 1)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            nodeId,
            siteId,
            pool?.id ?? null,
            ownerTenantId,
            nodeRole,
            trust,
            key?.key ?? null,
            key?.trusted ?? false,
            identityGen,
            shardOf(nodeId),
          ],
        );
        if (inserted.rowCount !== 1)
          throw new ComputeError('CONFLICT', 'This machine joined concurrently; retry', undefined, {
            retryAfterMs: 1000,
          });
        // The join itself is liveness evidence: Liveness counts from here until the first Hello.
        await tx.query(
          'INSERT INTO node_sessions (node_id, session_epoch, last_seen) VALUES ($1, 0, compute_now())',
          [nodeId],
        );
        await work.enqueue(tx, nodeWorkKind, nodeId);
      }

      const ttlSeconds = Math.min(
        certTtlSeconds,
        result.certTtlSeconds ?? certTtlSeconds,
        role === 'ramdisk' ? ramdiskMaxTtlS : certTtlSeconds,
      );
      // A dedicated-root lease (§13): the lessee's OS on a tenant-controlled node gets a
      // `node-tenant` certificate (telemetry and `leave`, never secrets). Metal sets the trust and
      // revokes the platform identity before that OS runs, so this is where the role is decided.
      // The platform ramdisk (teardown, wipe attestation) keeps its own role.
      const tenantControlled =
        role === 'node' && (existing ? existing.trust : trust) === 'tenant-controlled';
      const certificate = await issue(crypto, tx, {
        nodeId,
        siteId,
        role: tenantControlled ? 'node-tenant' : role,
        identityGen,
        csr: request.csr,
        spkiSha256: csr.spkiSha256,
        ttlSeconds,
        allowedKinds: checkedKinds(result.allowedKinds),
      });
      // A hardware subject the attestor proved (a TPM EK hash) is bound to this node for good: a
      // later join proving it reclaims this node, and it can never admit another one.
      if (result.bind !== undefined) await bindSubject(tx, attestorId, result.bind, nodeId);

      if (options.authz) await refreshNodeAuthz(tx, options.authz, nodeId);
      const subject = `node/${nodeId}`;
      await events.publish(tx, {
        type: 'node.joined',
        tenantId: ownerTenantId,
        subject,
        data: {
          nodeId,
          siteId,
          poolId: pool?.id ?? null,
          role: nodeRole,
          attestor: attestorId,
          reclaimed: existing !== undefined,
          hardwareKeyTrusted: key?.trusted ?? false,
          serial: certificate.serial,
          ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
        },
      });
      for (const serial of revoked)
        await events.publish(tx, {
          type: 'security.certificate-revoked',
          tenantId: ownerTenantId,
          subject,
          data: { nodeId, serial, reason: 'reclaimed' },
        });
      await tx.query(
        `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, 'node', $4, $5)`,
        [
          newId('aud'),
          ownerTenantId,
          existing ? 'node.reclaimed' : 'node.joined',
          nodeId,
          JSON.stringify({
            attestor: attestorId,
            tokenId: result.tokenId ?? null,
            serial: certificate.serial,
            revoked,
            hardwareKey: key?.key ?? null,
            hardwareKeyTrusted: key?.trusted ?? false,
          }),
        ],
      );

      const bundle = options.trustBundle ?? crypto.trustBundle;
      const body: JoinResponseBody = {
        $typeName: 'bettercompute.agent.v1.JoinResponseBody',
        nodeId,
        certChain: certificate.chain,
        trust: {
          $typeName: 'bettercompute.common.v1.TrustBundle',
          version: bundle?.version ?? 0n,
          commandSigningRoots: [...(bundle?.commandSigningRoots ?? [])],
        },
        csrSha256: csr.sha256,
        trustDomain: crypto.trustDomain,
        siteId,
        role: toWireRole[role],
        issuedAt: timestamp(clock.now()),
      };
      const bytes = encodeMessage(JoinResponseBodySchema, body);
      const signed: JoinResponse = {
        $typeName: 'bettercompute.agent.v1.JoinResponse',
        body: bytes,
        sig: signature(await crypto.sign('join-response', [bytes])),
      };
      return signed;
    });
    for (const serial of revoked)
      await Promise.resolve(crypto.nodeCa.revoke?.(serial, 'reclaimed')).catch((error: unknown) =>
        log?.error('revoking a reclaimed certificate failed', {
          serial,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return response;
  }

  async function renew(
    request: RenewRequest,
    context: GatewayCallContext = {},
  ): Promise<RenewResponse> {
    const crypto = requireCrypto();
    const leaf = request?.chain?.[0];
    if (!(leaf instanceof Uint8Array) || leaf.length === 0) throw denyRenew('chain');
    if (!request.clientTime) throw denyRenew('client-time');
    const now = clock.now();
    const clientTime = request.clientTime;
    if (Math.abs(timestampMs(clientTime) - now) > renewWindowMs) throw denyRenew('client-time');
    if (!(request.popSig instanceof Uint8Array) || request.popSig.length !== 64)
      throw denyRenew('proof');
    let csr;
    let current;
    try {
      csr = await crypto.inspectCsr(request.csr);
    } catch {
      throw denyRenew('csr');
    }
    try {
      current = await crypto.inspectCertificate(leaf);
    } catch {
      throw denyRenew('certificate');
    }
    const serial = normalizeSerial(current.serial);

    return database.transaction(async (tx) => {
      // The presented leaf must be exactly a certificate compute issued, still current: this is
      // the chain check, revocation and identity generation in one lookup (P1: Postgres is truth).
      const { rows } = await tx.query<{
        node_id: string;
        role: AgentRole;
        der: Uint8Array;
        usable: boolean;
        site_id: string;
        provision_state: string;
        identity_gen: number;
        current_gen: boolean;
        allowed_kinds: string[] | null;
      }>(
        `SELECT c.node_id, c.role, c.der, c.allowed_kinds, n.site_id, n.provision_state, n.identity_gen,
                (c.revoked_at IS NULL AND c.not_after > compute_now()) AS usable,
                c.identity_gen = n.identity_gen AS current_gen
           FROM node_certs c JOIN nodes n ON n.id = c.node_id
          WHERE c.serial = $1 FOR SHARE OF n`,
        [serial],
      );
      const row = rows[0];
      if (!row || !sameBytes(new Uint8Array(row.der), leaf)) throw denyRenew('certificate');
      if (!row.usable || !row.current_gen) throw denyRenew('revoked');
      if (row.provision_state === 'retired') throw denyRenew('retired');
      if (context.peerNodeId !== undefined && context.peerNodeId !== row.node_id)
        throw denyRenew('peer');
      // Proof of possession by the current key over [sha256(csr), node_id, client_time]; the node
      // id comes from compute's own record of the certificate, never from the request.
      const statement = renewPopSigningInput({
        csrSha256: csr.sha256,
        nodeId: row.node_id,
        clientTime,
      });
      if (!(await crypto.verifyNodeSignature(leaf, statement, request.popSig)))
        throw denyRenew('proof');
      if (!remember(toHex(sha256(statement)), now)) throw denyRenew('replay');

      const issued = await issue(crypto, tx, {
        nodeId: row.node_id,
        siteId: row.site_id,
        role: row.role,
        identityGen: Number(row.identity_gen),
        csr: request.csr,
        spkiSha256: csr.spkiSha256,
        ttlSeconds:
          row.role === 'ramdisk' ? Math.min(certTtlSeconds, ramdiskMaxTtlS) : certTtlSeconds,
        // A restricted certificate renews restricted: the gateway caches the set per session.
        allowedKinds: row.allowed_kinds,
      });
      const renewed: RenewResponse = {
        $typeName: 'bettercompute.agent.v1.RenewResponse',
        certChain: issued.chain,
        notAfter: timestamp(issued.notAfter),
      };
      return renewed;
    });
  }

  return { join, renew };
}
