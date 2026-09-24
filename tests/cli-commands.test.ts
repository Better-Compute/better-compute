import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiMethod, type SqlExecutor } from '@better-compute/core';
import {
  configTemplate,
  createCli,
  isUnconfiguredIam,
  loadConfig,
  main,
  unconfiguredIam,
  type CliIO,
} from '@better-compute/cli';
import { PROTOCOL_VERSION } from '@better-compute/protocol';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, serverVersion } from '@better-compute/server';
import { fakeIam, tokenOf } from './support/fake-iam.js';
import { ACME, BASE_URL, ROOT, acme, options } from './support/server.js';

// The P0 commands (PLAN.md §9.3) run in process: environment-only PGlite deployments (migrate,
// doctor, api), the init template, a configuration file with an IAM port and a plugin, the remote
// transport (--url), usage errors (exit 2) and a missing optional peer (MISSING_DEPENDENCY).

const SECRET = 'better-compute-cli-tests-secret-0123456789';
const ROOT_ADMIN = 'token-root-admin-0123456789';
const ACME_USER = 'token-acme-user-0123456789';
const OUTSIDER = 'token-other-user-0123456789';
const memoryEnv = { BETTER_COMPUTE_DATABASE_URL: 'pglite:memory', BETTER_COMPUTE_SECRET: SECRET };

const serverInfo = {
  name: 'better-compute',
  version: serverVersion,
  basePath: '/api/compute',
  protocol: { min: PROTOCOL_VERSION.min, max: PROTOCOL_VERSION.max },
};

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bc-cli-commands-'));
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
  options: { env?: NodeJS.ProcessEnv; cwd?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (message) => out.push(message),
    err: (message) => err.push(message),
    env: { ...options.env },
    cwd: options.cwd ?? scratch,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const status = await main(argv, createCli(), io);
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** Runs a command that must succeed and returns its parsed JSON output. */
async function json(argv: string[], options: Parameters<typeof run>[1] = {}): Promise<any> {
  const outcome = await run(argv, options);
  expect(outcome.stderr).toBe('');
  expect(outcome.status).toBe(0);
  return JSON.parse(outcome.stdout);
}

async function freshDir(name: string): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

const noIamFinding = {
  check: 'iam.not-configured',
  severity: 'warning',
  message: expect.stringContaining('No IAM is configured'),
  fix: expect.stringContaining('bridge.embedded(iam'),
};

describe('environment-only deployments on PGlite', () => {
  it('answers api system.version in process through the HTTP handler', async () => {
    expect(await json(['api', 'system.version'], { env: memoryEnv })).toEqual(serverInfo);
    expect(await json(['api', 'system/version', '--data', '{}'], { env: memoryEnv })).toEqual(
      serverInfo,
    );
    const table = await run(['api', 'system.version', '--format', 'table'], { env: memoryEnv });
    expect(table.stdout).toMatch(/^name\s+better-compute$/m);
    const query = await run(['api', 'system.version', '--query', 'protocol.max'], {
      env: memoryEnv,
    });
    expect(query.stdout).toBe(String(PROTOCOL_VERSION.max));
  });

  it('answers system.whoami anonymously; the unconfigured IAM refuses every token', async () => {
    expect(await json(['api', 'system.whoami'], { env: memoryEnv })).toEqual({
      authenticated: false,
    });
    const withToken = await run(['api', 'system.whoami'], {
      env: { ...memoryEnv, BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij' },
    });
    expect(withToken.status).toBe(1);
    expect(withToken.stderr).toBe(
      'UNAUTHENTICATED: No IAM is configured, so no credential can be verified',
    );
  });

  it('asks for BETTER_COMPUTE_TOKEN before calling a method that needs one', async () => {
    const missing = await run(['api', 'system.selfCheck'], { env: memoryEnv });
    expect(missing.status).toBe(1);
    expect(missing.stderr.split('\n')).toEqual([
      'MISSING_ENV: Set BETTER_COMPUTE_TOKEN to an IAM session token, API key or session JWT',
      'Hint: Public methods such as system.version need no token.',
    ]);
    const refused = await run(['api', 'system.selfCheck'], {
      env: { ...memoryEnv, BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij' },
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^UNAUTHENTICATED: /);
    // Unknown routes reach the handler, which answers NOT_FOUND; no token is asked for.
    const unknown = await run(['api', 'system.nope'], { env: memoryEnv });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toBe('NOT_FOUND: Endpoint not found');
  });

  it('lists every route with its access and IAM action', async () => {
    const rows: { method: string; access: string; action: string; http: string }[] = await json(
      ['api', '--list', '--format', 'json'],
      { env: memoryEnv },
    );
    // Derived from the normative table, so a module adding methods never breaks this test: every
    // listed route is a §9.2 row with that row's action, sorted, and the system group is complete.
    const names = rows.map((row) => row.method);
    expect(names).toEqual([...names].sort());
    for (const row of rows) {
      const [group, method] = row.method.split('.') as [string, string];
      const surface = apiMethod(group, method);
      expect(surface, row.method).toBeDefined();
      expect(row.action, row.method).toBe(surface!.action ?? '');
      expect(row.access, row.method).toBe(surface!.action ? 'token' : 'public');
      expect(row.http).toBe(`POST /api/compute/${group}/${method}`);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        'system.selfCheck',
        'system.version',
        'system.whoami',
        'inventory.get',
      ]),
    );
    expect(rows).toContainEqual({
      method: 'system.version',
      access: 'public',
      action: '',
      http: 'POST /api/compute/system/version',
    });
    expect(rows).toContainEqual({
      method: 'system.selfCheck',
      access: 'token',
      action: 'compute:fleet:admin',
      http: 'POST /api/compute/system/selfCheck',
    });
    const table = await run(['api'], { env: memoryEnv });
    expect(table.status).toBe(0);
    expect(table.stdout.split('\n')[0]).toMatch(/^METHOD\s+ACCESS\s+ACTION\s+HTTP$/);
    expect(table.stdout).toMatch(/^inventory\.get\s+token\s+compute:nodes:read\s+POST /m);
    const system = await json(['api', '--list', 'system', '--format', 'json'], { env: memoryEnv });
    expect(system).toHaveLength(3);
    const none = await run(['api', '--list', 'nope'], { env: memoryEnv });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('NOT_FOUND: No API group named nope');
  });

  it("lists this release's routes without any configuration, under --url's base path", async () => {
    const empty = await mkdtemp(join(tmpdir(), 'bc-cli-noconfig-'));
    try {
      const local = await json(['api', '--list', '--format', 'json'], { cwd: empty });
      expect(local).toContainEqual(
        expect.objectContaining({ http: 'POST /api/compute/system/version' }),
      );
      const remote = await json(
        ['api', '--list', '--format', 'json', '--url', 'https://compute.example.com/ops/compute'],
        { cwd: empty },
      );
      expect(remote).toContainEqual(
        expect.objectContaining({ http: 'POST /ops/compute/system/version' }),
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('migrates a PGlite directory, then doctor finds only the missing IAM', async () => {
    const env = { ...memoryEnv, BETTER_COMPUTE_DATABASE_URL: 'pglite:env-data' };
    const migrate = await run(['migrate'], { env });
    expect(migrate).toEqual({
      status: 0,
      stdout: 'Compute schema and module migrations applied.',
      stderr: '',
    });
    expect((await run(['migrate'], { env })).status).toBe(0); // idempotent
    expect(await json(['doctor'], { env })).toEqual({
      node: process.versions.node,
      config: 'BETTER_COMPUTE_DATABASE_URL',
      database: 'pglite',
      ok: true,
      findings: [noIamFinding],
    });
    const checks = await run(['doctor', '--query', 'findings[].check', '--format', 'compact'], {
      env,
    });
    expect(checks.stdout).toBe('["iam.not-configured"]');
    const strict = await run(['doctor', '--strict'], { env });
    expect(strict.status).toBe(1);
    expect(JSON.parse(strict.stdout).ok).toBe(true);
    expect(strict.stderr).toBe('DOCTOR_FINDINGS: 1 finding(s): iam.not-configured');
  });

  it('reports an unmigrated database', async () => {
    const report = await json(['doctor'], { env: memoryEnv });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding: { check: string }) => finding.check)).toEqual(
      expect.arrayContaining(['migrations', 'iam.not-configured']),
    );
  });

  it.each([
    [{ BETTER_COMPUTE_DATABASE_URL: 'pglite:memory' }, 'MISSING_ENV: Set BETTER_COMPUTE_SECRET'],
    [{ BETTER_COMPUTE_SECRET: SECRET }, 'CONFIG_NOT_FOUND: No better-compute.config'],
    [
      { ...memoryEnv, BETTER_COMPUTE_DATABASE_URL: 'mysql://db.example/compute' },
      'INVALID_CONFIG: BETTER_COMPUTE_DATABASE_URL must be postgres://…, pglite:DIR or pglite:memory',
    ],
    [
      { ...memoryEnv, BETTER_COMPUTE_DATABASE_URL: 'pglite:' },
      'INVALID_CONFIG: BETTER_COMPUTE_DATABASE_URL pglite: needs a directory',
    ],
    [
      { ...memoryEnv, BETTER_COMPUTE_SECRET: 'too-short' },
      'INVALID_CONFIG: secret must be a string of at least 32 characters',
    ],
    [
      { ...memoryEnv, BETTER_COMPUTE_BASE_URL: 'ftp://compute.example' },
      'INVALID_CONFIG: baseURL must be an HTTP(S) URL',
    ],
  ])('refuses the environment %j (exit 1)', async (env, message) => {
    const { status, stderr } = await run(['migrate'], { env });
    expect(status).toBe(1);
    expect(stderr).toContain(message);
  });

  it('connects postgres:// URLs with the postgres executor', async () => {
    // Nothing listens on port 1: the executor is chosen and fails to connect, which doctor reports.
    const report = await json(['doctor'], {
      env: { ...memoryEnv, BETTER_COMPUTE_DATABASE_URL: 'postgres://compute@127.0.0.1:1/compute' },
    });
    expect(report.database).toBe('postgres');
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({ check: 'database', severity: 'error' });
  });

  it.each([
    [['migrate', 'extra'], 'migrate takes no arguments (got extra)'],
    [['migrate', '--url', 'https://compute.example.com'], 'migrate does not take --url'],
    [['doctor', '--strict=maybe'], '--strict is a switch'],
    [['api', 'system'], 'system names no method'],
    [['api', 'a.b.c'], 'a.b.c is not an API route'],
    [['api', 'system.version', 'novalue'], 'novalue is not key=value or key:=json'],
    [['api', 'system.version', '--format', 'xml'], '--format must be json, compact, table'],
    [['api', '--list', 'system', 'extra'], 'api --list takes at most a group name'],
    [
      ['api', 'system.version', '--url', 'http://compute.example.com'],
      '--url http://compute.example.com must use https (plain http is allowed for localhost only)',
    ],
    [
      ['init', '--config', 'compute.config.cjs'],
      '--config compute.config.cjs must end in .ts, .mts, .js or .mjs',
    ],
  ])('exits 2 for the usage error %j', async (argv, message) => {
    const { status, stdout, stderr } = await run(argv, { env: memoryEnv });
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(`INVALID_ARGUMENT: ${message}`);
  });
});

describe('a missing optional peer', () => {
  it('names @electric-sql/pglite and how to install it (MISSING_DEPENDENCY)', async () => {
    vi.doMock('@electric-sql/pglite', () => {
      throw Object.assign(
        new Error("Cannot find package '@electric-sql/pglite' imported from config.js"),
        { code: 'ERR_MODULE_NOT_FOUND' },
      );
    });
    try {
      const { status, stdout, stderr } = await run(['migrate'], { env: memoryEnv });
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr.split('\n')).toEqual([
        'MISSING_DEPENDENCY: A pglite: database needs @electric-sql/pglite, which is not installed',
        'Hint: Install it next to better-compute (npm install @electric-sql/pglite).',
      ]);
    } finally {
      vi.doUnmock('@electric-sql/pglite');
    }
    // Any other failure to load the peer is not mistaken for a missing package.
    vi.doMock('@electric-sql/pglite', () => {
      throw new Error('WebAssembly is not available');
    });
    try {
      const { status, stderr } = await run(['migrate'], { env: memoryEnv });
      expect(status).toBe(1);
      expect(stderr).not.toContain('MISSING_DEPENDENCY');
    } finally {
      vi.doUnmock('@electric-sql/pglite');
    }
    expect((await run(['api', 'system.version'], { env: memoryEnv })).status).toBe(0);
  });
});

describe('init and its template', () => {
  it('writes better-compute.config.ts once, and the JavaScript form for .mjs', async () => {
    const dir = await freshDir('init-forms');
    const created = await run(['init'], { cwd: dir });
    const target = join(dir, 'better-compute.config.ts');
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(
      /^Created .*better-compute\.config\.ts\. Set BETTER_COMPUTE_SECRET/,
    );
    const typescript = await readFile(target, 'utf8');
    expect(typescript).toBe(configTemplate(true));
    expect(typescript).toContain(
      "import { unconfiguredIam, type CommandSpec } from 'better-compute/cli';",
    );
    expect(typescript).toContain('pglite({ dataDir:');
    expect(typescript).toContain('bridge.embedded(iam, { rootTenantId })');

    const again = await run(['init'], { cwd: dir });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/^CONFIG_EXISTS: .*already exists; it was not overwritten$/);
    expect(await readFile(target, 'utf8')).toBe(typescript);

    expect(
      (await run(['init', '--config', 'better-compute.config.mjs'], { cwd: dir })).status,
    ).toBe(0);
    const javascript = await readFile(join(dir, 'better-compute.config.mjs'), 'utf8');
    expect(javascript).toBe(configTemplate(false));
    expect(javascript).not.toMatch(/CommandSpec|: \w+\[\]/);
  });

  it('runs migrate, doctor and api through the generated configuration', async () => {
    const dir = await freshDir('init-run');
    expect((await run(['init'], { cwd: dir })).status).toBe(0);
    const env = { BETTER_COMPUTE_SECRET: SECRET };
    expect(await run(['migrate'], { cwd: dir, env })).toMatchObject({ status: 0, stderr: '' });
    const report = await json(['doctor'], { cwd: dir, env });
    expect(report).toMatchObject({
      config: join(dir, 'better-compute.config.ts'),
      database: 'pglite',
      ok: true,
      findings: [noIamFinding],
    });
    expect(await json(['api', 'system.version'], { cwd: dir, env })).toEqual(serverInfo);
    // Without the secret the server's own validation explains what is wrong.
    const insecure = await run(['migrate'], { cwd: dir });
    expect(insecure.status).toBe(1);
    expect(insecure.stderr).toBe(
      'INVALID_CONFIG: secret must be a string of at least 32 characters',
    );
  });
});

describe('a configuration file with an IAM port and a plugin', () => {
  let dir: string;
  const env = (token?: string) => (token ? { BETTER_COMPUTE_TOKEN: token } : {});

  beforeAll(async () => {
    dir = await freshDir('configured');
    const support = (file: string) =>
      pathToFileURL(fileURLToPath(new URL(`./support/${file}`, import.meta.url))).href;
    await writeFile(
      join(dir, 'better-compute.config.mjs'),
      `import { pglite } from 'better-compute/pglite';
import { defineConfig } from 'better-compute/server';
import { fakeIam } from '${support('fake-iam.ts')}';
import { ACME, OTHER, ROOT, acme } from '${support('server.ts')}';

export default defineConfig(({ cwd }) => {
  const iam = fakeIam();
  iam.addCaller('${ROOT_ADMIN}', { tenantId: ROOT, identityId: 'id-root' });
  iam.addCaller('${ACME_USER}', { tenantId: ACME, identityId: 'id-acme' });
  iam.addCaller('${OUTSIDER}', { tenantId: OTHER, identityId: 'id-other' });
  iam.allow({});
  return {
    database: pglite({ dataDir: cwd + '/data' }),
    secret: '${SECRET}',
    baseURL: 'https://compute.example.test',
    rootTenantId: ROOT,
    iam,
    plugins: [acme],
  };
});
`,
    );
    expect((await run(['migrate'], { cwd: dir })).status).toBe(0);
  });

  it('calls plugin methods as the token, in process, with state kept between commands', async () => {
    const poked = await json(
      ['api', 'plugins.acme.widgets.poke', `tenantId=${ACME}`, 'widgetId=w1'],
      { cwd: dir, env: env(ACME_USER) },
    );
    expect(poked).toMatchObject({
      poked: 'w1',
      admission: {
        tenantId: ACME,
        identityId: 'id-acme',
        action: 'compute:acme:poke',
        resource: { type: 'compute-tenant', id: ACME },
      },
    });
    expect(poked.admission.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    const read = await json(
      [
        'api',
        'plugins/acme/widgets/get',
        '--data',
        JSON.stringify({ tenantId: ACME, widgetId: 'w1' }),
      ],
      { cwd: dir, env: env(ACME_USER) },
    );
    expect(read).toEqual({ widgetId: 'w1', exists: true });
  });

  it('applies the envelope: tenant pre-check, fleet decisions in the root tenant, public whoami', async () => {
    const outsider = await run(
      ['api', 'plugins.acme.widgets.get', `tenantId=${ACME}`, 'widgetId=w1'],
      { cwd: dir, env: env(OUTSIDER) },
    );
    expect(outsider.status).toBe(1);
    expect(outsider.stderr).toBe('ACCESS_DENIED: Access denied');
    expect((await json(['api', 'system.selfCheck'], { cwd: dir, env: env(ROOT_ADMIN) })).ok).toBe(
      true,
    );
    const denied = await run(['api', 'system.selfCheck'], { cwd: dir, env: env(ACME_USER) });
    expect(denied.stderr).toBe('ACCESS_DENIED: Access denied');
    expect(await json(['api', 'system.whoami'], { cwd: dir, env: env(ACME_USER) })).toMatchObject({
      authenticated: true,
      identityId: 'id-acme',
      tenantId: ACME,
    });
    const invalid = await run(['api', 'plugins.acme.widgets.get', 'tenantId=bad tenant'], {
      cwd: dir,
      env: env(ACME_USER),
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/^INVALID_INPUT: /);
  });

  it("lists the configuration's plugin routes, and doctor finds nothing to fix", async () => {
    const rows = await json(['api', '--list', 'plugins.acme', '--format', 'json'], { cwd: dir });
    expect(rows.map((row: { method: string }) => row.method)).toEqual([
      'plugins.acme.widgets.crash',
      'plugins.acme.widgets.fail',
      'plugins.acme.widgets.get',
      'plugins.acme.widgets.limited',
      'plugins.acme.widgets.poke',
    ]);
    expect(rows).toContainEqual({
      method: 'plugins.acme.widgets.poke',
      access: 'token',
      action: 'compute:acme:poke',
      http: 'POST /api/compute/plugins/acme/widgets/poke',
    });
    expect(await json(['doctor', '--strict'], { cwd: dir })).toMatchObject({
      config: join(dir, 'better-compute.config.mjs'),
      ok: true,
      findings: [],
    });
  });

  it('loads the same deployment from code with loadConfig', async () => {
    const deployment = await loadConfig({ cwd: dir, env: {} });
    try {
      expect(deployment.source).toBe(join(dir, 'better-compute.config.mjs'));
      expect(deployment.compute.registry.plugins).toEqual(['acme']);
      expect(isUnconfiguredIam(deployment.options.iam)).toBe(false);
    } finally {
      await deployment.close();
    }
  });
});

describe('the remote transport (--url)', () => {
  let db: SqlExecutor;
  const iam = fakeIam();
  let compute: ReturnType<typeof build>;
  const build = () => betterCompute({ ...options(db, iam), plugins: [acme] });
  /** Sends the CLI's requests straight to the handler, as a server at BASE_URL would receive them. */
  const handlerFetch: typeof globalThis.fetch = async (input, init) =>
    compute.handler(new Request(input, init));

  beforeAll(async () => {
    db = pglite();
    iam.addCaller(ROOT_ADMIN, { tenantId: ROOT, identityId: 'id-root' });
    iam.addCaller(ACME_USER, { tenantId: ACME, identityId: 'id-acme' });
    iam.allow({});
    compute = build();
    await compute.initialize();
  });
  afterAll(async () => {
    await db.close();
  });

  it('calls a server with the token and a request id, like the local transport', async () => {
    iam.reset();
    const version = await json(['api', 'system.version', '--url', BASE_URL], {
      fetch: handlerFetch,
    });
    expect(version).toEqual(serverInfo);
    const whoami = await json(['api', 'system.whoami'], {
      env: { BETTER_COMPUTE_URL: BASE_URL, BETTER_COMPUTE_TOKEN: ACME_USER },
      fetch: handlerFetch,
    });
    expect(whoami).toMatchObject({ authenticated: true, identityId: 'id-acme', tenantId: ACME });
    const [call] = iam.calls;
    expect(tokenOf(call?.credential)).toBe(ACME_USER);
    expect(new Headers(call?.credential?.headers).get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('asks for a token before calling a method that needs one, and relays refusals', async () => {
    const missing = await run(['api', 'system.selfCheck', '--url', BASE_URL], {
      fetch: handlerFetch,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('MISSING_ENV: Set BETTER_COMPUTE_TOKEN');
    const plugin = await run(['api', 'plugins.acme.widgets.get', '--url', BASE_URL], {
      fetch: handlerFetch,
    });
    expect(plugin.stderr).toContain('MISSING_ENV: Set BETTER_COMPUTE_TOKEN');
    const denied = await run(['api', 'system.selfCheck', '--url', BASE_URL], {
      env: { BETTER_COMPUTE_TOKEN: ACME_USER },
      fetch: handlerFetch,
    });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toBe('ACCESS_DENIED: Access denied');
    expect(
      (
        await json(['api', 'system.selfCheck', '--url', BASE_URL], {
          env: { BETTER_COMPUTE_TOKEN: ROOT_ADMIN },
          fetch: handlerFetch,
        })
      ).ok,
    ).toBe(true);
  });

  it('strips control characters from what a server says', async () => {
    const hostile: typeof globalThis.fetch = async () =>
      Response.json(
        { error: { code: 'CONFLICT', message: 'Changed\u001b]0;pwned\u0007 meanwhile' } },
        { status: 409 },
      );
    const { status, stderr } = await run(['api', 'system.version', '--url', BASE_URL], {
      fetch: hostile,
    });
    expect(status).toBe(1);
    expect(stderr).toBe('CONFLICT: Changed ]0;pwned  meanwhile');
  });

  it('reaches a real HTTP server on localhost over plain http', async () => {
    const server = createServer((req, res) => void compute.nodeHandler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await json(['api', 'system.version', '--url', `http://127.0.0.1:${port}`])).toEqual(
        serverInfo,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the unconfigured IAM port', () => {
  it('authenticates nobody, denies every decision and bills nothing', async () => {
    const port = unconfiguredIam();
    const decision = {
      tenantId: 't',
      action: 'compute:pools:read',
      resource: { type: 'compute-pool', id: 'p' },
    };
    await expect(port.authenticate({ token: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(port.require({ token: 'x' }, decision)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(await port.authorize({ token: 'x' }, decision)).toBe(false);
    expect(await port.authorizeMany({ token: 'x' }, 't', [decision, decision])).toEqual([
      false,
      false,
    ]);
    expect(await port.billingCheck({ tenantId: 't' })).toEqual({ allowed: false, budgets: [] });
    await expect(port.recordUsage([])).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await port.featureEnabled('t', 'compute.byo-nodes')).toBe(false);
    expect(isUnconfiguredIam(port)).toBe(true);
    expect(isUnconfiguredIam(fakeIam())).toBe(false);
    expect(Object.isFrozen(port)).toBe(true);
  });

  it('is what environment-only deployments get', async () => {
    const deployment = await loadConfig({ cwd: scratch, env: memoryEnv });
    try {
      expect(deployment.source).toBe('BETTER_COMPUTE_DATABASE_URL');
      expect(isUnconfiguredIam(deployment.options.iam)).toBe(true);
      expect(deployment.options.database.kind).toBe('pglite');
    } finally {
      await deployment.close();
    }
  });
});
