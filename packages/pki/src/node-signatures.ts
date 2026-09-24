import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ComputeError, type SqlTx } from '@better-compute/core';
import {
  AttestedReportBodySchema,
  AttestedReportSchema,
  commandUpdateSigningInput,
  signingInput,
  SignatureSchema,
  type AttestedReport,
  type AttestedReportBody,
  type CommandState,
  type CommandUpdate,
  type Signature,
} from '@better-compute/protocol';
import { fromBase64url, nodeKeyId, spkiSha256 } from './keys.js';
import { parseCertificate } from './x509.js';

/**
 * "This node says" statements (PLAN.md §6, §13, P14): attested command results, allocation reports
 * and secret requests are signed with the node key, so a gateway relaying them cannot forge them.
 * `Signature.kid` is base64url(SHA-256(SPKI)) and the verifier finds the key in `node_certs`.
 */

/** A `node_certs` row, as the verifier needs it. */
export interface NodeCertRecord {
  serial: string;
  nodeId: string;
  role: string;
  /** DER certificate. */
  der: Uint8Array;
  /** Epoch milliseconds. */
  notBefore: number;
  notAfter: number;
  revokedAt?: number | null;
}

/** Finds the certificate of `nodeId` whose key has this SPKI SHA-256. */
export type NodeCertLookup = (
  spkiSha256: Uint8Array,
  nodeId: string,
) => Promise<NodeCertRecord | undefined>;

interface NodeCertRow {
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
 * `NodeCertLookup` over `node_certs`: the newest certificate of the node with that key. Revoked rows
 * are returned too, so the verifier can say why it refuses.
 */
export function nodeCertsLookup(tx: SqlTx): NodeCertLookup {
  return async (spki, nodeId) => {
    const { rows } = await tx.query<NodeCertRow>(
      `SELECT serial, node_id, role, der, not_before, not_after, revoked_at
         FROM node_certs WHERE spki_sha256 = $1 AND node_id = $2
        ORDER BY not_after DESC LIMIT 1`,
      [spki, nodeId],
    );
    const row = rows[0];
    return (
      row && {
        serial: row.serial,
        nodeId: row.node_id,
        role: row.role,
        der: new Uint8Array(row.der),
        notBefore: ms(row.not_before),
        notAfter: ms(row.not_after),
        revokedAt: row.revoked_at === null ? null : ms(row.revoked_at),
      }
    );
  };
}

export interface VerifyNodeStatementOptions {
  /** The node the session authenticated (from its certificate's SAN), never a message field. */
  nodeId: string;
  lookup: NodeCertLookup;
  /** Epoch milliseconds. */
  now: number;
  /**
   * Results journaled while offline may arrive after the signing certificate expired: they are
   * accepted this long past `notAfter` (default 7 days, the offline rejoin window) unless revoked.
   */
  expiredGraceMs?: number;
}

export interface VerifiedNodeStatement {
  serial: string;
  role: string;
}

/**
 * Verifies a node signature over already-framed signing input. Throws `ACCESS_DENIED` with a
 * `reason`: missing, unknown key, another node's key, revoked, not yet valid, too old, or bad.
 */
export async function verifyNodeStatement(
  input: Uint8Array,
  signature: Signature | undefined,
  options: VerifyNodeStatementOptions,
): Promise<VerifiedNodeStatement> {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Node signature rejected', undefined, { reason });
  if (!signature || signature.sig.length !== 64) throw deny('missing or malformed signature');
  let spki: Uint8Array;
  try {
    spki = fromBase64url(signature.kid);
  } catch {
    throw deny('malformed key id');
  }
  if (spki.length !== 32) throw deny('malformed key id');
  const record = await options.lookup(spki, options.nodeId);
  if (!record) throw deny('unknown node key');
  if (record.nodeId !== options.nodeId) throw deny("another node's key");
  if (record.revokedAt !== undefined && record.revokedAt !== null)
    throw deny('certificate revoked');
  if (options.now < record.notBefore) throw deny('certificate not yet valid');
  if (options.now > record.notAfter + (options.expiredGraceMs ?? 7 * 86_400_000))
    throw deny('certificate expired');
  let key: KeyObject;
  try {
    key = parseCertificate(record.der).publicKey;
  } catch {
    throw deny('unreadable certificate');
  }
  // The kid names the key; the stored certificate must hold exactly that key.
  if (Buffer.compare(Buffer.from(spkiSha256(key)), Buffer.from(spki)) !== 0)
    throw deny('key id does not match the certificate');
  let valid = false;
  try {
    valid = verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature.sig);
  } catch {
    valid = false;
  }
  if (!valid) throw deny('bad signature');
  return { serial: record.serial, role: record.role };
}

/** Signs framed input with a node key: the `Signature` a daemon attaches (kid = SPKI hash). */
export function signNodeStatement(privateKey: KeyObject, input: Uint8Array): Signature {
  return create(SignatureSchema, {
    kid: nodeKeyId(privateKey),
    sig: new Uint8Array(sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
  });
}

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

function updateInput(update: Pick<CommandUpdate, 'commandId' | 'state' | 'result'>): Uint8Array {
  return commandUpdateSigningInput({
    commandId: update.commandId,
    state: update.state,
    resultSha256: sha256(update.result),
  });
}

/**
 * Verifies `CommandUpdate.node_sig` of an attested kind (`wipe`, `deploy.*`, `gpu.reset`, `diag.*`)
 * before the worker makes any state transition from it.
 */
export async function verifyAttestedUpdate(
  update: CommandUpdate,
  options: VerifyNodeStatementOptions,
): Promise<VerifiedNodeStatement> {
  return verifyNodeStatement(updateInput(update), update.nodeSig, options);
}

/** The daemon side: `node_sig` for a command update. */
export function signCommandUpdate(
  privateKey: KeyObject,
  update: { commandId: string; state: CommandState; result?: Uint8Array },
): Signature {
  return signNodeStatement(
    privateKey,
    updateInput({ ...update, result: update.result ?? new Uint8Array(0) }),
  );
}

/**
 * Verifies an `AttestedReport` (AllocationBound, AllocationReleased) and returns its body. The body
 * must name the session's node.
 */
export async function verifyAttestedReport(
  report: AttestedReport,
  options: VerifyNodeStatementOptions,
): Promise<VerifiedNodeStatement & { body: AttestedReportBody }> {
  const verified = await verifyNodeStatement(
    signingInput('attested-report', [report.body]),
    report.nodeSig,
    options,
  );
  let body: AttestedReportBody;
  try {
    body = fromBinary(AttestedReportBodySchema, report.body);
  } catch {
    throw new ComputeError('ACCESS_DENIED', 'Node signature rejected', undefined, {
      reason: 'unreadable report',
    });
  }
  if (body.nodeId !== options.nodeId)
    throw new ComputeError('ACCESS_DENIED', 'Node signature rejected', undefined, {
      reason: 'report names another node',
    });
  return { ...verified, body };
}

/** The daemon side: an `AttestedReport` for a body, signed with the node key. */
export function signAttestedReport(
  privateKey: KeyObject,
  body: AttestedReportBody,
): AttestedReport {
  const bytes = toBinary(AttestedReportBodySchema, body);
  return create(AttestedReportSchema, {
    body: bytes,
    nodeSig: signNodeStatement(privateKey, signingInput('attested-report', [bytes])),
  });
}
