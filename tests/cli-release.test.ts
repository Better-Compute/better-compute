import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `better-compute release keygen|sign|cosign|verify` (PLAN.md §13): the offline release flow end
// to end in a temporary directory.

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line), env, cwd };
  try {
    await createCli().run([...argv, '--format', 'json'], io);
    return { ok: true as const, result: JSON.parse(out.join('\n')), notes: err.join('\n') };
  } catch (error) {
    return {
      ok: false as const,
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
}

describe('release commands', () => {
  it('keygen, sign with a cosigner listed, cosign, and verify with a threshold of two', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'release-'));
    const dist = join(cwd, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'bcd_1.4.0_linux_amd64.tar.gz'), 'amd64 bytes');
    await writeFile(join(dist, 'bcd_1.4.0_linux_arm64.tar.gz'), 'arm64 bytes!');
    await writeFile(join(dist, 'bcd_1.4.0_linux_amd64.tar.gz.sha256'), 'skipped');

    const alice = await run(['release', 'keygen', '--out', 'keys/alice.pem'], cwd);
    const bob = await run(['release', 'keygen', '--out', 'keys/bob.pem'], cwd);
    expect(alice.ok && alice.result.pin).toMatch(/^sha256\//);
    expect(await run(['release', 'keygen', '--out', 'keys/alice.pem'], cwd)).toMatchObject({
      ok: false,
      code: 'FILE_EXISTS',
    });
    const pins = `${alice.ok && alice.result.pin},${bob.ok && bob.result.pin}`;

    const signed = await run(
      [
        'release',
        'sign',
        'dist',
        '--product',
        'bcd',
        '--version',
        '1.4.0',
        '--sequence',
        '14',
        '--key',
        'keys/alice.pem',
        '--cosigners',
        'keys/bob.pem.pub.pem',
      ],
      cwd,
    );
    expect(signed.ok && signed.result.artifacts).toEqual([
      expect.objectContaining({ name: 'bcd_1.4.0_linux_amd64.tar.gz', platform: 'linux-amd64' }),
      expect.objectContaining({ name: 'bcd_1.4.0_linux_arm64.tar.gz', platform: 'linux-arm64' }),
    ]);

    const verify = (extra: string[] = []) =>
      run(['release', 'verify', 'dist/manifest.json', '--dir', 'dist', ...extra], cwd, {
        BCD_RELEASE_PINS: pins,
      });
    expect(await verify(['--threshold', '2'])).toMatchObject({
      ok: false,
      code: 'RELEASE_REJECTED',
    });
    const cosigned = await run(
      ['release', 'cosign', 'dist/manifest.json', '--key', 'keys/bob.pem'],
      cwd,
    );
    expect(cosigned.ok && cosigned.result.signatures).toHaveLength(2);
    const good = await verify(['--threshold', '2', '--min-sequence', '14', '--product', 'bcd']);
    expect(good).toMatchObject({
      ok: true,
      result: { valid: true, sequence: 14, version: '1.4.0' },
    });
    expect(good.ok && good.result.artifactsChecked).toHaveLength(2);

    // Rollback and tampering are refused.
    expect(await verify(['--min-sequence', '15'])).toMatchObject({
      ok: false,
      code: 'RELEASE_REJECTED',
      message: expect.stringContaining('rollback'),
    });
    await writeFile(join(dist, 'bcd_1.4.0_linux_amd64.tar.gz'), 'evil bytes!');
    expect(await verify()).toMatchObject({
      ok: false,
      code: 'RELEASE_REJECTED',
      message: expect.stringContaining('amd64'),
    });

    // A key the manifest does not list cannot cosign.
    await run(['release', 'keygen', '--out', 'keys/carol.pem'], cwd);
    expect(
      await run(['release', 'cosign', 'dist/manifest.json', '--key', 'keys/carol.pem'], cwd),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')).signatures).toHaveLength(
      2,
    );
  });

  it('rejects bad pins as a usage error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'release-'));
    await writeFile(join(cwd, 'manifest.json'), '{}');
    expect(
      await run(['release', 'verify', 'manifest.json', '--pins', 'not-a-pin'], cwd),
    ).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });
});
