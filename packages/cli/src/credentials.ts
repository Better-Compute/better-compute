import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import { importOptional } from './config.js';

// Where token commands get their credential (PLAN.md §9.3): `BETTER_COMPUTE_TOKEN`; else better-iam's saved
// session (`better-iam login`, the optional @better-iam/cli peer's profile store); else compute's own owner-only
// credentials file (`better-compute auth login`). Locations are read only from the given environment, so an
// embedding program (and every test) decides whether a saved credential can be found at all.

/** One saved credential. The file is owner-only; treat it like a password. */
export interface ComputeProfile {
  token: string;
  /** The compute API it is for (`--url`), when saved for a remote deployment. */
  url?: string;
  tenantId?: string;
  /** Epoch ms after which it is not used. */
  expiresAt?: number;
  savedAt: number;
}

interface CredentialsFile {
  version: 1;
  current?: string;
  profiles: Record<string, ComputeProfile>;
}

const profileName = /^[A-Za-z0-9._-]{1,64}$/;

export function assertComputeProfileName(name: string): string {
  if (!profileName.test(name))
    throw new CliError('INVALID_INPUT', 'Profile names are 1 to 64 of A-Z a-z 0-9 . _ -');
  return name;
}

/**
 * `BETTER_COMPUTE_CREDENTIALS`, else `%APPDATA%\better-compute\credentials.json` on Windows, else
 * `$XDG_CONFIG_HOME/better-compute/credentials.json` or `~/.config/better-compute/credentials.json`.
 */
export function computeCredentialsPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env.BETTER_COMPUTE_CREDENTIALS) return env.BETTER_COMPUTE_CREDENTIALS;
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'better-compute', 'credentials.json');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'better-compute', 'credentials.json');
  if (env.HOME) return join(env.HOME, '.config', 'better-compute', 'credentials.json');
  return undefined;
}

/** Reads and writes compute's credentials file; every write replaces it atomically with mode 0600. */
export interface ComputeProfileStore {
  readonly path: string | undefined;
  /** `explicit`, else `BETTER_COMPUTE_PROFILE`, else the file's current profile, else `default`. */
  currentName(explicit?: string): Promise<string>;
  get(name: string): Promise<ComputeProfile | undefined>;
  /** Names and metadata, never tokens. */
  list(): Promise<(Omit<ComputeProfile, 'token'> & { name: string; current: boolean })[]>;
  save(name: string, profile: ComputeProfile, makeCurrent?: boolean): Promise<void>;
  remove(name: string): Promise<boolean>;
}

export function createComputeProfileStore(env: NodeJS.ProcessEnv): ComputeProfileStore {
  const path = computeCredentialsPath(env);
  const read = async (): Promise<CredentialsFile> => {
    if (!path) return { version: 1, profiles: {} };
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<CredentialsFile>;
      if (parsed.version !== 1 || typeof parsed.profiles !== 'object' || parsed.profiles === null)
        throw new Error('unknown format');
      return { version: 1, profiles: { ...parsed.profiles }, ...(parsed.current ? { current: parsed.current } : {}) };
    } catch {
      throw new CliError('INVALID_CONFIG', `${path} is not a better-compute credentials file`);
    }
  };
  const write = async (file: CredentialsFile) => {
    if (!path)
      throw new CliError(
        'MISSING_ENV',
        'No place for saved credentials: set BETTER_COMPUTE_CREDENTIALS, HOME, XDG_CONFIG_HOME or APPDATA',
      );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const store: ComputeProfileStore = {
    path,
    async currentName(explicit) {
      if (explicit) return assertComputeProfileName(explicit);
      if (env.BETTER_COMPUTE_PROFILE) return assertComputeProfileName(env.BETTER_COMPUTE_PROFILE);
      return (await read()).current ?? 'default';
    },
    async get(name) {
      return (await read()).profiles[name];
    },
    async list() {
      const file = await read();
      const current = file.current ?? 'default';
      return Object.entries(file.profiles)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, { token: _token, ...rest }]) => ({ name, current: name === current, ...rest }));
    },
    async save(name, profile, makeCurrent = true) {
      assertComputeProfileName(name);
      const file = await read();
      file.profiles[name] = profile;
      if (makeCurrent) file.current = name;
      await write(file);
    },
    async remove(name) {
      const file = await read();
      if (!file.profiles[name]) return false;
      delete file.profiles[name];
      if (file.current === name) delete file.current;
      await write(file);
      return true;
    },
  };
  return store;
}

/** Where a token came from (never the token itself). */
export type TokenSource =
  | { kind: 'env' }
  | { kind: 'better-iam'; profile: string; path: string }
  | { kind: 'profile'; profile: string; path: string };

interface IamProfiles {
  createProfileStore(env: NodeJS.ProcessEnv): {
    readonly path: string | undefined;
    currentName(explicit?: string): Promise<string>;
    get(name: string): Promise<{ token: string; expiresAt?: number } | undefined>;
  };
}

/**
 * The token for token commands, in PLAN §9.3's order, or undefined when there is none. Expired saved sessions
 * are skipped. `profile` picks a saved profile by name in both stores.
 */
/** Whether a saved compute profile belongs to the deployment a command is about to call. */
function profileFits(profile: ComputeProfile, target: { url?: string }): boolean {
  // Saved in process (through a configuration): never sent to a remote server.
  if (profile.url === undefined) return target.url === undefined;
  if (target.url === undefined) return false;
  try {
    return new URL(profile.url).origin === new URL(target.url).origin;
  } catch {
    return false;
  }
}

export async function resolveToken(
  env: NodeJS.ProcessEnv,
  options: {
    profile?: string;
    now?: number;
    betterIam?: IamProfiles | null;
    /**
     * Where the token will go: `--url` for a remote server, nothing for in process. A saved compute profile is
     * used only for the deployment it was saved for (its URL's origin, or in process), so a token for one
     * deployment is never sent to another.
     */
    target?: { url?: string };
  } = {},
): Promise<{ token: string; source: TokenSource } | undefined> {
  if (env.BETTER_COMPUTE_TOKEN) return { token: env.BETTER_COMPUTE_TOKEN, source: { kind: 'env' } };
  const now = options.now ?? Date.now();
  const live = (saved: { token: string; expiresAt?: number } | undefined) =>
    saved?.token && !(saved.expiresAt !== undefined && saved.expiresAt <= now) ? saved : undefined;
  // better-iam's saved session, when its CLI is installed (an optional peer).
  const iam =
    options.betterIam === undefined
      ? await importOptional<IamProfiles>('@better-iam/cli', 'saved better-iam sessions').catch(
          () => undefined,
        )
      : (options.betterIam ?? undefined);
  if (iam?.createProfileStore) {
    const profiles = iam.createProfileStore(env);
    if (profiles.path) {
      // A broken or foreign better-iam file never blocks compute's own profile.
      const name = await profiles
        .currentName(options.profile ?? env.BETTER_IAM_PROFILE)
        .catch(() => undefined);
      const saved = name ? live(await profiles.get(name).catch(() => undefined)) : undefined;
      if (saved && name)
        return { token: saved.token, source: { kind: 'better-iam', profile: name, path: profiles.path } };
    }
  }
  const own = createComputeProfileStore(env);
  if (!own.path) return undefined;
  const name = await own.currentName(options.profile);
  const saved = live(await own.get(name));
  if (saved && options.target && !profileFits(saved as ComputeProfile, options.target)) return undefined;
  return saved ? { token: saved.token, source: { kind: 'profile', profile: name, path: own.path } } : undefined;
}
