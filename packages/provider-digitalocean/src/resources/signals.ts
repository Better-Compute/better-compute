import type { CallContext, ProviderResourceSignal } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { actionGatewayKindName, agentHarnessKindName } from './kinds/managed-agents.js';

// Managed Agents Signals (P8 task 6, a DigitalOcean preview): what DigitalOcean raises about a harness agent or an
// action gateway (a run that failed, an agent asking for a human), read into provider-neutral signals for the
// operator's attention list. Read-only: GETs on the sweep budget (they defer before any reconciler's reads and writes),
// never a mutation. DigitalOcean lists signals oldest first, so every page is read (at most `maxSignalsRead`) and the
// newest `maxSignals` are kept: those are the ones an attention list is for. A signal about anything else, or
// with an id or a time that is not one, is dropped; the text is one line without control characters, bounded. The path
// (/v2/managed-agents/signals) and the shape are assumed, not a recording: the live suite captures real bodies before
// release.

/** At most this many signals are returned per call: the newest. */
export const maxSignals = 500;
/** At most this many are read per call (50 pages of 200); past it the rest is not read, and a warning is logged. */
export const maxSignalsRead = 10_000;
const maxTitle = 120;
const maxDetail = 500;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface DoSignal {
  uuid?: unknown;
  resource_type?: unknown;
  resource_uuid?: unknown;
  type?: unknown;
  severity?: unknown;
  message?: unknown;
  created_at?: unknown;
}

const kinds: Readonly<Record<string, string>> = {
  HARNESS: agentHarnessKindName,
  ACTION_GATEWAY: actionGatewayKindName,
};
const severities: Readonly<Record<string, ProviderResourceSignal['severity']>> = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};
/** The severity of a type that names none: failures are critical, anything waiting on someone a warning. */
function severityOf(type: string): ProviderResourceSignal['severity'] {
  if (/FAILED|ERROR|CRASH/.test(type)) return 'critical';
  if (/REQUESTED|TRIGGERED|UNREACHABLE|DEGRADED|LIMIT/.test(type)) return 'warning';
  return 'info';
}

/** One line: control characters become spaces, runs of space one, bounded. */
function line(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** `RUN_FAILED` → `Run failed`. */
function titleOf(type: string): string {
  const words = line(type.replace(/_/g, ' ').toLowerCase(), maxTitle);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function signalOf(raw: DoSignal): ProviderResourceSignal | undefined {
  const id = raw.uuid;
  const resourceId = raw.resource_uuid;
  const type = raw.type;
  if (typeof id !== 'string' || !idPattern.test(id)) return undefined;
  if (typeof resourceId !== 'string' || !idPattern.test(resourceId)) return undefined;
  if (typeof type !== 'string' || type.length === 0) return undefined;
  const kind = typeof raw.resource_type === 'string' ? kinds[raw.resource_type] : undefined;
  if (kind === undefined) return undefined;
  const at = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const severity =
    (typeof raw.severity === 'string' ? severities[raw.severity.toUpperCase()] : undefined) ??
    severityOf(type.toUpperCase());
  const detail = typeof raw.message === 'string' ? line(raw.message, maxDetail) : '';
  return {
    id,
    kind,
    resourceId,
    severity,
    title: titleOf(type),
    ...(detail.length > 0 ? { detail } : {}),
    at,
  };
}

/** The account's newest `maxSignals` Managed Agents signals, oldest first. */
export async function doSignals(
  client: DoClient,
  context: CallContext,
): Promise<ProviderResourceSignal[]> {
  const all: ProviderResourceSignal[] = [];
  let read = 0;
  for await (const raw of client.pages<DoSignal>('/managed-agents/signals', 'signals', {
    signal: context.signal,
    budget: 'sweep',
  })) {
    if (++read > maxSignalsRead) {
      context.log?.warn('digitalocean: more Managed Agents signals than are read; the newest may be missing', {
        read: maxSignalsRead,
      });
      break;
    }
    const signal = signalOf(raw);
    if (signal) all.push(signal);
  }
  // By time, whatever order the pages came in (a stable sort keeps the listing's order among equal times).
  all.sort((a, b) => a.at - b.at);
  return all.slice(-maxSignals);
}
