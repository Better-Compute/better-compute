import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  approverKeyOf,
  base64url,
  batchScope,
  createApproverKey,
  signBatchApproval,
  type BatchScopeEntry,
} from '@better-compute/pki';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';
import type { ApiTransport } from '../transport.js';
import { tenantFlag } from './capacity.js';

// The destructive-batch quorum from an approver's terminal (PLAN.md §13). An approver key is a P-256 key pair held
// by one operator, off the control plane: its public half goes into the deployment's `pki.approvers.keys` (and so
// into every daemon's trust bundle), its private half signs batches. What gets signed is the batch's scope root,
// size and expiry; the CLI recomputes the root from the (subject, kind) list it shows the operator, so an approver
// never signs a root it has not seen the contents of.

/** The passphrase approver keys are encrypted under (PKCS#8, AES-256-CBC), when set. */
export const approverPassphraseEnv = 'BETTER_COMPUTE_APPROVER_PASSPHRASE';

/**
 * An approver's private key from a PEM file (PKCS#8, encrypted under BETTER_COMPUTE_APPROVER_PASSPHRASE or not),
 * checked to be P-256. Like ssh, refuses a key file others can read (POSIX modes).
 */
export async function loadApproverKey(
  path: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ privateKey: KeyObject; kid: string }> {
  let text: string;
  let mode: number;
  try {
    text = await readFile(path, 'utf8');
    mode = (await stat(path)).mode;
  } catch {
    throw new CliError('NOT_FOUND', `Cannot read the approver key ${path}`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0)
    throw new CliError(
      'INVALID_STATE',
      `${path} is readable by others (mode ${(mode & 0o777).toString(8)}): an approver key is its operator's alone`,
      `chmod 600 ${path}`,
    );
  const passphrase = env[approverPassphraseEnv];
  if (text.includes('ENCRYPTED PRIVATE KEY') && !passphrase)
    throw new CliError('MISSING_ENV', `${path} is encrypted: set ${approverPassphraseEnv}`);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: text, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  } catch {
    throw new CliError(
      'INVALID_INPUT',
      `${path} is not a private key (PKCS#8 PEM, from batch keygen), or ${approverPassphraseEnv} does not open it`,
    );
  }
  try {
    return { privateKey, kid: approverKeyOf(privateKey).kid };
  } catch {
    throw new CliError('INVALID_INPUT', `${path} is not an approver key: approver keys are ECDSA P-256`);
  }
}

/** A scope entry as JSON carries it: `payloadSha256` hex, empty or absent for "any payload of this kind". */
interface ScopeEntryJson {
  subject: string;
  kind: string;
  payloadSha256?: string;
}

const isEntry = (value: unknown): value is ScopeEntryJson =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ScopeEntryJson).subject === 'string' &&
  (value as ScopeEntryJson).subject.length > 0 &&
  typeof (value as ScopeEntryJson).kind === 'string' &&
  (value as ScopeEntryJson).kind.length > 0 &&
  ((value as ScopeEntryJson).payloadSha256 === undefined ||
    (typeof (value as ScopeEntryJson).payloadSha256 === 'string' &&
      /^([0-9a-f]{64})?$/.test((value as ScopeEntryJson).payloadSha256!)));

const entryOf = ({ subject, kind, payloadSha256 }: ScopeEntryJson): BatchScopeEntry => ({
  subject,
  kind,
  ...(payloadSha256 ? { payloadSha256: new Uint8Array(Buffer.from(payloadSha256, 'hex')) } : {}),
});
const jsonOf = ({ subject, kind, payloadSha256 }: BatchScopeEntry): ScopeEntryJson => ({
  subject,
  kind,
  payloadSha256: payloadSha256?.length ? Buffer.from(payloadSha256).toString('hex') : '',
});
/** A leaf that admits any payload of its kind (the batch's creator could not fix it in advance). */
const unbound = (entry: BatchScopeEntry) => !entry.payloadSha256?.length;

/** Unbound leaves are refused unless the approver accepts them (--allow-unbound), after seeing which. */
function checkUnbound(entries: readonly BatchScopeEntry[], allow: boolean, note: (line: string) => void): void {
  const open = entries.filter(unbound);
  if (open.length === 0) return;
  const listed = open
    .slice(0, 5)
    .map((entry) => `${entry.kind} on ${entry.subject}`)
    .join(', ');
  const message = `${open.length} command(s) admit any payload of their kind (${listed}${open.length > 5 ? ', …' : ''}): the approval does not fix what they do`;
  if (!allow) throw new CliError('UNBOUND_SCOPE', message, 'Ask why, then pass --allow-unbound to approve them anyway.');
  note(`Warning: ${message}.`);
}

const allowUnboundFlag = {
  type: 'boolean',
  description: 'Approve commands whose payload the batch does not fix (shown as "any payload")',
} as const satisfies FlagSpec;

/**
 * A batch scope from JSON: an array of `{ subject, kind }`, or an object with `batchId` and such an array as
 * `scope` or `entries` (what `batch show` prints). Throws INVALID_INPUT.
 */
export function parseScope(
  text: string,
  what: string,
): { batchId?: string; notAfter?: string; trustDomain?: string; entries: BatchScopeEntry[] } {
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
  const notAfter =
    typeof record?.notAfter === 'number' ? String(record.notAfter) : typeof record?.notAfter === 'string' ? record.notAfter : undefined;
  const trustDomain = typeof record?.trustDomain === 'string' ? record.trustDomain : undefined;
  return {
    ...(batchId ? { batchId } : {}),
    ...(notAfter ? { notAfter } : {}),
    ...(trustDomain ? { trustDomain } : {}),
    entries: list.map(entryOf),
  };
}

/** "412 command(s) on 206 subject(s): disk.wipe ×206, deploy.image ×206". */
function scopeLine(size: number, entries: readonly BatchScopeEntry[]): string {
  const { kinds, subjects } = describeScope(entries);
  const listed = Object.entries(kinds)
    .map(([kind, count]) => `${kind} ×${count}`)
    .join(', ');
  return `${size} command(s) on ${subjects} subject(s): ${listed}`;
}

/** What an approver is shown before signing: leaves by kind, and how many distinct subjects. */
export function describeScope(entries: readonly BatchScopeEntry[]): { kinds: Record<string, number>; subjects: number } {
  const seen = new Set<string>();
  const kinds: Record<string, number> = {};
  for (const { subject, kind, payloadSha256 } of entries) {
    const key = `${subject}\u0000${kind}\u0000${payloadSha256?.length ? Buffer.from(payloadSha256).toString('hex') : ''}`;
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
  return ms;
}

/**
 * An approval admits its commands until notAfter, as often as they are sent: the window must be open, and no longer
 * than `maxHours` (--max-hours, default 72) from now.
 */
function checkWindow(notAfter: number, now: number, maxHours: number): void {
  if (notAfter <= now) throw new CliError('INVALID_STATE', `The batch approval window closed at ${new Date(notAfter).toISOString()}`);
  if (notAfter - now > maxHours * 3_600_000)
    throw new CliError(
      'INVALID_STATE',
      `The batch stays open until ${new Date(notAfter).toISOString()}, more than ${maxHours} h from now`,
      'An approval admits its commands until then: ask for a shorter batch, or pass --max-hours after checking why.',
    );
}

const maxHoursFlag = {
  type: 'integer',
  value: 'N',
  min: 1,
  max: 720,
  default: 72,
  description: 'Refuse a batch that stays open longer than this many hours',
} as const satisfies FlagSpec;

/** Lines naming every subject by kind (at most `perKind` each, then how many more). */
export function subjectLines(entries: readonly BatchScopeEntry[], perKind = 12): string[] {
  const byKind = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = byKind.get(entry.kind) ?? new Set<string>();
    set.add(unbound(entry) ? `${entry.subject} (any payload)` : entry.subject);
    byKind.set(entry.kind, set);
  }
  return [...byKind].map(([kind, subjects]) => {
    const list = [...subjects].sort();
    const shown = list.slice(0, perKind).join(', ');
    return list.length > perKind ? `  ${kind}: ${shown} … and ${list.length - perKind} more` : `  ${kind}: ${shown}`;
  });
}

/**
 * `--expect FILE`: the subjects (one per line, or a JSON array of strings) or the { subject, kind } commands an
 * approver expects; the batch must hold exactly those, else SCOPE_UNEXPECTED names the differences.
 */
export function checkExpected(entries: readonly BatchScopeEntry[], text: string, what: string): void {
  let expected: string[] | BatchScopeEntry[];
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new CliError('INVALID_INPUT', `${what} is not JSON`);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)) expected = value as string[];
    else if (Array.isArray(value) && value.every(isEntry)) expected = value.map(entryOf);
    else throw new CliError('INVALID_INPUT', `${what} must list subjects (strings) or { subject, kind } commands`);
  } else
    expected = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  if (expected.length === 0) throw new CliError('INVALID_INPUT', `${what} lists nothing`);
  const byEntry = typeof expected[0] !== 'string';
  const keyOf = (entry: BatchScopeEntry) => (byEntry ? `${entry.subject} ${entry.kind}` : entry.subject);
  const want = new Set(byEntry ? (expected as BatchScopeEntry[]).map(keyOf) : (expected as string[]));
  const have = new Set(entries.map(keyOf));
  const missing = [...want].filter((key) => !have.has(key));
  const unexpected = [...have].filter((key) => !want.has(key));
  if (missing.length || unexpected.length) {
    const sample = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? ` … (${list.length})` : '');
    throw new CliError(
      'SCOPE_UNEXPECTED',
      [
        `The batch is not what ${what} expects`,
        ...(unexpected.length ? [`not expected: ${sample(unexpected)}`] : []),
        ...(missing.length ? [`missing: ${sample(missing)}`] : []),
      ].join('; '),
      'Do not approve it until the difference is explained.',
    );
  }
}

const expectFlag: FlagSpec = {
  type: 'string',
  value: 'PATH',
  description: 'Approve only if the batch holds exactly these subjects (one per line) or { subject, kind } commands',
};

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A batch as commandBatches.get returns it. */
export interface BatchView {
  batchId: string;
  tenantId: string;
  /** The deployment's trust domain: approvals sign it, so they admit nothing in another deployment. */
  trustDomain: string;
  reason: string;
  state: 'pending' | 'approved' | 'expired' | 'cancelled';
  scopeRoot: string;
  scopeSize: number;
  requiredApprovals: number;
  notAfter: number;
  approvals: { kid: string; at: number; approvedBy?: string }[];
  commands: Record<string, number>;
  createdAt: number;
  approvedAt?: number;
  createdBy?: string;
}

const badAnswer = (message: string) => new CliError('INVALID_RESPONSE', message);

/**
 * Every (subject, kind) of a batch, paged from commandBatches.scope, after checking they give exactly the root and
 * size the server asks approvers to sign. Throws SCOPE_MISMATCH otherwise: never sign such a batch.
 */
export async function verifiedScope(client: ApiTransport, view: BatchView): Promise<BatchScopeEntry[]> {
  if (!/^[0-9a-f]{64}$/.test(view.scopeRoot) || !Number.isInteger(view.scopeSize) || view.scopeSize < 1)
    throw badAnswer('The server answered a batch without a valid scope root and size');
  const entries: BatchScopeEntry[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = await client.call<{ items?: unknown; next?: unknown }>('commandBatches/scope', {
      tenantId: view.tenantId,
      batchId: view.batchId,
      limit: 5_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!Array.isArray(page.items) || !page.items.every(isEntry))
      throw badAnswer("The server answered a scope page that is not a list of { subject, kind }");
    for (const item of page.items) entries.push(entryOf(item));
    if (entries.length > view.scopeSize)
      throw new CliError('SCOPE_MISMATCH', `Batch ${view.batchId} lists more commands than the ${view.scopeSize} it asks approval for`);
    if (page.next === undefined) break;
    // Each page moves forward: a server cannot keep the CLI paging forever.
    if (!Number.isInteger(page.next) || page.items.length === 0 || (cursor !== undefined && (page.next as number) <= cursor))
      throw badAnswer('The server answered a scope page that does not advance');
    cursor = page.next as number;
  }
  if (entries.length === 0) throw badAnswer(`Batch ${view.batchId} lists no commands`);
  const tree = batchScope(view.batchId, entries);
  if (tree.size !== view.scopeSize || hexOf(tree.root) !== view.scopeRoot)
    throw new CliError(
      'SCOPE_MISMATCH',
      `Batch ${view.batchId}'s listed commands do not give the root it asks approvers to sign`,
      'Do not approve it. Report it: the control plane answered two different batches.',
    );
  return entries;
}

async function readBatch(client: ApiTransport, tenantId: string, batchId: string): Promise<BatchView> {
  const view = await client.call<BatchView>('commandBatches/get', { tenantId, batchId });
  if (view.batchId !== batchId || view.tenantId !== tenantId) throw badAnswer('The server answered another batch');
  if (typeof view.trustDomain !== 'string' || !view.trustDomain) throw badAnswer('The server answered a batch without its trust domain');
  return view;
}

const batchFlag: FlagSpec = { type: 'string', value: 'ID', required: true, description: 'The batch (batch_…)' };
const batchIdPattern = /^batch_[0-9a-z]{26,52}$/;
const checkBatchId = (flags: { batch?: string | undefined }) => {
  if (flags.batch !== undefined && !batchIdPattern.test(flags.batch)) throw usageError('--batch takes a batch id (batch_…)');
};

/** What `batch sign` printed: checked against the batch before it is submitted. */
function parseSignatureFile(text: string, what: string) {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CliError('INVALID_INPUT', `${what} is not JSON (the output of batch sign)`);
  }
  const signature = value?.signature as Record<string, unknown> | undefined;
  if (
    typeof value?.batchId !== 'string' ||
    typeof value.scopeRoot !== 'string' ||
    typeof value.scopeSize !== 'number' ||
    typeof value.notAfter !== 'string' ||
    typeof value.trustDomain !== 'string' ||
    typeof signature?.kid !== 'string' ||
    typeof signature.sig !== 'string'
  )
    throw new CliError('INVALID_INPUT', `${what} is not the output of batch sign`);
  return {
    batchId: value.batchId,
    scopeRoot: value.scopeRoot,
    scopeSize: value.scopeSize,
    notAfter: Date.parse(value.notAfter),
    trustDomain: value.trustDomain,
    signature: { kid: signature.kid, sig: signature.sig },
  };
}

export const batchCommands = [
  defineCommand({
    name: 'batch keygen',
    group: 'Quorum',
    summary: 'Create an approver key pair for destructive batches',
    description:
      "batch keygen creates an ECDSA P-256 approver key (PLAN.md §13): the private key (PKCS#8 PEM, mode 0600) at --out, the public key beside it at <out>.pub. Keep the private key with its operator, off the control plane (a hardware token or an offline machine is better). Add the public key to the deployment's pki.approvers.keys, e.g. approverKeyOf(readFileSync('alice.pem.pub', 'utf8')).spkiDer from @better-compute/pki, with pki.approvers.threshold; daemons receive it in their trust bundle. The kid printed is how approvals name the key. With BETTER_COMPUTE_APPROVER_PASSPHRASE set, the private key is encrypted under it (and every batch command reads it with it).",
    output: 'json',
    flags: {
      out: { type: 'string', value: 'PATH', required: true, description: 'Where to write the private key (never overwritten)' },
    },
    examples: ['better-compute batch keygen --out ~/.better-compute/approver.pem'],
    async run({ flags, env, path, note }) {
      const target = path(flags.out!);
      const { privateKey, key } = createApproverKey();
      const passphrase = env[approverPassphraseEnv];
      const privatePem = privateKey
        .export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) })
        .toString();
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
      if (!passphrase) note(`${target} is not encrypted: set ${approverPassphraseEnv} when creating keys to encrypt them.`);
      return { kid: key.kid, privateKey: target, publicKey: `${target}.pub`, spki: base64url(key.spkiDer) };
    },
  }),
  defineCommand({
    name: 'batch sign',
    group: 'Quorum',
    summary: 'Sign a batch approval offline, from its scope',
    description:
      "batch sign signs one approval of a destructive batch with an approver key (--key, from batch keygen) without contacting the server: for approvers on an offline machine. Pass the batch's scope (--scope, the JSON batch show prints, or an array of { subject, kind }): the root is recomputed from it and every subject is shown by kind before signing (--expect checks them against your own list). --root and --size, when given as well, must match what the scope gives; signing --root and --size alone, a root the CLI cannot check, needs --unchecked. --not-after is the batch's expiry as the server set it (all approvers sign the same one), at most --max-hours away. Prints the signature ({ kid, sig }) to hand to batch approve --signature.",
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
        description: "The batch's expiry: ISO-8601 or epoch milliseconds (default: the scope file's notAfter)",
      },
      'trust-domain': {
        type: 'string',
        value: 'DOMAIN',
        description: "The deployment's trust domain (default: the scope file's)",
      },
      expect: expectFlag,
      'allow-unbound': allowUnboundFlag,
      'max-hours': maxHoursFlag,
      unchecked: { type: 'boolean', description: 'Sign --root and --size without a scope to check them against' },
    },
    validate(flags) {
      if (flags.scope === undefined && (flags.root === undefined || flags.size === undefined))
        throw usageError('Pass --scope (recommended), or --root and --size');
      if (flags.scope === undefined && !flags.unchecked)
        throw usageError('Without --scope the CLI cannot see what the root contains: pass --scope, or --unchecked to sign it blind');
      if (flags.scope === undefined && flags.expect !== undefined) throw usageError('--expect needs --scope');
      if (flags.root !== undefined && !/^[0-9a-f]{64}$/i.test(flags.root)) throw usageError('--root takes 64 hex digits');
    },
    examples: [
      'better-compute batch sign --key approver.pem --scope batch.json --not-after 2026-09-25T18:00:00Z',
      'better-compute batch sign --key approver.pem --scope batch.json --expect my-nodes.txt',
    ],
    async run({ flags, env, path, note }) {
      const { privateKey, kid } = await loadApproverKey(path(flags.key!), env);
      let batchId = flags.batch;
      let root: Uint8Array | undefined = flags.root === undefined ? undefined : new Uint8Array(Buffer.from(flags.root, 'hex'));
      let size = flags.size;
      let notAfterText = flags['not-after'];
      let trustDomain = flags['trust-domain'];
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
        notAfterText ??= scope.notAfter;
        if (trustDomain !== undefined && scope.trustDomain !== undefined && scope.trustDomain !== trustDomain)
          throw new CliError('INVALID_INPUT', `${file} is for trust domain ${scope.trustDomain}, not ${trustDomain}`);
        trustDomain ??= scope.trustDomain;
        note(`Approving batch ${batchId}: ${scopeLine(size, scope.entries)}:`);
        for (const line of subjectLines(scope.entries)) note(line);
        if (flags.expect !== undefined) {
          const expected = path(flags.expect);
          checkExpected(scope.entries, await readFile(expected, 'utf8'), expected);
          note(`Every subject is one ${flags.expect} expects.`);
        }
        checkUnbound(scope.entries, flags['allow-unbound'], note);
      } else {
        if (!batchId) throw usageError('Pass --batch with --root and --size');
        note(`Signing root ${flags.root} of batch ${batchId} unchecked: pass --scope to see what it contains.`);
      }
      if (notAfterText === undefined) throw usageError("Pass --not-after: the batch's expiry");
      if (!trustDomain) throw usageError("Pass --trust-domain: the deployment's (the approval admits nothing elsewhere)");
      const notAfter = parseNotAfter(notAfterText, Date.now());
      checkWindow(notAfter, Date.now(), flags['max-hours'] ?? 72);
      note(`The approval admits them in ${trustDomain} until ${new Date(notAfter).toISOString()}.`);
      const signature = signBatchApproval({ batchId, scopeRoot: root!, scopeSize: size!, notAfter, trustDomain }, privateKey);
      return {
        batchId,
        scopeRoot: hexOf(root!),
        scopeSize: size,
        notAfter: new Date(notAfter).toISOString(),
        trustDomain,
        signature: { kid, sig: base64url(signature.sig) },
      };
    },
  }),
  defineCommand({
    name: 'batch list',
    group: 'Quorum',
    summary: 'List destructive batches, newest first',
    description:
      'batch list pages commandBatches.list: each batch with its reason, state (pending, approved, expired, cancelled), scope size, the approvals it has and needs, and its member commands by state. Needs compute:batches:read.',
    target: 'token',
    output: 'json',
    flags: {
      tenant: tenantFlag,
      state: { type: 'string', value: 'STATE', choices: ['pending', 'approved', 'expired', 'cancelled'], description: 'Only batches in this state' },
      limit: { type: 'integer', value: 'N', min: 1, max: 200, default: 50, description: 'Batches per page' },
      cursor: { type: 'string', value: 'ID', description: "The previous page's next" },
    },
    examples: ['better-compute batch list --tenant org_acme --state pending'],
    async run({ flags, api }) {
      return (await api()).call('commandBatches/list', {
        tenantId: flags.tenant,
        ...(flags.state ? { state: flags.state } : {}),
        limit: flags.limit ?? 50,
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'batch show',
    group: 'Quorum',
    summary: 'Show a batch and check its scope against its root',
    description:
      "batch show reads a batch (commandBatches.get), pages its scope (commandBatches.scope) and recomputes the Merkle root from the listed (subject, kind) commands: it fails with SCOPE_MISMATCH when they do not give the root the server asks approvers to sign. --scope-out writes the verified scope with the batch's expiry, the input of batch sign on an offline machine.",
    target: 'token',
    output: 'json',
    flags: {
      tenant: tenantFlag,
      batch: batchFlag,
      'scope-out': { type: 'string', value: 'PATH', description: 'Write the verified scope (JSON) for batch sign' },
    },
    validate: checkBatchId,
    examples: [
      'better-compute batch show --tenant org_acme --batch batch_01k5w…',
      'better-compute batch show --tenant org_acme --batch batch_01k5w… --scope-out batch.json',
    ],
    async run({ flags, api, path, note }) {
      const client = await api();
      const view = await readBatch(client, flags.tenant!, flags.batch!);
      const entries = await verifiedScope(client, view);
      if (flags['scope-out'] !== undefined) {
        const target = path(flags['scope-out']);
        const document = {
          batchId: view.batchId,
          reason: view.reason,
          scopeRoot: view.scopeRoot,
          scopeSize: view.scopeSize,
          notAfter: new Date(view.notAfter).toISOString(),
          trustDomain: view.trustDomain,
          scope: entries.map(jsonOf),
        };
        await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
        note(`Wrote ${target}: sign it with batch sign --key … --scope ${flags['scope-out']}.`);
      }
      return { ...view, scopeVerified: true, ...describeScope(entries) };
    },
  }),
  defineCommand({
    name: 'batch approve',
    group: 'Quorum',
    summary: "Approve a destructive batch with your approver key",
    description:
      "batch approve reads the batch, pages its scope and recomputes the root from the listed commands (refusing with SCOPE_MISMATCH when they do not give it), shows the reason, every subject by kind (--expect checks them against your own list) and the approvals so far, and then signs the batch's root, size and expiry with --key and submits the signature (commandBatches.approve, compute:batches:approve). Without --yes it stops after showing the batch; --root approves only the root you reviewed. Once the batch holds the required approvals it is released and its commands run. With --signature, submits a signature made offline by batch sign instead, after checking it is for this batch.",
    target: 'token',
    output: 'json',
    flags: {
      tenant: tenantFlag,
      batch: batchFlag,
      key: { type: 'string', value: 'PATH', description: 'Your approver private key (from batch keygen)' },
      signature: { type: 'string', value: 'PATH', description: 'A signature from batch sign (instead of --key)' },
      root: { type: 'string', value: 'HEX', description: 'Approve only if the batch still has this root (64 hex digits)' },
      expect: expectFlag,
      'allow-unbound': allowUnboundFlag,
      'max-hours': maxHoursFlag,
      yes: { type: 'boolean', description: 'Sign and submit without stopping after the summary' },
    },
    validate(flags) {
      checkBatchId(flags);
      if ((flags.key === undefined) === (flags.signature === undefined)) throw usageError('Pass --key or --signature (one of them)');
      if (flags.root !== undefined && !/^[0-9a-f]{64}$/i.test(flags.root)) throw usageError('--root takes 64 hex digits');
    },
    examples: [
      'better-compute batch approve --tenant org_acme --batch batch_01k5w… --key ~/.better-compute/approver.pem',
      'better-compute batch approve --tenant org_acme --batch batch_01k5w… --key approver.pem --root 3f1c…',
      'better-compute batch approve --tenant org_acme --batch batch_01k5w… --signature alice.sig.json',
    ],
    async run({ flags, api, env, path, note }) {
      const client = await api();
      const view = await readBatch(client, flags.tenant!, flags.batch!);
      if (view.state !== 'pending') throw new CliError('INVALID_STATE', `Batch ${view.batchId} is ${view.state}`);
      checkWindow(view.notAfter, Date.now(), flags['max-hours'] ?? 72);
      const entries = await verifiedScope(client, view);
      note(`Batch ${view.batchId}: ${view.reason}`);
      note(`${scopeLine(view.scopeSize, entries)}:`);
      for (const line of subjectLines(entries)) note(line);
      if (flags.expect !== undefined) {
        const expected = path(flags.expect);
        checkExpected(entries, await readFile(expected, 'utf8'), expected);
        note(`Every subject is one ${flags.expect} expects.`);
      }
      checkUnbound(entries, flags['allow-unbound'], note);
      note(
        `Approvals: ${view.approvals.length} of ${view.requiredApprovals}; the window closes at ${new Date(view.notAfter).toISOString()}.`,
      );
      if (flags.root !== undefined && flags.root.toLowerCase() !== view.scopeRoot)
        throw new CliError('SCOPE_CHANGED', `Batch ${view.batchId} no longer has root ${flags.root}`, 'Review it again with batch show.');
      let signature: { kid: string; sig: string };
      if (flags.signature !== undefined) {
        const file = path(flags.signature);
        const signed = parseSignatureFile(await readFile(file, 'utf8'), file);
        if (
          signed.batchId !== view.batchId ||
          signed.scopeRoot !== view.scopeRoot ||
          signed.scopeSize !== view.scopeSize ||
          signed.notAfter !== view.notAfter ||
          signed.trustDomain !== view.trustDomain
        )
          throw new CliError('SCOPE_MISMATCH', `${file} signs another batch, root, size, expiry or trust domain than ${view.batchId}`);
        signature = signed.signature;
      } else {
        const { privateKey, kid } = await loadApproverKey(path(flags.key!), env);
        if (view.approvals.some((approval) => approval.kid === kid)) {
          note(`Key ${kid} already approved this batch.`);
          return view;
        }
        if (!flags.yes && flags.root === undefined) {
          note(`Not approved. Re-run with --yes, or with --root ${view.scopeRoot}.`);
          return { approved: false, batchId: view.batchId, scopeRoot: view.scopeRoot, scopeSize: view.scopeSize };
        }
        const signed = signBatchApproval(
          {
            batchId: view.batchId,
            scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
            scopeSize: view.scopeSize,
            notAfter: view.notAfter,
            trustDomain: view.trustDomain,
          },
          privateKey,
        );
        signature = { kid, sig: base64url(signed.sig) };
      }
      const after = await client.call<BatchView>('commandBatches/approve', {
        tenantId: view.tenantId,
        batchId: view.batchId,
        signature,
      });
      note(
        after.state === 'approved'
          ? `Batch ${view.batchId} is approved (${after.approvals.length} of ${after.requiredApprovals}): its commands run now.`
          : `Approved by ${signature.kid}: ${after.approvals.length} of ${after.requiredApprovals}.`,
      );
      return after;
    },
  }),
  defineCommand({
    name: 'batch cancel',
    group: 'Quorum',
    summary: 'Cancel a pending batch and its held commands',
    description:
      'batch cancel ends a pending batch (commandBatches.cancel, compute:batches:approve): none of its commands run, and the pending ones are cancelled with reason batch-cancelled.',
    target: 'token',
    output: 'json',
    flags: { tenant: tenantFlag, batch: batchFlag },
    validate: checkBatchId,
    examples: ['better-compute batch cancel --tenant org_acme --batch batch_01k5w…'],
    async run({ flags, api }) {
      return (await api()).call('commandBatches/cancel', { tenantId: flags.tenant, batchId: flags.batch });
    },
  }),
];
