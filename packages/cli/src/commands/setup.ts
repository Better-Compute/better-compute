import { access, writeFile } from 'node:fs/promises';
import type { Finding } from '@better-compute/core';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { resolveHost } from '../host/config.js';
import { hostFindings } from '../host/findings.js';
import { isUnconfiguredIam } from '../iam.js';
import { defaultPkiPath, pkiFindings, quorumFindings, pkiFlag } from './pki.js';

/**
 * The starter configuration `init` writes: a side-effect-free factory with PGlite in development,
 * PostgreSQL when `BETTER_COMPUTE_DATABASE_URL` is set, where better-iam plugs in (v0.1), and a slot
 * for project commands. The TypeScript and JavaScript forms differ only in the one type annotation.
 */
export function configTemplate(typescript: boolean): string {
  return `// better-compute deployment configuration, read by the better-compute CLI and by your server:
//   import config from './better-compute.config${typescript ? '' : '.mjs'}';
//   const compute = betterCompute(await configOptions(config));   // both from 'better-compute/server'
import { unconfiguredIam${typescript ? ', type CommandSpec' : ''} } from 'better-compute/cli';
import { pglite } from 'better-compute/pglite';
import { postgres } from 'better-compute/postgres';
import { defineConfig } from 'better-compute/server';

// A factory keeps importing this file free of side effects: nothing connects until the CLI (or your
// server) calls it with { command, env, cwd }.
export default defineConfig(({ env = process.env, cwd = process.cwd() } = {}) => ({
  // PostgreSQL 16+ in production (PgBouncer in transaction mode is fine). In development, PGlite
  // (PostgreSQL in WebAssembly; install @electric-sql/pglite) keeps its files in one directory.
  database: env.BETTER_COMPUTE_DATABASE_URL
    ? postgres({ url: env.BETTER_COMPUTE_DATABASE_URL })
    : pglite({ dataDir: \`\${cwd}/.better-compute-pglite\` }),
  // At least 32 random characters, the same for every process of the deployment.
  secret: env.BETTER_COMPUTE_SECRET ?? '',
  baseURL: env.BETTER_COMPUTE_BASE_URL ?? 'http://localhost:3000',
  // better-iam authenticates every caller and decides every call. Its bridge arrives in v0.1:
  //   const bridge = createComputeIamBridge();                        // better-compute/iam
  //   const iam = betterIam({ database: sqliteAdapter({ filename: './better-iam.db' }), secret,
  //     baseURL, plugins: [bridge.plugin({ inbox: bridge.localInbox() })],
  //     resolveResource: bridge.resolveResource() });                 // better-iam/server
  //   ...then here: rootTenantId, iam: bridge.embedded(iam, { rootTenantId }),
  // Until then no credential authenticates, so only public methods (system.version) answer.
  rootTenantId: 'root',
  iam: unconfiguredIam(),
  // Injected modules as they land, e.g. modules: [metal(), vps()] from better-compute/metal and /vps.
}));

// Project commands: \`better-compute <name>\` runs them with the same flag parsing, help and output
// as the built-in ones (defineCommand from better-compute/cli).
export const commands${typescript ? ': CommandSpec<any>[]' : ''} = [];
`;
}

/** What doctor adds to `selfCheck()` when the deployment has no IAM yet. */
const noIamFinding: Finding = {
  check: 'iam.not-configured',
  severity: 'warning',
  message:
    'No IAM is configured: no credential authenticates, so every method except the public ones (system.version, system.whoami) is refused',
  fix: 'Embedded better-iam plugs in through the IAM bridge (v0.1): iam: bridge.embedded(iam, { rootTenantId })',
};

export const setupCommands = [
  defineCommand({
    name: 'init',
    group: 'Setup',
    summary: 'Write a starter configuration file',
    description:
      'init writes a starter better-compute.config.ts (or the JavaScript form when --config names a .mjs or .js file): a configuration factory that uses PGlite in a local .better-compute-pglite directory for development and PostgreSQL when BETTER_COMPUTE_DATABASE_URL is set, reads the secret and base URL from the environment, shows where better-iam plugs in, and exports an empty list of project commands. It never overwrites an existing file.',
    usage: 'better-compute init [--config better-compute.config.ts]',
    output: 'text',
    flags: {
      config: {
        type: 'string',
        value: 'PATH',
        default: 'better-compute.config.ts',
        description: 'Where to write the configuration (.ts, .mts, .js or .mjs)',
      },
    },
    examples: ['better-compute init', 'better-compute init --config better-compute.config.mjs'],
    async run({ flags, path }) {
      const target = path(flags.config ?? 'better-compute.config.ts');
      if (!/\.m?[jt]s$/i.test(target))
        throw usageError(`--config ${flags.config} must end in .ts, .mts, .js or .mjs`);
      try {
        await access(target);
        throw new CliError('CONFIG_EXISTS', `${target} already exists; it was not overwritten`);
      } catch (error) {
        if (error instanceof CliError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(target, configTemplate(/\.m?ts$/i.test(target)), { flag: 'wx' });
      return `Created ${target}. Set BETTER_COMPUTE_SECRET to at least 32 random characters, then run better-compute migrate. PGlite keeps its files in .better-compute-pglite/; add it to .gitignore.`;
    },
  }),
  defineCommand({
    name: 'migrate',
    group: 'Setup',
    summary: 'Create or upgrade the database schema and apply module migrations',
    description:
      "migrate runs compute.initialize(): it checks every method's IAM action against the merged catalog and the normative method table (INVALID_CONFIG on a mismatch), then creates or upgrades the compute schema and applies every module's and plugin's migrations. Run it on every deploy before the application starts; it is idempotent.",
    target: 'config',
    output: 'text',
    examples: [
      'better-compute migrate',
      'BETTER_COMPUTE_DATABASE_URL=pglite:./data better-compute migrate',
    ],
    async run({ compute }) {
      await (await compute()).initialize();
      return 'Compute schema and module migrations applied.';
    },
  }),
  defineCommand({
    name: 'doctor',
    group: 'Setup',
    summary: 'Check the database, schema, clock, method registry and IAM wiring',
    description:
      "doctor runs compute.selfCheck() (applied migrations, btree_gist, compute_now() against the database clock, the method → action registry, and each module's own checks) and adds the CLI's findings, such as a deployment with no IAM configured, the PKI bundle, and the configuration's host export (whether the gateway role can authenticate daemons by node certificate, reach the api's pokes, tunnels and revocations, and whether host routes fit beside the API). It only reads. --strict exits non-zero (DOCTOR_FINDINGS) when any error or warning is found.",
    target: 'config',
    flags: {
      strict: { type: 'boolean', description: 'Exit non-zero when any error or warning is found' },
      pki: pkiFlag,
    },
    examples: [
      'better-compute doctor',
      'better-compute doctor --strict --query "findings[].check"',
    ],
    async run({ deployment, configModule, flags, print, path, env, cwd }) {
      const { compute, options, source } = await deployment();
      const check = await compute.selfCheck();
      const findings = [...check.findings];
      if (isUnconfiguredIam(options.iam)) findings.push(noIamFinding);
      findings.push(...(await pkiFindings(path(flags.pki ?? defaultPkiPath), env, undefined, compute.context.sql)));
      findings.push(...(await quorumFindings(compute.context.sql, options)));
      const host = await resolveHost((await configModule()).host, { compute, options, env, cwd });
      findings.push(...hostFindings(compute, options, host));
      print({
        node: process.versions.node,
        config: source,
        database: options.database.kind,
        ok: check.ok,
        findings,
      });
      const serious = findings.filter((finding) => finding.severity !== 'info');
      if (flags.strict && serious.length)
        throw new CliError(
          'DOCTOR_FINDINGS',
          `${serious.length} finding(s): ${serious.map((finding) => finding.check).join(', ')}`,
        );
    },
  }),
  defineCommand({
    name: 'version',
    group: 'Setup',
    summary: 'Print the better-compute version',
    description: 'version prints the version of this command line (also --version or -v).',
    output: 'text',
    run: ({ program }) => program.version,
  }),
];
