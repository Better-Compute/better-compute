import { randomInt } from 'node:crypto';
import type { Json, SqlTx } from '@better-compute/core';

// BMC credential rotation (PLAN.md §3.5, §13), two-phase. `metal.rotateBmcCredential` (steps.ts):
// 1. makes (or, on a retry, reuses) a pending version: a generated password, sealed in the
//    SecretStore, known here only by its ref;
// 2. sends `bmc.rotate` to the site agent with refs only. The agent fetches the new value as a JWE,
//    applies it through the driver's `management.rotateCredential`, logs in with it, and signs the
//    result;
// 3. flips pending → current only on a node-signed (role site) `verified: true`. Otherwise the
//    version fails, the old one stays current, and the node gets `BmcCredentialRotated=False`.
// Superseded secrets are deleted once no open command names them.

/** A password most BMC vendors accept: 20 characters, every class, no quotes or backslashes. */
export function generateBmcPassword(length = 20): string {
  const classes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#%+-.:=@_'];
  const all = classes.join('');
  const chars = classes.map((set) => set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  // Fisher-Yates, so the class-guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface CredentialVersion {
  version: number;
  ref: string;
  state: 'pending' | 'current' | 'superseded' | 'failed';
}

/** The node's pending version, if a rotation is under way. */
export async function pendingCredential(tx: SqlTx, nodeId: string): Promise<CredentialVersion | undefined> {
  const { rows } = await tx.query<CredentialVersion>(
    `SELECT version, ref, state FROM bmc_credential_versions WHERE node_id = $1 AND state = 'pending'`,
    [nodeId],
  );
  return rows[0];
}

/**
 * Records a new pending version for `ref` (the next version number). The credential in use before
 * the first rotation (the enrollment one, `currentRef`) is recorded first as version 1, current.
 */
export async function addPendingCredential(tx: SqlTx, nodeId: string, ref: string, currentRef: string): Promise<CredentialVersion> {
  await tx.query(
    `INSERT INTO bmc_credential_versions (node_id, version, ref, state, verified_at)
     SELECT $1, 1, $2, 'current', compute_now()
      WHERE NOT EXISTS (SELECT 1 FROM bmc_credential_versions WHERE node_id = $1)`,
    [nodeId, currentRef],
  );
  const { rows } = await tx.query<CredentialVersion>(
    `INSERT INTO bmc_credential_versions (node_id, version, ref, state)
     VALUES ($1, COALESCE((SELECT max(version) FROM bmc_credential_versions WHERE node_id = $1), 0) + 1, $2, 'pending')
     RETURNING version, ref, state`,
    [nodeId, ref],
  );
  return rows[0]!;
}

async function setCondition(tx: SqlTx, nodeId: string, status: 'True' | 'False', reason: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO node_conditions (node_id, type, status, reason, since) VALUES ($1, 'BmcCredentialRotated', $2, $3, compute_now())
     ON CONFLICT (node_id, type) DO UPDATE SET reason = EXCLUDED.reason,
       since = CASE WHEN node_conditions.status = EXCLUDED.status THEN node_conditions.since ELSE EXCLUDED.since END,
       status = EXCLUDED.status`,
    [nodeId, status, reason],
  );
}

/**
 * The verified flip: pending → current, the old current → superseded, and every place that names
 * the old ref (`metal_nodes.bmc_credentials`, the node's driver bindings) names the new one.
 */
export async function promoteCredential(tx: SqlTx, nodeId: string, pending: CredentialVersion, previousRef: string): Promise<void> {
  await tx.query(`UPDATE bmc_credential_versions SET state = 'superseded' WHERE node_id = $1 AND state = 'current'`, [nodeId]);
  await tx.query(
    `UPDATE bmc_credential_versions SET state = 'current', verified_at = compute_now(), error = NULL
      WHERE node_id = $1 AND version = $2 AND state = 'pending'`,
    [nodeId, pending.version],
  );
  await tx.query('UPDATE metal_nodes SET bmc_credentials = $2, updated_at = compute_now(), version = version + 1 WHERE node_id = $1', [
    nodeId,
    pending.ref,
  ]);
  // Driver bindings carry the credential ref in their config (resolveDriverBindings).
  await tx.query(`UPDATE nodes SET drivers = replace(drivers::text, to_json($2::text)::text, to_json($3::text)::text)::jsonb WHERE id = $1`, [
    nodeId,
    previousRef,
    pending.ref,
  ]);
  await setCondition(tx, nodeId, 'True', null);
}

/** The failed rotation: the version fails (its ref kept), the old one stays current, the condition says why. */
export async function failCredential(tx: SqlTx, nodeId: string, pending: CredentialVersion, error: Json): Promise<void> {
  await tx.query(`UPDATE bmc_credential_versions SET state = 'failed', error = $3::jsonb WHERE node_id = $1 AND version = $2 AND state = 'pending'`, [
    nodeId,
    pending.version,
    JSON.stringify(error),
  ]);
  const message = error && typeof error === 'object' && !Array.isArray(error) && typeof error.message === 'string' ? error.message : 'rotation failed';
  await setCondition(tx, nodeId, 'False', message.slice(0, 256));
}

/**
 * Superseded versions whose secret may go: not purged yet, and named by no open command (a queued
 * BMC operation still carries the old ref). The caller deletes each from the store, then marks it.
 */
export async function purgeableCredentials(tx: SqlTx, nodeId: string): Promise<CredentialVersion[]> {
  const { rows } = await tx.query<CredentialVersion>(
    `SELECT v.version, v.ref, v.state FROM bmc_credential_versions v
      WHERE v.node_id = $1 AND v.state = 'superseded' AND v.purged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM commands c
                         WHERE c.state IN ('pending', 'dispatched', 'acked', 'running')
                           AND position(convert_to(v.ref, 'UTF8') IN c.body) > 0)
      ORDER BY v.version`,
    [nodeId],
  );
  return rows;
}

export async function markPurged(tx: SqlTx, nodeId: string, version: number): Promise<void> {
  await tx.query('UPDATE bmc_credential_versions SET purged_at = compute_now() WHERE node_id = $1 AND version = $2', [nodeId, version]);
}
