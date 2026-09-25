import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { approverKeyOf, batchScope, fromBase64url, verifyBatchApproval } from '@better-compute/pki';
import { BatchApprovalSchema } from '@better-compute/protocol';

// The approver's side of the destructive-batch quorum (PLAN.md §13): keygen writes a P-256 pair whose public half
// is what pki.approvers.keys takes, and batch sign recomputes the scope root from the listed commands before
// signing, so the signature verifies against the trust bundle exactly as a daemon checks it.

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'bc-batch-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line), cwd, env: {} };
  const run = async (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    await createCli().run(argv, io);
    return JSON.parse(out.join('\n'));
  };
  return { cwd, out, err, run };
}

const batchId = 'batch_01k5w00000000000000000000q';
const entries = [
  { subject: 'node_a', kind: 'disk.wipe' },
  { subject: 'node_b', kind: 'disk.wipe' },
  { subject: 'bmc:10.0.0.7', kind: 'bmc.power' },
];

describe('batch keygen', () => {
  it('writes a private key once and its public key beside it', async () => {
    const h = await harness();
    const keygen = await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    const publicPem = await readFile(join(h.cwd, 'alice.pem.pub'), 'utf8');
    expect(approverKeyOf(publicPem).kid).toBe(keygen.kid);
    expect(await readFile(join(h.cwd, 'alice.pem'), 'utf8')).toContain('PRIVATE KEY');
    if (process.platform !== 'win32') expect((await stat(join(h.cwd, 'alice.pem'))).mode & 0o777).toBe(0o600);
    await expect(h.run(['batch', 'keygen', '--out', 'alice.pem'])).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });
});

describe('batch sign', () => {
  it('signs the root it recomputes from the scope, verifiable against the trust bundle', async () => {
    const h = await harness();
    const alice = await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, scope: entries }));
    const notAfter = Date.now() + 3_600_000;
    const signed = await h.run(['batch', 'sign', '--key', 'alice.pem', '--scope', 'scope.json', '--not-after', String(notAfter)]);
    const tree = batchScope(batchId, entries);
    expect(signed).toMatchObject({ batchId, scopeRoot: Buffer.from(tree.root).toString('hex'), scopeSize: 3 });
    expect(signed.signature.kid).toBe(alice.kid);
    // It shows what is approved before signing.
    expect(h.err.join('\n')).toMatch(/3 command\(s\) on 3 subject\(s\): disk\.wipe ×2, bmc\.power ×1/);
    const approval = create(BatchApprovalSchema, {
      batchId,
      scopeRoot: tree.root,
      scopeSize: tree.size,
      notAfter: timestampFromMs(notAfter),
      signatures: [{ kid: signed.signature.kid, sig: fromBase64url(signed.signature.sig) }],
    });
    const key = approverKeyOf(await readFile(join(h.cwd, 'alice.pem.pub'), 'utf8'));
    expect(verifyBatchApproval(approval, { approverKeys: [key], threshold: 1, now: Date.now() })).toEqual([alice.kid]);
  });

  it('refuses a root or size the scope does not give, and a closed window', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify(entries));
    const later = String(Date.now() + 3_600_000);
    const base = ['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--scope', 'scope.json'];
    await expect(h.run([...base, '--root', '00'.repeat(32), '--not-after', later])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.run([...base, '--size', '4', '--not-after', later])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.run([...base, '--not-after', '2020-01-01T00:00:00Z'])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Another batch's scope file.
    await writeFile(join(h.cwd, 'other.json'), JSON.stringify({ batchId: 'batch_other', scope: entries }));
    await expect(
      h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--scope', 'other.json', '--not-after', later]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Neither a scope nor a root and size.
    await expect(h.run(['batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--not-after', later])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('signs an unchecked root only with --root and --size, and says so', async () => {
    const h = await harness();
    await h.run(['batch', 'keygen', '--out', 'alice.pem']);
    const tree = batchScope(batchId, entries);
    const root = Buffer.from(tree.root).toString('hex');
    const signed = await h.run([
      'batch', 'sign', '--key', 'alice.pem', '--batch', batchId, '--root', root, '--size', '3',
      '--not-after', new Date(Date.now() + 60_000).toISOString(),
    ]);
    expect(signed).toMatchObject({ scopeRoot: root, scopeSize: 3 });
    expect(h.err.join('\n')).toMatch(/unchecked/);
  });

  it('refuses a key that is not a P-256 approver key', async () => {
    const h = await harness();
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(join(h.cwd, 'ed.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    await writeFile(join(h.cwd, 'scope.json'), JSON.stringify({ batchId, scope: entries }));
    await expect(
      h.run(['batch', 'sign', '--key', 'ed.pem', '--scope', 'scope.json', '--not-after', String(Date.now() + 60_000)]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /P-256/ });
  });
});
