import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  ComputeError,
  isComputeError,
  isSecretRef,
  type DriverContext,
  type DriverDefinition,
  type DuplexStream,
  type JsonSchema,
  type Logger,
  type Progress,
  type SecretResolver,
} from '@better-compute/core';
import { driver, type DriverManifest } from '@better-compute/protocol';
import { connectPlugin, type PluginConnection } from './client.js';
import { GrpcCode, GrpcError } from './grpc.js';
import {
  BCX_CLIENT_CERT,
  BCX_MAGIC_COOKIE_KEY,
  BCX_MAGIC_COOKIE_VALUE,
  BCX_PROTOCOL_VERSION,
  BCX_SOCKET_DIR,
  createEphemeralIdentity,
  parseHandshake,
  type Handshake,
} from './handshake.js';
import { remoteConfigSchema, type RemoteConfigSchema } from './schema.js';
import {
  decodeResult,
  encodeArgs,
  errorFromWire,
  isRecord,
  progressFromWire,
  runsOnFromWire,
  STREAM_CAPABILITY_PREFIX,
  type CallSite,
} from './wire.js';

export interface ExternalDriverOptions {
  /**
   * The plugin command line, executed without a shell. `command[0]` is resolved against `cwd` or
   * `PATH`; see `pinnedFile` for which file `sha256` pins.
   */
  command: readonly string[];
  /** Hex SHA-256 of the pinned file, checked before every start and restart. */
  sha256: string;
  /**
   * Extra environment for the plugin. It never inherits the host's environment: only PATH, the
   * temp dirs, HOME and a few OS basics pass through, plus these and the bcx handshake variables.
   */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  /** How long the plugin may take to print its handshake and answer Describe (30 000 ms). */
  startTimeoutMs?: number;
  /**
   * Deadline of calls whose context carries no `deadline` (default: none). Deadlines are wall-clock
   * epoch milliseconds, since the plugin enforces them with its own clock.
   */
  callTimeoutMs?: number;
  /** Restart back-off after a crash: doubles from `initialDelayMs` (250) up to `maxDelayMs` (30 000). */
  restart?: { initialDelayMs?: number; maxDelayMs?: number };
  /** How long a stopping plugin gets between stdin EOF / SIGTERM and SIGKILL (5 000 ms). */
  shutdownGraceMs?: number;
  /** Plugin stderr (JSON lines keep their level), exits and restarts. Default: warnings on stderr. */
  log?: Logger;
}

/**
 * What a remote operation returns: a promise of its result that is also an async iterable of its
 * progress. Awaited, progress goes to the context's `emit`; iterated (`deploy`, `tearDown`, …),
 * progress is yielded instead and the loop ends when the operation does.
 */
export interface RemoteCall<T = unknown> extends Promise<T>, AsyncIterable<Progress> {}

/** A kind of a remote driver: every property is an operation forwarded to the plugin. */
export type RemoteKind = Readonly<Record<string, (...args: unknown[]) => RemoteCall>>;

/** A plugin's driver as the control plane registers it: a `DriverDefinition` backed by bcx. */
export interface RemoteDriverDefinition extends DriverDefinition {
  readonly config: RemoteConfigSchema;
  readonly implements: Readonly<
    Record<string, (config: unknown, context: DriverContext) => RemoteKind>
  >;
  readonly retrySafe: Readonly<Record<string, readonly string[]>>;
}

export interface ExternalDriverHost {
  readonly command: readonly string[];
  /**
   * Verifies the pin, starts the plugin, dials it and calls Describe. Resolves with its drivers;
   * later calls return the same promise.
   */
  start(): Promise<RemoteDriverDefinition[]>;
  /** The plugin's drivers once `start` resolved (empty before). */
  readonly drivers: readonly RemoteDriverDefinition[];
  /** The running plugin's pid, if any. */
  readonly pid: number | undefined;
  /** How many times the plugin was restarted after a crash. */
  readonly restarts: number;
  /** The plugin's `Health`. */
  health(signal?: AbortSignal): Promise<{ serving: boolean; message: string }>;
  /** Stops supervising and stops the plugin (stdin EOF, SIGTERM, then SIGKILL). */
  close(): Promise<void>;
}

const interpreters = new Set(['node', 'nodejs', 'bun']);
const inheritedEnv = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
]);
const logLevels = new Set(['debug', 'info', 'warn', 'error']);

const invalidConfig = (message: string) => new ComputeError('INVALID_CONFIG', message);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves an executable name the way a shell would: a path against `cwd`, a bare name on PATH. */
function resolveExecutable(
  name: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) return resolve(cwd, name);
  const path = env.PATH ?? env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE').split(';').filter((extension) => extension)]
      : [''];
  for (const directory of path.split(delimiter).filter((entry) => entry))
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  throw invalidConfig(`The plugin executable ${name} is not on PATH`);
}

const isInterpreter = (file: string) =>
  interpreters.has(
    basename(file)
      .toLowerCase()
      .replace(/\.exe$/, ''),
  );

/**
 * Which file `sha256` pins for a command line:
 * - `command[0]` (resolved against `cwd`, or on PATH), for a native plugin;
 * - when `command[0]` is `node`, `nodejs` or `bun` (by basename, `.exe` or not), the script: the
 *   first later argument that does not start with `-` (after `bun`'s optional `run`), resolved
 *   against `cwd`. Interpreter options must use the `--name=value` form, or their value would be
 *   taken for the script. Only the entry file is pinned, so bundle a JS plugin into one file.
 */
export function pinnedFile(
  command: readonly string[],
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const [program] = command;
  if (!program || command.some((part) => typeof part !== 'string'))
    throw invalidConfig('The plugin command must name an executable');
  if (!isInterpreter(program)) return resolveExecutable(program, cwd, env);
  const operands = command.slice(1).filter((part) => !part.startsWith('-'));
  const script =
    basename(program).toLowerCase().startsWith('bun') && operands[0] === 'run'
      ? operands[1]
      : operands[0];
  if (!script) throw invalidConfig(`${program} needs a script to pin`);
  return resolve(cwd, script);
}

/** Hex SHA-256 of a file's contents. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  } catch (error) {
    throw invalidConfig(`Cannot read the plugin ${path}: ${(error as Error).message}`);
  }
  return hash.digest('hex');
}

const defaultLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message, fields) =>
    process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`),
  error: (message, fields) =>
    process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`),
};

/** A plugin stderr line: JSON lines from `serveDriver`'s logger keep their level. */
function forwardLine(log: Logger, line: string, fields: Record<string, unknown>): void {
  if (!line.trim()) return;
  try {
    const record: unknown = JSON.parse(line);
    if (
      isRecord(record) &&
      typeof record.level === 'string' &&
      logLevels.has(record.level) &&
      typeof record.message === 'string'
    ) {
      const { level, message, ...rest } = record;
      log[level as keyof Logger](message as string, { ...rest, ...fields });
      return;
    }
  } catch {
    // Not a JSON line.
  }
  log.warn(line, fields);
}

interface Running {
  child: ChildProcess;
  connection: PluginConnection;
  socketDir: string;
  startedAt: number;
  exited: Promise<void>;
  lost: boolean;
}

function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** Resolves with the handshake line, or rejects when the plugin exits, fails or times out. */
function awaitHandshake(
  child: ChildProcess,
  timeoutMs: number,
  log: Logger,
  fields: Record<string, unknown>,
): Promise<Handshake> {
  const tail: string[] = [];
  createInterface({ input: child.stderr! }).on('line', (line) => {
    tail.push(line);
    if (tail.length > 20) tail.shift();
    forwardLine(log, line, fields);
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const failure = (message: string, driverCode = 'unreachable') =>
      new ComputeError('DRIVER_ERROR', message, undefined, { driverCode, ...fields });
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(failure(`The plugin printed no bcx handshake within ${timeoutMs} ms`, 'timeout')),
        ),
      timeoutMs,
    );
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (settled || !line.startsWith('bcx|')) {
        if (line.trim()) log.info(line, { ...fields, stream: 'stdout' });
        return;
      }
      try {
        const handshake = parseHandshake(line);
        settle(() => resolve(handshake));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    child.once('error', (error) =>
      settle(() => reject(failure(`Cannot start the plugin: ${error.message}`))),
    );
    // `close`, not `exit`: every stderr line has been read by then.
    child.once('close', (code, signal) =>
      settle(() =>
        reject(
          failure(
            `The plugin exited (${code ?? signal}) before its bcx handshake` +
              (tail.length ? `: ${tail.slice(-3).join(' | ')}` : ''),
          ),
        ),
      ),
    );
  });
}

/** Resolves true once `exited` settles, false after `ms`. */
async function within(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return stopped;
}

async function stopProcess(
  running: Pick<Running, 'child' | 'exited' | 'socketDir'>,
  graceMs: number,
): Promise<void> {
  const { child } = running;
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.stdin?.end(); // The plugin's lifeline: it shuts down when stdin closes.
    if (process.platform !== 'win32') child.kill('SIGTERM');
    if (!(await within(running.exited, graceMs))) {
      child.kill('SIGKILL');
      await within(running.exited, 5_000);
    }
  }
  await rm(running.socketDir, { recursive: true, force: true }).catch(() => {});
}

/** `ctx.deadline` (epoch ms) when the caller's context carries one. */
function deadlineOf(context: DriverContext | undefined): number | undefined {
  const deadline = (context as { deadline?: unknown } | undefined)?.deadline;
  return typeof deadline === 'number' && Number.isFinite(deadline) ? deadline : undefined;
}

/** Resolves only the declared secret fields whose config values are secret references. */
async function deliverSecrets(
  config: unknown,
  fields: readonly string[],
  secrets: SecretResolver | undefined,
): Promise<{ field: string; value: Uint8Array }[]> {
  const delivered: { field: string; value: Uint8Array }[] = [];
  if (!isRecord(config)) return delivered;
  for (const field of fields) {
    const ref = config[field];
    if (!isSecretRef(ref)) continue;
    if (!secrets)
      throw new ComputeError('INVALID_STATE', `Secret field ${field} needs a secret resolver`);
    delivered.push({ field, value: new TextEncoder().encode(await secrets.resolve(ref)) });
  }
  return delivered;
}

function pointerSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Promise + progress iterable; see `RemoteCall`. */
function remoteCall<T>(
  run: (onProgress: (progress: Progress) => void) => Promise<T>,
  emit: (progress: Progress) => void,
): RemoteCall<T> {
  let iterating = false;
  const queue: Progress[] = [];
  let settled: { error?: unknown; failed: boolean } | undefined;
  let wake: (() => void) | undefined;
  const promise = run((progress) => {
    if (!iterating) return emit(progress);
    queue.push(progress);
    wake?.();
  });
  promise.then(
    () => {
      settled = { failed: false };
      wake?.();
    },
    (error: unknown) => {
      settled = { error, failed: true };
      wake?.();
    },
  );
  async function* progress(): AsyncGenerator<Progress, void> {
    iterating = true;
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (settled) {
        if (settled.failed) throw settled.error;
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
  }
  return Object.assign(promise, { [Symbol.asyncIterator]: progress }) as RemoteCall<T>;
}

/** What remote definitions need from their host. */
interface CallPort {
  connection(): Promise<PluginConnection>;
  callTimeoutMs?: number;
}

/** A transport failure as the `ComputeError` a caller sees; a lost plugin is retryable. */
function callFailure(error: unknown, site: CallSite, retrySafe: boolean): unknown {
  if (isComputeError(error) || !(error instanceof GrpcError)) return error;
  const lost = error.code === GrpcCode.UNAVAILABLE || error.code === GrpcCode.CANCELLED;
  return new ComputeError(
    'DRIVER_ERROR',
    lost
      ? `The plugin serving ${site.driver} is unreachable: ${error.message}`
      : `bcx call ${site.driver} ${site.kind}.${site.operation} failed: ${error.message}`,
    undefined,
    { driverCode: lost ? 'unreachable' : 'protocol', retryable: lost, retrySafe, ...site },
  );
}

const inheritedProperty = (property: string | symbol) =>
  typeof property !== 'string' || property in Object.prototype;

function remoteDefinition(manifest: DriverManifest, port: CallPort): RemoteDriverDefinition {
  let schema: JsonSchema = {};
  try {
    const parsed: unknown = JSON.parse(manifest.configSchemaJson || '{}');
    if (isRecord(parsed)) schema = parsed as JsonSchema;
  } catch {
    // A plugin without a usable schema: the plugin validates alone.
  }
  const config = remoteConfigSchema(schema);
  const streams = new Set(
    manifest.capabilities
      .filter((capability) => capability.startsWith(STREAM_CAPABILITY_PREFIX))
      .map((capability) => capability.slice(STREAM_CAPABILITY_PREFIX.length)),
  );
  const retrySafe: Record<string, string[]> = {};
  for (const entry of manifest.retrySafeOperations) {
    const dot = entry.indexOf('.');
    if (dot > 0) (retrySafe[entry.slice(0, dot)] ??= []).push(entry.slice(dot + 1));
  }

  const request = async (
    kind: string,
    operation: string,
    configValue: unknown,
    context: DriverContext | undefined,
    args: readonly unknown[],
  ) => {
    let argsJson: string;
    try {
      argsJson = encodeArgs(args);
    } catch {
      throw new ComputeError(
        'INVALID_INPUT',
        `The arguments of ${manifest.id} ${kind}.${operation} are not JSON`,
      );
    }
    const deadline =
      deadlineOf(context) ??
      (port.callTimeoutMs !== undefined ? Date.now() + port.callTimeoutMs : undefined);
    const traceparent = (context as { traceparent?: unknown } | undefined)?.traceparent;
    return {
      deadline,
      init: {
        driverId: manifest.id,
        kind,
        operation,
        configJson: JSON.stringify(configValue ?? {}),
        argsJson,
        secrets: await deliverSecrets(configValue, config.secretFields, context?.secrets),
        idempotencyKey: context?.idempotencyKey ?? '',
        deadline: deadline !== undefined ? timestampFromMs(deadline) : undefined,
        traceparent: typeof traceparent === 'string' ? traceparent : '',
      },
    };
  };

  /**
   * Runs one call under a signal that follows the caller's and, a second after the deadline the
   * plugin enforces itself, gives up on a plugin that stopped answering.
   */
  const guarded = async <T>(
    site: CallSite,
    safe: boolean,
    context: DriverContext | undefined,
    deadline: number | undefined,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const follow = () => controller.abort(context?.signal?.reason);
    if (context?.signal?.aborted) follow();
    else context?.signal?.addEventListener('abort', follow, { once: true });
    const timer =
      deadline === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                errorFromWire(
                  {
                    code: 'timeout',
                    message: `${site.driver} ${site.kind}.${site.operation} did not finish before its deadline`,
                    retryable: safe,
                  } as driver.DriverError,
                  site,
                ),
              ),
            Math.max(0, deadline - Date.now()) + 1_000,
          );
    try {
      return await call(controller.signal);
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : callFailure(error, site, safe);
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', follow);
    }
  };

  const operationOf = (
    kind: string,
    operation: string,
    configValue: unknown,
    context: DriverContext,
  ) => {
    const site: CallSite = { driver: manifest.id, kind, operation };
    const safe = retrySafe[kind]?.includes(operation) ?? false;
    const emit = (progress: Progress) => context?.emit?.(progress);
    if (streams.has(`${kind}.${operation}`))
      return (...args: unknown[]) =>
        remoteCall<DuplexStream>(async () => {
          const { init, deadline } = await request(kind, operation, configValue, context, args);
          // The deadline bounds opening the stream, not its lifetime.
          const opened = await guarded(site, safe, context, deadline, async (signal) =>
            (await port.connection()).stream(init, signal),
          );
          return opened;
        }, emit);
    return (...args: unknown[]) =>
      remoteCall(async (onProgress) => {
        const { init, deadline } = await request(kind, operation, configValue, context, args);
        const json = await guarded(site, safe, context, deadline, async (signal) =>
          (await port.connection()).invoke(
            init,
            (progress) => onProgress(progressFromWire(progress)),
            signal,
          ),
        );
        return decodeResult(json);
      }, emit);
  };

  const implementations: Record<
    string,
    (configValue: unknown, context: DriverContext) => RemoteKind
  > = {};
  for (const kind of manifest.kinds)
    implementations[kind] = (configValue, context) => {
      const methods = new Map<string, (...args: unknown[]) => RemoteCall>();
      return new Proxy(Object.freeze({}) as RemoteKind, {
        get(target, property) {
          // Not thenable (so `await implements[kind](…)` works), and Object's own members stay.
          if (inheritedProperty(property)) return Reflect.get(target, property);
          if (property === 'then') return undefined;
          const name = property as string;
          let method = methods.get(name);
          if (!method) {
            method = operationOf(kind, name, configValue, context) as (
              ...args: unknown[]
            ) => RemoteCall;
            methods.set(name, method);
          }
          return method;
        },
      });
    };

  return Object.freeze({
    extension: 'driver' as const,
    id: manifest.id,
    version: manifest.version,
    runsOn: runsOnFromWire(manifest.runsOn),
    config,
    capabilities: Object.freeze([...manifest.capabilities]),
    implements: Object.freeze(implementations),
    retrySafe: Object.freeze(retrySafe),
    async validate(configValue: unknown, context: DriverContext): Promise<void> {
      const site: CallSite = { driver: manifest.id, kind: '', operation: 'validate' };
      const response = await guarded(site, true, context, undefined, async (signal) =>
        (await port.connection()).validate(
          {
            driverId: manifest.id,
            configJson: JSON.stringify(configValue ?? {}),
            secrets: await deliverSecrets(configValue, config.secretFields, context?.secrets),
          },
          signal,
        ),
      );
      if (response.valid) return;
      const issues = response.issues.map((issue) => ({
        message: issue.message,
        path: pointerSegments(issue.path),
      }));
      const [first] = issues;
      throw new ComputeError(
        'INVALID_INPUT',
        `${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'Invalid configuration'}`,
        undefined,
        { issues, driver: manifest.id },
      );
    },
  });
}

/**
 * Hosts a bcx plugin in the control plane (PLAN.md §5.5): verifies its sha256 pin, execs it with
 * the magic cookie, a socket dir and an ephemeral client certificate, reads the handshake line,
 * dials with mTLS pinned to the handshake's server certificate, and exposes the drivers from
 * Describe as `DriverDefinition`s whose operations call `Invoke`. A crashed plugin is restarted
 * with back-off (the pin is checked again); calls in flight fail with a retryable `DRIVER_ERROR`
 * (`details.driverCode: 'unreachable'`), and calls made meanwhile wait for the restart.
 *
 * ```ts
 * const acme = externalDriver({ command: ['/opt/bc/plugins/acme-bmc'], sha256: '…' });
 * const compute = betterCompute({ drivers: [...builtins, ...(await acme.start())], … });
 * ```
 */
export function externalDriver(options: ExternalDriverOptions): ExternalDriverHost {
  const command = Object.freeze([...options.command]);
  if (!command.length || command.some((part) => typeof part !== 'string' || !part))
    throw invalidConfig('externalDriver needs a command');
  const expected = options.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected))
    throw invalidConfig('externalDriver sha256 must be 64 hex characters');
  const log = options.log ?? defaultLog;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const graceMs = options.shutdownGraceMs ?? 5_000;
  const initialDelayMs = options.restart?.initialDelayMs ?? 250;
  const maxDelayMs = options.restart?.maxDelayMs ?? 30_000;
  const fields = { plugin: command[0] };

  let current: Running | undefined;
  let pending: Promise<Running> | undefined;
  let starting: Promise<RemoteDriverDefinition[]> | undefined;
  let definitions: RemoteDriverDefinition[] = [];
  let described = '';
  let failed: unknown;
  let closed = false;
  let delayMs = initialDelayMs;
  let restarts = 0;
  let timer: NodeJS.Timeout | undefined;

  const unavailable = (message: string) =>
    new ComputeError('DRIVER_ERROR', message, undefined, {
      driverCode: 'unreachable',
      retryable: true,
      ...fields,
    });

  async function launch(): Promise<{ running: Running; response: driver.DescribeResponse }> {
    const cwd = options.cwd ?? process.cwd();
    const pinned = pinnedFile(command, cwd);
    const actual = await sha256File(pinned);
    if (actual !== expected)
      throw invalidConfig(
        `The plugin ${pinned} does not match its pin: sha256 ${actual}, expected ${expected}`,
      );
    const identity = createEphemeralIdentity('bcx-host');
    const socketDir = await mkdtemp(join(tmpdir(), 'bcx-'));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && inheritedEnv.has(name.toUpperCase())) env[name] = value;
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    try {
      child = spawn(resolveExecutable(command[0]!, cwd, process.env), command.slice(1), {
        cwd,
        env: {
          ...env,
          ...options.env,
          [BCX_MAGIC_COOKIE_KEY]: BCX_MAGIC_COOKIE_VALUE,
          [BCX_SOCKET_DIR]: socketDir,
          [BCX_CLIENT_CERT]: identity.certificatePem,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdin!.on('error', () => {}); // EPIPE once the plugin is gone.
      child.on('error', (error) =>
        log.warn('bcx plugin process error', { ...fields, error: error.message }),
      );
      exited = exitOf(child);
      const handshake = await awaitHandshake(child, startTimeoutMs, log, {
        ...fields,
        pid: child.pid,
      });
      const connection = await connectPlugin(handshake, identity, { timeoutMs: startTimeoutMs });
      let response: driver.DescribeResponse;
      try {
        response = await connection.describe(AbortSignal.timeout(startTimeoutMs));
      } catch (error) {
        connection.close();
        throw error;
      }
      if (response.protocolVersion !== BCX_PROTOCOL_VERSION) {
        connection.close();
        throw invalidConfig(`The plugin speaks bcx ${response.protocolVersion}, not 1`);
      }
      return {
        running: { child, connection, socketDir, startedAt: Date.now(), exited, lost: false },
        response,
      };
    } catch (error) {
      if (child && exited) await stopProcess({ child, exited, socketDir }, 0);
      else await rm(socketDir, { recursive: true, force: true }).catch(() => {});
      throw error instanceof GrpcError
        ? unavailable(`Cannot reach the plugin: ${error.message}`)
        : error;
    }
  }

  /** The plugin process or its connection went away: fail its calls and restart it. */
  function lost(running: Running, reason: string): void {
    if (running.lost) return;
    running.lost = true;
    if (current === running) current = undefined;
    running.connection.close();
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
    void running.exited.then(() =>
      rm(running.socketDir, { recursive: true, force: true }).catch(() => {}),
    );
    if (closed) return;
    log.warn('bcx plugin lost; restarting', { ...fields, pid: running.child.pid, reason });
    scheduleRestart(Date.now() - running.startedAt);
  }

  function supervise(running: Running): void {
    current = running;
    void running.exited.then(() =>
      lost(running, `exited (${running.child.exitCode ?? running.child.signalCode ?? 'unknown'})`),
    );
    running.connection.onClose(() => lost(running, 'connection closed'));
  }

  function scheduleRestart(uptimeMs: number): void {
    // A plugin that ran for a while starts over at the initial delay.
    if (uptimeMs >= maxDelayMs) delayMs = initialDelayMs;
    const wait = delayMs;
    delayMs = Math.min(delayMs * 2, maxDelayMs);
    const attempt = new Promise<Running>((resolveRestart, rejectRestart) => {
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return rejectRestart(unavailable('The plugin host is closed'));
        launch().then(
          ({ running, response }) => {
            restarts++;
            if (pending === attempt) pending = undefined;
            if (closed) {
              void stopProcess(running, graceMs);
              return rejectRestart(unavailable('The plugin host is closed'));
            }
            if (describe(response) !== described)
              log.warn(
                'The restarted plugin describes other drivers; keeping the registered ones',
                fields,
              );
            supervise(running);
            log.info('bcx plugin restarted', { ...fields, pid: running.child.pid, restarts });
            resolveRestart(running);
          },
          (error: unknown) => {
            log.error('bcx plugin restart failed', {
              ...fields,
              error: error instanceof Error ? error.message : String(error),
            });
            if (isComputeError(error, 'INVALID_CONFIG')) {
              // The pin no longer matches (or the command is gone): stop restarting.
              failed = error;
              if (pending === attempt) pending = undefined;
              return rejectRestart(error);
            }
            rejectRestart(
              unavailable(`The plugin could not be restarted: ${(error as Error).message}`),
            );
            if (!closed) scheduleRestart(0);
          },
        );
      }, wait);
    });
    attempt.catch(() => {}); // Only calls waiting for it care.
    pending = attempt;
  }

  const describe = (response: driver.DescribeResponse) =>
    JSON.stringify(response.drivers.map((entry) => [entry.id, entry.version, entry.kinds]));

  async function connection(): Promise<PluginConnection> {
    if (closed) throw unavailable('The plugin host is closed');
    if (failed) throw failed;
    // The first start may still be running.
    if (!current && !pending && starting) await starting.catch(() => {});
    // Noticed before the close event: restart now rather than dial a dead connection.
    if (current?.connection.closed) lost(current, 'connection closed');
    if (current) return current.connection;
    if (pending) return (await pending).connection;
    throw new ComputeError('INVALID_STATE', `Start the plugin ${command[0]} before calling it`);
  }

  const port: CallPort = { connection, callTimeoutMs: options.callTimeoutMs };

  return {
    command,
    start() {
      starting ??= (async () => {
        const { running, response } = await launch();
        if (closed) {
          await stopProcess(running, graceMs);
          throw unavailable('The plugin host is closed');
        }
        described = describe(response);
        definitions = response.drivers.map((manifest) => remoteDefinition(manifest, port));
        supervise(running);
        return definitions;
      })();
      const attempt = starting;
      attempt.catch(() => {
        if (starting === attempt) starting = undefined; // A failed start may be retried.
      });
      return attempt;
    },
    get drivers() {
      return definitions;
    },
    get pid() {
      return current?.child.pid;
    },
    get restarts() {
      return restarts;
    },
    async health(signal) {
      const response = await (await connection()).health(signal);
      return {
        serving: response.status === driver.HealthStatus.SERVING,
        message: response.message,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      const running = current;
      current = undefined;
      if (running) {
        running.lost = true;
        running.connection.close();
        await stopProcess(running, graceMs);
      }
    },
  };
}

/**
 * Starts several plugin hosts and returns all their drivers, for wherever drivers go today:
 * `betterCompute({ drivers: [...builtins, ...(await startExternalDrivers([acme]))] })`.
 */
export async function startExternalDrivers(
  hosts: readonly ExternalDriverHost[],
): Promise<RemoteDriverDefinition[]> {
  return (await Promise.all(hosts.map((host) => host.start()))).flat();
}
