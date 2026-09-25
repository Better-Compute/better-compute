import type { DriverContext, DriverDefinition, Json, SecretResolver } from '@better-compute/core';

// The daemon's driver host for `driver.invoke` (PLAN.md §5.5, §11.2): one driver operation
// `<concern>.<operation>` of a driver the agent hosts — built in, or a bcx plugin whose host
// (`externalDriver` of @better-compute/driver-sdk) hands out the same `DriverDefinition`s. bcd does
// this in Go; this is the TypeScript side for FakeDaemon and TS agents.

/** What a `driver.invoke` asks for: the provision engine's expanded step (`args` of the request). */
export interface DriverInvocation {
  concern: string;
  operation: string;
  /** The step's `with`, passed as the operation's single argument. */
  args?: Json;
  /** The driver bound for the concern; without it, the only hosted driver implementing it. */
  driver?: string;
  config?: Json;
}

/** The call around it. */
export interface DriverInvocationContext {
  nodeId?: string;
  idempotencyKey: string;
  /** Epoch ms the operation must finish by. */
  deadline?: number;
  now(): number;
  secrets?: SecretResolver;
  log?: DriverContext['log'];
}

/** Why an invocation failed, as the command result reports it (kebab-case, like bcx codes). */
export class DriverInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const noSecrets: SecretResolver = {
  resolve: async (ref) => {
    throw new DriverInvocationError('secret-unavailable', `This agent cannot resolve ${ref}`);
  },
};
const quiet: DriverContext['log'] = { debug() {}, info() {}, warn() {}, error() {} };

/** Parses the invocation out of the request's `args` (a JSON object). */
export function parseDriverInvocation(value: unknown): DriverInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DriverInvocationError('invalid-payload', 'driver.invoke args must be an object');
  const input = value as Record<string, unknown>;
  const name = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
  if (typeof input.concern !== 'string' || !name.test(input.concern))
    throw new DriverInvocationError('invalid-payload', 'driver.invoke needs a concern');
  if (typeof input.operation !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.operation))
    throw new DriverInvocationError('invalid-payload', 'driver.invoke needs an operation');
  if (input.driver !== undefined && (typeof input.driver !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(input.driver)))
    throw new DriverInvocationError('invalid-payload', 'driver.invoke driver is not a driver id');
  const invocation: DriverInvocation = { concern: input.concern, operation: input.operation };
  if (input.args !== undefined) invocation.args = input.args as Json;
  if (input.driver !== undefined) invocation.driver = input.driver as string;
  if (input.config !== undefined) invocation.config = input.config as Json;
  return invocation;
}

/**
 * Runs one driver operation on the hosted drivers and returns its JSON result. Unknown drivers,
 * concerns and operations fail with `driver-not-found` / `unsupported`; the operation's own errors
 * keep their code (`details.driverCode` of a bcx DRIVER_ERROR, else the ComputeError code).
 */
export async function invokeDriver(
  drivers: readonly DriverDefinition[],
  invocation: DriverInvocation,
  context: DriverInvocationContext,
): Promise<Json> {
  const candidates = drivers.filter(
    (definition) =>
      (invocation.driver === undefined || definition.id === invocation.driver) &&
      Object.hasOwn(definition.implements, invocation.concern),
  );
  if (candidates.length === 0)
    throw new DriverInvocationError(
      'driver-not-found',
      invocation.driver
        ? `driver ${invocation.driver} is not hosted here or does not implement ${invocation.concern}`
        : `no hosted driver implements ${invocation.concern}`,
    );
  if (candidates.length > 1)
    throw new DriverInvocationError(
      'ambiguous-driver',
      `several hosted drivers implement ${invocation.concern}; the step must name one`,
    );
  const definition = candidates[0]!;
  const controller = new AbortController();
  const remaining = context.deadline === undefined ? undefined : context.deadline - context.now();
  const timer =
    remaining === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(0, remaining));
  const driverContext: DriverContext = {
    idempotencyKey: context.idempotencyKey,
    signal: controller.signal,
    clock: { now: context.now },
    secrets: context.secrets ?? noSecrets,
    log: context.log ?? quiet,
    emit() {},
    ...(context.nodeId ? { node: { id: context.nodeId } as DriverContext['node'] } : {}),
    ...(context.deadline !== undefined ? { deadline: context.deadline } : {}),
  };
  try {
    const factory = (definition.implements as Record<string, (config: unknown, ctx: DriverContext) => unknown>)[
      invocation.concern
    ]!;
    const implementation = (await factory(invocation.config ?? {}, driverContext)) as Record<string, unknown>;
    const operation = implementation?.[invocation.operation];
    if (typeof operation !== 'function')
      throw new DriverInvocationError(
        'unsupported',
        `${definition.id} ${invocation.concern} has no operation ${invocation.operation}`,
      );
    let result = (operation as (...args: unknown[]) => unknown).apply(
      implementation,
      invocation.args === undefined ? [] : [invocation.args],
    );
    // An operation that yields progress (AsyncIterable) ends with its last value.
    if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
      let last: unknown = null;
      for await (const item of result as AsyncIterable<unknown>) last = item;
      result = last;
    } else result = await result;
    return (result === undefined ? null : result) as Json;
  } catch (error) {
    if (error instanceof DriverInvocationError) throw error;
    const details = (error as { details?: { driverCode?: unknown } }).details;
    const code =
      typeof details?.driverCode === 'string'
        ? details.driverCode
        : typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code: string }).code).toLowerCase().replaceAll('_', '-')
          : 'driver-error';
    throw new DriverInvocationError(code, error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
