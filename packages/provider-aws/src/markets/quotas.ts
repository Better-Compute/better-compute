import { isComputeError, type Clock } from '@better-compute/core';
import type { JsonClient } from '@better-compute/aws-core';

// EC2 vCPU quotas (AWS A3): Service Quotas `GetServiceQuota` gives the limit of each instance
// family class, running instances give the usage, and the headroom caps how many machines of a
// shape an offer can still promise (`Offer.count`). Read failures leave the count unknown: EC2
// itself still refuses a launch over quota (VcpuLimitExceeded → QUOTA_EXCEEDED).

/** A quota class: the on-demand and Spot quota codes that limit a family of instance types. */
export interface QuotaClass {
  name: string;
  onDemand: string;
  spot: string;
}

/**
 * The EC2 vCPU quota codes. The plan's three on-demand codes (standard, G/VT, P) and their Spot
 * twins are the documented ones; **(verify)** the rest against the Service Quotas console before
 * relying on them in production. A family not listed here has no count.
 */
export const quotaClasses: Readonly<Record<string, QuotaClass>> = {
  standard: { name: 'standard', onDemand: 'L-1216C47A', spot: 'L-34B43A08' },
  g: { name: 'g', onDemand: 'L-DB2E81BA', spot: 'L-3819A6DF' },
  p: { name: 'p', onDemand: 'L-417A185B', spot: 'L-7212CCBC' },
  // (verify) below.
  inf: { name: 'inf', onDemand: 'L-1945791B', spot: 'L-B5D1601B' },
  trn: { name: 'trn', onDemand: 'L-2C3B7624', spot: 'L-6B0D517C' },
  dl: { name: 'dl', onDemand: 'L-6E869C2A', spot: 'L-85EED4F7' },
  f: { name: 'f', onDemand: 'L-74FC7D96', spot: 'L-88CF9481' },
  x: { name: 'x', onDemand: 'L-7295265B', spot: 'L-E3A00192' },
};

/** The quota class of an instance type (`m7i.large` → standard), or undefined when unknown. */
export function quotaClassOf(instanceType: string): QuotaClass | undefined {
  const family = instanceType.split('.')[0] ?? '';
  for (const prefix of ['inf', 'trn', 'dl'] as const)
    if (family.startsWith(prefix) && /\d/.test(family.charAt(prefix.length)))
      return quotaClasses[prefix];
  // Families with quotas of their own that are not modelled (yet): HPC, Mac, high memory.
  if (/^(hpc|mac|u-)/.test(family)) return undefined;
  if (family.startsWith('vt')) return quotaClasses.g;
  const letter = family.charAt(0);
  if ('acdhimrtz'.includes(letter) && letter !== '') return quotaClasses.standard;
  if (letter === 'g') return quotaClasses.g;
  if (letter === 'p') return quotaClasses.p;
  if (letter === 'f') return quotaClasses.f;
  if (letter === 'x') return quotaClasses.x;
  return undefined;
}

/** vCPUs in use per quota code. */
export type QuotaUsage = ReadonlyMap<string, number>;

export interface QuotaReader {
  /**
   * Headroom in vCPUs per quota code, for the codes asked. A code whose limit could not be read
   * (absent, denied, throttled) is missing from the result.
   */
  headroom(codes: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, number>>;
}

const usageTtlMs = 5 * 60_000;
const limitTtlMs = 5 * 60_000;

/**
 * Quota limits (GetServiceQuota, one call per code) and usage (`usage`, the caller's sum over
 * running instances), each cached for 5 minutes, failures included. `onError` sees each failed read
 * but a quota code that does not exist in the region (NOT_FOUND).
 */
export function quotaReader(options: {
  client: JsonClient;
  clock: Clock;
  usage(signal: AbortSignal): Promise<QuotaUsage>;
  onError(error: unknown): void;
}): QuotaReader {
  const limits = new Map<string, { value: number | undefined; at: number }>();
  let usage: { value: QuotaUsage; at: number } | undefined;
  const limitOf = async (code: string, signal: AbortSignal): Promise<number | undefined> => {
    const now = options.clock.now();
    const hit = limits.get(code);
    if (hit && now - hit.at < limitTtlMs) return hit.value;
    try {
      const response = await options.client.call<{ Quota?: { Value?: unknown } }>(
        'GetServiceQuota',
        { ServiceCode: 'ec2', QuotaCode: code },
        { signal },
      );
      const raw = response.Quota?.Value;
      const value =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
      limits.set(code, { value, at: now });
      return value;
    } catch (error) {
      if (signal.aborted) throw error;
      // A quota that does not exist here, or cannot be read, stays unknown for the TTL too.
      limits.set(code, { value: undefined, at: now });
      if (!isComputeError(error, 'NOT_FOUND')) options.onError(error);
      return undefined;
    }
  };
  return {
    async headroom(codes, signal) {
      const out = new Map<string, number>();
      const known = new Map<string, number>();
      for (const code of new Set(codes)) {
        const limit = await limitOf(code, signal);
        if (limit !== undefined) known.set(code, limit);
      }
      if (known.size === 0) return out;
      const now = options.clock.now();
      if (!usage || now - usage.at >= usageTtlMs) {
        try {
          usage = { value: await options.usage(signal), at: now };
        } catch (error) {
          if (signal.aborted) throw error;
          options.onError(error);
          return out;
        }
      }
      for (const [code, limit] of known)
        out.set(code, Math.max(0, limit - (usage.value.get(code) ?? 0)));
      return out;
    },
  };
}
