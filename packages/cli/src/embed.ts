import { commandFlags, type ArgSpec, type Cli, type CliIO, type CommandSpec, type FlagSpecs } from './framework.js';

// One binary for IAM and compute (PLAN.md §9.3): `computeCommands(defineCommand)` turns every built-in compute command
// into a spec of the caller's own framework (better-iam's `defineCommand`/`createCli({ commands })` is the port this
// framework mirrors), named `compute-<command>` so nothing collides with better-iam's own `init`, `api` or `serve`.
// Each one declares compute's flags (so help and parsing match), then runs compute's program itself with the flags
// given on the command line: compute reads its environment (BETTER_COMPUTE_*), loads its configuration and prints
// its output exactly as `better-compute` would.

/** The spec shape both frameworks share (better-iam's `CommandSpec` accepts it). */
export interface PortableCommandSpec {
  name: string;
  group?: string;
  summary: string;
  description?: string;
  flags?: FlagSpecs;
  args?: ArgSpec[];
  examples?: string[];
  aliases?: string[];
  target: 'none';
  output?: 'json' | 'text';
  run(context: {
    flags: Record<string, unknown>;
    args: string[];
    explicit: ReadonlySet<string>;
    io: CliIO;
  }): Promise<unknown>;
}

export interface EmbedOptions {
  /** The first word of every command (default `compute`). */
  prefix?: string;
  /**
   * How the prefix and the command's words join (default `-`: better-iam resolves one-word command names, so
   * `better-iam compute-reserve`, `compute-support-bundle`). Use `' '` for a framework that matches several words.
   */
  separator?: '-' | ' ';
  /** Help section (default `Compute`). */
  group?: string;
  /** Command names to leave out, e.g. `['dev', 'serve']` for a CLI that never hosts compute. */
  exclude?: readonly string[];
}

/** The argv that reproduces the flags given on the command line (`explicit`), then the positionals. */
export function argvOf(
  flags: Record<string, unknown>,
  explicit: ReadonlySet<string>,
  args: readonly string[],
  specs: FlagSpecs,
): string[] {
  const argv: string[] = [];
  for (const name of explicit) {
    const spec = specs[name];
    const value = flags[name];
    if (!spec || value === undefined) continue;
    if (spec.type === 'boolean') {
      if (value === true) argv.push(`--${name}`);
    } else argv.push(`--${name}=${String(value)}`);
  }
  // Positionals after `--`, so one that starts with a dash is never read as a flag.
  return args.length ? [...argv, '--', ...args] : argv;
}

/** Embeds `program`'s commands into another framework through its `defineCommand`. */
export function embedCommands<T>(
  define: (spec: PortableCommandSpec) => T,
  program: Pick<Cli, 'commands' | 'run'>,
  options: EmbedOptions = {},
): T[] {
  const prefix = options.prefix ?? 'compute';
  const separator = options.separator ?? '-';
  const nameOf = (name: string) => [prefix, ...name.split(' ')].join(separator);
  const exclude = new Set(options.exclude ?? []);
  return program.commands
    .filter((spec: CommandSpec<any>) => !exclude.has(spec.name))
    .map((spec: CommandSpec<any>) => {
      // Compute's own flags and its target's (--config, --url); the host framework adds its output flags.
      const all = commandFlags(spec);
      const flags: FlagSpecs = Object.fromEntries(
        Object.entries(all).filter(([name]) => name !== 'format' && name !== 'query'),
      );
      return define({
        name: nameOf(spec.name),
        group: options.group ?? 'Compute',
        summary: spec.summary,
        ...(spec.description ? { description: spec.description } : {}),
        ...(Object.keys(flags).length ? { flags } : {}),
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.examples
          ? {
              examples: spec.examples.map((line) =>
                line.startsWith(`better-compute ${spec.name}`)
                  ? `better-iam ${nameOf(spec.name)}${line.slice(`better-compute ${spec.name}`.length)}`
                  : line,
              ),
            }
          : {}),
        target: 'none',
        ...(spec.output ? { output: spec.output } : {}),
        async run(context) {
          const argv = [...spec.name.split(' '), ...argvOf(context.flags, context.explicit, context.args, all)];
          await program.run(argv, context.io);
          return undefined;
        },
      });
    });
}
