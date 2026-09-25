import { describe, expect, it } from 'vitest';
import { ComputeError, defineDriver, field, manifest } from '@better-compute/core';
import {
  DriverInvocationError,
  invokeDriver,
  parseDriverInvocation,
} from '@better-compute/testing';

// The agent's driver host for driver.invoke (PLAN.md §5.5, §11.2): the provision engine's expanded
// step {concern, operation, args, driver, config} runs one operation of a hosted driver.

const acme = defineDriver({
  id: 'acme-bmc',
  version: '1.0.0',
  runsOn: 'site',
  config: manifest({ address: field.string() }),
  implements: {
    bios: (config: { address: string }, ctx) => ({
      async applySettings(settings: Record<string, string>) {
        return {
          applied: Object.keys(settings).sort(),
          address: config.address,
          key: ctx.idempotencyKey,
        };
      },
      async fail() {
        throw new ComputeError('CONFLICT', 'BIOS is locked');
      },
      async *flash() {
        yield { percent: 50 };
        yield { percent: 100, done: true };
      },
      async slow() {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted by deadline'));
          });
        });
      },
    }),
  },
} as never);
const other = defineDriver({
  id: 'other-bmc',
  version: '1.0.0',
  runsOn: 'site',
  config: manifest({}),
  implements: {
    bios: () => ({
      async applySettings() {
        return 'other';
      },
    }),
  },
} as never);

const context = { idempotencyKey: 'wf:wf_1:main.1', now: () => Date.now() };
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof DriverInvocationError ? error.code : `other:${String(error)}`,
  );

describe('driver.invoke on the agent', () => {
  it('runs the named driver operation with the step args and config', async () => {
    const invocation = parseDriverInvocation({
      concern: 'bios',
      operation: 'applySettings',
      args: { SriovGlobalEnable: 'Enabled', BootMode: 'Uefi' },
      driver: 'acme-bmc',
      config: { address: '10.0.0.9' },
    });
    expect(await invokeDriver([acme, other], invocation, context)).toEqual({
      applied: ['BootMode', 'SriovGlobalEnable'],
      address: '10.0.0.9',
      key: 'wf:wf_1:main.1',
    });
  });

  it('picks the only driver for a concern, and refuses to guess between several', async () => {
    const invocation = parseDriverInvocation({
      concern: 'bios',
      operation: 'applySettings',
      args: {},
    });
    expect(await invokeDriver([other], invocation, context)).toBe('other');
    expect(await code(invokeDriver([acme, other], invocation, context))).toBe('ambiguous-driver');
  });

  it('reports unknown drivers and operations, and the operation’s own errors', async () => {
    const run = (input: Record<string, unknown>) =>
      code(invokeDriver([acme], parseDriverInvocation(input), context));
    expect(await run({ concern: 'bios', operation: 'x', driver: 'nope' })).toBe('driver-not-found');
    expect(await run({ concern: 'power', operation: 'setPower' })).toBe('driver-not-found');
    expect(await run({ concern: 'bios', operation: 'reset', driver: 'acme-bmc' })).toBe(
      'unsupported',
    );
    expect(await run({ concern: 'bios', operation: 'fail', driver: 'acme-bmc' })).toBe('conflict');
  });

  it('ends a progress stream with its last value and enforces the deadline', async () => {
    expect(
      await invokeDriver(
        [acme],
        parseDriverInvocation({ concern: 'bios', operation: 'flash' }),
        context,
      ),
    ).toEqual({ percent: 100, done: true });
    const started = Date.now();
    expect(
      await code(
        invokeDriver([acme], parseDriverInvocation({ concern: 'bios', operation: 'slow' }), {
          ...context,
          deadline: Date.now() + 50,
        }),
      ),
    ).toBe('driver-error');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses malformed invocations', () => {
    for (const bad of [
      null,
      [],
      { concern: 'bios' },
      { concern: '../x', operation: 'y' },
      { concern: 'bios', operation: 'a b' },
    ])
      expect(() => parseDriverInvocation(bad)).toThrow(DriverInvocationError);
  });
});
