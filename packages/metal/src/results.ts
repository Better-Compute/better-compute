import { ComputeError, type Json } from '@better-compute/core';
import {
  DeployImageResultSchema,
  DiagDcgmResultSchema,
  InventoryRefreshResultSchema,
  WipeResultSchema,
  decodeMessage,
  site,
  type DeployImageResult,
  type DiagDcgmResult,
  type WipeResult,
} from '@better-compute/protocol';
import type { CommandOutcome } from '@better-compute/provision';

// Command results arrive as the kind's result message in binary protobuf (`CommandUpdate.result`,
// stored as `commands.result`). Decoding them here, per kind, is what makes a failed DCGM run or an
// unverified disk wipe fail its step.

/** A decoded BMC result: `ok`, and the operation's own JSON result. */
export interface BmcResult {
  ok: boolean;
  result: Json;
  errorCode: string;
  message: string;
}

function bytes(outcome: CommandOutcome): Uint8Array {
  return outcome.result ?? new Uint8Array();
}

/** `BmcOperationResult`; a result that is not ok throws `DRIVER_ERROR` with the BMC's error. */
export function bmcResult(outcome: CommandOutcome): BmcResult {
  const message = decodeMessage(site.BmcOperationResultSchema, bytes(outcome));
  let result: Json = {};
  if (message.resultJson)
    try {
      result = JSON.parse(message.resultJson) as Json;
    } catch {
      throw new ComputeError('DRIVER_ERROR', 'The BMC result is not JSON');
    }
  if (!message.ok)
    throw new ComputeError('DRIVER_ERROR', message.message || `BMC operation failed (${message.errorCode || 'unknown'})`, undefined, {
      errorCode: message.errorCode,
    });
  return { ok: true, result, errorCode: message.errorCode, message: message.message };
}

export function dcgmResult(outcome: CommandOutcome): DiagDcgmResult {
  return decodeMessage(DiagDcgmResultSchema, bytes(outcome));
}

export function wipeResult(outcome: CommandOutcome): WipeResult {
  return decodeMessage(WipeResultSchema, bytes(outcome));
}

export function deployResult(outcome: CommandOutcome): DeployImageResult {
  return decodeMessage(DeployImageResultSchema, bytes(outcome));
}

export function inventoryRefreshResult(outcome: CommandOutcome): Record<string, Json> {
  const message = decodeMessage(InventoryRefreshResultSchema, bytes(outcome));
  return plain(message) as Record<string, Json>;
}

export function httpProxyResult(outcome: CommandOutcome): site.HttpProxyResponse {
  return decodeMessage(site.HttpProxyResponseSchema, bytes(outcome));
}

/** A decoded message as JSON: no `$typeName`, bigints as numbers when safe, bytes as base64. */
export function plain(value: unknown): Json {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) if (key !== '$typeName' && child !== undefined) out[key] = plain(child);
    return out;
  }
  return value as Json;
}
