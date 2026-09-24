// A bcx plugin for tests/driver-sdk-*.test.ts: `defineDriver` objects served by `serveDriver`,
// run as `node tests/fixtures/bcx-echo-driver.mjs` (./bcx-loader.mjs maps the workspace sources).
//
// `echo` implements `power` (getPower/setPower, which emits progress) and `demo` (operations for
// arguments, progress, errors, deadlines, secrets, a crash and a byte stream); `quiet` runs on a
// site agent and implements `management`. BCX_ECHO_HANG=1 never prints the handshake.
import './bcx-loader.mjs';

const { ComputeError, defineDriver, field, manifest } = await import('@better-compute/core');
const { driverError, serveDriver } = await import('@better-compute/driver-sdk');

if (process.env.BCX_ECHO_HANG === '1') {
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let power = 'off';

const echo = defineDriver({
  id: 'echo',
  version: '1.2.3',
  runsOn: 'control-plane',
  config: manifest({
    endpoint: field.string(),
    password: field.secret().optional(),
    note: field.string().optional(),
    timeout: field.duration().default('30s'),
  }),
  capabilities: ['echo'],
  implements: {
    power: (_config, ctx) => ({
      async getPower() {
        return power;
      },
      async setPower(action) {
        ctx.emit({ phase: 'power', message: `setting ${action}`, percent: 50 });
        if (action === 'nmi') throw driverError('unreachable', 'The BMC did not answer');
        power = action === 'on' ? 'on' : 'off';
        ctx.emit({ phase: 'power', message: `power is ${power}`, percent: 100 });
      },
    }),
    demo: (config, ctx) => ({
      async echo(...args) {
        return {
          args,
          endpoint: config.endpoint,
          timeout: config.timeout,
          idempotencyKey: ctx.idempotencyKey,
          traceparent: ctx.traceparent ?? null,
          deadline: ctx.deadline ?? null,
        };
      },
      async steps(count) {
        for (let step = 1; step <= count; step++) {
          ctx.emit({ phase: 'step', message: `step ${step}`, percent: (step * 100) / count });
          await sleep(2);
        }
        return { count };
      },
      async *deploy(count) {
        for (let step = 1; step <= count; step++) {
          await sleep(2);
          yield { phase: 'deploy', percent: (step * 100) / count };
        }
      },
      waitForAbort() {
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
        );
      },
      ignoreAbort() {
        return new Promise(() => {});
      },
      async secret(ref) {
        return ctx.secrets.resolve(ref);
      },
      async fail(code, message) {
        throw new ComputeError(code, message ?? `failed with ${code}`);
      },
      async boom() {
        throw new Error('boom');
      },
      crash() {
        process.exit(3);
      },
      pid() {
        return process.pid;
      },
      async console(prefix) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const { readable, writable } = new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(encoder.encode(`${prefix}${decoder.decode(chunk).toUpperCase()}`));
          },
        });
        return { readable, writable, close: async () => {} };
      },
    }),
  },
  retrySafe: {
    power: ['getPower'],
    demo: ['echo', 'fail', 'boom', 'waitForAbort', 'ignoreAbort', 'pid'],
  },
  async validate(config, ctx) {
    if (config.endpoint.startsWith('down:'))
      throw new ComputeError('INVALID_INPUT', 'Unreachable endpoint', undefined, {
        issues: [{ message: 'Cannot reach the endpoint', path: ['endpoint'] }],
      });
    if (config.password && (await ctx.secrets.resolve(config.password)) !== 'hunter2')
      throw new Error('The password is wrong');
  },
});

const quiet = defineDriver({
  id: 'quiet',
  version: '0.1.0',
  runsOn: 'site',
  config: manifest({}),
  implements: {
    management: () => ({
      async setBootDevice() {},
    }),
  },
});

await serveDriver([echo, quiet], { pluginVersion: '0.0.1', streams: ['demo.console'] });
