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
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
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
    // Nothing says which daemons hold version 2 here: the switch refuses unless forced.
    await expect(createCli().run(['pki', 'rotate-command-root', '--stage', 'switch'], io)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: /Cannot check which daemons hold trust version 2/,
    });
    const switched = await run(['pki', 'rotate-command-root', '--stage', 'switch', '--force']);
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

  it('switches only once every connected daemon reports the new trust version', { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-rotate-gate-'));
    const env = { BETTER_COMPUTE_SECRET: SECRET, BETTER_COMPUTE_DATABASE_URL: 'pglite:data' };
    const notes: string[] = [];
    const io: CliIO = { out() {}, err: (line) => notes.push(line), cwd, env };
    await createCli().run(['pki', 'init', '--trust-domain', 'compute.test'], io);
    await createCli().run(['pki', 'rotate-command-root', '--stage', 'add'], io);
    await createCli().run(['migrate'], io);
    const at = async (fn: (db: SqlExecutor) => Promise<unknown>) => {
      const db = pglite({ dataDir: join(cwd, 'data') });
      try {
        await fn(db);
      } finally {
        await db.close();
      }
    };
    await at(async (db) => {
      await db.query(
        `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_r', 'root', 'shared', 'eu', 1)`,
      );
      for (const [id, version, gone, seen] of [
        ['node_new', 2, false, '0 seconds'],
        ['node_old', 1, false, '5 seconds'],
        ['node_away', 0, true, '0 seconds'],
        // A session its gateway never closed (the gateway died): not live, not counted.
        ['node_stale', 0, false, '10 minutes'],
      ] as const) {
        await db.query(
          `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
             trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
           VALUES ($1, 'site_r', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
          [id],
        );
        await db.query(
          `INSERT INTO node_sessions (node_id, session_epoch, gateway_id, trust_version, disconnected_at, last_seen)
           VALUES ($1, 1, 'gw', $2, CASE WHEN $3 THEN compute_now() END, compute_now() - $4::interval)`,
          [id, version, gone, seen],
        );
      }
    });
    // node_old has not applied version 2; the disconnected node does not count (Welcome hands it the bundle).
    await expect(createCli().run(['pki', 'rotate-command-root', '--stage', 'switch'], io)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: /1 of 2 connected node\(s\) have not applied it \(node_old at 1\)/,
    });
    await at(async (db) => {
      const findings = await pkiFindings(join(cwd, '.better-compute', 'pki.json'), env, Date.now(), db);
      expect(findings.find((finding) => finding.check === 'pki.rotation')?.message).toMatch(/1 of 2 connected/);
      await db.query(`UPDATE node_sessions SET trust_version = 2 WHERE node_id = 'node_old'`);
    });
    await createCli().run(['pki', 'rotate-command-root', '--stage', 'switch'], io);
    expect(notes).toContain('All 2 connected node(s) hold trust version 2.');
  });
});
