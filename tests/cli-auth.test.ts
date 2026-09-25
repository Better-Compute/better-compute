import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCredentialsPath,
  createCli,
  createComputeProfileStore,
  resolveToken,
  type CliIO,
} from '@better-compute/cli';

// Where token commands get their credential (PLAN.md §9.3): BETTER_COMPUTE_TOKEN, else better-iam's saved session,
// else compute's own owner-only credentials file, managed with `auth login|status|logout`.

const T = Date.UTC(2026, 8, 24, 12);
const noIam = { betterIam: null } as const;

function iamProfiles(profiles: Record<string, { token: string; expiresAt?: number }>, current = 'default') {
  return {
    createProfileStore: () => ({
      path: '/iam/credentials.json',
      currentName: async (explicit?: string) => explicit ?? current,
      get: async (name: string) => profiles[name],
    }),
  };
}

describe('credentials', () => {
  it('locates the file from the environment only', () => {
    expect(computeCredentialsPath({})).toBeUndefined();
    expect(computeCredentialsPath({ BETTER_COMPUTE_CREDENTIALS: '/x/c.json', HOME: '/h' })).toBe('/x/c.json');
    expect(computeCredentialsPath({ APPDATA: 'C:\\A' }, 'win32')).toBe(join('C:\\A', 'better-compute', 'credentials.json'));
    expect(computeCredentialsPath({ XDG_CONFIG_HOME: '/cfg', HOME: '/h' }, 'linux')).toBe(
      join('/cfg', 'better-compute', 'credentials.json'),
    );
    expect(computeCredentialsPath({ HOME: '/h' }, 'linux')).toBe(join('/h', '.config', 'better-compute', 'credentials.json'));
  });

  it('resolves BETTER_COMPUTE_TOKEN, then a live better-iam session, then its own profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-auth-'));
    const env = { BETTER_COMPUTE_CREDENTIALS: join(dir, 'credentials.json') };
    const store = createComputeProfileStore(env);
    await store.save('default', { token: 'biam_ses_own', savedAt: T });

    expect(await resolveToken({ ...env, BETTER_COMPUTE_TOKEN: 'biam_env' }, noIam)).toEqual({
      token: 'biam_env',
      source: { kind: 'env' },
    });
    const iam = iamProfiles({ default: { token: 'biam_ses_iam' } });
    expect(await resolveToken(env, { betterIam: iam })).toMatchObject({
      token: 'biam_ses_iam',
      source: { kind: 'better-iam', profile: 'default' },
    });
    // An expired better-iam session falls through to compute's own profile.
    const expired = iamProfiles({ default: { token: 'biam_old', expiresAt: T - 1 } });
    expect(await resolveToken(env, { betterIam: expired, now: T })).toMatchObject({
      token: 'biam_ses_own',
      source: { kind: 'profile', profile: 'default' },
    });
    expect(await resolveToken(env, noIam)).toMatchObject({ token: 'biam_ses_own' });
    // A named profile, and nothing at all.
    await store.save('ci', { token: 'biam_key_ci', savedAt: T, expiresAt: T + 1000 }, false);
    expect((await resolveToken({ ...env, BETTER_COMPUTE_PROFILE: 'ci' }, { ...noIam, now: T }))?.token).toBe('biam_key_ci');
    expect((await resolveToken({ ...env, BETTER_COMPUTE_PROFILE: 'ci' }, { ...noIam, now: T + 1000 }))?.token).toBeUndefined();
    expect(await resolveToken({}, noIam)).toBeUndefined();

    // Listing never shows tokens; the file is owner-only.
    const listed = await store.list();
    expect(listed.map((profile) => profile.name)).toEqual(['ci', 'default']);
    expect(JSON.stringify(listed)).not.toContain('biam_');
    if (process.platform !== 'win32') expect((await stat(env.BETTER_COMPUTE_CREDENTIALS)).mode & 0o077).toBe(0);
    expect(await store.remove('default')).toBe(true);
    expect(await store.remove('default')).toBe(false);
  });

  it('sends a saved compute profile only to the deployment it was saved for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-auth-'));
    const env = { BETTER_COMPUTE_CREDENTIALS: join(dir, 'credentials.json') };
    const store = createComputeProfileStore(env);
    await store.save('prod', { token: 'biam_ses_prod', url: 'https://compute.example.com', savedAt: T });
    await store.save('local', { token: 'biam_ses_local', savedAt: T }, false);
    const as = (profile: string, target: { url?: string }) =>
      resolveToken({ ...env, BETTER_COMPUTE_PROFILE: profile }, { ...noIam, target });
    expect((await as('prod', { url: 'https://compute.example.com/api/compute' }))?.token).toBe('biam_ses_prod');
    // Another origin (a repo's env file, a CI variable) or in process: not this token.
    expect(await as('prod', { url: 'https://compute.attacker.example' })).toBeUndefined();
    expect(await as('prod', { url: 'http://compute.example.com' })).toBeUndefined();
    expect(await as('prod', {})).toBeUndefined();
    // Saved in process: never sent to a remote server.
    expect((await as('local', {}))?.token).toBe('biam_ses_local');
    expect(await as('local', { url: 'https://compute.example.com' })).toBeUndefined();
  });

  it('refuses a file that is not a credentials file, and bad profile names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-auth-'));
    const path = join(dir, 'credentials.json');
    await writeFile(path, '{"something":"else"}');
    await expect(createComputeProfileStore({ BETTER_COMPUTE_CREDENTIALS: path }).get('default')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      createComputeProfileStore({ BETTER_COMPUTE_CREDENTIALS: join(dir, 'other.json') }).save('../x', {
        token: 't',
        savedAt: T,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('auth commands', () => {
  it('saves a token from standard input, reports its source without it, and forgets it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-auth-cmd-'));
    const credentials = join(dir, 'credentials.json');
    const out: string[] = [];
    const io = (env: Record<string, string>, stdin?: string): CliIO => ({
      out: (line) => out.push(line),
      err() {},
      cwd: dir,
      env: { BETTER_COMPUTE_CREDENTIALS: credentials, ...env },
      ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
    });
    const last = () => JSON.parse(out.splice(0).join('\n'));

    await createCli().run(['auth', 'login', '--no-verify', '--profile', 'ci'], io({}, 'biam_key_saved\n'));
    expect(last()).toMatchObject({ profile: 'ci', path: credentials, verified: false });
    expect(JSON.parse(await readFile(credentials, 'utf8')).profiles.ci.token).toBe('biam_key_saved');

    await createCli().run(['auth', 'status'], io({}));
    const status = last();
    expect(status.using).toMatchObject({ kind: 'profile', profile: 'ci' });
    expect(JSON.stringify(status)).not.toContain('biam_key_saved');

    // Checked against the deployment: the unconfigured IAM accepts no token, so nothing is saved.
    await expect(
      createCli().run(
        ['auth', 'login', '--profile', 'other'],
        io({ BETTER_COMPUTE_DATABASE_URL: 'pglite:memory', BETTER_COMPUTE_SECRET: 'auth-test-secret-0123456789abcdefghij' }, 'biam_ses_nope'),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_TOKEN|UNAUTHENTICATED/) });
    expect(JSON.parse(await readFile(credentials, 'utf8')).profiles.other).toBeUndefined();

    await expect(createCli().run(['auth', 'login', '--no-verify'], io({}, ''))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await createCli().run(['auth', 'logout', '--profile', 'ci'], io({}));
    expect(last()).toEqual({ profile: 'ci', removed: true });
  });
});
