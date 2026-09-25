import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  configFromEnv,
  createDeployment,
  envConfigSource,
  importConfigModule,
  instantiate,
  resolveConfigPath,
  type AnyCompute,
  type ConfigModule,
  type Deployment,
  type ResolvedConfigPath,
} from './config.js';
import { resolveToken } from './credentials.js';
import { CliError, didYouMean, usageError } from './errors.js';
import { formatResult, outputFormats, type OutputFormat } from './output.js';
import { localTransport, remoteTransport, type ApiTransport } from './transport.js';

/** Where the CLI writes and reads. Everything is injectable so programs and tests can run commands. */
export interface CliIO {
  /** Command results (stdout). */
  out(message: string): void;
  /** The environment the command reads (token, configuration, defaults); never `process.env` implicitly. */
  env: NodeJS.ProcessEnv;
  /** Progress, warnings and failures (stderr). Silent when absent. */
  err?(message: string): void;
  /** Reads all of standard input (`--data -`). */
  stdin?(): Promise<string>;
  /** The directory relative paths and configuration discovery start from (default `process.cwd()`). */
  cwd?: string;
  /** The Fetch implementation remote (`--url`) calls use (default `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Ends long-running commands (`serve`, `dev`); default: SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** The interactive terminal `console` and `exec` attach to (default: the process's own). */
  terminal?: CliTerminal;
}

/** A terminal for interactive sessions: keys in, the remote program's output out. */
export interface CliTerminal {
  /** Calls `listener` with the bytes typed (in raw mode every key, Ctrl-C included); returns a function that stops. */
  onInput(listener: (data: Uint8Array) => void): () => void;
  /** Writes the remote program's output: channel 0 is stdout, 1 is stderr. */
  write(data: Uint8Array, channel: number): void;
  /** Rows and columns, when it is a terminal. */
  size?(): { rows: number; cols: number } | undefined;
  /** Calls `listener` when the size changes; returns a function that stops. */
  onResize?(listener: () => void): () => void;
  /** Passes keys through unprocessed; returns a function that restores the previous mode. */
  raw?(): () => void;
}

/** One flag of a command. Keys of a command's `flags` object are the flag names without the leading `--`. */
export interface FlagSpec {
  type: 'string' | 'integer' | 'boolean';
  /** What one line of help says the flag does. */
  description: string;
  /** Placeholder in usage lines (`PATH`, `URL`, `N`); defaults by type. */
  value?: string;
  required?: boolean;
  /** An environment variable read when the flag is not given, for example `BETTER_COMPUTE_URL`. */
  env?: string;
  /** Allowed values of a string flag. */
  choices?: readonly string[];
  /** Bounds of an integer flag. */
  min?: number;
  max?: number;
  /** The default the command applies, shown in help (the command applies it itself). */
  default?: string | number | boolean;
  /** Left out of help (still accepted). */
  hidden?: boolean;
}
export type FlagSpecs = Record<string, FlagSpec>;

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Collects every remaining positional argument. Only the last argument may be variadic. */
  variadic?: boolean;
}

type FlagValue<S extends FlagSpec> = S['type'] extends 'boolean'
  ? boolean
  : S['type'] extends 'integer'
    ? number | undefined
    : string | undefined;
/** The parsed flags a command receives: booleans, numbers (or undefined), and strings (or undefined). */
export type FlagValues<F extends FlagSpecs> = { [K in keyof F]: FlagValue<F[K]> };

/** Flags the CLI adds by command kind: `config` for configuration and token commands, `url` for token commands, plus output flags. */
export interface CommonFlags {
  config?: string;
  url?: string;
  format?: OutputFormat;
  query?: string;
}

/**
 * - `config`: a deployment operation; loads the configuration (`--config`, `BETTER_COMPUTE_CONFIG`,
 *   the nearest `better-compute.config.*`, or `BETTER_COMPUTE_DATABASE_URL`) and uses no credential.
 * - `token`: acts as an IAM credential (`BETTER_COMPUTE_TOKEN`), in process through the
 *   configuration or remotely with `--url`; authorized like any API client.
 * - `none`: needs neither.
 */
export type CommandTarget = 'config' | 'token' | 'none';

export interface CommandContext<F extends FlagSpecs = FlagSpecs> {
  /** The command name as registered. */
  readonly name: string;
  readonly flags: FlagValues<F> & CommonFlags;
  /** Positional arguments. */
  readonly args: string[];
  /** The flags given on the command line itself (not filled from the environment or defaults). */
  readonly explicit: ReadonlySet<string>;
  readonly io: CliIO;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Resolves a path against the working directory. */
  path(value: string): string;
  /** Prints a result with `--format` / `--query` applied. Returning a value from `run` does the same. */
  print(value: unknown): void;
  /** Writes a line to stderr (progress, warnings); silent when the IO has no `err`. */
  note(message: string): void;
  /** Where the configuration comes from, or undefined when none was given or found. */
  configPath(): Promise<ResolvedConfigPath | undefined>;
  /** The configuration module (imported once); empty without a configuration file. */
  configModule(): Promise<ConfigModule>;
  /**
   * The configuration's deployment, or without a file the one `BETTER_COMPUTE_DATABASE_URL`
   * describes; created once, and its database is closed after the command.
   */
  deployment(): Promise<Deployment>;
  /** The deployment's control plane. */
  compute(): Promise<AnyCompute>;
  /** The bearer token commands act as: `BETTER_COMPUTE_TOKEN`. */
  token(): Promise<string>;
  /** Calls API routes as the token (or with no credential when `authenticated` is false). */
  api(options?: { authenticated?: boolean; token?: string }): Promise<ApiTransport>;
  /** The program running the command: its commands (with the configuration's project commands) and version. */
  readonly program: { readonly commands: readonly CommandSpec<any>[]; readonly version: string };
}

export interface CommandSpec<F extends FlagSpecs = FlagSpecs> {
  name: string;
  /** Section in `help`: Setup, API, or your own. */
  group?: string;
  /** One line, starting with a verb. */
  summary: string;
  /** Paragraphs of detail for `help <command>` and the reference documentation. */
  description?: string;
  /** Replaces the generated usage line. */
  usage?: string;
  flags?: F;
  args?: ArgSpec[];
  examples?: string[];
  aliases?: string[];
  target?: CommandTarget;
  /** `text` commands print plain text and take no `--format` / `--query`. */
  output?: 'json' | 'text';
  /** The format used when `--format` is not given (default `json`). */
  defaultFormat?: OutputFormat;
  /** Whether `cli.defaults` from the configuration module apply (imports the module before the command runs). */
  configDefaults?: boolean;
  /**
   * Cross-flag checks after parsing, before the command runs. Throw `usageError(...)`. `explicit`
   * names the flags given on the command line, as opposed to filled from the environment or defaults.
   */
  validate?(
    flags: FlagValues<F> & CommonFlags,
    args: string[],
    explicit: ReadonlySet<string>,
  ): void;
  run(context: CommandContext<F>): Promise<unknown> | unknown;
}

/**
 * Declares a CLI command with typed flags. Export an array of them as `commands` from
 * `better-compute.config.ts` to add project commands (seeding, reports) that get the same flag
 * parsing, help, configuration loading and output formatting as the built-in ones.
 *
 * ```ts
 * export const commands = [
 *   defineCommand({
 *     name: 'seed',
 *     summary: 'Create the demo sites and pools',
 *     target: 'config',
 *     flags: { region: { type: 'string', description: 'Region label', default: 'eu' } },
 *     async run({ compute, flags }) { const instance = await compute(); ... return { created: true }; },
 *   }),
 * ];
 * ```
 */
export function defineCommand<const F extends FlagSpecs = Record<never, FlagSpec>>(
  spec: CommandSpec<F>,
): CommandSpec<F> {
  return spec;
}

/** Flags that choose the deployment; configuration defaults never set them. */
const targetFlags = new Set(['config', 'url']);

const configFlag: FlagSpec = {
  type: 'string',
  value: 'PATH',
  env: 'BETTER_COMPUTE_CONFIG',
  description: 'Configuration module; default: the nearest better-compute.config.{mjs,js,ts,mts}',
};
const urlFlag: FlagSpec = {
  type: 'string',
  value: 'URL',
  env: 'BETTER_COMPUTE_URL',
  description:
    'Call a running compute server (https://host or https://host/api/compute) instead of loading the configuration',
};
const formatFlag: FlagSpec = {
  type: 'string',
  value: 'FORMAT',
  choices: outputFormats,
  description: 'Output as json (indented, default), compact (one line), or table',
};
const queryFlag: FlagSpec = {
  type: 'string',
  value: 'PATH',
  description:
    'Print only part of the result, e.g. protocol.max or findings[].check (strings print raw)',
};

/** Every flag a command accepts: its own, then the ones its target and output add. */
export function commandFlags(spec: CommandSpec<any>): FlagSpecs {
  const flags: FlagSpecs = { ...(spec.flags ?? {}) };
  const target = spec.target ?? 'none';
  if ((target === 'config' || target === 'token') && !flags.config) flags.config = configFlag;
  if (target === 'token') flags.url ??= urlFlag;
  if ((spec.output ?? 'json') === 'json') {
    flags.format ??= formatFlag;
    flags.query ??= queryFlag;
  }
  return flags;
}

const placeholder = (flag: FlagSpec) =>
  flag.value ?? (flag.choices ? flag.choices.join('|') : flag.type === 'integer' ? 'N' : 'VALUE');

/** The usage line: required flags as `--flag VALUE`, optional ones in brackets; output flags are left to help. */
export function usageLine(spec: CommandSpec<any>): string {
  if (spec.usage) return spec.usage;
  const parts = [`better-compute ${spec.name}`];
  const target = spec.target ?? 'none';
  for (const arg of spec.args ?? []) {
    const name = `${arg.name.toUpperCase()}${arg.variadic ? '...' : ''}`;
    parts.push(arg.required ? name : `[${name}]`);
  }
  for (const [name, flag] of Object.entries((spec.flags ?? {}) as FlagSpecs)) {
    if (name === 'config' || flag.hidden) continue;
    const text = flag.type === 'boolean' ? `--${name}` : `--${name} ${placeholder(flag)}`;
    parts.push(flag.required ? text : `[${text}]`);
  }
  if (target === 'config' || target === 'token' || spec.flags?.config)
    parts.push('[--config PATH]');
  if (target === 'token') parts.push('[--url URL]');
  return parts.join(' ');
}

function wrap(text: string, indent = 2, width = 80): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && indent + line.length + 1 + word.length > width) {
        lines.push(' '.repeat(indent) + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(' '.repeat(indent) + line);
    lines.push('');
  }
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function flagLines(spec: CommandSpec<any>): string[] {
  const entries = Object.entries(commandFlags(spec)).filter(([, flag]) => !flag.hidden);
  const labels = entries.map(([name, flag]) =>
    flag.type === 'boolean' ? `--${name}` : `--${name} ${placeholder(flag)}`,
  );
  const width = Math.min(30, Math.max(...labels.map((label) => label.length), 10));
  const lines = entries.flatMap(([, flag], index) => {
    const notes = [
      flag.required ? 'required' : undefined,
      flag.default !== undefined ? `default ${flag.default}` : undefined,
      flag.env ? `env ${flag.env}` : undefined,
    ].filter(Boolean);
    const description = `${flag.description}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    const label = labels[index]!;
    const wrapped = wrap(description, width + 6, 100).map((line) => line.trimStart());
    return label.length > width
      ? [`  ${label}`, ...wrapped.map((line) => `${' '.repeat(width + 6)}${line}`)]
      : [
          `  ${label.padEnd(width)}    ${wrapped[0] ?? ''}`,
          ...wrapped.slice(1).map((line) => `${' '.repeat(width + 6)}${line}`),
        ];
  });
  return [...lines, `  ${'-h, --help'.padEnd(width)}    Show this help`];
}

/** `better-compute help <command>`: usage, description, arguments, flags, and examples. */
export function commandHelp(spec: CommandSpec<any>): string {
  const lines = [
    `better-compute ${spec.name} - ${spec.summary}`,
    '',
    'Usage',
    `  ${usageLine(spec)}`,
  ];
  if (spec.aliases?.length) lines.push('', `Aliases: ${spec.aliases.join(', ')}`);
  if (spec.description) lines.push('', ...wrap(spec.description));
  if (spec.args?.length) {
    lines.push('', 'Arguments');
    const width = Math.max(...spec.args.map((arg) => arg.name.length + 3));
    for (const arg of spec.args)
      lines.push(`  ${arg.name.toUpperCase().padEnd(width)}  ${arg.description}`);
  }
  lines.push('', 'Flags', ...flagLines(spec));
  if (spec.examples?.length)
    lines.push('', 'Examples', ...spec.examples.map((example) => `  $ ${example}`));
  return lines.join('\n');
}

/** Environment variables the CLI reads, for help and the manifest. */
export const environmentVariables: { name: string; description: string }[] = [
  { name: 'BETTER_COMPUTE_CONFIG', description: 'Configuration module, like --config' },
  {
    name: 'BETTER_COMPUTE_TOKEN',
    description: 'IAM session token, API key or session JWT that token commands act as',
  },
  { name: 'BETTER_COMPUTE_URL', description: 'Compute server token commands call, like --url' },
  {
    name: 'BETTER_COMPUTE_DATABASE_URL',
    description:
      'Without a configuration file: the database (postgres://, pglite:DIR, pglite:memory), with BETTER_COMPUTE_SECRET',
  },
  {
    name: 'BETTER_COMPUTE_SECRET',
    description: 'Without a configuration file: the deployment secret (at least 32 characters)',
  },
  {
    name: 'BETTER_COMPUTE_BASE_URL',
    description: 'Without a configuration file: the public origin (default http://localhost:3000)',
  },
  { name: 'BETTER_COMPUTE_DEBUG', description: 'Print the stack trace of a failure' },
];

/** A machine-readable description of every command: what `better-compute help --json` prints and the docs are built from. */
export interface CliManifest {
  name: 'better-compute';
  version: string;
  commands: {
    name: string;
    aliases: string[];
    group: string;
    summary: string;
    description: string;
    usage: string;
    target: CommandTarget;
    args: ArgSpec[];
    flags: {
      flag: string;
      value?: string;
      optional: boolean;
      description: string;
      env?: string;
      default?: string | number | boolean;
      choices?: readonly string[];
    }[];
    examples: string[];
  }[];
  env: { name: string; description: string }[];
}

export function manifestOf(commands: readonly CommandSpec<any>[], version: string): CliManifest {
  return {
    name: 'better-compute',
    version,
    commands: commands.map((spec) => ({
      name: spec.name,
      aliases: spec.aliases ?? [],
      group: spec.group ?? 'Commands',
      summary: spec.summary,
      description: spec.description ?? spec.summary,
      usage: usageLine(spec),
      target: spec.target ?? 'none',
      args: spec.args ?? [],
      flags: Object.entries(commandFlags(spec))
        .filter(([, flag]) => !flag.hidden)
        .map(([name, flag]) => ({
          flag: `--${name}`,
          ...(flag.type === 'boolean' ? {} : { value: placeholder(flag) }),
          optional: !flag.required,
          description: flag.description,
          ...(flag.env ? { env: flag.env } : {}),
          ...(flag.default !== undefined ? { default: flag.default } : {}),
          ...(flag.choices ? { choices: flag.choices } : {}),
        })),
      examples: spec.examples ?? [],
    })),
    env: environmentVariables,
  };
}

const groupOrder = ['Setup', 'API'];

/** `better-compute help`: every command by section, every usage line, the details, and the environment. */
export function overviewHelp(commands: readonly CommandSpec<any>[], version: string): string {
  const groups = new Map<string, CommandSpec<any>[]>();
  for (const spec of commands) {
    const group = spec.group ?? 'Commands';
    groups.set(group, [...(groups.get(group) ?? []), spec]);
  }
  const ordered = [...groups.keys()].sort(
    (a, b) =>
      (groupOrder.indexOf(a) + 1 || 99) - (groupOrder.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  const width = Math.max(0, ...commands.map((spec) => spec.name.length)) + 2;
  const lines = [
    `better-compute ${version}`,
    '',
    'Usage',
    '  better-compute <command> [flags]',
    '  better-compute help <command>      flags, details, and examples for one command',
    '  better-compute help --json         every command as JSON, for tools',
    '',
  ];
  for (const group of ordered) {
    lines.push(group);
    for (const spec of groups.get(group)!)
      lines.push(`  ${spec.name.padEnd(width)}${spec.summary}`);
    lines.push('');
  }
  lines.push('Commands', ...commands.map((spec) => `  ${usageLine(spec)}`), '');
  lines.push(
    ...wrap(
      'Configuration commands load better-compute.config.ts (or --config, BETTER_COMPUTE_CONFIG, the nearest better-compute.config.{mjs,js,ts,mts} in a parent directory, or BETTER_COMPUTE_DATABASE_URL + BETTER_COMPUTE_SECRET without a file). Token commands act as BETTER_COMPUTE_TOKEN, in process through the configuration or against --url, and are authorized like any API client. Secrets are never accepted in command-line arguments. Every flag also accepts --flag=value; results print as JSON unless --format says otherwise.',
    ),
    '',
  );
  for (const spec of commands) if (spec.description) lines.push(...wrap(spec.description), '');
  lines.push('Environment');
  const envWidth = Math.max(...environmentVariables.map((entry) => entry.name.length)) + 2;
  for (const entry of environmentVariables)
    lines.push(`  ${entry.name.padEnd(envWidth)}${entry.description}`);
  return lines.join('\n');
}

interface Parsed {
  values: Map<string, string | boolean>;
  args: string[];
  help: boolean;
}

/** Parses `--flag value`, `--flag=value`, boolean `--flag`, `--` and positionals for one command. */
export function parseArguments(spec: CommandSpec<any>, argv: string[]): Parsed {
  const flags = commandFlags(spec);
  const values = new Map<string, string | boolean>();
  const args: string[] = [];
  let help = false;
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (positionalOnly) {
      args.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const inline = equals === -1 ? undefined : token.slice(equals + 1);
      const flag = Object.hasOwn(flags, name) ? flags[name] : undefined;
      if (!flag)
        throw usageError(
          `${spec.name} does not take --${name}.${didYouMean(name, Object.keys(flags), '--')}`,
          `Run better-compute help ${spec.name} for its flags.`,
        );
      if (values.has(name)) throw usageError(`--${name} was given more than once`);
      if (flag.type === 'boolean') {
        if (inline === undefined) values.set(name, true);
        else if (inline === 'true' || inline === 'false') values.set(name, inline === 'true');
        else throw usageError(`--${name} is a switch; use --${name} or --${name}=false`);
        continue;
      }
      const value = inline ?? argv[++index];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--')))
        throw usageError(`--${name} needs a value (${placeholder(flag)})`);
      values.set(name, value);
      continue;
    }
    if (token.startsWith('-') && token !== '-' && !spec.args?.length)
      throw usageError(
        `${spec.name} does not take ${token}`,
        `Run better-compute help ${spec.name}.`,
      );
    args.push(token);
  }
  const specs = spec.args ?? [];
  if (!specs.length && args.length)
    throw usageError(
      `${spec.name} takes no arguments (got ${args[0]})`,
      `Flags start with --; run better-compute help ${spec.name}.`,
    );
  if (!specs.at(-1)?.variadic && args.length > specs.length)
    throw usageError(`${spec.name} takes at most ${specs.length} argument(s)`);
  return { values, args, help };
}

/** Checks and converts one raw flag value (from argv, the environment, or configuration defaults). */
function convert(
  name: string,
  flag: FlagSpec,
  raw: string | boolean | number,
  source: string,
): string | number | boolean {
  const label = source === 'flag' ? `--${name}` : `${source} (for --${name})`;
  if (flag.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (['true', '1', 'yes'].includes(String(raw).toLowerCase())) return true;
    if (['false', '0', 'no', ''].includes(String(raw).toLowerCase())) return false;
    throw usageError(`${label} must be true or false`);
  }
  if (flag.type === 'integer') {
    const text = String(raw);
    const number = Number(text);
    const min = flag.min ?? Number.MIN_SAFE_INTEGER;
    const max = flag.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
      throw usageError(
        flag.min !== undefined || flag.max !== undefined
          ? `${label} must be an integer between ${min} and ${max}`
          : `${label} must be an integer`,
      );
    return number;
  }
  const text = String(raw);
  if (!text) throw usageError(`${label} needs a value`);
  if (flag.choices && !flag.choices.includes(text))
    throw usageError(`${label} must be ${flag.choices.join(', ')}`);
  return text;
}

export interface CreateCliOptions {
  /** Commands in addition to (or, with `builtins: false`, instead of) the built-in ones. */
  commands?: readonly CommandSpec<any>[];
  /** Keep the built-in commands (default true). */
  builtins?: boolean;
  version?: string;
}

/** A command-line program: the built-in commands plus yours, runnable from code with any IO. */
export interface Cli {
  readonly commands: readonly CommandSpec<any>[];
  run(argv: string[], io?: CliIO): Promise<void>;
  help(command?: string): string;
  manifest(): CliManifest;
}

/** Commands a configuration module exports (`export const commands = [...]`). */
async function configCommands(argv: string[], io: CliIO, cwd: string): Promise<CommandSpec<any>[]> {
  let flag: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--config') flag = argv[index + 1];
    else if (token.startsWith('--config=')) flag = token.slice('--config='.length);
  }
  const located = await resolveConfigPath(flag, io.env, cwd);
  if (!located) return [];
  const module = await importConfigModule(located.path);
  return Array.isArray(module.commands) ? [...module.commands] : [];
}

/**
 * Builds a program factory around a set of built-in commands: `createCli()` is this with
 * better-compute's own commands, and a host can make one binary of its own commands the same way.
 */
export function createCliProgram(
  builtins: readonly CommandSpec<any>[],
  version: string,
  defaultIO: () => CliIO,
): (options?: CreateCliOptions) => Cli {
  return (options = {}) => {
    const commands = [...(options.builtins === false ? [] : builtins), ...(options.commands ?? [])];
    const cliVersion = options.version ?? version;
    const find = (list: readonly CommandSpec<any>[], name: string) =>
      list.find((spec) => spec.name === name || spec.aliases?.includes(name));
    const unknown = (name: string, list: readonly CommandSpec<any>[], hint?: string) =>
      new CliError(
        'INVALID_COMMAND',
        `Unknown command: ${name}.${didYouMean(
          name,
          list.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
        )}`,
        hint,
      );
    const cli: Cli = {
      commands,
      help: (name) => {
        if (!name) return overviewHelp(commands, cliVersion);
        const spec = find(commands, name);
        if (!spec) throw unknown(name, commands);
        return commandHelp(spec);
      },
      manifest: () => manifestOf(commands, cliVersion),
      async run(argv, io = defaultIO()) {
        const cwd = io.cwd ?? process.cwd();
        const name = argv[0] ?? 'help';
        if (['help', '--help', '-h'].includes(name)) {
          const rest = argv.slice(1);
          const json = rest.includes('--json');
          const words = rest.filter(
            (item, index) => !item.startsWith('-') && rest[index - 1] !== '--config',
          );
          // `help pki init` names the two-word command.
          const topic =
            words.length > 1 && find(commands, `${words[0]} ${words[1]}`)
              ? `${words[0]} ${words[1]}`
              : words[0];
          let all = commands;
          // Project commands from the configuration module appear in help when a configuration is found.
          try {
            all = [
              ...commands,
              ...(await configCommands(rest, io, cwd)).filter((spec) => !find(commands, spec.name)),
            ];
          } catch {
            /* Help never fails because a configuration does not load. */
          }
          if (json)
            io.out(
              JSON.stringify(
                manifestOf(topic ? all.filter((spec) => spec.name === topic) : all, cliVersion),
                null,
                2,
              ),
            );
          else if (topic) {
            const spec = find(all, topic);
            const subcommands = all.filter((command) => command.name.startsWith(`${topic} `));
            if (spec) io.out(commandHelp(spec));
            else if (subcommands.length) io.out(overviewHelp(subcommands, cliVersion));
            else throw unknown(topic, all);
          } else io.out(overviewHelp(all, cliVersion));
          return;
        }
        if (['--version', '-v'].includes(name)) {
          io.out(cliVersion);
          return;
        }
        let spec = find(commands, name);
        let extra: CommandSpec<any>[] | undefined;
        let rest = argv.slice(1);
        // Two-word commands (`pki init`, `daemon install-script`): the pair wins over a one-word name.
        const second = argv[1];
        const pair =
          second && !second.startsWith('-') ? find(commands, `${name} ${second}`) : undefined;
        if (pair) {
          spec = pair;
          rest = argv.slice(2);
        } else if (!spec && commands.some((command) => command.name.startsWith(`${name} `)))
          throw new CliError(
            'INVALID_COMMAND',
            `${name} needs a subcommand: ${commands
              .filter((command) => command.name.startsWith(`${name} `))
              .map((command) => command.name.slice(name.length + 1))
              .join(', ')}`,
            `Run better-compute help ${name} <subcommand>.`,
          );
        // An unknown name may be a project command: a configuration that fails to load reports its
        // own error then, instead of "unknown command".
        if (!spec && !name.startsWith('-')) {
          extra = await configCommands(rest, io, cwd);
          spec = find(extra, name);
          // A project command found through --config accepts that flag even when it loads no configuration.
          if (spec && !commandFlags(spec).config)
            rest = rest.filter(
              (token, index) =>
                token !== '--config' &&
                rest[index - 1] !== '--config' &&
                !token.startsWith('--config='),
            );
        }
        if (!spec)
          throw unknown(
            name,
            [...commands, ...(extra ?? [])],
            'Run better-compute help for the list of commands.',
          );
        const all = [...commands, ...(extra ?? []).filter((item) => !find(commands, item.name))];
        await execute(spec, rest, io, cwd, { commands: all, version: cliVersion });
      },
    };
    return cli;
  };
}

async function execute(
  spec: CommandSpec<any>,
  argv: string[],
  io: CliIO,
  cwd: string,
  program: CommandContext['program'],
): Promise<void> {
  const parsed = parseArguments(spec, argv);
  if (parsed.help) {
    io.out(commandHelp(spec));
    return;
  }
  const flags = commandFlags(spec);
  const target = spec.target ?? 'none';
  // Null prototype: a project flag named `constructor` or `toString` must not look already set.
  const values: Record<string, unknown> = Object.create(null);
  const has = (name: string) => Object.hasOwn(values, name);
  const explicit = new Set(parsed.values.keys());
  for (const [name, raw] of parsed.values) values[name] = convert(name, flags[name]!, raw, 'flag');
  for (const [name, flag] of Object.entries(flags))
    if (!has(name) && flag.env && io.env[flag.env])
      values[name] = convert(name, flag, io.env[flag.env]!, flag.env);
  // One deployment per command: the command line beats the environment, and naming both at one level is ambiguous.
  if (target === 'token') {
    if (explicit.has('url') && explicit.has('config'))
      throw usageError('Give --url or --config, not both');
    if (explicit.has('config')) delete values.url;
    else if (explicit.has('url')) delete values.config;
    else if (has('url') && has('config'))
      throw usageError(
        'BETTER_COMPUTE_URL and BETTER_COMPUTE_CONFIG are both set',
        'Pass --url or --config to choose one.',
      );
  }
  let located: ResolvedConfigPath | undefined | null = null;
  // The flag itself, else resolution reads BETTER_COMPUTE_CONFIG (so `source` says which).
  const configPath = async () =>
    located !== null
      ? located
      : (located = await resolveConfigPath(
          explicit.has('config') ? (values.config as string) : undefined,
          io.env,
          cwd,
        ));
  let moduleCache: Promise<ConfigModule> | undefined;
  const configModule = () =>
    (moduleCache ??= (async (): Promise<ConfigModule> => {
      const where = await configPath();
      return where ? importConfigModule(where.path) : {};
    })());
  // Configuration defaults (`export const cli = { defaults }`) fill flags nobody set; they need the module imported.
  // The flags that choose the deployment cannot come from that deployment's own configuration.
  if (target !== 'none' && spec.configDefaults !== false && !(target === 'token' && has('url'))) {
    const where = await configPath();
    const missing = Object.keys(flags).filter((name) => !has(name));
    // A missing file is reported by the command when it loads the configuration, after flag checks.
    const present = where
      ? await access(where.path).then(
          () => true,
          () => false,
        )
      : false;
    if (where && present && missing.length) {
      const defaults = (await configModule()).cli?.defaults ?? {};
      for (const scope of [spec.name, '*'])
        for (const [name, raw] of Object.entries(defaults[scope] ?? {}))
          if (Object.hasOwn(flags, name) && !has(name) && !targetFlags.has(name))
            values[name] = convert(name, flags[name]!, raw, `cli.defaults['${scope}']`);
    }
  }
  for (const [name, flag] of Object.entries(flags))
    if (flag.required && values[name] === undefined)
      throw usageError(`--${name} ${placeholder(flag)} is required`);
  for (const [name, flag] of Object.entries(flags))
    if (flag.type === 'boolean' && values[name] === undefined) values[name] = false;
  const args = parsed.args;
  for (const [index, arg] of (spec.args ?? []).entries())
    if (arg.required && args[index] === undefined)
      throw usageError(
        `${spec.name} needs ${arg.name.toUpperCase()}`,
        `Run better-compute help ${spec.name}.`,
      );
  spec.validate?.(values as never, args, explicit);

  const opened: Deployment[] = [];
  let deploymentCache: Promise<Deployment> | undefined;
  const deployment = () =>
    (deploymentCache ??= (async () => {
      const where = await configPath();
      let created: Deployment;
      if (where)
        created = await instantiate(await configModule(), where.path, {
          command: spec.name,
          env: io.env,
          cwd,
        });
      else if (io.env.BETTER_COMPUTE_DATABASE_URL)
        created = createDeployment(await configFromEnv(io.env, cwd), envConfigSource);
      else
        throw new CliError(
          'CONFIG_NOT_FOUND',
          `No better-compute.config.{mjs,js,ts,mts} in ${cwd} or its parents`,
          target === 'token'
            ? 'Pass --config PATH or --url URL, run better-compute init, or set BETTER_COMPUTE_DATABASE_URL and BETTER_COMPUTE_SECRET.'
            : 'Run better-compute init, pass --config PATH, or set BETTER_COMPUTE_DATABASE_URL and BETTER_COMPUTE_SECRET.',
        );
      opened.push(created);
      return created;
    })());
  const token = async () => {
    // BETTER_COMPUTE_TOKEN, else better-iam's saved session, else `better-compute auth login`'s (§9.3).
    // A saved compute profile only goes to the deployment it was saved for (--url origin, or in process).
    const found = await resolveToken(io.env, {
      target: has('url') ? { url: values.url as string } : {},
    });
    if (found) return found.token;
    throw new CliError(
      'MISSING_ENV',
      'Set BETTER_COMPUTE_TOKEN to an IAM session token, API key or session JWT (or sign in: better-iam login, better-compute auth login)',
      'Public methods such as system.version need no token.',
    );
  };
  const context: CommandContext<FlagSpecs> = {
    name: spec.name,
    flags: values as never,
    args,
    explicit,
    io,
    env: io.env,
    cwd,
    program,
    path: (value) => resolve(cwd, value),
    print: (value) =>
      io.out(
        formatResult(
          value,
          (values.format as OutputFormat | undefined) ?? spec.defaultFormat,
          values.query as string | undefined,
        ),
      ),
    note: (message) => io.err?.(message),
    configPath,
    configModule,
    deployment,
    compute: async () => (await deployment()).compute,
    token,
    async api(options = {}) {
      const bearer = options.token ?? (options.authenticated === false ? undefined : await token());
      if (has('url')) return remoteTransport(values.url as string, bearer, io.fetch);
      const { compute, source } = await deployment();
      return localTransport(compute, source, bearer);
    },
  };
  try {
    const result = await spec.run(context);
    if (result !== undefined) context.print(result);
  } finally {
    // What the command did (or why it failed) is the outcome; a failing close does not replace it.
    for (const created of opened.reverse()) await created.close().catch(() => undefined);
  }
}
