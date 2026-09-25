import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import {
  bootstrapPins,
  createPkiBundle,
  exportPkiBundle,
  importPkiBundle,
  pkiPins,
  readPkiPins,
  tunnelsOptions,
} from '@better-compute/pki';

// The sandbox SSH CA (PLAN.md §3.7): its own CA in the bundle, sealed like the others, handed to the tunnels
// module (sandboxSsh) and, as a public key, to vps's sandboxExec. Separate from break-glass.

const SECRET = 'pki-sandbox-ca-test-secret-0123456789abcdef';

describe('sandbox SSH CA', () => {
  it('is created, sealed, reloaded and handed to the tunnels options, apart from break-glass', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    expect(bundle.sandboxSshCa).toBeDefined();
    expect(bundle.sandboxSshCa!.publicKey).not.toBe(bundle.sshCa!.publicKey);
    const loaded = importPkiBundle(exportPkiBundle(bundle, { secret: SECRET }), { secret: SECRET });
    expect(loaded.sandboxSshCa!.publicKey).toBe(bundle.sandboxSshCa!.publicKey);
    expect(pkiPins(loaded).sandboxSshCaPublicKey).toBe(bundle.sandboxSshCa!.publicKey);
    const options = tunnelsOptions(loaded, { issuer: 'https://compute.test' });
    expect(options.ssh).toBe(loaded.sshCa);
    expect(options.sandboxSsh).toBe(loaded.sandboxSshCa);
    expect(options.issuer.jwksJson()).toContain('"kty":"EC"');
  });

  it('gives machines their bootstrap pins from the bundle', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const pins = pkiPins(bundle);
    expect(bootstrapPins(bundle)).toEqual({
      servingCaPin: pins.servingCaSpkiPin,
      joinSigningPin: pins.joinSigningKeyPin,
      joinEncryptionPin: pins.joinEncryptionKeyPin,
    });
    expect(bootstrapPins(bundle).servingCaPin).toMatch(/^sha256\/[A-Za-z0-9+/]{43}=$/);
  });

  it('keeps generated CA comments printable for any organization name', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test', organization: 'Müller & Söhne\nGmbH' });
    for (const ca of [bundle.sshCa!, bundle.sandboxSshCa!]) expect(ca.publicKey).toMatch(/^[\x20-\x7e]+$/);
  });

  it('is added to an older bundle through the CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-sandbox-ca-'));
    const target = join(cwd, '.better-compute', 'pki.json');
    const io: CliIO = { out() {}, err() {}, cwd, env: { BETTER_COMPUTE_SECRET: SECRET } };
    await createCli().run(['pki', 'init', '--trust-domain', 'compute.test'], io);
    // An older bundle: no sandbox CA (made here by dropping it and re-sealing).
    const older = importPkiBundle(await readFile(target, 'utf8'), { secret: SECRET });
    delete older.sandboxSshCa;
    await writeFile(target, exportPkiBundle(older, { secret: SECRET }));
    expect(readPkiPins(await readFile(target, 'utf8')).sandboxSshCaPublicKey).toBeUndefined();

    const out: string[] = [];
    await createCli().run(['pki', 'add-sandbox-ca'], { ...io, out: (line) => out.push(line) });
    const added = JSON.parse(out.join('\n')) as { sandboxSshCaPublicKey: string };
    expect(added.sandboxSshCaPublicKey).toMatch(/^ssh-ed25519 /);
    const pins = readPkiPins(await readFile(target, 'utf8'), { secret: SECRET });
    expect(pins).toMatchObject({ authenticated: true, sandboxSshCaPublicKey: added.sandboxSshCaPublicKey });
    await expect(createCli().run(['pki', 'add-sandbox-ca'], io)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
