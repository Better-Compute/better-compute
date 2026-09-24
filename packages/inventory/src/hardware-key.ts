import type { GpusSection, NicsSection, SystemSection } from '@better-compute/protocol';
import { sha256Hex } from './sections.js';

// hardware_key (PLAN.md §8.3): sha256 over the normalized product UUID, serial, sorted permanent
// MACs and sorted GPU UUIDs, after dropping values from a placeholder blocklist. The key is trusted
// (and so unique across nodes) only when at least two independent identifiers survive.
// Verify the blocklist against lab hardware.

/** DMI strings vendors ship instead of a real value, compared after trimming and upper-casing. */
export const placeholderValues: readonly string[] = Object.freeze([
  '',
  'TO BE FILLED BY O.E.M.',
  'TO BE FILLED BY OEM',
  'DEFAULT STRING',
  'SYSTEM SERIAL NUMBER',
  'SYSTEM PRODUCT NAME',
  'CHASSIS SERIAL NUMBER',
  'BASE BOARD SERIAL NUMBER',
  'NOT SPECIFIED',
  'NOT APPLICABLE',
  'NOT AVAILABLE',
  'NONE',
  'N/A',
  'NA',
  'UNKNOWN',
  'INVALID',
  'OEM',
  'O.E.M.',
  '0',
  '0123456789',
  '123456789',
  '1234567890',
  'XXXXXXXXXX',
  'SERIAL',
  'SN',
]);
const placeholders = new Set(placeholderValues);

/** A normalized DMI string, or undefined when it is a placeholder. */
export function usableDmiValue(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (placeholders.has(trimmed.toUpperCase())) return undefined;
  // All one repeated character ("00000000", "FFFFFFFF", "........") is a placeholder too.
  if (/^(.)\1*$/.test(trimmed.replace(/[-\s]/g, ''))) return undefined;
  return trimmed;
}

const uuidPattern = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;
/** UUIDs firmware reports when it has none, beyond the repeated-digit ones. */
const placeholderUuids = new Set([
  '03000200-0400-0500-0006-000700080009',
  '00020003-0004-0005-0006-000700080009',
  '12345678-1234-5678-90ab-cddeefaabbcc',
]);

/** A normalized (lowercase, dashed) product UUID, or undefined when it is a placeholder. */
export function usableProductUuid(value: string | undefined): string | undefined {
  const lower = (value ?? '').trim().toLowerCase();
  if (!uuidPattern.test(lower)) return undefined;
  const hex = lower.replace(/-/g, '');
  if (/^(.)\1*$/.test(hex)) return undefined;
  const dashed = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return placeholderUuids.has(dashed) ? undefined : dashed;
}

/**
 * A normalized MAC (`aa:bb:cc:dd:ee:ff`) when it is a permanent, globally administered unicast
 * address; undefined for locally administered (virtual NICs, VFs, bonds), multicast, all-zero or
 * malformed addresses.
 */
export function permanentMac(value: string | undefined): string | undefined {
  const hex = (value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return undefined;
  const first = Number.parseInt(hex.slice(0, 2), 16);
  if (first & 0x03) return undefined; // bit 0: multicast; bit 1: locally administered
  if (/^0+$/.test(hex) || /^f+$/.test(hex)) return undefined;
  return hex.match(/../g)!.join(':');
}

/** The identifiers behind a hardware key, each normalized and with placeholders dropped. */
export interface HardwareIdentifiers {
  productUuid?: string;
  /** The system serial, else the board serial, else the chassis serial. */
  serial?: string;
  macs: string[];
  gpuUuids: string[];
}

export interface HardwareKey {
  /** Lowercase hex SHA-256. */
  key: string;
  /** At least two independent identifiers survived, so the key may be unique-indexed. */
  trusted: boolean;
  /** How many of product UUID, serial, MACs and GPU UUIDs contributed. */
  independent: number;
  identifiers: HardwareIdentifiers;
}

/**
 * Raw hardware identifiers from any source: inventory sections, or the claims of a join request
 * (`HardwareClaims` on the wire, via pki's `claimsFromWire`). Both paths hash identically.
 */
export interface HardwareClaims {
  productUuid?: string;
  serial?: string;
  boardSerial?: string;
  chassisSerial?: string;
  macs?: readonly string[];
  gpuUuids?: readonly string[];
}

/**
 * Normalizes claims: placeholders dropped; the product UUID lowercase and dashed; the serial (the
 * system serial, else the board's, else the chassis') upper case; MACs permanent only, lowercase
 * and colon-separated; GPU UUIDs lowercase. Lists are sorted and duplicate-free.
 */
export function normalizeHardwareClaims(claims: HardwareClaims): HardwareIdentifiers {
  const serial =
    usableDmiValue(claims.serial) ?? usableDmiValue(claims.boardSerial) ?? usableDmiValue(claims.chassisSerial);
  const macs = [...new Set((claims.macs ?? []).map(permanentMac))]
    .filter((mac): mac is string => mac !== undefined)
    .sort();
  const gpuUuids = [...new Set((claims.gpuUuids ?? []).map((uuid) => (uuid ?? '').trim().toLowerCase()))]
    .filter((uuid) => uuid.length > 0 && usableDmiValue(uuid) !== undefined)
    .sort();
  const identifiers: HardwareIdentifiers = { macs, gpuUuids };
  const productUuid = usableProductUuid(claims.productUuid);
  if (productUuid) identifiers.productUuid = productUuid;
  if (serial) identifiers.serial = serial.toUpperCase();
  return identifiers;
}

/** The claims inventory sections make. */
export function claimsFromSections(sections: {
  system?: SystemSection;
  nics?: NicsSection;
  gpus?: GpusSection;
}): HardwareClaims {
  const system = sections.system;
  return {
    productUuid: system?.productUuid,
    serial: system?.serial,
    boardSerial: system?.boardSerial,
    chassisSerial: system?.chassisSerial,
    macs: (sections.nics?.nics ?? []).map((nic) => nic.mac),
    gpuUuids: (sections.gpus?.gpus ?? []).map((gpu) => gpu.uuid),
  };
}

/** Extracts and normalizes the identifiers a hardware key hashes. */
export function hardwareIdentifiers(sections: {
  system?: SystemSection;
  nics?: NicsSection;
  gpus?: GpusSection;
}): HardwareIdentifiers {
  return normalizeHardwareClaims(claimsFromSections(sections));
}

/**
 * The hardware key of a node, or undefined when no identifier survives. Each identifier is framed
 * as `name=value\n`, so values cannot run into each other; lists join with `,`.
 */
export function hardwareKey(sections: {
  system?: SystemSection;
  nics?: NicsSection;
  gpus?: GpusSection;
}): HardwareKey | undefined {
  return hardwareKeyFromClaims(claimsFromSections(sections));
}

/** The hardware key of a join request's claims; equal to `hardwareKey` of matching sections. */
export function hardwareKeyFromClaims(claims: HardwareClaims): HardwareKey | undefined {
  const identifiers = normalizeHardwareClaims(claims);
  const parts: string[] = [];
  let independent = 0;
  if (identifiers.productUuid) {
    parts.push(`uuid=${identifiers.productUuid}`);
    independent++;
  }
  if (identifiers.serial) {
    parts.push(`serial=${identifiers.serial}`);
    independent++;
  }
  if (identifiers.macs.length > 0) {
    parts.push(`mac=${identifiers.macs.join(',')}`);
    independent++;
  }
  if (identifiers.gpuUuids.length > 0) {
    parts.push(`gpu=${identifiers.gpuUuids.join(',')}`);
    independent++;
  }
  if (independent === 0) return undefined;
  return {
    key: sha256Hex(`bc-hwkey-v1\n${parts.map((part) => `${part}\n`).join('')}`),
    trusted: independent >= 2,
    independent,
    identifiers,
  };
}
