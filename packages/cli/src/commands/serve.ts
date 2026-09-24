import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workerRoles, type WorkerRole } from '@better-compute/server';
import {
  configFromEnv,
  createDeployment,
  type AnyCompute,
  type AnyComputeOptions,
  type Deployment,
} from '../config.js';
import { prepareDevSim, simVariants, type SimVariant } from '../dev-sim.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';
import { resolveHost, type HostConfig } from '../host/config.js';
import { startGateway, type RunningGateway } from '../host/gateway.js';
import { hostListener } from '../host/http.js';
import { joinKeysWellKnown } from '../host/well-known.js';
import { defaultPkiPath, loadPkiBundle, pkiFlag } from './pki.js';

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
  /** After migrations, before the workers start (binding a store-backed IAM projection). */
  afterMigrate?(): Promise<void>;
  /** Once the workers run and the API listens (attaching a dev fleet). */
  started?(running: RunningServer): Promise<void>;
  /** On the stop signal, before the listener and the workers stop. */
  stopping?(): Promise<void>;
  /** The configuration's `host` export: routes, upgrade handlers, well-known fields, the gateway. */
  hostConfig?: HostConfig;
  /** Run the gateway role (needs `hostConfig.gateway` and `computeOptions`). */
  gateway?: boolean;
  /** The options `compute` was built from (the gateway role reads the store and tunnels from them). */
  computeOptions?: AnyComputeOptions;
}

export interface RunningServer {
  /** `http://host:port` once listening; undefined for a worker-only process. */
  url?: string;
  roles: readonly WorkerRole[];
  /** The gateway role, when it runs. */
  gateway?: { id: string; port: number; internalPort?: number };
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
  await options.afterMigrate?.();
  const running: RunningServer = { roles: options.roles };
  let server: Server | undefined;
  let gateway: RunningGateway | undefined;
  let stopping = false;
  try {
    if (options.roles.length) await compute.start({ roles: [...options.roles] });
    if (options.gateway) {
      const config = options.hostConfig?.gateway;
      if (!config || !options.computeOptions)
        throw new CliError(
          'INVALID_CONFIG',
          'The gateway role needs host.gateway in the configuration',
          'Export host = defineHost({ gateway: { region, tls: { key, cert, ca } } }) from better-compute.config.ts.',
        );
      gateway = await startGateway(compute, options.computeOptions, config, options.note);
      running.gateway = {
        id: gateway.id,
        port: gateway.port,
        ...(gateway.internalPort === undefined ? {} : { internalPort: gateway.internalPort }),
      };
    }
    if (options.api !== false) {
      const listener = hostListener(compute, options.hostConfig?.http);
      server = createServer(listener.request);
      server.on('upgrade', listener.upgrade);
      const port = await listen(server, options.host, options.port);
      const host = options.host.includes(':') ? `[${options.host}]` : options.host;
      running.url = `http://${host}:${port}`;
      options.note(`better-compute listening on ${running.url}${compute.endpoint.basePath}`);
    }
    if (options.roles.length) options.note(`Workers running: ${options.roles.join(', ')}`);
    await options.started?.(running);
    if (!options.signal.aborted)
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    options.note('Stopping…');
    stopping = true;
    await options.stopping?.();
    return running;
  } finally {
    // A failed start still releases what `started` attached.
    if (!stopping) await options.stopping?.().catch(() => undefined);
    // Daemons first (they reconnect to another gateway), then HTTP, then the workers' leases.
    await gateway?.stop().catch(() => undefined);
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

/**
 * Parses `--roles`: `all`, or a comma list of `api`, `gateway` and worker roles. `gateway` is `'auto'` for
 * `all` (it runs when the configuration has `host.gateway`) and `true` when named.
 */
export function parseRoles(value: string): {
  api: boolean;
  roles: WorkerRole[];
  gateway: boolean | 'auto';
} {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 1 && items[0] === 'all')
    return { api: true, roles: [...workerRoles], gateway: 'auto' };
  const roles: WorkerRole[] = [];
  let api = false;
  let gateway = false;
  for (const item of items) {
    if (item === 'api') api = true;
    else if (item === 'gateway') gateway = true;
    else if ((workerRoles as readonly string[]).includes(item)) roles.push(item as WorkerRole);
    else
      throw usageError(
        `--roles: unknown role ${JSON.stringify(item)}`,
        `Use all, or any of api, gateway, ${workerRoles.join(', ')}.`,
      );
  }
  if (!api && !gateway && !roles.length) throw usageError('--roles needs at least one role');
  return { api, roles: [...new Set(roles)], gateway };
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
      "serve loads the configuration, migrates (skip with --no-migrate once a deploy step runs better-compute migrate), starts the worker roles (controllers: reconcilers and the command sweeper; scheduler; sinks: outbox dispatch; iam: IAM jobs) under their leases, and serves the API with compute.nodeHandler on --host:--port. Run several processes against one database: leases and shard ownership keep each job single-writer. --roles api serves the API only; --roles controllers,sinks runs a worker with no listener; --roles gateway runs the daemon gateway over mTLS from the configuration's host.gateway (all includes it when configured), with the report hooks of the built-in modules and tunnels when the deployment issues exec tickets. Beside the API the listener answers /healthz, /readyz, /.well-known/better-compute (with --pki, the join keys bcd may fall back to) and the host export's own routes (for example GET /watch and GET /metrics). SIGINT or SIGTERM drains the gateway first, then stops the listener and the workers, releasing their leases.",
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
        description: `all, or a comma list of api, gateway and ${workerRoles.join(', ')}`,
      },
      'no-migrate': { type: 'boolean', description: 'Do not run migrations first' },
      pki: {
        ...pkiFlag,
        description:
          'Publish the join keys of this PKI bundle at /.well-known/better-compute (the bcd fallback to its pins)',
      },
    },
    examples: [
      'better-compute serve',
      'better-compute serve --roles api --port 8080',
      'better-compute serve --roles controllers,sinks,iam --no-migrate',
      'better-compute serve --roles gateway,controllers',
    ],
    async run({ flags, explicit, deployment, configModule, io, env, cwd, path, note }) {
      const parsed = parseRoles(flags.roles ?? 'all');
      const { compute, options } = await deployment();
      const hostConfig = await resolveHost((await configModule()).host, {
        compute,
        options,
        env,
        cwd,
      });
      const gateway = parsed.gateway === 'auto' ? hostConfig.gateway !== undefined : parsed.gateway;
      if (explicit.has('pki')) {
        const bundle = await loadPkiBundle(path(flags.pki ?? defaultPkiPath), env);
        hostConfig.http = {
          ...hostConfig.http,
          wellKnown: { ...joinKeysWellKnown(bundle), ...hostConfig.http?.wellKnown },
        };
      }
      const stop = stopSignal(io.signal);
      try {
        const running = await runServer(compute, {
          host: flags.host ?? '0.0.0.0',
          port: flags.port ?? 3000,
          api: parsed.api,
          roles: parsed.roles,
          gateway,
          hostConfig,
          computeOptions: options,
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
      'dev runs the API and every worker role on 127.0.0.1. With a configuration file (or BETTER_COMPUTE_DATABASE_URL) it uses that deployment; without one it keeps PGlite in --data (default .better-compute/dev-db; --memory for a throwaway database) and a generated deployment secret in .better-compute/dev-secret (owner-only), so repeated runs keep their data. It always migrates first. Without IAM configured only public methods answer; see better-compute iam setup. --sim N adds a gateway on loopback cleartext HTTP/2 (sessions authenticate by a header; local development only) and N simulated machines that join the way bcd does: a join token sealed to throwaway dev JoinService keys, the Join RPC, a Session stream, diag.nvml acceptance and adoption by the real runtime. Without configured IAM, --sim starts an embedded in-memory better-iam and prints its root token; with configured IAM it acts as BETTER_COMPUTE_TOKEN, which must be a root administrator.',
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
      sim: {
        type: 'integer',
        value: 'N',
        min: 0,
        max: 1000,
        description:
          'Join N simulated machines (FakeDaemons) through a loopback dev gateway (needs @better-compute/testing)',
      },
      'sim-variant': {
        type: 'string',
        value: 'VARIANT',
        default: 'hgx-h100',
        description: `Hardware of the simulated machines: ${simVariants.join(', ')}`,
      },
    },
    validate(flags) {
      const variant = flags['sim-variant'];
      if (variant !== undefined && !(simVariants as readonly string[]).includes(variant))
        throw usageError(
          `--sim-variant ${JSON.stringify(variant)} is not one of ${simVariants.join(', ')}`,
        );
    },
    examples: [
      'better-compute dev',
      'better-compute dev --memory --port 0',
      'better-compute dev --memory --sim 8',
      'better-compute dev --sim 4 --sim-variant l40s',
    ],
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
      const count = flags.sim ?? 0;
      const sim = count
        ? await prepareDevSim(chosen.options, {
            count,
            variant: (flags['sim-variant'] ?? 'hgx-h100') as SimVariant,
            env,
            note,
          })
        : undefined;
      // The same store and options plus the dev join keys: one control plane, not a second stack.
      if (sim) chosen = createDeployment(sim.options, chosen.source);
      const stop = stopSignal(io.signal);
      try {
        const running = await runServer(chosen.compute, {
          host,
          port,
          roles: [...workerRoles],
          migrate: true,
          signal: stop.signal,
          note,
          ...(sim
            ? {
                afterMigrate: () => sim.afterMigrate(),
                started: () => sim.started(chosen.compute),
                stopping: () => sim.stopping(),
              }
            : {}),
        });
        return `Stopped ${running.url}.`;
      } finally {
        stop.dispose();
        await sim?.close();
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
