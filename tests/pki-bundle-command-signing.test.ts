import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPkiBundle,
  exportPkiBundle,
  importPkiBundle,
  pkiPins,
  readPkiPins,
} from '@better-compute/pki';

// The PKI bundle carries the command-signing root (v0.2 signed intent): created by pki init, sealed
// with the other keys, reloaded as the same authority, pinned by the SHA-256 of its certificate.

const secret = 'x'.repeat(40);

describe('PKI bundle command-signing root', () => {
  const bundle = createPkiBundle({ trustDomain: 'compute.test' });

  it('is created, pinned, sealed and reloaded as the same root', () => {
    expect(bundle.commandSigning).toBeDefined();
    const expected = createHash('sha256').update(bundle.commandSigning!.certificate).digest('hex');
    expect(pkiPins(bundle).commandSigningRootSha256).toBe(expected);

    const text = exportPkiBundle(bundle, { secret });
    expect(text).not.toContain('PRIVATE KEY');
    const pins = readPkiPins(text);
    expect(pins.commandSigningRootSha256).toBe(expected);
    expect(pins.expires.commandSigningRoot).toBeGreaterThan(Date.now());

    const loaded = importPkiBundle(text, { secret });
    expect(Buffer.from(loaded.commandSigning!.certificate)).toEqual(
      Buffer.from(bundle.commandSigning!.certificate),
    );
    // The reloaded root still certifies worker keys.
    const worker = loaded.commandSigning!.issueWorkerKey({ workerId: 'api-1' });
    expect(worker.workerId).toBe('api-1');
    expect(worker.notAfter).toBeGreaterThan(Date.now());
  });

  it('loads bundles made before it existed', () => {
    const stored = JSON.parse(exportPkiBundle(bundle));
    delete stored.commandSigningCertificate;
    delete stored.keys.commandSigning;
    const text = JSON.stringify(stored);
    expect(importPkiBundle(text).commandSigning).toBeUndefined();
    expect(readPkiPins(text)).not.toHaveProperty('commandSigningRootSha256');
  });

  it('refuses a key that does not match the stored certificate', () => {
    const other = createPkiBundle({ trustDomain: 'compute.test' });
    const stored = JSON.parse(exportPkiBundle(bundle));
    stored.keys.commandSigning = JSON.parse(exportPkiBundle(other)).keys.commandSigning;
    expect(() => importPkiBundle(JSON.stringify(stored))).toThrow(/does not match/);
  });
});
