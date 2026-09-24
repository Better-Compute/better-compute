#!/usr/bin/env node
/**
 * The `better-compute` command line (PLAN.md §9.3): deployment jobs (`init`, `migrate`, `doctor`)
 * and any API method as an IAM credential (`api`), in process through `better-compute.config.ts`
 * (or `BETTER_COMPUTE_DATABASE_URL`) or against a running server with `--url`. A port of
 * better-iam's `defineCommand` framework, so project commands and embedding hosts work the same.
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isComputeError } from '@better-compute/core';
import { builtinCommands } from './commands/index.js';
import { CliError, errorCode, usageCodes } from './errors.js';
import {
  createCliProgram,
  manifestOf,
  type Cli,
  type CliIO,
  type CliManifest,
  type CreateCliOptions,
} from './framework.js';

export { builtinCommands } from './commands/index.js';
export { configTemplate } from './commands/setup.js';
export { requestBody } from './commands/api.js';
export { parseSha256Flag } from './commands/daemon.js';
export { defaultPkiPath, loadPkiBundle } from './commands/pki.js';
export {
  bcdServiceUnit,
  checkInstallScriptOptions,
  renderBcdConfig,
  renderInstallScript,
  type BcdArch,
  type InstallScriptOptions,
} from './install-script.js';
export { CliError, errorCode, usageCodes, usageError } from './errors.js';
export {
  commandHelp,
  createCliProgram,
  defineCommand,
  environmentVariables,
  manifestOf,
  type ArgSpec,
  type Cli,
  type CliIO,
  type CliManifest,
  type CommandContext,
  type CommandSpec,
  type CommandTarget,
  type CommonFlags,
  type CreateCliOptions,
  type FlagSpec,
  type FlagSpecs,
  type FlagValues,
} from './framework.js';
export {
  configFileNames,
  configFromEnv,
  createDeployment,
  findConfigFile,
  importOptional,
  loadConfig,
  type AnyCompute,
  type AnyComputeOptions,
  type CliSettings,
  type ConfigExport,
  type ConfigModule,
  type Deployment,
  type ResolvedConfigPath,
} from './config.js';
export { isUnconfiguredIam, unconfiguredIam } from './iam.js';
export {
  defineHost,
  resolveHost,
  type HostConfig,
  type HostContext,
  type HostExport,
  type HostGatewayConfig,
} from './host/config.js';
export {
  checkHostRoutes,
  hostListener,
  toRequest,
  writeResponse,
  type HostListener,
  type HostRoute,
  type HostUpgradeHandler,
} from './host/http.js';
export {
  gatewayIdentity,
  gatewayOptions,
  startGateway,
  type GatewayIdentity,
  type RevocationSetLike,
  type RunningGateway,
} from './host/gateway.js';
export { joinKeysWellKnown } from './host/well-known.js';
export {
  parseRoles,
  runServer,
  type RunServerOptions,
  type RunningServer,
} from './commands/serve.js';
export {
  isPublicRoute,
  listRoutes,
  localTransport,
  parseEndpoint,
  remoteTransport,
  routePath,
  type ApiTransport,
  type RouteEntry,
} from './transport.js';
export { formatResult, selectPath, type OutputFormat } from './output.js';

const version: string = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** The process's own IO: stdout, stderr, standard input and `process.env`. */
export function processIO(): CliIO {
  return {
    out: (message) => console.log(message),
    err: (message) => console.error(message),
    env: process.env,
    cwd: process.cwd(),
    async stdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

const program = createCliProgram(builtinCommands, version, processIO);

/**
 * Creates a `better-compute`-style program from code: the built-in commands plus your own
 * (`defineCommand`), with the same parsing, help, configuration loading and output. Use it to ship
 * a project CLI, or to run commands in tests.
 */
export function createCli(options?: CreateCliOptions): Cli {
  return program(options);
}

const defaultCli = program();

/**
 * Runs one `better-compute` command line (without the program name) and resolves when it finishes;
 * failures reject with a `ComputeError`, `CliError` or `ComputeClientError` whose `code` says what
 * went wrong. This loads trusted application configuration as executable code.
 */
export async function runCli(argv: string[], io?: CliIO): Promise<void> {
  return defaultCli.run(argv, io);
}

/** The machine-readable description of every built-in command (what `better-compute help --json` prints). */
export function cliManifest(): CliManifest {
  return manifestOf(builtinCommands, version);
}

/** Terminal escapes and other control characters, which messages from a remote server may carry. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

/**
 * Runs the CLI like the `better-compute` binary: prints `CODE: message` (and a hint) on stderr on
 * failure and resolves with the exit status, 0 on success, 2 for a usage mistake, 1 otherwise. For
 * wrappers that ship their own binary.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  cli: Cli = defaultCli,
  io: CliIO = processIO(),
): Promise<number> {
  const err = (message: string) => (io.err ? io.err(message) : console.error(message));
  try {
    await cli.run(argv, io);
    return 0;
  } catch (error) {
    const code = errorCode(error);
    const message = printable(error instanceof Error ? error.message : String(error));
    // Compute errors (local or remote), the CLI's own and Node system errors (ENOENT, EEXIST) say
    // what went wrong; anything else may carry driver details such as connection strings, so it
    // stays generic unless BETTER_COMPUTE_DEBUG is set.
    const known =
      code !== undefined &&
      (isComputeError(error) ||
        error instanceof CliError ||
        (error as Error).name === 'ComputeClientError' ||
        /^(E[A-Z]+|ERR_[A-Z_]+)$/.test(code));
    if (known) err(`${printable(code)}: ${message}`);
    else
      err(
        'better-compute command failed. Check the configuration and database connectivity (set BETTER_COMPUTE_DEBUG=1 for details).',
      );
    if (error instanceof CliError && error.hint) err(`Hint: ${error.hint}`);
    if (io.env.BETTER_COMPUTE_DEBUG && error instanceof Error && error.stack) err(error.stack);
    return code !== undefined && usageCodes.has(code) ? 2 : 1;
  }
}

/**
 * What the `better-compute` binary does: runs `main()` on the process arguments, sets the exit
 * status, and fails a command that can never finish instead of exiting 0. For packages that ship
 * the CLI under their own `bin` (the `better-compute` umbrella does).
 */
export function runBinary(argv: string[] = process.argv.slice(2), cli: Cli = defaultCli): void {
  let settled = false;
  // If nothing is left to run while the command is still pending, it can never finish (for
  // example a lock that waits on itself); fail instead of exiting 0 without output.
  process.once('beforeExit', () => {
    if (settled) return;
    console.error('INCOMPLETE: the command stopped before it finished; nothing was reported.');
    process.exitCode = 1;
  });
  main(argv, cli)
    .then((status) => {
      process.exitCode = status;
    })
    .finally(() => {
      settled = true;
    });
}

/** Whether this file is the process's entry point (`node dist/index.js`, the package's bin). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Windows paths compare without case: a shim may spell the drive or directories differently.
  const normal = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return (
      normal(realpathSync(resolve(entry))) === normal(realpathSync(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) runBinary();
