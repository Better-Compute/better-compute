import type { HardwareClaims } from '@better-compute/core';
import type { HardwareClaims as WireHardwareClaims } from '@better-compute/protocol';

/**
 * Hardware claims as JoinService sees them. `hardware_key` itself (placeholder blocklist, digest,
 * trust) belongs to `@better-compute/inventory`, so JoinService and the Inventory controller always
 * compute the same key; this module only maps and formats claims for the join-token checks.
 */
export type JoinClaims = HardwareClaims & { boardSerial?: string; chassisSerial?: string };

/** Maps wire `HardwareClaims` (protocol) to core's claims shape, keeping the extra DMI serials. */
export function claimsFromWire(claims: WireHardwareClaims): JoinClaims {
  const out: JoinClaims = { macs: [...claims.permanentMacs], gpuUuids: [...claims.gpuUuids] };
  if (claims.productUuid) out.productUuid = claims.productUuid;
  if (claims.productSerial) out.serial = claims.productSerial;
  if (claims.boardSerial) out.boardSerial = claims.boardSerial;
  if (claims.chassisSerial) out.chassisSerial = claims.chassisSerial;
  if (claims.hostname) out.hostname = claims.hostname;
  return out;
}

/** Format-only normalization for comparing an `expect` value with a claim: case, separators. */
export const normalizeClaim = {
  uuid: (value: string): string => value.trim().toLowerCase(),
  serial: (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' '),
  mac: (value: string): string => {
    const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
    return hex.length === 12 ? hex.match(/../g)!.join(':') : value.trim().toLowerCase();
  },
  gpuUuid: (value: string): string => {
    const text = value.trim().toLowerCase();
    return text.startsWith('gpu-') ? text : `gpu-${text}`;
  },
};
