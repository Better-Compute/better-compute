import { sign, verify, type KeyObject } from 'node:crypto';
import {
  defineAttestor,
  type AgentRole,
  type AttestationEvidence,
  type AttestationResult,
  type AttestorVerifier,
  type NodeAttestor,
} from '@better-compute/core';
import { signingInput } from '@better-compute/protocol';
import { base64url, fromBase64url, sha256 } from '../keys.js';
import { createReplayCache, type ReplayCache } from '../pop.js';
import { parseCertificate, type ParsedCertificate } from '../x509.js';
import { csrSha256Of, ms, refuser, type AttestorBaseOptions } from './common.js';

/**
 * The `x509pop` attestor (v0.2, PLAN.md §6 "Offline", §13): a node whose certificate expired while
 * it was offline re-joins with that certificate and a proof by its key, within 7 days of `notAfter`,
 * unless the certificate was revoked. The proof covers the new CSR, the node id and the client time
 * (±60 s), under its own signing purpose, so neither a Renew proof nor an earlier x509pop proof can
 * be replayed as one. Postgres is the truth (P1): the leaf must be byte-for-byte a `node_certs` row
 * of the node's current identity generation. The result names the node, so JoinService reclaims it
 * in place (revoking every older certificate) and keeps its state.
 *
 * Evidence (`JoinRequest.attestation`, UTF-8 JSON):
 * `{"v":1,"nodeId":"node_…","chain":["<b64url DER leaf>",…],"clientTime":<epoch ms>,"sig":"<b64url r‖s>"}`.
 */
export const x509popPurpose = 'x509pop';

/** How long after `notAfter` an unrevoked certificate may still re-join (§6: 7 days). */
export const x509popGraceMs = 7 * 86_400_000;
/** `clientTime` is accepted within this distance of database time. */
export const x509popWindowMs = 60_000;

export interface X509popEvidence {
  v: 1;
  nodeId: string;
  /** The last certificate chain the node held, leaf first (base64url DER). */
  chain: string[];
  clientTime: number;
  /** Raw `r ‖ s` by the certificate's key over the `x509pop` signing input. */
  sig: string;
}

const utf8 = new TextEncoder();

function timestampBytes(epochMs: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  const seconds = Math.floor(epochMs / 1000);
  view.setBigInt64(0, BigInt(seconds));
  view.setInt32(8, Math.round((epochMs - seconds * 1000) * 1_000_000));
  return out;
}

/** The signed bytes: `x509pop` purpose over [sha256(csr), node_id, int64 s ‖ int32 ns]. */
export function x509popSigningInput(input: {
  csrSha256: Uint8Array;
  nodeId: string;
  clientTime: number;
}): Uint8Array {
  if (input.csrSha256.length !== 32) throw new TypeError('csrSha256 must be 32 bytes');
  return signingInput(x509popPurpose, [
    input.csrSha256,
    utf8.encode(input.nodeId),
    timestampBytes(input.clientTime),
  ]);
}

/**
 * The agent side (Go in `bcd`; TS for `FakeDaemon`): `JoinRequest.attestation` for a re-join with
 * the expired certificate `chain` and its key, for the new `csr`.
 */
export function createX509popEvidence(input: {
  nodeId: string;
  chain: readonly Uint8Array[];
  privateKey: KeyObject;
  csr: Uint8Array;
  now: number;
}): Uint8Array {
  const statement = x509popSigningInput({
    csrSha256: sha256(input.csr),
    nodeId: input.nodeId,
    clientTime: input.now,
  });
  const sig = new Uint8Array(
    sign('sha256', statement, { key: input.privateKey, dsaEncoding: 'ieee-p1363' }),
  );
  const evidence: X509popEvidence = {
    v: 1,
    nodeId: input.nodeId,
    chain: input.chain.map(base64url),
    clientTime: input.now,
    sig: base64url(sig),
  };
  return utf8.encode(JSON.stringify(evidence));
}

/** A `NodeAttestor` for FakeDaemon: produce() needs the CSR, so it is bound per join. */
export function x509popProducer(input: {
  nodeId: string;
  chain: readonly Uint8Array[];
  privateKey: KeyObject;
  csr: Uint8Array;
  clock?: { now(): number };
}): NodeAttestor {
  return {
    id: 'x509pop',
    async produce(): Promise<AttestationEvidence> {
      return {
        attestor: 'x509pop',
        payload: createX509popEvidence({ ...input, now: input.clock?.now() ?? Date.now() }),
      };
    },
  };
}

export interface X509popAttestorOptions extends AttestorBaseOptions {
  /** Default 7 days. */
  graceMs?: number;
  windowMs?: number;
  /** Accepted proofs; default an in-memory cache per attestor (JoinService's reclaim also revokes). */
  replayCache?: ReplayCache;
}

interface CertRow {
  node_id: string;
  role: string;
  der: Uint8Array;
  not_before: Date | string;
  not_after: Date | string;
  revoked: boolean;
  current_gen: boolean;
  owner_tenant_id: string;
  pool_id: string | null;
  site_id: string;
  provision_state: string;
  now: Date | string;
}

function parseEvidence(payload: Uint8Array): X509popEvidence | undefined {
  if (payload.length === 0 || payload.length > 64 * 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  const e = value as Partial<X509popEvidence>;
  if (
    typeof value !== 'object' ||
    value === null ||
    e.v !== 1 ||
    typeof e.nodeId !== 'string' ||
    !Array.isArray(e.chain) ||
    e.chain.length === 0 ||
    e.chain.length > 4 ||
    !e.chain.every((item) => typeof item === 'string') ||
    typeof e.clientTime !== 'number' ||
    !Number.isFinite(e.clientTime) ||
    typeof e.sig !== 'string'
  )
    return undefined;
  return e as X509popEvidence;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** The control-plane half of `x509pop`: admits `node` and `site` agents back as themselves. */
export function x509popAttestor(options: X509popAttestorOptions = {}): AttestorVerifier {
  const graceMs = options.graceMs ?? x509popGraceMs;
  const windowMs = options.windowMs ?? x509popWindowMs;
  const replay = options.replayCache ?? createReplayCache({ maxEntries: 10_000 });
  return defineAttestor({
    id: 'x509pop',
    version: '1.0.0',
    roles: ['node', 'site'],
    async verify(evidence, context): Promise<AttestationResult> {
      const refuse = refuser('x509pop', options.onRefusal);
      const csrSha256 = csrSha256Of(context);
      if (!csrSha256) return refuse('no-csr-binding');
      const parsed = parseEvidence(evidence.payload);
      if (!parsed) return refuse('malformed');
      let leafDer: Uint8Array;
      let leaf: ParsedCertificate;
      let sig: Uint8Array;
      try {
        leafDer = fromBase64url(parsed.chain[0]!);
        leaf = parseCertificate(leafDer);
        sig = fromBase64url(parsed.sig);
      } catch {
        return refuse('malformed');
      }
      if (sig.length !== 64) return refuse('malformed');
      const ids = { nodeId: parsed.nodeId };

      const { rows } = await context.tx.query<CertRow>(
        `SELECT c.node_id, c.role, c.der, c.not_before, c.not_after,
                c.revoked_at IS NOT NULL AS revoked, c.identity_gen = n.identity_gen AS current_gen,
                n.owner_tenant_id, n.pool_id, n.site_id, n.provision_state, compute_now() AS now
           FROM node_certs c JOIN nodes n ON n.id = c.node_id
          WHERE c.serial = $1 FOR UPDATE OF n`,
        [leaf.serial],
      );
      const row = rows[0];
      // Only a certificate compute issued, exactly: not a look-alike signed by some other CA.
      if (!row || !sameBytes(new Uint8Array(row.der), leafDer))
        return refuse('unknown-certificate', ids);
      if (row.node_id !== parsed.nodeId) return refuse('another-node', ids);
      if (row.revoked) return refuse('revoked', ids);
      if (!row.current_gen) return refuse('superseded', ids);
      if (row.provision_state === 'retired') return refuse('retired', ids);
      // A lessee's node-tenant certificate re-joins as a node; JoinService re-derives node-tenant
      // from the node's tenant-controlled trust, so the restriction survives the re-join.
      const role = (row.role === 'node-tenant' ? 'node' : row.role) as AgentRole;
      if (role !== context.role || (role !== 'node' && role !== 'site')) return refuse('role', ids);
      const now = ms(row.now);
      if (now < ms(row.not_before)) return refuse('not-yet-valid', ids);
      if (now > ms(row.not_after) + graceMs) return refuse('past-grace', ids);
      if (Math.abs(parsed.clientTime - now) > windowMs) return refuse('client-time', ids);

      const statement = x509popSigningInput({
        csrSha256,
        nodeId: row.node_id,
        clientTime: parsed.clientTime,
      });
      let valid = false;
      try {
        valid = verify(
          'sha256',
          statement,
          { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
          sig,
        );
      } catch {
        valid = false;
      }
      if (!valid) return refuse('bad-proof', ids);
      if (!replay.add(base64url(sha256(statement)), now + 2 * windowMs, now))
        return refuse('replayed', ids);
      return {
        tenantId: row.owner_tenant_id,
        role,
        nodeId: row.node_id,
        siteId: row.site_id,
        ...(row.pool_id ? { poolId: row.pool_id } : {}),
      };
    },
  });
}
