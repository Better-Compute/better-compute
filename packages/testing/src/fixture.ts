import {
  ComputeError,
  manualClock,
  systemClock,
  type Caller,
  type Clock,
  type ComputeErrorBody,
  type ComputeModule,
  type ComputePlugin,
  type Logger,
  type SqlExecutor,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam, type FakeIam, type FakeIamOptions } from './fake-iam.js';

/** Where the sim clock starts unless `start` says otherwise: 2026-01-01T00:00:00.000Z. */
const defaultStart = Date.UTC(2026, 0, 1);
const secret = 'better-compute-testing-fixture-secret-0123456789';
const baseURL = 'https://compute.example.test';

export interface ComputeFixtureOptions<
  M extends readonly ComputeModule[] = [],
  P extends readonly ComputePlugin[] = [],
> {
  /**
   * `sim` (default): compute's `Clock` and SQL's `compute_now()` both read one manual clock that
   * moves only on `advance()`. `system`: the wall clock and the database's own `now()`.
   */
  clock?: 'sim' | 'system';
  /** Where the sim clock starts, in whole milliseconds since the epoch (default 2026-01-01 UTC). */
  start?: number;
  /** Extra callers and rules for the fake IAM; nothing is allowed unless a rule says so. */
  iam?: FakeIamOptions;
  /** Injected modules, as for `betterCompute()`. */
  modules?: M;
  /** Plugins, as for `betterCompute()`. */
  plugins?: P;
  /** Where compute logs (default: warnings and errors as JSON on stderr). */
  log?: Logger;
}

/** One tenant of the fixture and the one signed-in person the fake IAM knows in it. */
export interface FixtureTenant {
  id: string;
  /** A bearer token that authenticates as `caller`. */
  token: string;
  caller: Caller;
}

/**
 * The fixture's business clock. It is compute's `Clock`, and under `sim` it also drives
 * `compute_sim_clock`, so SQL's `compute_now()` always equals `now()`.
 */
export interface FixtureClock extends Clock {
  readonly mode: 'sim' | 'system';
  /** Moves both clocks forward by `ms` whole milliseconds and returns the new time (sim only). */
  advance(ms: number): Promise<number>;
  /** Moves both clocks to `ms`; time never moves backwards (sim only). */
  set(ms: number): Promise<void>;
}

export interface FixtureRequestOptions {
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Routes to `plugins/{plugin}/{group}/{method}`. */
  plugin?: string;
  /** Extra headers; they replace the defaults (`content-type`, `x-better-compute`) they name. */
  headers?: HeadersInit;
}

/** The answer of `request()`: the `{ data }` or `{ error }` envelope with the status and headers. */
export type FixtureResponse<T = unknown> = {
  status: number;
  headers: Headers;
  /** The `X-Request-Id` the server answered with. */
  requestId: string;
} & ({ ok: true; data: T } | { ok: false; error: ComputeErrorBody });

export interface ComputeFixture<
  M extends readonly ComputeModule[] = [],
  P extends readonly ComputePlugin[] = [],
> {
  /** The control plane, initialized: registry checked, base schema and module migrations applied. */
  compute: BetterCompute<M, P>;
  /** The PGlite store behind `compute`, in memory. */
  database: SqlExecutor;
  clock: FixtureClock;
  /** `clock.advance(ms)`. */
  advance(ms: number): Promise<number>;
  /** The scripted IAM port: recorded calls, callers, allow and deny rules. */
  iam: FakeIam;
  /** The platform (root) tenant and two organizations, one signed-in person each. */
  tenants: { root: FixtureTenant; acme: FixtureTenant; other: FixtureTenant };
  /** `POST {basePath}/{group}/{method}` with `input` as JSON, through `compute.handler`. */
  request<T = unknown>(
    group: string,
    method: string,
    input?: unknown,
    options?: FixtureRequestOptions,
  ): Promise<FixtureResponse<T>>;
  /** Stops compute and closes the store; `closeFixtures()` does this for every open fixture. */
  close(): Promise<void>;
}

const open = new Set<() => Promise<void>>();

/**
 * Closes every fixture that is still open, even when one of them fails to close; register it with
 * `afterEach(closeFixtures)`.
 */
export async function closeFixtures(): Promise<void> {
  const failures: unknown[] = [];
  for (const close of [...open]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `${failures.length} fixtures failed to close`);
}

/** Loads an optional peer dependency, or says which one to install. */
async function optionalPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && String(message).includes(name))
      throw new ComputeError(
        'MISSING_DEPENDENCY',
        `computeFixture() needs the optional peer dependency ${name}; install it as a devDependency next to @better-compute/testing`,
      );
    throw error;
  }
}

const wholeMs = (ms: unknown): ms is number =>
  typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0;

function checkMs(ms: unknown, name: string): asserts ms is number {
  if (!wholeMs(ms))
    throw new ComputeError(
      'INVALID_INPUT',
      `${name} takes a whole, non-negative number of milliseconds`,
    );
}

/** A manual clock that moves `compute_sim_clock` first, one move at a time. */
function simClock(database: SqlExecutor, start: number): FixtureClock {
  const clock = manualClock(start);
  let queue: Promise<unknown> = Promise.resolve();
  const move = (target: () => number): Promise<number> => {
    const moved = queue.then(async () => {
      const ms = target();
      await setSimClock(database, ms);
      clock.set(ms);
      return ms;
    });
    queue = moved.catch(() => undefined);
    return moved;
  };
  return {
    mode: 'sim',
    now: () => clock.now(),
    async advance(ms) {
      checkMs(ms, 'advance()');
      return move(() => clock.now() + ms);
    },
    async set(ms) {
      checkMs(ms, 'set()');
      await move(() => ms);
    },
  };
}

/** The wall clock; moving it is `INVALID_STATE`. */
function wallClock(): FixtureClock {
  const refuse = async (): Promise<never> => {
    throw new ComputeError('INVALID_STATE', "Only computeFixture({ clock: 'sim' }) can move time");
  };
  return { mode: 'system', now: () => systemClock.now(), advance: refuse, set: refuse };
}

function fixtureTenants(): ComputeFixture['tenants'] {
  const tenant = (name: string, extra: Partial<Caller> = {}): FixtureTenant => {
    const id = `tenant-${name}`;
    return {
      id,
      token: `biam_ses_fixture_${name}`,
      caller: {
        identityId: `identity-${name}`,
        identityKind: 'user',
        tenantId: id,
        sessionId: `session-${name}`,
        sessionKind: 'user',
        mfa: false,
        ...extra,
      },
    };
  };
  // The root caller stands for a root administrator: a user session with MFA.
  return { root: tenant('root', { mfa: true }), acme: tenant('acme'), other: tenant('other') };
}

/**
 * A control plane for tests (PLAN.md §15): PGlite in memory, migrated by `compute.initialize()`; the
 * sim clock; a fake IAM that knows the root tenant and two organizations, one person each; and a
 * `request()` helper that goes through `compute.handler`, like the typed client does.
 *
 * ```ts
 * afterEach(closeFixtures);
 *
 * it('reads the version over HTTP', async () => {
 *   const { request, advance } = await computeFixture();
 *   expect(await request('system', 'version')).toMatchObject({ ok: true, status: 200 });
 *   await advance(60_000); // compute_now() moves with it
 * });
 * ```
 *
 * Embedded better-iam on its SQLite adapter replaces the fake IAM once the IAM bridge lands (v0.1).
 */
export async function computeFixture<
  const M extends readonly ComputeModule[] = [],
  const P extends readonly ComputePlugin[] = [],
>(options: ComputeFixtureOptions<M, P> = {}): Promise<ComputeFixture<M, P>> {
  if (typeof options !== 'object' || options === null)
    throw new ComputeError('INVALID_CONFIG', 'computeFixture() takes an options object');
  const mode = options.clock ?? 'sim';
  if (mode !== 'sim' && mode !== 'system')
    throw new ComputeError('INVALID_CONFIG', "clock must be 'sim' or 'system'");
  const start = options.start ?? defaultStart;
  if (!wholeMs(start))
    throw new ComputeError(
      'INVALID_CONFIG',
      'start must be a whole, non-negative number of milliseconds',
    );

  await optionalPeer('@electric-sql/pglite', () => import('@electric-sql/pglite'));

  const tenants = fixtureTenants();
  const iam = fakeIam({
    ...options.iam,
    callers: {
      ...Object.fromEntries(Object.values(tenants).map(({ token, caller }) => [token, caller])),
      ...options.iam?.callers,
    },
  });
  const database = pglite();
  const clock = mode === 'sim' ? simClock(database, start) : wallClock();

  let compute: BetterCompute<M, P> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      open.delete(close);
      try {
        await compute?.stop();
      } finally {
        await database.close();
      }
    })());
  open.add(close);

  try {
    compute = betterCompute<M, P>({
      database,
      iam,
      secret,
      baseURL,
      rootTenantId: tenants.root.id,
      clock,
      ...(options.modules ? { modules: options.modules } : {}),
      ...(options.plugins ? { plugins: options.plugins } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    await compute.initialize();
    if (mode === 'sim') await useSimClock(database, start);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const ready = compute;

  async function request<T = unknown>(
    group: string,
    method: string,
    input: unknown = {},
    requestOptions: FixtureRequestOptions = {},
  ): Promise<FixtureResponse<T>> {
    const path =
      requestOptions.plugin === undefined
        ? `${group}/${method}`
        : `plugins/${requestOptions.plugin}/${group}/${method}`;
    const headers = new Headers({ 'content-type': 'application/json', 'x-better-compute': '1' });
    if (requestOptions.token !== undefined)
      headers.set('authorization', `Bearer ${requestOptions.token}`);
    new Headers(requestOptions.headers).forEach((value, key) => headers.set(key, value));
    const { origin, basePath } = ready.endpoint;
    const response = await ready.handler(
      new Request(`${origin}${basePath}/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input ?? {}),
      }),
    );
    const body = (await response.json()) as { data?: T; error?: ComputeErrorBody };
    const common = {
      status: response.status,
      headers: response.headers,
      requestId: response.headers.get('x-request-id') ?? '',
    };
    return body.error
      ? { ...common, ok: false, error: body.error }
      : { ...common, ok: true, data: body.data as T };
  }

  return {
    compute: ready,
    database,
    clock,
    advance: (ms) => clock.advance(ms),
    iam,
    tenants,
    request,
    close,
  };
}
