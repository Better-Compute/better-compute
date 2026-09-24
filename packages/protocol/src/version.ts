/**
 * The agent protocol versions this build speaks, sent as `Hello.proto_min/proto_max`. The range
 * widens when a release adds a version and narrows (min rises) when the skew window drops one
 * (N-1 minors before 1.0, N-2 after; PLAN.md §7.6).
 */
export const PROTOCOL_VERSION = { min: 1, max: 1 } as const;

/** An inclusive protocol version range. */
export interface ProtocolRange {
  min: number;
  max: number;
}

/**
 * The version both sides use: the highest one inside both ranges, or `undefined` when the ranges
 * do not overlap (a daemon below the server's minimum gets `Welcome.upgrade_required`).
 */
export function negotiateProtocolVersion(
  peer: ProtocolRange,
  local: ProtocolRange = PROTOCOL_VERSION,
): number | undefined {
  const version = Math.min(peer.max, local.max);
  return version >= Math.max(peer.min, local.min) ? version : undefined;
}
