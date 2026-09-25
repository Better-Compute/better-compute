import { createCipheriv, hkdfSync, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { pkiFindings } from '../packages/cli/src/commands/pki.js';
import {
  commandSigningOptions,
  createPkiBundle,
  exportPkiBundle,
  importPkiBundle,
  pkiPins,
  readPkiPins,
  rotateCommandSigningRoot,
  signCommand,
  verifyCommand,
} from '@better-compute/pki';
import { create } from '@bufbuild/protobuf';
import { CommandBodySchema } from '@better-compute/protocol';

// Command-signing root rotation (PLAN.md §13: new key first, switch after every daemon has it, then drop the old),
// on the PKI bundle and through `better-compute pki rotate-command-root`.

const SECRET = 'pki-rotation-test-secret-0123456789abcdef';
const body = create(CommandBodySchema, { id: 'cmd_1', nodeId: 'node_r', kind: 'node.reboot' });
const trusts = (roots: Uint8Array[], signer: { issueWorkerKey(o: { workerId: string }): never }) => {
  const command = signCommand(body, signer.issueWorkerKey({ workerId: 'w1' }));
  try {
    verifyCommand(command, { roots, now: Date.now(), nodeId: 'node_r', required: true });
    return true;
  } catch {
    return false;
  }
};

describe('command-signing root rotation', () => {
  it('adds, switches and drops a root; the trust bundle version moves when the trusted set does', () => {
    const start = createPkiBundle({ trustDomain: 'compute.test' });
    expect(commandSigningOptions(start)).toMatchObject({ commandSigningRoots: [], trustVersion: 1 });
    const oldRoot = start.commandSigning!;

    const added = rotateCommandSigningRoot(start, 'add');
    const a = commandSigningOptions(added)!;
    expect(a.commandSigning).toBe(oldRoot); // still signing under the current root
    expect(a.trustVersion).toBe(2);
    const newRoot = added.commandSigningNext!;
    const publishedAfterAdd = [a.commandSigning.certificate, ...a.commandSigningRoots];
    // Daemons holding version 2 accept both workers.
    expect(trusts(publishedAfterAdd, oldRoot as never)).toBe(true);
    expect(trusts(publishedAfterAdd, newRoot as never)).toBe(true);

    const switched = rotateCommandSigningRoot(added, 'switch');
    const s = commandSigningOptions(switched)!;
    expect(s.commandSigning).toBe(newRoot);
    expect(s.trustVersion).toBe(2); // the same two roots
    expect(s.commandSigningRoots).toEqual([oldRoot.certificate]);

    const dropped = rotateCommandSigningRoot(switched, 'drop');
    const d = commandSigningOptions(dropped)!;
    expect(d.trustVersion).toBe(3);
    expect(d.commandSigningRoots).toEqual([]);
    expect(trusts([d.commandSigning.certificate], oldRoot as never)).toBe(false);
    expect(trusts([d.commandSigning.certificate], newRoot as never)).toBe(true);

    // Out of order: refused.
    expect(() => rotateCommandSigningRoot(start, 'switch')).toThrow(/add one first/);
    expect(() => rotateCommandSigningRoot(start, 'drop')).toThrow(/No previous root/);
    expect(() => rotateCommandSigningRoot(added, 'add')).toThrow(/already added/);
    expect(() => rotateCommandSigningRoot(switched, 'add')).toThrow(/drop it before/);
  });

  it('keeps the rotation state through a sealed export and import', () => {
    const added = rotateCommandSigningRoot(createPkiBundle({ trustDomain: 'compute.test' }), 'add');
    const text = exportPkiBundle(added, { secret: SECRET });
    expect(text).not.toContain('PRIVATE KEY');
    const loaded = importPkiBundle(text, { secret: SECRET });
    expect(pkiPins(loaded)).toMatchObject({
      trustVersion: 2,
      commandSigningNextRootSha256: pkiPins(added).commandSigningNextRootSha256,
    });
    // The public half says the same without the secret.
    expect(readPkiPins(text)).toMatchObject({ trustVersion: 2 });
    const switched = importPkiBundle(exportPkiBundle(rotateCommandSigningRoot(loaded, 'switch'), { secret: SECRET }), {
      secret: SECRET,
    });
    expect(pkiPins(switched).commandSigningPreviousRootSha256).toBe(pkiPins(added).commandSigningRootSha256);
  });

  it('refuses a sealed bundle whose public parts were changed without the secret', () => {
    const sealed = exportPkiBundle(createPkiBundle({ trustDomain: 'compute.test' }), { secret: SECRET });
    const stranger = createPkiBundle({ trustDomain: 'compute.test' });
    const pem = (der: Uint8Array) => new X509Certificate(der).toString();
    const edit = (change: (stored: Record<string, unknown>) => void) => {
      const stored = JSON.parse(sealed) as Record<string, unknown>;
      change(stored);
      return () => importPkiBundle(JSON.stringify(stored), { secret: SECRET });
    };
    // A file writer adds their own command-signing root (daemons would trust it) or pins the trust version.
    expect(edit((s) => (s.commandSigningPreviousCertificate = pem(stranger.rootCertificate)))).toThrow(
      /changed after it was sealed/,
    );
    expect(edit((s) => (s.trustVersion = 2 ** 52))).toThrow(/changed after it was sealed/);
    expect(edit((s) => (s.rootCertificate = pem(stranger.rootCertificate)))).toThrow(/changed after it was sealed/);
    // Reformatting the JSON (key order, indentation) changes nothing that matters.
    const reordered = Object.fromEntries(Object.entries(JSON.parse(sealed) as object).reverse());
    expect(importPkiBundle(JSON.stringify(reordered), { secret: SECRET }).trustDomain).toBe('compute.test');
  });

  it('loads bundles sealed before the public parts were authenticated, unless they carry rotation fields', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    // The former format: only the private keys under the seal.
    const legacy = (extra: Record<string, unknown>) => {
      const stored = JSON.parse(exportPkiBundle(bundle)) as Record<string, unknown>;
      const keys = stored.keys;
      delete stored.keys;
      Object.assign(stored, extra);
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = Buffer.from(hkdfSync('sha256', SECRET, salt, 'better-compute/pki-bundle/v1', 32));
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`better-compute-pki/1/${stored.trustDomain}`));
      const data = Buffer.concat([cipher.update(JSON.stringify(keys)), cipher.final(), cipher.getAuthTag()]);
      stored.sealed = {
        alg: 'HKDF-SHA256+A256GCM',
        salt: salt.toString('base64url'),
        iv: iv.toString('base64url'),
        data: data.toString('base64url'),
      };
      return JSON.stringify(stored);
    };
    expect(importPkiBundle(legacy({}), { secret: SECRET }).trustDomain).toBe('compute.test');
    const stranger = createPkiBundle({ trustDomain: 'compute.test' });
    expect(() =>
      importPkiBundle(
        legacy({ commandSigningPreviousCertificate: new X509Certificate(stranger.rootCertificate).toString() }),
        { secret: SECRET },
      ),
    ).toThrow(/without authenticating/);
    expect(() => importPkiBundle(legacy({ trustVersion: 7 }), { secret: SECRET })).toThrow(/without authenticating/);
  });

  it('rotates through the CLI, writing the bundle back sealed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-rotate-'));
    const out: string[] = [];
    const io: CliIO = { out: (line) => out.push(line), err() {}, cwd, env: { BETTER_COMPUTE_SECRET: SECRET } };
    const run = async (argv: string[]) => {
      out.length = 0;
      await createCli().run(argv, io);
      return JSON.parse(out.join('\n'));
    };
    const initial = await run(['pki', 'init', '--trust-domain', 'compute.test']);
    const added = await run(['pki', 'rotate-command-root', '--stage', 'add']);
    expect(added).toMatchObject({ stage: 'add', trustVersion: 2, signingRoot: initial.commandSigningRootSha256 });
    // doctor reminds that the rotation is half done.
    const reminders = await pkiFindings(join(cwd, '.better-compute', 'pki.json'), { BETTER_COMPUTE_SECRET: SECRET });
    expect(reminders.map((finding) => `${finding.severity} ${finding.check}`)).toEqual(['info pki.rotation']);
    const switched = await run(['pki', 'rotate-command-root', '--stage', 'switch']);
    expect(switched).toMatchObject({
      signingRoot: added.nextRoot,
      previousRoot: initial.commandSigningRootSha256,
      trustVersion: 2,
    });
    const dropped = await run(['pki', 'rotate-command-root', '--stage', 'drop']);
    expect(dropped).toEqual({ stage: 'drop', trustVersion: 3, signingRoot: added.nextRoot });
    await expect(createCli().run(['pki', 'rotate-command-root', '--stage', 'drop'], io)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(await readFile(join(cwd, '.better-compute', 'pki.json'), 'utf8')).toContain('"sealed"');
  });
});
