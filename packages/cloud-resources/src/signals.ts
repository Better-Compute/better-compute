import {
  ComputeError,
  type MethodContext,
  type ProviderResources,
  type ProviderResourceSignal,
} from '@better-compute/core';
import { poolResources, tenantSecrets, type CloudResourcesDeps } from './store.js';
import type { ResourceSignalView, SignalsInput } from './types.js';

// `cloudResources.signals`: the read-only signals the pool's provider raises about its resources (DigitalOcean's
// Managed Agents Signals), for an attention list. The provider is asked with no transaction open and sends no
// mutation. Whom a signal is shown to: a tenant sees the signals about its own cloud resources; on the tenant's own
// account (the platform's, for the root tenant) it sees every signal, recorded by a cloud resource or not. A signal
// about another tenant's resource, or about something no one records, never reaches a tenant of a shared pool.
//
// The provider's answer is kept for `signalsTtlMs` per provider account (its `ProviderResources`), whichever tenant
// asked: every tenant of a shared pool reads the same account, and asking it on each call would let one tenant spend
// the account's request budget that every tenant's reconcilers need. A refusal is not kept.

/** At most this many signals are returned, newest first. */
export const maxSignalItems = 500;
/** How long one answer of a provider account's signals is reused. */
export const signalsTtlMs = 30_000;

const answers = new WeakMap<
  ProviderResources,
  { at: number; signals: readonly ProviderResourceSignal[] }
>();
const severities: ReadonlySet<string> = new Set(['critical', 'warning', 'info']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const kindPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** One line without control characters, bounded. */
const line = (value: string, max: number) =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A provider's signal as the module trusts it; a malformed one is dropped. */
function wellFormed(signal: ProviderResourceSignal): ProviderResourceSignal | undefined {
  if (typeof signal?.id !== 'string' || !idPattern.test(signal.id)) return undefined;
  if (typeof signal.resourceId !== 'string' || !idPattern.test(signal.resourceId)) return undefined;
  if (typeof signal.kind !== 'string' || signal.kind.length > 64 || !kindPattern.test(signal.kind))
    return undefined;
  if (!severities.has(signal.severity)) return undefined;
  if (typeof signal.at !== 'number' || !Number.isFinite(signal.at)) return undefined;
  const title = typeof signal.title === 'string' ? line(signal.title, 120) : '';
  if (title.length === 0) return undefined;
  const detail = typeof signal.detail === 'string' ? line(signal.detail, 500) : '';
  return { ...signal, title, ...(detail ? { detail } : {}) };
}

export async function listSignals(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: SignalsInput,
): Promise<{ items: ResourceSignalView[] }> {
  const provider = await context.sql.transaction((tx) =>
    poolResources(deps, tx, input.tenantId, input.poolId),
  );
  if (typeof provider.resources.signals !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider.account.provider} raises no resource signals`,
      undefined,
      { reason: 'signals' },
    );
  const now = deps.clock.now();
  const kept = answers.get(provider.resources);
  let raw: readonly ProviderResourceSignal[];
  if (kept !== undefined && now >= kept.at && now - kept.at < signalsTtlMs) raw = kept.signals;
  else {
    raw = await provider.resources.signals({
      idempotencyKey: `signals:${provider.account.id}`,
      signal: context.signal ?? new AbortController().signal,
      clock: deps.clock,
      secrets: tenantSecrets(deps, input.tenantId),
      log: deps.log,
    });
    answers.set(provider.resources, { at: now, signals: raw });
  }
  const signals = raw.map(wellFormed).filter((s): s is ProviderResourceSignal => s !== undefined);
  const own = provider.poolOwnerTenantId === input.tenantId;
  const rows = await context.sql.transaction((tx) =>
    tx.query<{ id: string; tenant_id: string; kind: string; provider_id: string }>(
      `SELECT id, tenant_id, kind, provider_id FROM cloud_resources
        WHERE provider_account_id = $1 AND provider_id = ANY($2::text[])
          AND state NOT IN ('deleted', 'released')`,
      [provider.account.id, [...new Set(signals.map((s) => s.resourceId))]],
    ),
  );
  const recorded = new Map(rows.rows.map((row) => [`${row.kind}\n${row.provider_id}`, row]));
  const items: ResourceSignalView[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const row = recorded.get(`${signal.kind}\n${signal.resourceId}`);
    const mine = row !== undefined && row.tenant_id === input.tenantId;
    if (!mine && !own) continue;
    if (input.resourceId !== undefined && row?.id !== input.resourceId) continue;
    if (seen.has(signal.id)) continue;
    seen.add(signal.id);
    items.push({
      id: signal.id,
      severity: signal.severity,
      title: signal.title,
      ...(signal.detail ? { detail: signal.detail } : {}),
      at: signal.at,
      kind: signal.kind,
      providerId: signal.resourceId,
      ...(row ? { resourceId: row.id } : {}),
    });
  }
  items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { items: items.slice(0, maxSignalItems) };
}
