import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  isComputeError,
  systemClock,
  type DriverContext,
  type Logger,
  type Progress,
  type SecretRef,
} from '@better-compute/core';
import {
  externalDriver,
  sha256File,
  type ExternalDriverHost,
  type RemoteDriverDefinition,
} from '@better-compute/driver-sdk';

const fixture = fileURLToPath(new URL('./fixtures/bcx-echo-driver.mjs', import.meta.url));
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const secrets: Record<string, string> = { 'secret://pw': 'hunter2', 'secret://note': 'leaked' };

interface Harness {
  context: DriverContext & { deadline?: number; traceparent?: string };
  progress: Progress[];
  resolved: string[];
  abort(reason?: unknown): void;
}

function harness(extra: { deadline?: number; traceparent?: string } = {}): Harness {
  const progress: Progress[] = [];
  const resolved: string[] = [];
  const controller = new AbortController();
  return {
    progress,
    resolved,
    abort: (reason) => controller.abort(reason),
    context: {
      idempotencyKey: 'wf:1:power',
      signal: controller.signal,
      clock: systemClock,
      log: silent,
      emit: (entry) => progress.push(entry),
      secrets: {
        async resolve(ref: SecretRef) {
          resolved.push(ref);
          const value = secrets[ref];
          if (value === undefined) throw new ComputeError('NOT_FOUND', `no secret ${ref}`);
          return value;
        },
      },
      ...extra,
    },
  };
}

/** The error a promise rejects with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error as ComputeError,
  );

let host: ExternalDriverHost;
let echo: RemoteDriverDefinition;
let quiet: RemoteDriverDefinition;
const config = { endpoint: 'https://bmc.example', password: 'secret://pw' };

beforeAll(async () => {
  host = externalDriver({
    command: [process.execPath, fixture],
    sha256: await sha256File(fixture),
    log: silent,
  });
  const drivers = await host.start();
  echo = drivers.find((entry) => entry.id === 'echo')!;
  quiet = drivers.find((entry) => entry.id === 'quiet')!;
});

afterAll(async () => {
  await host?.close();
});

describe('Describe', () => {
  it('exposes each served driver as a DriverDefinition', () => {
    expect(host.drivers.map((entry) => entry.id)).toEqual(['echo', 'quiet']);
    expect(echo).toMatchObject({
      extension: 'driver',
      id: 'echo',
      version: '1.2.3',
      runsOn: 'control-plane',
      retrySafe: {
        power: ['getPower'],
        demo: ['echo', 'fail', 'boom', 'waitForAbort', 'ignoreAbort', 'pid'],
      },
    });
    expect(Object.keys(echo.implements)).toEqual(['power', 'demo']);
    expect(echo.capabilities).toEqual(['echo', 'bcx.stream:demo.console']);
    expect(quiet).toMatchObject({ runsOn: 'site', capabilities: [] });
    expect(Object.keys(quiet.implements)).toEqual(['management']);
  });

  it("carries the manifest's JSON Schema, with the secret field declared", () => {
    const schema = echo.config.jsonSchema();
    expect(schema).toMatchObject({
      type: 'object',
      required: ['endpoint'],
      additionalProperties: false,
    });
    expect(Object.keys(schema.properties as object)).toEqual([
      'endpoint',
      'password',
      'note',
      'timeout',
    ]);
    expect(echo.config.secretFields).toEqual(['password']);
    expect(echo.config.redact({ ...config, note: 'n' })).toEqual({
      endpoint: config.endpoint,
      password: '********',
      note: 'n',
    });
  });

  it('checks config structurally on the host side', async () => {
    const result = await echo.config['~standard'].validate({ endpoint: 7, extra: true });
    expect(result.issues?.map((issue) => [issue.path, issue.message])).toEqual([
      [['endpoint'], 'Expected string'],
      [['extra'], 'Unknown field extra'],
    ]);
    expect(() => echo.config.parse({ password: 'plain' })).toThrow(/Required|Must match/);
    expect(echo.config.parse(config)).toEqual(config);
  });

  it('answers Health', async () => {
    expect(await host.health()).toEqual({ serving: true, message: '' });
  });
});

describe('Validate', () => {
  it('accepts a valid config, resolving the declared secret for the live check', async () => {
    const { context, resolved } = harness();
    await expect(echo.validate!(config, context)).resolves.toBeUndefined();
    expect(resolved).toEqual(['secret://pw']);
  });

  it("maps the manifest's and the validate hook's errors to issues", async () => {
    const shape = await failure(echo.validate!({ endpoint: 5, colour: 'red' }, harness().context));
    expect(isComputeError(shape, 'INVALID_INPUT')).toBe(true);
    expect(shape.details?.issues).toEqual([
      { message: 'Unknown field colour', path: ['colour'] },
      { message: 'Expected a string', path: ['endpoint'] },
    ]);

    const live = await failure(echo.validate!({ endpoint: 'down:bmc' }, harness().context));
    expect(live.message).toBe('endpoint: Cannot reach the endpoint');
    expect(live.details?.issues).toEqual([
      { message: 'Cannot reach the endpoint', path: ['endpoint'] },
    ]);

    const wrong = await failure(
      echo.validate!({ endpoint: 'https://x', password: 'secret://note' }, harness().context),
    );
    expect(wrong.details?.issues).toEqual([{ message: 'The password is wrong', path: [] }]);
  });
});

describe('Invoke', () => {
  it('runs power operations with progress and a result', async () => {
    const { context, progress } = harness();
    const power = echo.implements.power!(config, context);
    await expect(power.setPower!('on')).resolves.toBeUndefined();
    expect(progress).toEqual([
      { phase: 'power', message: 'setting on', percent: 50 },
      { phase: 'power', message: 'power is on', percent: 100 },
    ]);
    await expect(power.getPower!()).resolves.toBe('on');
  });

  it('sends positional JSON arguments, the idempotency key, the deadline and traceparent', async () => {
    const deadline = Date.now() + 60_000;
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const demo = echo.implements.demo!(config, harness({ deadline, traceparent }).context);
    await expect(demo.echo!('pxe', { persistent: true, uefi: false })).resolves.toEqual({
      args: ['pxe', { persistent: true, uefi: false }],
      endpoint: config.endpoint,
      timeout: 30_000, // The plugin applied the manifest's default and parsed the duration.
      idempotencyKey: 'wf:1:power',
      traceparent,
      deadline,
    });
  });

  it('streams progress to emit when awaited, or yields it when iterated', async () => {
    const awaited = harness();
    await expect(echo.implements.demo!(config, awaited.context).steps!(4)).resolves.toEqual({
      count: 4,
    });
    expect(awaited.progress.map((entry) => entry.percent)).toEqual([25, 50, 75, 100]);

    const iterated = harness();
    const seen: Progress[] = [];
    for await (const entry of echo.implements.demo!(config, iterated.context).deploy!(3))
      seen.push(entry);
    expect(seen).toEqual([
      { phase: 'deploy', percent: 33 },
      { phase: 'deploy', percent: 67 },
      { phase: 'deploy', percent: 100 },
    ]);
    expect(iterated.progress).toEqual([]);
  });

  it('maps DriverErrors back to ComputeErrors, retryable only for retry-safe operations', async () => {
    const { context } = harness();
    const unreachable = await failure(echo.implements.power!(config, context).setPower!('nmi'));
    expect(unreachable.code).toBe('DRIVER_ERROR');
    expect(unreachable.message).toBe('The BMC did not answer');
    expect(unreachable.details).toMatchObject({
      driverCode: 'unreachable',
      retryable: false, // setPower is not retry-safe.
      driver: 'echo',
      kind: 'power',
      operation: 'setPower',
    });

    const demo = echo.implements.demo!(config, context);
    const conflict = await failure(demo.fail!('CONFLICT', 'busy'));
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.message).toBe('busy');
    expect(conflict.details).toMatchObject({ driverCode: 'conflict', retryable: true });

    const boom = await failure(demo.boom!());
    expect(boom.code).toBe('DRIVER_ERROR');
    expect(boom.details).toMatchObject({ driverCode: 'driver-error', retryable: true });

    const unknown = await failure(demo.missing!());
    expect(unknown.code).toBe('UNSUPPORTED');
    expect(unknown.details).toMatchObject({ retryable: false });

    // The second driver of the same plugin.
    await expect(
      quiet.implements.management!({}, context).setBootDevice!('pxe', {
        persistent: false,
        uefi: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a config the manifest rejects as INVALID_CONFIG', async () => {
    const error = await failure(echo.implements.demo!({ endpoint: 42 }, harness().context).echo!());
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain('/endpoint: Expected a string');
    expect(error.details).toMatchObject({ retryable: false });
  });
});

describe('deadlines and cancellation', () => {
  it('turns the deadline into an AbortSignal and ends the call with timeout', async () => {
    const started = Date.now();
    const { context } = harness({ deadline: Date.now() + 300 });
    const error = await failure(echo.implements.demo!(config, context).waitForAbort!());
    expect(error.code).toBe('DRIVER_ERROR');
    expect(error.details).toMatchObject({ driverCode: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('ends the call at the deadline even when the operation ignores the signal', async () => {
    const { context } = harness({ deadline: Date.now() + 300 });
    const error = await failure(echo.implements.demo!(config, context).ignoreAbort!());
    expect(error.details).toMatchObject({ driverCode: 'timeout' });
  });

  it("cancels the call when the caller's signal aborts", async () => {
    const run = harness();
    const call = echo.implements.demo!(config, run.context).waitForAbort!();
    setTimeout(() => run.abort(new ComputeError('CONFLICT', 'superseded')), 100);
    const error = await failure(call);
    expect(error.message).toBe('superseded');
    // The plugin is still healthy afterwards.
    expect(await host.health()).toMatchObject({ serving: true });
  });
});

describe('secrets', () => {
  it('delivers only the fields the manifest declares secret', async () => {
    const run = harness();
    const demo = echo.implements.demo!({ ...config, note: 'secret://note' }, run.context);
    await expect(demo.secret!('secret://pw')).resolves.toBe('hunter2');
    // `note` is a plain string field: its secret-looking value is never resolved or sent.
    const denied = await failure(demo.secret!('secret://note'));
    expect(denied.code).toBe('ACCESS_DENIED');
    expect(denied.message).toMatch(/not delivered/);
    expect(run.resolved).toEqual(['secret://pw', 'secret://pw']);
  });

  it('sends no secrets when the config names none', async () => {
    const run = harness();
    const demo = echo.implements.demo!({ endpoint: 'https://x' }, run.context);
    expect((await failure(demo.secret!('secret://pw'))).code).toBe('ACCESS_DENIED');
    expect(run.resolved).toEqual([]);
  });
});

describe('Stream', () => {
  it('opens a byte stream for an operation the plugin advertises as streaming', async () => {
    const { context } = harness();
    const duplex = (await echo.implements.demo!(config, context).console!('> ')) as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };
    const writer = duplex.writable.getWriter();
    const reader = duplex.readable.getReader();
    await writer.write(new TextEncoder().encode('hello'));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('> HELLO');
    await writer.close();
    expect((await reader.read()).done).toBe(true);
  });
});
