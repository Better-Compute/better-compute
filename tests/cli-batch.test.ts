import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import {
  approverKeyOf,
  batchScope,
  fromBase64url,
  verifyApproverSetChange,
  verifyBatchApproval,
} from '@better-compute/pki';
import { BatchApprovalSchema } from '@better-compute/protocol';

// The approver's side of the destructive-batch quorum (PLAN.md §13): keygen writes a P-256 pair whose public half
// is what pki.approvers.keys takes, and batch sign recomputes the scope root from the listed commands, shows every
// subject and signs it for one trust domain, so the signature verifies exactly as a daemon checks it.

async function harness(env: NodeJS.ProcessEnv = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'bc-batch-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line), cwd, env };
  const run = async (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    await createCli().run(argv, io);
    return JSON.parse(out.join('\n'));
  };
  return { cwd, out, err, run, io };
}

const batchId = 'batch_01k5w00000000000000000000q';
const trustDomain = 'compute.test';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
// Every leaf fixes its payload (the operation itself), as JSON carries it: hex.
const entries = [
  { subject: 'node_a', kind: 'disk.wipe', payloadSha256: digest('wipe node_a') },
  { subject: 'node_b', kind: 'disk.wipe', payloadSha256: digest('wipe node_b') },
  { subject: 'bmc:node_site/10.0.0.7', kind: 'bmc.power', payloadSha256: digest('power cycle') },
];
/** The same scope as pki takes it. */
const leaves = (list: { subject: string; kind: string; payloadSha256?: string }[]) =>
  list.map(({ subject, kind, payloadSha256 }) => ({
    subject,
    kind,
    ...(payloadSha256 ? { payloadSha256: new Uint8Array(Buffer.from(payloadSha256, 'hex')) } : {}),
  }));
const later = () => String(Date.now() + 3_600_000);

describe('batch keygen', () => {
  it('writes a private key once and its public key beside it', async () => {
    const h = await harness();
    const keygen = await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    const publicPem = await readFile(join(h.cwd, 'alice.pem.pub'), 'utf8');
    expect(approverKeyOf(publicPem).kid).toBe(keygen.kid);
    expect(await readFile(join(h.cwd, 'alice.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(h.err.join('\n')).toMatch(/not encrypted/);
    if (process.platform !== 'win32') expect((await stat(join(h.cwd, 'alice.pem'))).mode & 0o777).toBe(0o600);
    await expect(h.run(['batch', 'keygen', '--out', 'alice.pem'])).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('encrypts the key under BETTER_COMPUTE_APPROVER_PASSPHRASE, which signing then needs', async () => {
    const h = await harness({ BETTER_COMPUTE_APPROVER_PASSPHRASE: 'correct horse battery staple' });
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    expect(await readFile(join(h.cwd, 'alice.pem'), 'utf8')).toContain('ENCRYPTED PRIVATE KEY');
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: entries }));
    const sign = ['batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', later()];
    await expect(h.run(sign)).resolves.toMatchObject({ batchId });
    h.io.env = {};
    await expect(h.run(sign)).rejects.toMatchObject({ code: 'MISSING_ENV' });
    h.io.env = { BETTER_COMPUTE_APPROVER_PASSPHRASE: 'wrong' };
    await expect(h.run(sign)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.skipIf(process.platform === 'win32')('refuses a key file others can read', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await chmod(join(h.cwd, 'alice.pem'), 0o644);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: entries }));
    await expect(
      h.run(['batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', later()]),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', message: /readable by others/ });
  });
});

describe('batch sign-approvers', () => {
  it('signs a new approver set that daemons holding the current one accept at its threshold', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await h.run(['batch', 'keygen', '--out', 'bob.pem']);
    await h.run(['batch', 'keygen', '--out', 'carol.pem']);
    const key = async (name: string) => approverKeyOf(await readFile(join(h.cwd, `${name}.pem.pub`), 'utf8'));
    const [alice, bob, carol] = [await key('alice'), await key('bob'), await key('carol')];
    const current = { approverKeys: [alice, bob], approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    const argv = (signer: string) => [
      'batch', 'sign-approvers', '--key', `${signer}.pem`, '--version', '4',
      '--approvers', 'alice.pem.pub,bob.pem.pub,carol.pem.pub', '--threshold', '2', '--tiers', '5:1,100:2',
      '--trust-domain', 'compute.test',
    ];
    const byAlice = await h.run(argv('alice'));
    const byBob = await h.run(argv('bob'));
    expect(byAlice).toMatchObject({
      version: 4,
      trustDomain: 'compute.test',
      set: { approverKids: [alice.kid, bob.kid, carol.kid], threshold: 2 },
    });
    expect(byAlice.setSha256).toBe(byBob.setSha256);
    const next = {
      approverKeys: [alice, bob, carol],
      approverThreshold: 2,
      quorumTiers: [
        { maxScopeSize: 5, threshold: 1 },
        { maxScopeSize: 100, threshold: 2 },
      ],
      unbatchedDestructivePerHour: 0,
      version: 4n,
      trustDomain: 'compute.test',
    };
    const signatures = [byAlice, byBob].map((out) => ({ kid: out.signature.kid, sig: fromBase64url(out.signature.sig) }));
    expect(verifyApproverSetChange(current, { ...next, approverSetSignatures: signatures })).toHaveLength(2);
    expect(() => verifyApproverSetChange(current, { ...next, approverSetSignatures: signatures.slice(0, 1) })).toThrow();
    // Another deployment sharing these approver keys does not take it.
    expect(() => verifyApproverSetChange(current, { ...next, approverSetSignatures: signatures, trustDomain: 'prod.test' })).toThrow();
    // Without a PKI bundle to read the trust domain from, it must be given.
    await expect(h.run(argv('alice').slice(0, -2))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: /--trust-domain/ });
    // Removing the quorum is said out loud; bad thresholds and tier orders are refused.
    await h.run(['batch', 'sign-approvers', '--key', 'alice.pem', '--version', '5', '--trust-domain', 'compute.test']);
    expect(h.err.join('\n')).toMatch(/REMOVAL of the quorum/);
    await expect(h.run([...argv('alice'), '--threshold', '4'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.run([...argv('alice'), '--tiers', '100:2,5:1'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('batch sign', () => {
  it('signs the root it recomputes from the scope, for its trust domain, verifiable as a daemon checks it', async () => {
    const h = await harness();
    const alice = await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: entries }));
    const notAfter = Date.now() + 3_600_000;
    const signed = await h.run(['batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', String(notAfter)]);
    const tree = batchScope(batchId, leaves(entries));
    expect(signed).toMatchObject({ batchId, trustDomain, scopeRoot: Buffer.from(tree.root).toString('hex'), scopeSize: 3 });
    expect(signed.signature.kid).toBe(alice.kid);
    // It shows every subject, by kind, before signing.
    const shown = h.err.join('\n');
    expect(shown).toMatch(/3 command\(s\) on 3 subject\(s\): disk\.wipe ×2, bmc\.power ×1/);
    expect(shown).toMatch(/disk\.wipe: node_a, node_b/);
    expect(shown).toMatch(/bmc\.power: bmc:node_site\/10\.0\.0\.7/);
    const approval = create(BatchApprovalSchema, {
      batchId,
      scopeRoot: tree.root,
      scopeSize: tree.size,
      notAfter: timestampFromMs(notAfter),
      signatures: [{ kid: signed.signature.kid, sig: fromBase64url(signed.signature.sig) }],
    });
    const key = approverKeyOf(await readFile(join(h.cwd, 'alice.pem.pub'), 'utf8'));
    expect(verifyBatchApproval(approval, { approverKeys: [key], threshold: 1, now: Date.now(), trustDomain })).toEqual([alice.kid]);
    // Another deployment does not accept it.
    expect(() =>
      verifyBatchApproval(approval, { approverKeys: [key], threshold: 1, now: Date.now(), trustDomain: 'staging.test' }),
    ).toThrow();
  });

  it('refuses leaves that admit any payload unless --allow-unbound, naming them', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    const open = [...entries.slice(0, 2), { subject: 'bmc:node_site/10.0.0.7', kind: 'bmc.power', payloadSha256: '' }];
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: open }));
    const sign = ['batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', later()];
    await expect(h.run(sign)).rejects.toMatchObject({ code: 'UNBOUND_SCOPE', message: /bmc\.power on bmc:node_site\/10\.0\.0\.7/ });
    const signed = await h.run([...sign, '--allow-unbound']);
    expect(signed.scopeRoot).toBe(Buffer.from(batchScope(batchId, leaves(open)).root).toString('hex'));
    expect(h.err.join('\n')).toMatch(/\(any payload\)/);
    expect(h.err.join('\n')).toMatch(/Warning: 1 command\(s\) admit any payload/);
  });

  it('checks the subjects against --expect', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: entries }));
    const sign = (expected: string) => [
      'batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', later(), '--expect', expected,
    ];
    await writeFile(join(h.cwd, 'mine.txt'), '# my nodes\nnode_a\nnode_b\nbmc:node_site/10.0.0.7\n');
    await expect(h.run(sign('mine.txt'))).resolves.toMatchObject({ batchId });
    // One more subject than expected (another BMC), or one missing: refused, naming it.
    await writeFile(join(h.cwd, 'fewer.txt'), 'node_a\nnode_b\n');
    await expect(h.run(sign('fewer.txt'))).rejects.toMatchObject({
      code: 'SCOPE_UNEXPECTED',
      message: /not expected: bmc:node_site\/10\.0\.0\.7/,
    });
    await writeFile(join(h.cwd, 'more.json'), JSON.stringify([...entries, { subject: 'node_c', kind: 'disk.wipe' }]));
    await expect(h.run(sign('more.json'))).rejects.toMatchObject({ code: 'SCOPE_UNEXPECTED', message: /missing: node_c disk\.wipe/ });
  });

  it('refuses a root or size the scope does not give, a closed or overlong window, and a blind root', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify(entries));
    const base = ['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--scope', 'scope.json', '--trust-domain', trustDomain];
    await expect(h.run([...base, '--root', '00'.repeat(32), '--not-after', later()])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.run([...base, '--size', '4', '--not-after', later()])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.run([...base, '--not-after', '2020-01-01T00:00:00Z'])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // An approval admits its commands until notAfter: more than --max-hours (default 72) away is refused.
    const far = String(Date.now() + 100 * 3_600_000);
    await expect(h.run([...base, '--not-after', far])).rejects.toMatchObject({ code: 'INVALID_STATE', message: /more than 72 h/ });
    await expect(h.run([...base, '--not-after', far, '--max-hours', '120'])).resolves.toMatchObject({ batchId });
    // No trust domain: refused.
    await expect(
      h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--scope', 'scope.json', '--not-after', later()]),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // Another batch's scope file.
    await writeFile(join(h.cwd, 'other.json'), JSON.stringify({ batchId: 'batch_other', scope: entries }));
    await expect(
      h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--scope', 'other.json', '--not-after', later()]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Neither a scope nor a root and size; a root and size without --unchecked.
    await expect(h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--not-after', later()])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    const root = Buffer.from(batchScope(batchId, leaves(entries)).root).toString('hex');
    await expect(
      h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--root', root, '--size', '3', '--not-after', later()]),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: /--unchecked/ });
  });

  it('signs a blind root only with --unchecked, and says so', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    const root = Buffer.from(batchScope(batchId, leaves(entries)).root).toString('hex');
    const signed = await h.run([
      'batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--root', root, '--size', '3', '--unchecked',
      '--trust-domain', trustDomain, '--not-after', new Date(Date.now() + 60_000).toISOString(),
    ]);
    expect(signed).toMatchObject({ scopeRoot: root, scopeSize: 3 });
    expect(h.err.join('\n')).toMatch(/unchecked/);
  });

  it('refuses a key that is not a P-256 approver key', async () => {
    const h = await harness();
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(join(h.cwd, 'ed.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, trustDomain, scope: entries }));
    await expect(
      h.run(['batch', 'sign', '--key', 'ed.pem', '--scope', 'scope.json', '--not-after', later()]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /P-256/ });
  });
});
