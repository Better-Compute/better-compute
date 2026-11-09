import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// Commands that mint a one-time secret and write it to a file (--out, --secret-out) reserve the file
// before they call the API: a path that cannot be written is refused while nothing has been minted or
// rotated yet, and a call that fails leaves no file behind.

const WHK = 'whk_01k5w0000000000000000000bb';
const SITE = 'site_01k5w0000000000000000000cc';

const commands = [
  { name: 'webhooks rotate-secret', argv: ['webhooks', 'rotate-secret', WHK], flag: '--secret-out', path: 'webhooks/rotateSecret', answer: { webhook: { id: WHK }, secret: 'whsec_n3w' }, content: 'whsec_n3w\n' },
  { name: 'webhooks create', argv: ['webhooks', 'create', '--endpoint', 'https://hooks.test/x', '--events', 'node.*'], flag: '--secret-out', path: 'webhooks/create', answer: { webhook: { id: WHK }, secret: 'whsec_n3w' }, content: 'whsec_n3w\n' },
  { name: 'join-tokens create', argv: ['join-tokens', 'create', '--pool', 'h100-eu', '--ttl', '2h'], flag: '--out', path: 'joinTokens/create', answer: { id: 'jt_1', token: 'bcjt_jt_1.s3cr3t' }, content: 'bcjt_jt_1.s3cr3t\n' },
  { name: 'site-tokens create', argv: ['site-tokens', 'create', '--site', SITE, '--ttl', '3600'], flag: '--out', path: 'siteTokens/create', answer: { id: 'jt_2', token: 'bcjt_jt_2.s3cr3t' }, content: 'bcjt_jt_2.s3cr3t\n' },
] as const;

async function run(argv: readonly string[], cwd: string, respond: () => Response) {
  const calls: string[] = [];
  const out: string[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test', '--format', 'json'], {
      out: (line) => out.push(line),
      err() {},
      cwd,
      env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'org_acme' },
      fetch: async (input, init) => {
        calls.push(new URL(new Request(input, init).url).pathname.replace('/api/compute/', ''));
        return respond();
      },
    });
    return { ok: true as const, calls, stdout: out.join('\n') };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code };
  }
}
const ok = (data: unknown) => () => Response.json({ data });
const refused = () => Response.json({ error: { code: 'ACCESS_DENIED', message: 'not allowed' } }, { status: 403 });

describe.each(commands)('$name with its secret file', (command) => {
  it('refuses an existing file before anything is minted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-secret-file-'));
    await writeFile(join(dir, 'taken'), 'the secret in use\n');
    const result = await run([...command.argv, command.flag, 'taken'], dir, ok(command.answer));
    expect(result).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    // The API was never called: nothing was created or rotated that the caller cannot have.
    expect(result.calls).toEqual([]);
    expect(await readFile(join(dir, 'taken'), 'utf8')).toBe('the secret in use\n');
  });

  it('refuses a path it cannot create before anything is minted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-secret-file-'));
    const result = await run([...command.argv, command.flag, join('no-such-directory', 'secret')], dir, ok(command.answer));
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([]);
  });

  it('writes the secret to the reserved file, 0600, and leaves it out of the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-secret-file-'));
    const result = await run([...command.argv, command.flag, 'secret'], dir, ok(command.answer));
    expect(result).toMatchObject({ ok: true, calls: [command.path] });
    expect(result.ok && result.stdout).not.toContain(command.content.trim());
    expect(await readFile(join(dir, 'secret'), 'utf8')).toBe(command.content);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'secret'))).mode & 0o777).toBe(0o600);
  });

  it('leaves no file when the call fails or its answer has no secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-secret-file-'));
    expect(await run([...command.argv, command.flag, 'secret'], dir, refused)).toMatchObject({ ok: false, calls: [command.path] });
    expect(await readdir(dir)).toEqual([]);
    const { secret: _secret, token: _token, ...bare } = command.answer as Record<string, unknown>;
    expect((await run([...command.argv, command.flag, 'secret'], dir, ok(bare))).ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});
