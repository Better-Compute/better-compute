import type { HardwareClaims as CoreHardwareClaims } from '@better-compute/core';
import {
  hardwareKey,
  permanentMac,
  usableDmiValue,
  usableProductUuid,
  type GpusSection,
  type HardwareKey,
  type NicsSection,
  type SystemSection,
} from '@better-compute/inventory';
import type { HardwareClaims } from '@better-compute/protocol';

// Hardware identity at join (PLAN.md §3.3 step 4, §8.3). The key is the inventory module's
// `hardwareKey`, the one the Inventory reconciler recomputes from every snapshot, so a key
// computed from join claims and one computed from inventory agree for the same machine.

/** The wire claims as core's `HardwareClaims` (what attestors receive). */
export function coreClaims(claims: HardwareClaims | undefined): CoreHardwareClaims {
  const out: CoreHardwareClaims = {
    macs: [...(claims?.permanentMacs ?? [])],
    gpuUuids: [...(claims?.gpuUuids ?? [])],
  };
  if (claims?.productUuid) out.productUuid = claims.productUuid;
  const serial = claims?.productSerial || claims?.boardSerial || claims?.chassisSerial;
  if (serial) out.serial = serial;
  if (claims?.hostname) out.hostname = claims.hostname;
  return out;
}

/** The hardware key of the claimed identifiers, or undefined when none survives the placeholder list. */
export function claimedHardwareKey(claims: HardwareClaims | undefined): HardwareKey | undefined {
  // Section-shaped views of the claims: `hardwareKey` reads only these fields.
  const system = {
    productUuid: claims?.productUuid ?? '',
    serial: claims?.productSerial ?? '',
    boardSerial: claims?.boardSerial ?? '',
    chassisSerial: claims?.chassisSerial ?? '',
  } as unknown as SystemSection;
  const nics = {
    nics: (claims?.permanentMacs ?? []).map((mac) => ({ mac })),
  } as unknown as NicsSection;
  const gpus = {
    gpus: (claims?.gpuUuids ?? []).map((uuid) => ({ uuid })),
  } as unknown as GpusSection;
  return hardwareKey({ system, nics, gpus });
}

/**
 * A key built from placeholder DMI values needs `expect` in v0.1 (joinRequests.approve from v0.2):
 * the key is missing or untrusted (fewer than two independent identifiers), or neither the product
 * UUID nor a serial survived the placeholder list.
 */
export function needsBinding(key: HardwareKey | undefined): boolean {
  return (
    !key || !key.trusted || (key.identifiers.productUuid === undefined && !key.identifiers.serial)
  );
}

/** `join_tokens.expect`: every identifier given must be among the claims. */
export interface JoinExpect {
  productUuid?: string[];
  serial?: string[];
  mac?: string[];
  gpuUuid?: string[];
  /** Members this server cannot check; any makes the binding fail (fail closed). */
  unknown: string[];
}

const expectKeys = ['productUuid', 'serial', 'mac', 'gpuUuid'] as const;

/** Parses `join_tokens.expect` (jsonb); undefined when the token has no binding. */
export function parseExpect(value: unknown): JoinExpect | undefined {
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { unknown: ['<not an object>'] };
  const expect: JoinExpect = { unknown: [] };
  let bound = false;
  for (const [key, member] of Object.entries(raw as Record<string, unknown>)) {
    if (member === null || member === undefined) continue;
    if (!(expectKeys as readonly string[]).includes(key)) {
      expect.unknown.push(key);
      continue;
    }
    const values = (Array.isArray(member) ? member : [member]).map(String);
    if (!values.length) continue;
    expect[key as (typeof expectKeys)[number]] = values;
    bound = true;
  }
  return bound || expect.unknown.length ? expect : undefined;
}

const upper = (value: string | undefined) => value?.toUpperCase();

/** Whether the claims satisfy the binding, compared after the hardware-key normalization. */
export function matchesExpect(expect: JoinExpect, claims: HardwareClaims | undefined): boolean {
  if (expect.unknown.length) return false;
  const uuid = usableProductUuid(claims?.productUuid);
  const serials = [claims?.productSerial, claims?.boardSerial, claims?.chassisSerial]
    .map((value) => upper(usableDmiValue(value)))
    .filter((value): value is string => value !== undefined);
  const macs = new Set(
    (claims?.permanentMacs ?? []).map(permanentMac).filter((mac) => mac !== undefined),
  );
  const gpus = new Set((claims?.gpuUuids ?? []).map((gpu) => gpu.trim().toUpperCase()));
  const all = <T>(values: T[] | undefined, test: (value: T) => boolean) =>
    (values ?? []).every(test);
  return (
    all(expect.productUuid, (want) => {
      const normalized = usableProductUuid(want);
      return normalized !== undefined && normalized === uuid;
    }) &&
    all(expect.serial, (want) => {
      const normalized = upper(usableDmiValue(want));
      return normalized !== undefined && serials.includes(normalized);
    }) &&
    all(expect.mac, (want) => {
      const normalized = permanentMac(want);
      return normalized !== undefined && macs.has(normalized);
    }) &&
    all(expect.gpuUuid, (want) => want.trim() !== '' && gpus.has(want.trim().toUpperCase()))
  );
}
