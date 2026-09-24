import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  isComputeError,
  systemClock,
  type DriverContext,
  type Logger,
} from '@better-compute/core';
import { externalDriver, sha256File, type ExternalDriverHost } from '@better-compute/driver-sdk';

const fixture = fileURLToPath(new URL('./fixtures/bcx-echo-driver.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'bcx-supervision-'));
const hosts: ExternalDriverHost[] = [];

afterAll(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  rmSync(scratch, { recursive: true, force: true });
});

function recordingLog() {
  const lines: { level: string; message: string }[] = [];
  const log: Logger = {
    debug: (message) => lines.push({ level: 'debug', message }),
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  };
  return { lines, log };
}

const context = (): DriverContext => ({
  idempotencyKey: 'k',
  signal: new AbortController().signal,
  clock: systemClock,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  emit() {},
  secrets: {
    resolve: async () => {
      throw new ComputeError('NOT_FOUND', 'no secrets here');
    },
  },
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error as ComputeError,
  );

describe('supervision', () => {
  it('restarts a crashed plugin and fails the calls in flight as retryable', async () => {
    const { lines, log } = recordingLog();
    const host = externalDriver({
      command: [process.execPath, fixture],
      sha256: await sha256File(fixture),
      restart: { initialDelayMs: 50 },
      log,
    });
    hosts.push(host);
    const [echo] = await host.start();
    const demo = echo!.implements.demo!({ endpoint: 'https://x' }, context());
    const firstPid = await demo.pid!();
    expect(firstPid).toBe(host.pid);

    // One call waiting forever (given time to reach the plugin), then the plugin exits under a
    // second one.
    const waiting = failure(demo.waitForAbort!());
    await new Promise((resolve) => setTimeout(resolve, 200));
    const crashing = failure(demo.crash!());
    for (const error of [await waiting, await crashing]) {
      expect(error.code).toBe('DRIVER_ERROR');
      expect(error.details).toMatchObject({ driverCode: 'unreachable', retryable: true });
    }

    // Calls made meanwhile wait for the restart.
    const secondPid = await demo.pid!();
    expect(secondPid).not.toBe(firstPid);
    expect(host.pid).toBe(secondPid);
    expect(host.restarts).toBe(1);
    expect(lines.some((line) => line.message === 'bcx plugin lost; restarting')).toBe(true);

    // The same remote definitions keep working against the new process.
    await expect(demo.echo!(1)).resolves.toMatchObject({ args: [1] });
    await host.close();
    expect(host.pid).toBeUndefined();
  });

  it('checks the pin again before a restart and stops when it no longer matches', async () => {
    // A wrapper entry script, so the pinned file can change without touching the fixture.
    const entry = join(scratch, 'plugin.mjs');
    writeFileSync(entry, `await import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
    const { log } = recordingLog();
    const host = externalDriver({
      command: [process.execPath, entry],
      sha256: await sha256File(entry),
      restart: { initialDelayMs: 50 },
      log,
    });
    hosts.push(host);
    const [echo] = await host.start();
    const demo = echo!.implements.demo!({ endpoint: 'https://x' }, context());
    await demo.pid!();

    appendFileSync(entry, '// tampered\n');
    await failure(demo.crash!());
    const refused = await failure(demo.pid!());
    expect(isComputeError(refused, 'INVALID_CONFIG')).toBe(true);
    expect(refused.message).toMatch(/does not match its pin/);
    expect(host.restarts).toBe(0);
  });

  it('stops the plugin gracefully on close', async () => {
    const host = externalDriver({
      command: [process.execPath, fixture],
      sha256: await sha256File(fixture),
      shutdownGraceMs: 10_000,
    });
    hosts.push(host);
    await host.start();
    const started = Date.now();
    await host.close();
    // stdin EOF (and SIGTERM off Windows) is enough: no SIGKILL after the grace period.
    expect(Date.now() - started).toBeLessThan(8_000);
    await expect(host.health()).rejects.toThrow(/closed/);
  });
});
