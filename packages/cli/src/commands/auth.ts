import {
  assertComputeProfileName,
  createComputeProfileStore,
  resolveToken,
} from '../credentials.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';

// Saved credentials for token commands (PLAN.md §9.3): `auth login` checks a token with system.whoami and keeps it
// in compute's owner-only credentials file; `auth status` says which credential commands would use (never the
// token); `auth logout` forgets a profile. Tokens are read from standard input or BETTER_COMPUTE_TOKEN, never from
// the command line, where other users and shell history could see them.

const profileFlag = {
  type: 'string',
  value: 'NAME',
  env: 'BETTER_COMPUTE_PROFILE',
  description: 'The saved profile (default: the current one, else default)',
} as const;

export const authCommands = [
  defineCommand({
    name: 'auth login',
    group: 'Access',
    summary: 'Save a token for later commands (checked with system.whoami)',
    description:
      "auth login reads an IAM session token, API key or session JWT from standard input (or BETTER_COMPUTE_TOKEN), checks it with system.whoami against the deployment (--url, or the configuration in process; --no-verify skips the check), and saves it under --profile in better-compute's credentials file (BETTER_COMPUTE_CREDENTIALS, else %APPDATA%\\better-compute or ~/.config/better-compute), written owner-only. Token commands then use it when BETTER_COMPUTE_TOKEN is unset and no better-iam session is saved. A session that better-iam's own CLI saved (better-iam login) is used without this step.",
    target: 'token',
    output: 'json',
    flags: {
      profile: profileFlag,
      'no-verify': { type: 'boolean', description: 'Save without calling system.whoami' },
    },
    examples: [
      'better-compute auth login --url https://compute.example.com < token.txt',
      'BETTER_COMPUTE_TOKEN=biam_key_… better-compute auth login --profile ci --no-verify',
    ],
    async run({ flags, io, env, api }) {
      const token = (env.BETTER_COMPUTE_TOKEN ?? (io.stdin ? await io.stdin() : '')).trim();
      if (!token)
        throw usageError(
          'auth login reads the token from standard input or BETTER_COMPUTE_TOKEN',
          'Pipe it in: … | better-compute auth login',
        );
      if (/\s/.test(token)) throw usageError('The token must be a single line without spaces');
      let whoami: { tenantId?: string; identityId?: string } | undefined;
      if (!flags['no-verify']) {
        whoami = await (await api({ token })).call('system/whoami', {});
        if (!whoami?.identityId)
          throw new CliError('UNAUTHENTICATED', 'The deployment does not accept this token');
      }
      const store = createComputeProfileStore(env);
      const name = await store.currentName(flags.profile);
      await store.save(name, {
        token,
        ...(flags.url ? { url: flags.url } : {}),
        ...(whoami?.tenantId ? { tenantId: whoami.tenantId } : {}),
        savedAt: Date.now(),
      });
      return {
        profile: name,
        path: store.path,
        verified: whoami !== undefined,
        ...(whoami?.tenantId ? { tenantId: whoami.tenantId } : {}),
        ...(whoami?.identityId ? { identityId: whoami.identityId } : {}),
      };
    },
  }),
  defineCommand({
    name: 'auth status',
    group: 'Access',
    summary: 'Show which credential token commands use (never the token)',
    description:
      "auth status says where token commands get their credential, in PLAN §9.3's order: BETTER_COMPUTE_TOKEN, else better-iam's saved session (better-iam login, when @better-iam/cli is installed), else better-compute's saved profile. It lists the saved profiles without their tokens.",
    output: 'json',
    flags: { profile: profileFlag },
    examples: ['better-compute auth status'],
    async run({ flags, env }) {
      const found = await resolveToken(env, flags.profile ? { profile: flags.profile } : {});
      const store = createComputeProfileStore(env);
      return {
        using: found?.source ?? null,
        credentials: store.path ?? null,
        profiles: await store.list(),
      };
    },
  }),
  defineCommand({
    name: 'auth logout',
    group: 'Access',
    summary: "Forget a saved profile's token",
    description:
      'auth logout removes a profile from better-compute\'s credentials file (the current one by default). It does not revoke the session in better-iam: run better-iam logout for that.',
    output: 'json',
    flags: { profile: profileFlag },
    examples: ['better-compute auth logout', 'better-compute auth logout --profile ci'],
    async run({ flags, env }) {
      const store = createComputeProfileStore(env);
      const name = flags.profile ? assertComputeProfileName(flags.profile) : await store.currentName();
      return { profile: name, removed: await store.remove(name) };
    },
  }),
];
