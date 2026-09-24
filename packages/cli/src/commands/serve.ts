import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workerRoles, type WorkerRole } from '@better-compute/server';
import { configFromEnv, createDeployment, type AnyCompute, type Deployment } from '../config.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';

// `serve` and `dev` (PLAN.md §9.3): one process runs the HTTP API (`compute.nodeHandler`) and the
// worker roles, after migrating, until SIGINT/SIGTERM (or `CliIO.signal`). `dev` needs no setup:
// without a configuration it keeps PGlite and a generated secret under .better-compute/.

export interface RunServerOptions {
  host: string;
  port: number;
  /** Worker roles to run beside the API (none: API only). */
  roles: readonly WorkerRole[];
  /** Serve the API (default true); false runs a worker only. */
  api?: boolean;
  /** Run `initialize()` first (migrations; idempotent). */
  migrate: boolean;
  signal: AbortSignal;
  note(message: string): void;
}

export interface RunningServer {
  /** `http://host:port` once listening; undefined for a worker-only process. */
  url?: string;
  roles: readonly WorkerRole[];
}

const listen = (server: Server, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

/**
 * Migrates, starts the worker roles and the HTTP server, and returns once `signal` aborts and
 * everything stopped: the listener first (no new requests), then the workers (leases released).
 */
export async function runServer(
  compute: AnyCompute,
  options: RunServerOptions,
): Promise<RunningServer> {
  if (options.migrate) await compute.initialize();
  const running: RunningServer = { roles: options.roles };
  let server: Server | undefined;
  try {
    if (options.roles.length) await compute.start({ roles: [...options.roles] });
    if (options.api !== false) {
      server = createServer((req, res) => {
        void compute.nodeHandler(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"INTERNAL_ERROR","message":"Internal error"}}');
        });
      });
      const port = await listen(server, options.host, options.port);
      const host = options.host.includes(':') ? `[${options.host}]` : options.host;
      running.url = `http://${host}:${port}`;
      options.note(`better-compute listening on ${running.url}${compute.endpoint.basePath}`);
    }
    if (options.roles.length) options.note(`Workers running: ${options.roles.join(', ')}`);
    if (!options.signal.aborted)
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    options.note('Stopping…');
    return running;
  } finally {
    if (server) await closeServer(server);
    await compute.stop();
  }
}

/** The process's stop signal: `io.signal`, or the first SIGINT/SIGTERM. */
function stopSignal(signal: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
  if (signal) return { signal, dispose() {} };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

/** Parses `--roles`: `all`, `none`, or worker roles and `api` separated by commas. */
export function parseRoles(value: string): { api: boolean; roles: WorkerRole[] } {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 1 && items[0] === 'all') return { api: true, roles: [...workerRoles] };
  if (items.length === 1 && items[0] === 'api') return { api: true, roles: [] };
  const roles: WorkerRole[] = [];
  let api = false;
  for (const item of items) {
    if (item === 'api') api = true;
    else if ((workerRoles as readonly string[]).includes(item)) roles.push(item as WorkerRole);
    else
      throw usageError(
        `--roles: unknown role ${JSON.stringify(item)}`,
        `Use all, or api and any of ${workerRoles.join(', ')}.`,
      );
  }
  if (!api && !roles.length) throw usageError('--roles needs at least one role');
  return { api, roles: [...new Set(roles)] };
}

const portFlag = {
  type: 'integer',
  value: 'PORT',
  env: 'PORT',
  min: 0,
  max: 65535,
  description: 'The port to listen on (0 picks a free one)',
} satisfies FlagSpec;

export const serveCommands = [
  defineCommand({
    name: 'serve',
    group: 'Setup',
    summary: 'Run the API and the workers in this process',
    description:
      'serve loads the configuration, migrates (skip with --no-migrate once a deploy step runs better-compute migrate), starts the worker roles (controllers: reconcilers and the command sweeper; scheduler; sinks: outbox dispatch; iam: IAM jobs) under their leases, and serves the API with compute.nodeHandler on --host:--port. Run several processes against one database: leases and shard ownership keep each job single-writer. --roles api serves the API only; --roles controllers,sinks runs a worker with no listener. SIGINT or SIGTERM stops the listener first, then the workers, releasing their leases.',
    target: 'config',
    output: 'text',
    flags: {
      host: {
        type: 'string',
        value: 'HOST',
        env: 'HOST',
        default: '0.0.0.0',
        description: 'The address to listen on',
      },
      port: { ...portFlag, default: 3000 },
      roles: {
        type: 'string',
        value: 'ROLES',
        default: 'all',
        env: 'BETTER_COMPUTE_ROLES',
        description: `all, or a comma list of api and ${workerRoles.join(', ')}`,
      },
      'no-migrate': { type: 'boolean', description: 'Do not run migrations first' },
    },
    examples: [
      'better-compute serve',
      'better-compute serve --roles api --port 8080',
      'better-compute serve --roles controllers,sinks,iam --no-migrate',
    ],
    async run({ flags, deployment, io, note }) {
      const { api, roles } = parseRoles(flags.roles ?? 'all');
      const { compute } = await deployment();
      const stop = stopSignal(io.signal);
      try {
        const running = await runServer(compute, {
          host: flags.host ?? '0.0.0.0',
          port: flags.port ?? 3000,
          api,
          roles,
          migrate: !flags['no-migrate'],
          signal: stop.signal,
          note,
        });
        return `Stopped${running.url ? ` ${running.url}` : ''}.`;
      } finally {
        stop.dispose();
      }
    },
  }),
  defineCommand({
    name: 'dev',
    group: 'Setup',
    summary: 'Run a local development server with no setup',
    description:
      'dev runs the API and every worker role on 127.0.0.1. With a configuration file (or BETTER_COMPUTE_DATABASE_URL) it uses that deployment; without one it keeps PGlite in --data (default .better-compute/dev-db; --memory for a throwaway database) and a generated deployment secret in .better-compute/dev-secret (owner-only), so repeated runs keep their data. It always migrates first. Without IAM configured only public methods answer; see better-compute iam setup.',
    target: 'none',
    output: 'text',
    flags: {
      host: {
        type: 'string',
        value: 'HOST',
        default: '127.0.0.1',
        description: 'The address to listen on',
      },
      port: { ...portFlag, default: 3000 },
      data: {
        type: 'string',
        value: 'DIR',
        default: '.better-compute/dev-db',
        description: 'Where PGlite keeps the development database (no configuration only)',
      },
      memory: { type: 'boolean', description: 'Use a throwaway in-memory database' },
      config: {
        type: 'string',
        value: 'PATH',
        env: 'BETTER_COMPUTE_CONFIG',
        description: 'The configuration file (default: discovered)',
      },
    },
    examples: ['better-compute dev', 'better-compute dev --memory --port 0'],
    async run({ flags, io, env, path, note, configPath, deployment }) {
      const port = flags.port ?? 3000;
      const host = flags.host ?? '127.0.0.1';
      let local: Deployment | undefined;
      let chosen: Deployment;
      if ((await configPath()) || env.BETTER_COMPUTE_DATABASE_URL) chosen = await deployment();
      else {
        const secretFile = path('.better-compute/dev-secret');
        const secret = await devSecret(secretFile, env);
        const database = flags.memory
          ? 'pglite:memory'
          : `pglite:${path(flags.data ?? '.better-compute/dev-db')}`;
        if (!flags.memory)
          await mkdir(path(flags.data ?? '.better-compute/dev-db'), { recursive: true });
        const options = await configFromEnv(
          {
            ...env,
            BETTER_COMPUTE_DATABASE_URL: database,
            BETTER_COMPUTE_SECRET: secret,
            BETTER_COMPUTE_BASE_URL: env.BETTER_COMPUTE_BASE_URL ?? `http://${host}:${port}`,
          },
          io.cwd ?? process.cwd(),
        );
        local = chosen = createDeployment(options, database);
        note(`Development database: ${database} (secret in ${secretFile})`);
      }
      const stop = stopSignal(io.signal);
      try {
        const running = await runServer(chosen.compute, {
          host,
          port,
          roles: [...workerRoles],
          migrate: true,
          signal: stop.signal,
          note,
        });
        return `Stopped ${running.url}.`;
      } finally {
        stop.dispose();
        await local?.close().catch(() => undefined);
      }
    },
  }),
];

/** The development secret: BETTER_COMPUTE_SECRET, else one generated once and kept owner-only. */
async function devSecret(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.BETTER_COMPUTE_SECRET) return env.BETTER_COMPUTE_SECRET;
  try {
    const stored = (await readFile(file, 'utf8')).trim();
    if (stored.length >= 32) return stored;
    throw new CliError('INVALID_CONFIG', `${file} holds a secret shorter than 32 characters`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('base64url');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  return secret;
}
