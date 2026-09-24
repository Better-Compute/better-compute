import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import {
  CliError,
  cliManifest,
  configFileNames,
  createCli,
  defineCommand,
  formatResult,
  main,
  parseEndpoint,
  requestBody,
  routePath,
  selectPath,
  usageError,
  type Cli,
  type CliIO,
} from '@better-compute/cli';

// The command-line framework ported from better-iam (PLAN.md §9.3, docs/research/iam-conventions.md
// §7): parsing, help and the JSON manifest, exit codes 0/2/1, `CODE: message` + `Hint:` on stderr,
// control characters stripped, BETTER_COMPUTE_DEBUG stacks, output formats, request bodies,
// routes, and configuration discovery with project commands and flag defaults.

const packageVersion: string = JSON.parse(
  await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
).version;

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bc-cli-framework-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  options: { cli?: Cli; env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {},
): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (message) => out.push(message),
    err: (message) => err.push(message),
    env: { ...options.env },
    cwd: options.cwd ?? scratch,
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
  };
  const status = await main(argv, options.cli ?? createCli(), io);
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** A program of one test command that echoes what it received. */
const echo = defineCommand({
  name: 'echo',
  group: 'Test',
  summary: 'Echo the parsed flags and arguments',
  args: [{ name: 'items', description: 'Anything', variadic: true }],
  flags: {
    name: { type: 'string', description: 'A name', env: 'ECHO_NAME' },
    count: { type: 'integer', description: 'How many', min: 1, max: 5 },
    loud: { type: 'boolean', description: 'Shout' },
    color: { type: 'string', description: 'A color', choices: ['red', 'blue'] },
  },
  run: ({ flags, args, explicit }) => ({
    name: flags.name ?? null,
    count: flags.count ?? null,
    loud: flags.loud,
    color: flags.color ?? null,
    args,
    explicit: [...explicit].sort(),
  }),
});
const strict = defineCommand({
  name: 'strict',
  summary: 'Take one required flag and no arguments',
  flags: { id: { type: 'string', description: 'An id', required: true } },
  run: ({ flags }) => ({ id: flags.id }),
});
const failing = defineCommand({
  name: 'fail',
  summary: 'Throw what --kind says',
  output: 'text',
  flags: { kind: { type: 'string', description: 'What to throw', required: true } },
  run({ flags }) {
    if (flags.kind === 'compute')
      throw new ComputeError('CONFLICT', 'Pool changed\u001b[31m meanwhile\r\nreally');
    if (flags.kind === 'cli') throw new CliError('MISSING_ENV', 'Set X', 'Export X first.');
    if (flags.kind === 'usage') throw usageError('Bad combination', 'Pick one.');
    if (flags.kind === 'system')
      throw Object.assign(new Error('ENOENT: no such file, open x.json'), { code: 'ENOENT' });
    throw new Error('connect to postgres://admin:hunter2@db-7.internal failed');
  },
});
const testCli = createCli({ builtins: false, commands: [echo, strict, failing] });

describe('help and the manifest', () => {
  it('lists every built-in command by group, with usage lines and the environment', async () => {
    const { status, stdout } = await run(['help']);
    expect(status).toBe(0);
    expect(stdout).toContain(`better-compute ${packageVersion}`);
    expect(stdout).toMatch(/^Setup$/m);
    expect(stdout).toMatch(/^API$/m);
    for (const name of ['init', 'migrate', 'doctor', 'version', 'api'])
      expect(stdout).toMatch(new RegExp(`^  ${name} `, 'm'));
    expect(stdout).toContain('better-compute api GROUP.METHOD');
    expect(stdout).toContain('BETTER_COMPUTE_DATABASE_URL');
    expect(stdout).toContain('BETTER_COMPUTE_DEBUG');
    // Profiles and login arrive in v0.1 and are not advertised before.
    expect(stdout).not.toMatch(/login|--profile/);
    expect((await run([])).stdout).toBe(stdout);
    expect((await run(['--help'])).stdout).toBe(stdout);
  });

  it('shows one command with its usage, flags, environment and examples', async () => {
    const { status, stdout } = await run(['help', 'doctor']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^better-compute doctor - /);
    expect(stdout).toContain('better-compute doctor [--strict] [--pki PATH] [--config PATH]');
    expect(stdout).toMatch(/--config PATH\s+Configuration module/);
    expect(stdout).toContain('env BETTER_COMPUTE_CONFIG');
    expect(stdout).toContain('--format FORMAT');
    expect(stdout).toContain('Examples');
    expect((await run(['doctor', '--help'])).stdout).toBe(stdout);
    expect((await run(['help', 'api'])).stdout).toMatch(/--url URL\s+Call a running compute/);
  });

  it('prints every command as JSON with help --json', async () => {
    const { status, stdout } = await run(['help', '--json']);
    expect(status).toBe(0);
    const manifest = JSON.parse(stdout);
    expect(manifest).toEqual(cliManifest());
    expect(manifest.name).toBe('better-compute');
    expect(manifest.version).toBe(packageVersion);
    expect(manifest.commands.map((command: { name: string }) => command.name)).toEqual([
      'init',
      'migrate',
      'doctor',
      'version',
      'api',
      'reserve',
      'release',
      'extend',
      'reservations list',
      'reservations get',
      'pools list',
      'capacity',
      'fleet export',
      'fleet plan',
      'fleet status',
      'fleet apply',
      'pki init',
      'pki show',
      'pki issue-gateway',
      'daemon install-script',
      'iam setup',
      'audit checkpoint',
      'audit verify',
      'audit prove',
      'audit check-proof',
    ]);
    const api = manifest.commands.find((command: { name: string }) => command.name === 'api');
    expect(api.target).toBe('token');
    expect(api.flags.map((flag: { flag: string }) => flag.flag)).toEqual([
      '--data',
      '--list',
      '--config',
      '--url',
      '--format',
      '--query',
    ]);
    expect(api.flags.find((flag: { flag: string }) => flag.flag === '--url')).toMatchObject({
      value: 'URL',
      optional: true,
      env: 'BETTER_COMPUTE_URL',
    });
    expect(manifest.env.map((entry: { name: string }) => entry.name)).toContain(
      'BETTER_COMPUTE_TOKEN',
    );
    const one = JSON.parse((await run(['help', 'migrate', '--json'])).stdout);
    expect(one.commands.map((command: { name: string }) => command.name)).toEqual(['migrate']);
  });

  it('prints the version three ways', async () => {
    for (const argv of [['version'], ['--version'], ['-v']]) {
      const { status, stdout } = await run(argv);
      expect(status).toBe(0);
      expect(stdout).toBe(packageVersion);
    }
  });

  it('suggests close command names and exits 2 for unknown ones', async () => {
    const unknown = await run(['migrat']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain(
      'INVALID_COMMAND: Unknown command: migrat. Did you mean migrate?',
    );
    expect(unknown.stderr).toContain('Hint: Run better-compute help for the list of commands.');
    const help = await run(['help', 'doctr']);
    expect(help.status).toBe(2);
    expect(help.stderr).toContain('Did you mean doctor?');
  });
});

describe('flag parsing', () => {
  it('parses strings, integers, switches, choices, --flag=value and positionals', async () => {
    const { status, stdout } = await run(
      ['echo', 'a', '--name', 'gpu', '--count=3', '--loud', '--color', 'blue', 'b', '--', '--x'],
      { cli: testCli },
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      name: 'gpu',
      count: 3,
      loud: true,
      color: 'blue',
      args: ['a', 'b', '--x'],
      explicit: ['color', 'count', 'loud', 'name'],
    });
  });

  it('fills flags from their environment variable, below the command line', async () => {
    const fromEnv = await run(['echo'], { cli: testCli, env: { ECHO_NAME: 'env' } });
    expect(JSON.parse(fromEnv.stdout)).toMatchObject({ name: 'env', loud: false, explicit: [] });
    const flag = await run(['echo', '--name', 'flag'], { cli: testCli, env: { ECHO_NAME: 'env' } });
    expect(JSON.parse(flag.stdout).name).toBe('flag');
  });

  it.each([
    [['echo', '--nam', 'x'], 'echo does not take --nam. Did you mean --name?'],
    [['echo', '--count', 'many'], '--count must be an integer between 1 and 5'],
    [['echo', '--count', '9'], '--count must be an integer between 1 and 5'],
    [['echo', '--color', 'green'], '--color must be red, blue'],
    [['echo', '--loud=maybe'], '--loud is a switch'],
    [['echo', '--name'], '--name needs a value'],
    [['echo', '--name', '--loud'], '--name needs a value'],
    [['echo', '--name', 'a', '--name', 'b'], '--name was given more than once'],
    [['strict'], '--id VALUE is required'],
    [['strict', '--id', 'x', 'extra'], 'strict takes no arguments (got extra)'],
    [['strict', '-x'], 'strict does not take -x'],
    [['echo', '--format', 'xml'], '--format must be json, compact, table'],
  ])('refuses %j as a usage error (exit 2)', async (argv, message) => {
    const { status, stderr, stdout } = await run(argv, { cli: testCli });
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(`INVALID_ARGUMENT: ${message}`);
  });
});

describe('failures on stderr', () => {
  it('prints CODE: message with control characters stripped, and exits 1', async () => {
    const { status, stderr } = await run(['fail', '--kind', 'compute'], { cli: testCli });
    expect(status).toBe(1);
    expect(stderr).toBe('CONFLICT: Pool changed [31m meanwhile really');
    expect(stderr).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('prints the hint of a CLI error on its own line', async () => {
    const { status, stderr } = await run(['fail', '--kind', 'cli'], { cli: testCli });
    expect(status).toBe(1);
    expect(stderr.split('\n')).toEqual(['MISSING_ENV: Set X', 'Hint: Export X first.']);
    const usage = await run(['fail', '--kind', 'usage'], { cli: testCli });
    expect(usage.status).toBe(2);
    expect(usage.stderr.split('\n')).toEqual([
      'INVALID_ARGUMENT: Bad combination',
      'Hint: Pick one.',
    ]);
  });

  it('shows Node system errors by code', async () => {
    const { status, stderr } = await run(['fail', '--kind', 'system'], { cli: testCli });
    expect(status).toBe(1);
    expect(stderr).toBe('ENOENT: ENOENT: no such file, open x.json');
  });

  it('keeps unknown errors generic unless BETTER_COMPUTE_DEBUG is set', async () => {
    const quiet = await run(['fail', '--kind', 'other'], { cli: testCli });
    expect(quiet.status).toBe(1);
    expect(quiet.stderr).toBe(
      'better-compute command failed. Check the configuration and database connectivity (set BETTER_COMPUTE_DEBUG=1 for details).',
    );
    expect(quiet.stderr).not.toContain('hunter2');
    const debug = await run(['fail', '--kind', 'other'], {
      cli: testCli,
      env: { BETTER_COMPUTE_DEBUG: '1' },
    });
    expect(debug.status).toBe(1);
    expect(debug.stderr).toContain('Error: connect to postgres://');
    expect(debug.stderr).toMatch(/\n\s+at /);
  });
});

describe('output', () => {
  const report = {
    ok: false,
    findings: [
      { check: 'migrations', severity: 'error' },
      { check: 'clock', severity: 'info' },
    ],
  };

  it('formats results as indented JSON, one line, or a table', () => {
    expect(formatResult(report)).toBe(JSON.stringify(report, null, 2));
    expect(formatResult(report, 'compact')).toBe(JSON.stringify(report));
    expect(formatResult(report, 'table').split('\n')).toEqual([
      'CHECK       SEVERITY',
      'migrations  error',
      'clock       info',
    ]);
    expect(formatResult({ name: 'better-compute', protocol: { max: 1 } }, 'table')).toBe(
      'name      better-compute\nprotocol  {"max":1}',
    );
    expect(formatResult([], 'table')).toBe('(no rows)');
    expect(formatResult(undefined)).toBe('null');
  });

  it('selects paths with --query; strings print raw', () => {
    expect(selectPath(report, 'findings[].check')).toEqual(['migrations', 'clock']);
    expect(selectPath(report, 'findings.1.check')).toBe('clock');
    expect(selectPath(report, 'findings[0].severity')).toBe('error');
    expect(selectPath(report, 'findings.length')).toBe(2);
    expect(selectPath(report, 'missing.key')).toBeNull();
    expect(formatResult(report, 'json', 'findings.0.check')).toBe('migrations');
    expect(() => selectPath(report, '__proto__.x')).toThrow(/not a usable path/);
    expect(() => selectPath(report, 'a[b]')).toThrow(/not a path/);
  });

  it('applies --format and --query to command results', async () => {
    const compact = await run(['echo', '--format', 'compact', '--name', 'x'], { cli: testCli });
    expect(compact.stdout).toBe(
      '{"name":"x","count":null,"loud":false,"color":null,"args":[],"explicit":["format","name"]}',
    );
    const query = await run(['echo', 'a', 'b', '--query', 'args[1]'], { cli: testCli });
    expect(query.stdout).toBe('b');
    const bad = await run(['echo', '--query', 'constructor'], { cli: testCli });
    expect(bad.status).toBe(2);
  });
});

describe('request bodies', () => {
  const context = (stdin?: string) => ({
    io: {
      out() {},
      env: {},
      ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
    } as CliIO,
    path: (value: string) => join(scratch, value),
  });

  it('builds bodies from key=value items, like HTTPie', async () => {
    await writeFile(join(scratch, 'spec.json'), '{"gpus":4}');
    await writeFile(join(scratch, 'notes.md'), '# Notes\n');
    const body = await requestBody(context(), undefined, [
      'name=gpu-a',
      'limit:=10',
      'labels:=["a","b"]',
      'spec:=@spec.json',
      'notes=@notes.md',
      'resource.type=pool',
      'resource.id=pool_1',
      'ids[]=a',
      'ids[]=b',
      'empty=',
      'at=@',
    ]);
    expect(body).toEqual({
      name: 'gpu-a',
      limit: 10,
      labels: ['a', 'b'],
      spec: { gpus: 4 },
      notes: '# Notes\n',
      resource: { type: 'pool', id: 'pool_1' },
      ids: ['a', 'b'],
      empty: '',
      at: '@',
    });
  });

  it('starts from --data (JSON, @file or standard input) and lets items override it', async () => {
    await writeFile(join(scratch, 'body.json'), '{"tenantId":"t1","nodeId":"n1"}');
    expect(await requestBody(context(), '{"a":1}', ['b:=2'])).toEqual({ a: 1, b: 2 });
    expect(await requestBody(context(), '@body.json', ['nodeId=n2'])).toEqual({
      tenantId: 't1',
      nodeId: 'n2',
    });
    expect(await requestBody(context('{"from":"stdin"}'), '-', [])).toEqual({ from: 'stdin' });
    // Prototype keys never survive, wherever they come from.
    const polluted = await requestBody(context(), '{"__proto__":{"admin":true},"ok":1}', []);
    expect(polluted).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
  });

  it.each([
    [undefined, ['novalue'], 'novalue is not key=value or key:=json'],
    [undefined, ['n:=nope'], 'n:= is not valid JSON'],
    [undefined, ['__proto__.admin=1'], '__proto__.admin is not a usable field name'],
    [undefined, ['a=1', 'a.b=2'], 'a is already set to a non-object value'],
    [undefined, ['a=1', 'a[]=2'], 'a is already set to a non-list value'],
    [undefined, ['a[].b=1'], 'a[].b: [] may only end a field name'],
    ['[1,2]', [], '--data must be a JSON object'],
    ['{nope', [], '--data is not valid JSON'],
    ['-', [], '--data - needs standard input'],
  ])('refuses --data %j with %j', async (data, items, message) => {
    await expect(requestBody(context(), data, items)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message,
    });
  });
});

describe('routes and endpoints', () => {
  it('accepts group.method and plugin routes in dotted or slashed form', () => {
    expect(routePath('system.version')).toBe('system/version');
    expect(routePath('system/version')).toBe('system/version');
    expect(routePath('plugins.acme.widgets.poke')).toBe('plugins/acme/widgets/poke');
    expect(routePath('plugins/acme/widgets/poke')).toBe('plugins/acme/widgets/poke');
    expect(() => routePath('system')).toThrow(/names no method/);
    expect(() => routePath('a.b.c')).toThrow(/plugins\.ID\.group\.method/);
    expect(() => routePath('plugins.acme.widgets')).toThrow(/not an API route/);
    expect(() => routePath('system.$version')).toThrow(/not an API route/);
    expect(() => routePath('../system/version')).toThrow(/not an API route/);
  });

  it('parses --url with the default base path and requires https off localhost', () => {
    expect(parseEndpoint('https://compute.example.com')).toEqual({
      origin: 'https://compute.example.com',
      basePath: '/api/compute',
      url: 'https://compute.example.com/api/compute',
    });
    expect(parseEndpoint('https://example.com/custom/compute/').basePath).toBe('/custom/compute');
    expect(parseEndpoint('http://localhost:3000').url).toBe('http://localhost:3000/api/compute');
    expect(parseEndpoint('http://127.0.0.1:8080').origin).toBe('http://127.0.0.1:8080');
    expect(parseEndpoint('http://api.localhost').origin).toBe('http://api.localhost');
    expect(() => parseEndpoint('http://compute.example.com')).toThrow(/must use https/);
    expect(() => parseEndpoint('https://user:pw@compute.example.com')).toThrow(
      /without credentials/,
    );
    expect(() => parseEndpoint('https://compute.example.com/?x=1')).toThrow(/without credentials/);
    expect(() => parseEndpoint('ftp://compute.example.com')).toThrow(/http\(s\)/);
    expect(() => parseEndpoint('compute.example.com')).toThrow(/absolute/);
    expect(() => parseEndpoint('https://example.com/api.v1')).toThrow(/not a base path/);
  });
});

describe('configuration discovery', () => {
  /** A configuration module whose project command reports the config it was loaded from. */
  const configModule = (label: string) => `
export default () => { throw new Error('the deployment is not needed'); };
export const commands = [
  {
    name: 'hello',
    group: 'Project',
    summary: 'Say hello from ${label}',
    target: 'config',
    flags: {
      who: { type: 'string', description: 'Who to greet' },
      times: { type: 'integer', description: 'How often', min: 1 },
    },
    run: ({ flags, configPath }) =>
      configPath().then((where) => ({ from: '${label}', source: where.source, who: flags.who ?? 'world', times: flags.times ?? 1 })),
  },
];
export const cli = { defaults: { hello: { who: 'defaults' }, '*': { times: 2, url: 'https://ignored.example' } } };
`;

  let project: string;
  let nested: string;
  beforeAll(async () => {
    project = join(scratch, 'project');
    nested = join(project, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(join(project, 'better-compute.config.mjs'), configModule('discovered'));
    await writeFile(join(scratch, 'other.config.mjs'), configModule('other'));
  });

  it('looks for the four configuration names in order', () => {
    expect(configFileNames).toEqual([
      'better-compute.config.mjs',
      'better-compute.config.js',
      'better-compute.config.ts',
      'better-compute.config.mts',
    ]);
  });

  it('finds the nearest configuration in a parent directory and runs its project commands', async () => {
    const { status, stdout } = await run(['hello'], { cwd: nested });
    expect(status).toBe(0);
    // cli.defaults fill flags nobody set: per command first, then '*'.
    expect(JSON.parse(stdout)).toEqual({
      from: 'discovered',
      source: 'discovered',
      who: 'defaults',
      times: 2,
    });
    const flagged = await run(['hello', '--who', 'flag', '--times', '5'], { cwd: nested });
    expect(JSON.parse(flagged.stdout)).toMatchObject({ who: 'flag', times: 5 });
  });

  it('prefers --config over BETTER_COMPUTE_CONFIG over discovery', async () => {
    const env = { BETTER_COMPUTE_CONFIG: join(scratch, 'other.config.mjs') };
    const fromEnv = await run(['hello'], { cwd: nested, env });
    expect(JSON.parse(fromEnv.stdout)).toMatchObject({ from: 'other', source: 'env' });
    const fromFlag = await run(['hello', '--config', join(project, 'better-compute.config.mjs')], {
      cwd: nested,
      env,
    });
    expect(JSON.parse(fromFlag.stdout)).toMatchObject({ from: 'discovered', source: 'flag' });
  });

  it('lists project commands in help and the manifest', async () => {
    const { stdout } = await run(['help'], { cwd: nested });
    expect(stdout).toMatch(/^Project$/m);
    expect(stdout).toMatch(/^ {2}hello\s+Say hello from discovered$/m);
    const manifest = JSON.parse((await run(['help', '--json'], { cwd: nested })).stdout);
    expect(manifest.commands.map((command: { name: string }) => command.name)).toContain('hello');
    // A configuration that fails to load never breaks help.
    await writeFile(join(scratch, 'broken.config.mjs'), 'throw new Error("broken");');
    const broken = await run(['help'], {
      cwd: nested,
      env: { BETTER_COMPUTE_CONFIG: join(scratch, 'broken.config.mjs') },
    });
    expect(broken.status).toBe(0);
    expect(broken.stdout).not.toContain('hello');
  });

  it('reports a missing configuration with what to do next', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'bc-cli-empty-'));
    try {
      const { status, stderr } = await run(['migrate'], { cwd: empty });
      expect(status).toBe(1);
      expect(stderr).toContain('CONFIG_NOT_FOUND: No better-compute.config.{mjs,js,ts,mts} in');
      expect(stderr).toContain(
        'Hint: Run better-compute init, pass --config PATH, or set BETTER_COMPUTE_DATABASE_URL and BETTER_COMPUTE_SECRET.',
      );
      const named = await run(['migrate', '--config', 'nowhere.config.mjs'], { cwd: empty });
      expect(named.status).toBe(1);
      expect(named.stderr).toContain('CONFIG_NOT_FOUND: Configuration');
      expect(named.stderr).toContain('nowhere.config.mjs does not exist');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('refuses a configuration without a default export', async () => {
    await writeFile(join(scratch, 'nodefault.config.mjs'), 'export const cli = {};');
    const { status, stderr } = await run([
      'migrate',
      '--config',
      join(scratch, 'nodefault.config.mjs'),
    ]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/^INVALID_CONFIG: .*must export default defineConfig/);
  });

  it('takes one deployment per token command: --url or --config, not both', async () => {
    const both = await run([
      'api',
      'system.version',
      '--url',
      'https://a.example',
      '--config',
      'x',
    ]);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('Give --url or --config, not both');
    const envBoth = await run(['api', 'system.version'], {
      env: { BETTER_COMPUTE_URL: 'https://a.example', BETTER_COMPUTE_CONFIG: 'x.mjs' },
    });
    expect(envBoth.status).toBe(2);
    expect(envBoth.stderr).toContain('BETTER_COMPUTE_URL and BETTER_COMPUTE_CONFIG are both set');
  });
});
