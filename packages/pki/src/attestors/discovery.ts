import type { KeyObject } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  defineAttestor,
  type AttestationDeferral,
  type AttestationResult,
  type AttestorVerifier,
  type SqlTx,
} from '@better-compute/core';
import { signingInput, site } from '@better-compute/protocol';
import { normalizeClaim, type JoinClaims } from '../claims.js';
import { sha256 } from '../keys.js';
import { consumeApprovedRequest, recordPendingRequest, requestRejected } from './join-requests.js';
import { nodeCertsLookup, signNodeStatement, verifyNodeStatement } from '../node-signatures.js';
import {
  checkSingleUseToken,
  csrSha256Of,
  refuser,
  spendToken,
  tokenOf,
  useOnce,
  type AttestorBaseOptions,
} from './common.js';

/**
 * The `discovery` attestor (v0.2, PLAN.md §5 walkthrough "Commission", §8.5): a PXE-booted
 * ramdisk joins with the single-use `discovery` token from its iPXE script AND the site agent's
 * `SignedDiscoveryAssertion` (site/v1) that it served this MAC/IP. The assertion is signed with the
 * site agent's node key (purpose `discovery-assertion`), under the `site:<id>:boot` lease epoch the
 * agent held; the control plane refuses an epoch that is not the lease's current one, so a fenced
 * (stale) boot server can no longer vouch. The certificate is a ramdisk one: at most 2 h and only
 * the commissioning kinds.
 *
 * Evidence: `JoinRequest.sealed_token` (the discovery token) + `JoinRequest.attestation` (the
 * serialized `SignedDiscoveryAssertion`).
 */
export const discoveryCertTtlSeconds = 2 * 3600;
/** Command kinds a ramdisk certificate allows (§5: inventory, diag, wipe, deploy, kexec). */
export const discoveryAllowedKinds: readonly string[] = Object.freeze([
  'inventory',
  'diag.*',
  'wipe',
  'deploy.*',
  'boot.kexec',
]);
/**
 * Whether a restricted certificate (`node_certs.allowed_kinds`, from `AttestationResult.allowedKinds`)
 * allows a command kind: an exact kind, or `prefix.*` for every kind under `prefix.` (never `prefix`
 * itself). `null`/`undefined` means unrestricted; an empty list allows nothing. Gateway dispatch
 * and `CommandQueue.enqueue` share this so the two checks cannot disagree.
 */
export function commandKindAllowed(
  kind: string,
  allowed: readonly string[] | null | undefined,
): boolean {
  if (allowed === null || allowed === undefined) return true;
  for (const entry of allowed) {
    if (entry === kind) return true;
    if (entry.endsWith('.*') && entry.length > 2 && kind.startsWith(entry.slice(0, -1)))
      return true;
  }
  return false;
}

/** An assertion is valid at most this long after it was issued, whatever its `not_after` says. */
export const discoveryAssertionMaxAgeMs = 15 * 60_000;

const bootLeaseName = (siteId: string) => `site:${siteId}:boot`;

export interface DiscoveryAttestorOptions extends AttestorBaseOptions {
  /**
   * The node a discovery workflow runs for (`DiscoveryAssertion.workflow_id` → `workflows.node_id`):
   * a known machine re-commissions as itself. Without it every discovery creates a node.
   */
  resolveWorkflowNode?(tx: SqlTx, workflowId: string): Promise<string | undefined>;
  certTtlSeconds?: number;
  allowedKinds?: readonly string[];
  maxAgeMs?: number;
  /**
   * Operator approval through `join_requests` (joinRequests.approve/reject): `never` (default),
   * `unknown-machines` (no discovery workflow names the machine) or `always`. A pending join is
   * deferred; the ramdisk retries with the same CSR, token and a fresh assertion, and the approved
   * request is consumed in that join's transaction (single use).
   */
  approval?: 'never' | 'unknown-machines' | 'always';
  /**
   * The machine's TRUSTED hardware key bytes (inventory's `hardwareKeyFromClaims`, when trusted), so
   * requests key on it; without one they key on (site, MAC).
   */
  hardwareKey?(claims: JoinClaims): Uint8Array | undefined;
  /** How long a pending request waits for a decision (default 24 h). */
  pendingTtlSeconds?: number;
  retryAfterSeconds?: number;
}

/** The site agent side (Go in `bcd site`; TS for the sim): signs an assertion with its node key. */
export function signDiscoveryAssertion(
  privateKey: KeyObject,
  assertion: {
    siteId: string;
    siteAgentNodeId: string;
    bootLeaseEpoch: bigint | number;
    mac: string;
    ip?: string;
    productUuid?: string;
    workflowId?: string;
    issuedAt: number;
    notAfter: number;
  },
): Uint8Array {
  const body = toBinary(
    site.DiscoveryAssertionSchema,
    create(site.DiscoveryAssertionSchema, {
      siteId: assertion.siteId,
      siteAgentNodeId: assertion.siteAgentNodeId,
      bootLeaseEpoch: BigInt(assertion.bootLeaseEpoch),
      mac: assertion.mac,
      ip: assertion.ip ?? '',
      productUuid: assertion.productUuid ?? '',
      workflowId: assertion.workflowId ?? '',
      issuedAt: timestampFromMs(assertion.issuedAt),
      notAfter: timestampFromMs(assertion.notAfter),
    }),
  );
  return toBinary(
    site.SignedDiscoveryAssertionSchema,
    create(site.SignedDiscoveryAssertionSchema, {
      body,
      sig: signNodeStatement(privateKey, signingInput('discovery-assertion', [body])),
    }),
  );
}

interface AgentRow {
  site_id: string;
  role: string;
  provision_state: string;
  lease_owner: string | null;
  lease_epoch: string | number | null;
  lease_live: boolean | null;
}

/** The control-plane half of `discovery`: admits `ramdisk` agents only. */
export function discoveryAttestor(options: DiscoveryAttestorOptions = {}): AttestorVerifier {
  const maxAgeMs = options.maxAgeMs ?? discoveryAssertionMaxAgeMs;
  const certTtlSeconds = Math.min(
    options.certTtlSeconds ?? discoveryCertTtlSeconds,
    discoveryCertTtlSeconds,
  );
  const allowedKinds = options.allowedKinds ?? discoveryAllowedKinds;
  return defineAttestor({
    id: 'discovery',
    version: '1.0.0',
    roles: ['ramdisk'],
    async verify(evidence, context): Promise<AttestationResult | AttestationDeferral> {
      const refuse = refuser('discovery', options.onRefusal);
      const token = tokenOf(evidence);
      if (!token) return refuse('no-token');
      if (evidence.payload.length === 0) return refuse('no-assertion');
      let signed: site.SignedDiscoveryAssertion;
      let assertion: site.DiscoveryAssertion;
      try {
        signed = fromBinary(site.SignedDiscoveryAssertionSchema, evidence.payload);
        assertion = fromBinary(site.DiscoveryAssertionSchema, signed.body);
      } catch {
        return refuse('malformed');
      }
      if (
        !assertion.siteId ||
        !assertion.siteAgentNodeId ||
        !assertion.mac ||
        !assertion.issuedAt ||
        !assertion.notAfter
      )
        return refuse('malformed');

      const claims = context.claims as JoinClaims;
      const { record, now } = await checkSingleUseToken(
        context.tx,
        token,
        { role: 'discovery', agentRole: context.role, claims, now: context.clock.now() },
        refuse,
      );
      const ids = { tokenId: record.id, nodeId: assertion.siteAgentNodeId };
      if (!record.siteId || record.siteId !== assertion.siteId) return refuse('site-mismatch', ids);
      // A token minted for one machine (the iPXE script's) only goes with that machine's assertion.
      if (
        record.expect?.mac &&
        normalizeClaim.mac(record.expect.mac) !== normalizeClaim.mac(assertion.mac)
      )
        return refuse('token-mac-mismatch', ids);

      // The vouching agent: a site agent of that site, holding the site's boot lease at this epoch.
      const { rows } = await context.tx.query<AgentRow>(
        `SELECT n.site_id, n.role, n.provision_state, l.owner AS lease_owner, l.epoch AS lease_epoch,
                l.expires_at > compute_now() AS lease_live
           FROM nodes n LEFT JOIN leases l ON l.name = $2
          WHERE n.id = $1`,
        [assertion.siteAgentNodeId, bootLeaseName(assertion.siteId)],
      );
      const agent = rows[0];
      if (
        !agent ||
        agent.role !== 'site' ||
        agent.site_id !== assertion.siteId ||
        agent.provision_state === 'retired'
      )
        return refuse('not-a-site-agent', ids);
      if (agent.lease_owner !== assertion.siteAgentNodeId || !agent.lease_live)
        return refuse('not-boot-lease-holder', ids);
      if (agent.lease_epoch === null || BigInt(agent.lease_epoch) !== assertion.bootLeaseEpoch)
        return refuse('stale-epoch', ids);

      let signerRole: string;
      try {
        signerRole = (
          await verifyNodeStatement(
            signingInput('discovery-assertion', [signed.body]),
            signed.sig,
            {
              nodeId: assertion.siteAgentNodeId,
              lookup: nodeCertsLookup(context.tx),
              now,
              expiredGraceMs: 0,
            },
          )
        ).role;
      } catch {
        return refuse('bad-signature', ids);
      }
      if (signerRole !== 'site') return refuse('signer-role', ids);

      const issuedAt = timestampMs(assertion.issuedAt);
      const notAfter = Math.min(timestampMs(assertion.notAfter), issuedAt + maxAgeMs);
      if (now < issuedAt - 60_000 || now > notAfter) return refuse('assertion-expired', ids);

      // The ramdisk is the machine the site agent saw.
      const macs = (claims.macs ?? []).map(normalizeClaim.mac);
      if (!macs.includes(normalizeClaim.mac(assertion.mac))) return refuse('mac-mismatch', ids);
      if (assertion.productUuid) {
        if (
          !claims.productUuid ||
          normalizeClaim.uuid(claims.productUuid) !== normalizeClaim.uuid(assertion.productUuid)
        )
          return refuse('product-uuid-mismatch', ids);
      }
      const workflowNode = assertion.workflowId
        ? await options.resolveWorkflowNode?.(context.tx, assertion.workflowId)
        : undefined;

      // Operator approval (joinRequests, core/0010): consume an approved request for this CSR and
      // machine, or record a pending one and defer. Nothing is spent until the final round.
      const approval = options.approval ?? 'never';
      let nodeId = workflowNode;
      let poolId = record.poolId ?? undefined;
      if (approval !== 'never') {
        const csrSha256 = csrSha256Of(context);
        if (!csrSha256) return refuse('no-csr-binding', ids);
        const machine = {
          key: options.hardwareKey?.(claims),
          siteId: assertion.siteId,
          mac: normalizeClaim.mac(assertion.mac),
        };
        const request = { tenantId: record.tenantId, attestor: 'discovery', csrSha256, machine };
        const consumed = await consumeApprovedRequest(context.tx, request);
        if (consumed) {
          nodeId = consumed.node_id ?? nodeId;
          poolId = consumed.pool_id ?? poolId;
        } else if (approval === 'always' || !workflowNode) {
          if (await requestRejected(context.tx, request)) return refuse('rejected', ids);
          const requestId = await recordPendingRequest(context.tx, {
            attestor: 'discovery',
            tenantId: record.tenantId,
            poolId: record.poolId ?? null,
            csrSha256,
            machine,
            claims,
            ip: assertion.ip || null,
            workflowId: assertion.workflowId || null,
            vouchedBy: assertion.siteAgentNodeId,
            epoch: assertion.bootLeaseEpoch,
            nodeId: workflowNode ?? null,
            ttlSeconds: options.pendingTtlSeconds ?? 86_400,
          });
          return {
            deferred: 'approval',
            requestId,
            retryAfterSeconds: options.retryAfterSeconds ?? 30,
          };
        }
      }
      // A signed assertion admits one join, whatever token comes with it.
      if (!(await useOnce(context.tx, 'discovery', sha256(signed.body), notAfter)))
        return refuse('assertion-reused', ids);
      await spendToken(context.tx, record.id, refuse);
      return {
        tenantId: record.tenantId,
        role: 'ramdisk',
        tokenId: record.id,
        siteId: assertion.siteId,
        ...(poolId ? { poolId } : {}),
        ...(nodeId ? { nodeId } : {}),
        certTtlSeconds,
        allowedKinds,
      };
    },
  });
}
