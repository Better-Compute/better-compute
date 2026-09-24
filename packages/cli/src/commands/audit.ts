import { readFile, writeFile } from 'node:fs/promises';
import {
  checkpointAudit,
  proveAuditEvent,
  verifyAuditCheckpoints,
  verifyAuditProof,
} from '@better-compute/audit';
import { readPkiPins } from '@better-compute/pki';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';
import { defaultPkiPath, loadPkiBundle, pkiFlag } from './pki.js';

// Audit trail commands (PLAN.md §13 "Supply chain and audit"): seal audit_events into signed
// checkpoints, verify a tenant's trail, and prove one event to a third party offline.

const pinFlag: FlagSpec = {
  type: 'string',
  value: 'PIN',
  env: 'BETTER_COMPUTE_AUDIT_PIN',
  description: 'The audit signing key pin (sha256/…); default: from the PKI bundle',
};

/** The pin to verify under: --pin, else the bundle's public half. */
async function auditPin(pin: string | undefined, bundlePath: string): Promise<string> {
  if (pin) {
    if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin))
      throw usageError('--pin must be sha256/<base64>');
    return pin;
  }
  let text: string;
  try {
    text = await readFile(bundlePath, 'utf8');
  } catch {
    throw new CliError(
      'PKI_NOT_FOUND',
      `No PKI bundle at ${bundlePath}`,
      'Pass --pin sha256/… or --pki PATH.',
    );
  }
  const found = readPkiPins(text).auditSigningKeyPin;
  if (!found)
    throw new CliError(
      'AUDIT_KEY_MISSING',
      'The PKI bundle has no audit signing key',
      'Create a new PKI with pki init, or pass --pin.',
    );
  return found;
}

export const auditCommands = [
  defineCommand({
    name: 'audit checkpoint',
    group: 'Audit',
    summary: 'Seal committed audit events into signed per-tenant checkpoints',
    description:
      "audit checkpoint runs what the audit module's hourly job does: it seals every audit event committed since the last checkpoint into a signed, hash-chained Merkle checkpoint per tenant, signed with the PKI bundle's audit key (unsealed with BETTER_COMPUTE_SECRET). It repeats until nothing is left. The deployment must include auditModule() and be migrated.",
    target: 'config',
    flags: {
      pki: pkiFlag,
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        description: 'Events per pass (default 50000)',
      },
    },
    examples: ['better-compute audit checkpoint'],
    async run({ flags, env, path, deployment }) {
      const bundle = await loadPkiBundle(path(flags.pki ?? defaultPkiPath), env);
      if (!bundle.auditSigning)
        throw new CliError(
          'AUDIT_KEY_MISSING',
          'The PKI bundle has no audit signing key',
          'Create a new PKI with pki init.',
        );
      const { options } = await deployment();
      const total = { passes: 0, checkpoints: 0, events: 0 };
      for (;;) {
        const pass = await checkpointAudit(options.database, {
          signer: bundle.auditSigning,
          ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        });
        total.passes++;
        total.checkpoints += pass.checkpoints.length;
        total.events += pass.events;
        if (!pass.more) return total;
      }
    },
  }),
  defineCommand({
    name: 'audit verify',
    group: 'Audit',
    summary: "Verify a tenant's audit trail against its signed checkpoints",
    description:
      "audit verify recomputes every checkpoint of --tenant from the audit events as they are now: signatures under the audit key's pin, the hash chain, contiguous ranges, sizes and Merkle roots. An edited, deleted or inserted event in a sealed range, a broken chain or a foreign signature is a problem; with any problem the command exits AUDIT_TAMPERED after printing the report. It only reads.",
    target: 'config',
    flags: {
      tenant: {
        type: 'string',
        value: 'ID',
        required: true,
        env: 'BETTER_COMPUTE_TENANT',
        description: 'The tenant',
      },
      pin: pinFlag,
      pki: pkiFlag,
    },
    examples: [
      'better-compute audit verify --tenant org_acme',
      'better-compute audit verify --tenant org_acme --query problems',
    ],
    async run({ flags, path, deployment, print }) {
      const pin = await auditPin(flags.pin, path(flags.pki ?? defaultPkiPath));
      const { options } = await deployment();
      const report = await verifyAuditCheckpoints(options.database, {
        tenantId: flags.tenant!,
        trust: { pin },
      });
      print(report);
      if (!report.ok)
        throw new CliError(
          'AUDIT_TAMPERED',
          `${report.problems.length} problem(s) in the audit trail of ${flags.tenant}`,
        );
    },
  }),
  defineCommand({
    name: 'audit prove',
    group: 'Audit',
    summary: 'Write an inclusion proof that one audit event is sealed',
    description:
      'audit prove writes a self-contained proof that the event is in a signed checkpoint: the event, its Merkle path and the signed checkpoint. Anyone holding the audit key pin checks it offline with audit check-proof, without database access.',
    target: 'config',
    args: [{ name: 'event', description: 'The audit event id', required: true }],
    flags: {
      tenant: {
        type: 'string',
        value: 'ID',
        required: true,
        env: 'BETTER_COMPUTE_TENANT',
        description: 'The tenant',
      },
      out: {
        type: 'string',
        value: 'PATH',
        description: 'Write the proof to a file instead of printing it',
      },
    },
    examples: ['better-compute audit prove aud_01k… --tenant org_acme --out proof.json'],
    async run({ flags, args, path, deployment, note }) {
      const { options } = await deployment();
      const proof = await proveAuditEvent(options.database, {
        tenantId: flags.tenant!,
        eventId: args[0]!,
      });
      if (!flags.out) return proof;
      await writeFile(path(flags.out), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
      note(`Wrote ${path(flags.out)}.`);
      return { written: path(flags.out) };
    },
  }),
  defineCommand({
    name: 'audit check-proof',
    group: 'Audit',
    summary: 'Check an inclusion proof offline against the audit key pin',
    description:
      "audit check-proof verifies a proof written by audit prove: the checkpoint's signature under the pin and the event's Merkle path to the signed root. It needs no database; it exits INVALID_PROOF when the proof does not hold.",
    args: [
      { name: 'file', description: 'The proof (JSON), or - for standard input', required: true },
    ],
    flags: { pin: pinFlag, pki: pkiFlag },
    examples: ['better-compute audit check-proof proof.json --pin sha256/…'],
    async run({ flags, args, path, io }) {
      const pin = await auditPin(flags.pin, path(flags.pki ?? defaultPkiPath));
      const source = args[0]!;
      let text: string;
      if (source === '-') {
        if (!io.stdin) throw usageError('Reading - needs standard input');
        text = await io.stdin();
      } else text = await readFile(path(source), 'utf8');
      let proof;
      try {
        proof = JSON.parse(text);
      } catch {
        throw usageError(`${source} is not JSON`);
      }
      if (!verifyAuditProof(proof, { pin }))
        throw new CliError('INVALID_PROOF', 'The proof does not verify under that audit key');
      return {
        valid: true,
        eventId: proof.event?.id,
        tenantId: proof.event?.tenantId,
        sequence: proof.checkpoint?.body?.sequence,
      };
    },
  }),
];
