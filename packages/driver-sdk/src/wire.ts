import { create } from '@bufbuild/protobuf';
import {
  ComputeError,
  isComputeError,
  isErrorCode,
  type Progress,
  type RunsOn,
} from '@better-compute/core';
import { RunsOn as WireRunsOn, driver } from '@better-compute/protocol';

// What crosses the bcx wire besides protobuf framing: JSON arguments and results, progress,
// errors and run locations, identical on the plugin and the host side.

/** Capability flag a plugin advertises for an operation served over `Stream`, not `Invoke`. */
export const STREAM_CAPABILITY_PREFIX = 'bcx.stream:';

const runsOnWire: Readonly<Record<RunsOn, WireRunsOn>> = {
  'control-plane': WireRunsOn.CONTROL_PLANE,
  site: WireRunsOn.SITE,
  node: WireRunsOn.NODE,
  ramdisk: WireRunsOn.RAMDISK,
};

export function runsOnToWire(runsOn: RunsOn): WireRunsOn {
  return runsOnWire[runsOn] ?? WireRunsOn.UNSPECIFIED;
}

/** Unknown or unspecified values run in the control plane, where an `externalDriver` lives. */
export function runsOnFromWire(value: WireRunsOn): RunsOn {
  const entry = Object.entries(runsOnWire).find(([, wire]) => wire === value);
  return (entry?.[0] as RunsOn | undefined) ?? 'control-plane';
}

/**
 * Operation arguments on the wire (`InvokeRequest.args_json`): a JSON array of the positional
 * arguments, `[]` for none. Trailing `undefined`s are dropped (JSON has no `undefined`; inner ones
 * become `null`). Values must be JSON: no `Uint8Array`, `Map` or class instances.
 */
export function encodeArgs(args: readonly unknown[]): string {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length--;
  return JSON.stringify(args.slice(0, length));
}

/**
 * The inverse of `encodeArgs`. For hosts in other languages, an empty string means no arguments
 * and any JSON value that is not an array (typically an object) is the single argument.
 */
export function decodeArgs(json: string): unknown[] {
  if (json.trim() === '') return [];
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) ? value : [value];
}

/** An operation's result as `result_json`: `undefined` travels as `null`. */
export function encodeResult(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** The inverse of `encodeResult`: `null` comes back as `undefined` (the usual `void`). */
export function decodeResult(json: string): unknown {
  const value: unknown = json === '' ? null : JSON.parse(json);
  return value === null ? undefined : value;
}

export function progressToWire(progress: Progress): driver.Progress {
  const percent =
    typeof progress.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, Math.round(progress.percent)))
      : 0;
  return create(driver.ProgressSchema, {
    percent,
    phase: typeof progress.phase === 'string' ? progress.phase : '',
    message: typeof progress.message === 'string' ? progress.message : '',
  });
}

/** Wire progress as core `Progress`; empty fields and `percent: 0` ("unknown") are left out. */
export function progressFromWire(progress: driver.Progress): Progress {
  const out: Progress = {};
  if (progress.phase) out.phase = progress.phase;
  if (progress.message) out.message = progress.message;
  if (progress.percent > 0) out.percent = Math.min(100, progress.percent);
  return out;
}

const driverCodePattern = /^[a-z][a-z0-9-]{0,63}$/;
const maxMessageLength = 2048;

/**
 * An error with a wire code of the driver's choosing (`unreachable`, `timeout`, …), which the host
 * turns back into `DRIVER_ERROR` with the code in `details.driverCode`.
 */
export function driverError(code: string, message: string): ComputeError {
  if (!driverCodePattern.test(code))
    throw new ComputeError(
      'INVALID_INPUT',
      `Driver error code ${code} must be lowercase kebab-case`,
    );
  return new ComputeError('DRIVER_ERROR', message, undefined, { driverCode: code });
}

/**
 * A thrown value as a `DriverError`. `ComputeError` codes travel in kebab-case (`INVALID_CONFIG` →
 * `invalid-config`) unless `details.driverCode` names one; any other error is `driver-error` with
 * its message, since the host is the plugin's operator.
 */
export function errorToWire(error: unknown, retryable: boolean): driver.DriverError {
  let code = 'driver-error';
  let message = error instanceof Error ? error.message : String(error);
  if (isComputeError(error)) {
    const custom = error.details?.driverCode;
    code =
      typeof custom === 'string' && driverCodePattern.test(custom)
        ? custom
        : error.code.toLowerCase().replaceAll('_', '-');
  }
  if (message.length > maxMessageLength) message = `${message.slice(0, maxMessageLength)}…`;
  return create(driver.DriverErrorSchema, { code, message, retryable });
}

/** Which call an error came from, for the `ComputeError` details on the host. */
export interface CallSite {
  driver: string;
  kind: string;
  operation: string;
}

/**
 * A `DriverError` as the `ComputeError` a host throws: a code that names a core `ErrorCode` in
 * kebab-case maps back to it, anything else is `DRIVER_ERROR`. `details` carries `driverCode`,
 * `retryable` and the call site.
 */
export function errorFromWire(error: driver.DriverError, site: CallSite): ComputeError {
  const code = error.code.toUpperCase().replaceAll('-', '_');
  return new ComputeError(
    isErrorCode(code) ? code : 'DRIVER_ERROR',
    error.message || `${site.driver} ${site.kind}.${site.operation} failed (${error.code})`,
    undefined,
    { driverCode: error.code || 'driver-error', retryable: error.retryable, ...site },
  );
}

/** A top-level config field `x-bc` marks `kind: 'secret'` (or JSON Schema `writeOnly`). */
export function secretFields(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(
      ([, property]) =>
        isRecord(property) &&
        ((isRecord(property['x-bc']) && property['x-bc'].kind === 'secret') ||
          property.writeOnly === true),
    )
    .map(([name]) => name);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
