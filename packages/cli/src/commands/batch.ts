import type { KeyObject } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  approverKeyOf,
  base64url,
  batchScope,
  createApproverKey,
  signBatchApproval,
  toPrivateKey,
  type BatchScopeEntry,
} from '@better-compute/pki';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';

// The destructive-batch quorum from an approver's terminal (PLAN.md §13). An approver key is a P-256 key pair held
// by one operator, off the control plane: its public half goes into the deployment's `pki.approvers.keys` (and so
// into every daemon's trust bundle), its private half signs batches. What gets signed is the batch's scope root,
// size and expiry; the CLI recomputes the root from the (subject, kind) list it shows the operator, so an approver
// never signs a root it has not seen the contents of.

/** An approver's private key from a PEM file (PKCS#8), checked to be P-256. */
export async function loadApproverKey(path: string): Promise<{ privateKey: KeyObject; kid: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError('NOT_FOUND', `Cannot read the approver key ${path}`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = toPrivateKey(text);
  } catch {
    throw new CliError('INVALID_INPUT', `${path} is not a private key (PKCS#8 PEM, from batch keygen)`);
  }
  try {
    return { privateKey, kid: approverKeyOf(privateKey).kid };
  } catch {
    throw new CliError('INVALID_INPUT', `${path} is not an approver key: approver keys are ECDSA P-256`);
  }
}

const isEntry = (value: unknown): value is BatchScopeEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as BatchScopeEntry).subject === 'string' &&
  (value as BatchScopeEntry).subject.length > 0 &&
  typeof (value as BatchScopeEntry).kind === 'string' &&
  (value as BatchScopeEntry).kind.length > 0;

/**
 * A batch scope from JSON: an array of `{ subject, kind }`, or an object with `batchId` and such an array as
 * `scope` or `entries` (what `batch show` prints). Throws INVALID_INPUT.
 */
export function parseScope(text: string, what: string): { batchId?: string; entries: BatchScopeEntry[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError('INVALID_INPUT', `${what} is not JSON`);
  }
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const list = Array.isArray(value) ? value : (record?.scope ?? record?.entries);
  if (!Array.isArray(list) || list.length === 0 || !list.every(isEntry))
    throw new CliError('INVALID_INPUT', `${what} must list the batch's commands as { subject, kind } objects`);
  const batchId = typeof record?.batchId === 'string' ? record.batchId : undefined;
  return { ...(batchId ? { batchId } : {}), entries: list.map(({ subject, kind }) => ({ subject, kind })) };
}

/** What an approver is shown before signing: leaves by kind, and how many distinct subjects. */
export function describeScope(entries: readonly BatchScopeEntry[]): { kinds: Record<string, number>; subjects: number } {
  const seen = new Set<string>();
  const kinds: Record<string, number> = {};
  for (const { subject, kind } of entries) {
    const key = `${subject}\u0000${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { kinds, subjects: new Set(entries.map((entry) => entry.subject)).size };
}

/** `--not-after`: an ISO-8601 time or epoch milliseconds, in the future. */
function parseNotAfter(value: string, now: number): number {
  const ms = /^\d{10,}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw usageError('--not-after takes an ISO-8601 time or epoch milliseconds');
  if (ms <= now) throw new CliError('INVALID_STATE', `The batch approval window closed at ${new Date(ms).toISOString()}`);
  return ms;
}

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export const batchCommands = [
  defineCommand({
    name: 'batch keygen',
    group: 'Quorum',
    summary: 'Create an approver key pair for destructive batches',
    description:
      "batch keygen creates an ECDSA P-256 approver key (PLAN.md §13): the private key (PKCS#8 PEM, mode 0600) at --out, the public key beside it at <out>.pub. Keep the private key with its operator, off the control plane (a hardware token or an offline machine is better). Add the public key to the deployment's pki.approvers.keys, e.g. approverKeyOf(readFileSync('alice.pem.pub', 'utf8')).spkiDer from @better-compute/pki, with pki.approvers.threshold; daemons receive it in their trust bundle. The kid printed is how approvals name the key.",
    output: 'json',
    flags: {
      out: { type: 'string', value: 'PATH', required: true, description: 'Where to write the private key (never overwritten)' },
    },
    examples: ['better-compute batch keygen --out ~/.better-compute/approver.pem'],
    async run({ flags, path, note }) {
      const target = path(flags.out!);
      const { privateKey, key } = createApproverKey();
      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(key.spkiDer)
        .toString('base64')
        .replace(/.{64}/g, '$&\n')
        .trimEnd()}\n-----END PUBLIC KEY-----\n`;
      try {
        await writeFile(target, privatePem, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new CliError('ALREADY_EXISTS', `${target} exists: batch keygen never overwrites a key`);
        throw error;
      }
      await writeFile(`${target}.pub`, publicKeyPem, { flag: 'w', mode: 0o644 });
      note(`Add ${target}.pub to pki.approvers.keys; keep ${target} with its operator.`);
      return { kid: key.kid, privateKey: target, publicKey: `${target}.pub`, spki: base64url(key.spkiDer) };
    },
  }),
  defineCommand({
    name: 'batch sign',
    group: 'Quorum',
    summary: 'Sign a batch approval offline, from its scope',
    description:
      "batch sign signs one approval of a destructive batch with an approver key (--key, from batch keygen) without contacting the server: for approvers on an offline machine. Pass the batch's scope (--scope, the JSON batch show prints, or an array of { subject, kind }): the root is recomputed from it and the kinds and subject count are shown before signing. --root and --size, when given as well, must match what the scope gives; with --root and --size alone the CLI signs a root it cannot check, and says so. --not-after is the batch's expiry as the server set it (all approvers sign the same one). Prints the signature ({ kid, sig }) to hand to batch approve --signature.",
    output: 'json',
    flags: {
      key: { type: 'string', value: 'PATH', required: true, description: 'The approver private key (PEM)' },
      batch: { type: 'string', value: 'ID', description: 'The batch id (default: the scope file\'s batchId)' },
      scope: { type: 'string', value: 'PATH', description: 'The batch scope (JSON), to recompute the root from' },
      root: { type: 'string', value: 'HEX', description: 'The scope root (64 hex digits), checked against --scope' },
      size: { type: 'integer', value: 'N', min: 1, description: 'The scope size, checked against --scope' },
      'not-after': {
        type: 'string',
        value: 'TIME',
        required: true,
        description: "The batch's expiry: ISO-8601 or epoch milliseconds",
      },
    },
    validate(flags) {
      if (flags.scope === undefined && (flags.root === undefined || flags.size === undefined))
        throw usageError('Pass --scope (recommended), or --root and --size');
      if (flags.root !== undefined && !/^[0-9a-f]{64}$/i.test(flags.root)) throw usageError('--root takes 64 hex digits');
    },
    examples: [
      'better-compute batch sign --key approver.pem --scope batch.json --not-after 2026-09-25T18:00:00Z',
      'better-compute batch sign --key approver.pem --batch batch_01k5w… --root 3f1c… --size 412 --not-after 1790359200000',
    ],
    async run({ flags, path, note }) {
      const { privateKey, kid } = await loadApproverKey(path(flags.key!));
      const notAfter = parseNotAfter(flags['not-after']!, Date.now());
      let batchId = flags.batch;
      let root: Uint8Array | undefined = flags.root === undefined ? undefined : new Uint8Array(Buffer.from(flags.root, 'hex'));
      let size = flags.size;
      if (flags.scope !== undefined) {
        const file = path(flags.scope);
        const scope = parseScope(await readFile(file, 'utf8'), file);
        if (batchId !== undefined && scope.batchId !== undefined && scope.batchId !== batchId)
          throw new CliError('INVALID_INPUT', `${file} is batch ${scope.batchId}, not ${batchId}`);
        batchId ??= scope.batchId;
        if (!batchId) throw usageError('Pass --batch: the scope file names no batchId');
        const tree = batchScope(batchId, scope.entries);
        if (root !== undefined && Buffer.compare(root, tree.root) !== 0)
          throw new CliError('INVALID_STATE', 'The scope does not give --root: the batch is not what the scope lists');
        if (size !== undefined && size !== tree.size)
          throw new CliError('INVALID_STATE', `The scope has ${tree.size} commands, not --size ${size}`);
        root = tree.root;
        size = tree.size;
        const { kinds, subjects } = describeScope(scope.entries);
        const listed = Object.entries(kinds)
          .map(([kind, count]) => `${kind} ×${count}`)
          .join(', ');
        note(`Approving batch ${batchId}: ${size} command(s) on ${subjects} subject(s): ${listed}.`);
      } else {
        if (!batchId) throw usageError('Pass --batch with --root and --size');
        note(`Signing root ${flags.root} of batch ${batchId} unchecked: pass --scope to see what it contains.`);
      }
      note(`The approval admits them until ${new Date(notAfter).toISOString()}.`);
      const signature = signBatchApproval({ batchId, scopeRoot: root!, scopeSize: size!, notAfter }, privateKey);
      return {
        batchId,
        scopeRoot: hexOf(root!),
        scopeSize: size,
        notAfter: new Date(notAfter).toISOString(),
        signature: { kid, sig: base64url(signature.sig) },
      };
    },
  }),
];
