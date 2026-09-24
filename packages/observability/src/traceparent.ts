// W3C Trace Context `traceparent` (version 00): `00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`. Stored on
// commands and steps (PLAN.md §14) so a daemon's work joins the API request's trace.

export interface TraceParent {
  traceId: string;
  parentId: string;
  sampled: boolean;
}

const pattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/** Parses a `traceparent` header; undefined for anything invalid (all-zero ids, version ff, bad shape). */
export function parseTraceparent(value: string | null | undefined): TraceParent | undefined {
  if (typeof value !== 'string') return undefined;
  const match = pattern.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const [, version, traceId, parentId, flags] = match;
  if (version === 'ff') return undefined;
  // Version 00 has exactly four fields; later versions may append more.
  if (version === '00' && value.trim().length !== 55) return undefined;
  if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return undefined;
  return { traceId: traceId!, parentId: parentId!, sampled: (parseInt(flags!, 16) & 1) === 1 };
}

export function formatTraceparent(trace: TraceParent): string {
  if (!/^[0-9a-f]{32}$/.test(trace.traceId) || !/^[0-9a-f]{16}$/.test(trace.parentId))
    throw new TypeError('Invalid trace or parent id');
  return `00-${trace.traceId}-${trace.parentId}-${trace.sampled ? '01' : '00'}`;
}

const randomHex = (bytes: number) =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** A child of `parent` (same trace, new span id), or a new sampled root trace. */
export function childTraceparent(parent?: TraceParent): TraceParent {
  let parentId = randomHex(8);
  while (/^0+$/.test(parentId)) parentId = randomHex(8);
  if (parent) return { traceId: parent.traceId, parentId, sampled: parent.sampled };
  let traceId = randomHex(16);
  while (/^0+$/.test(traceId)) traceId = randomHex(16);
  return { traceId, parentId, sampled: true };
}
