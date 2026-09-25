import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// Destructive batches (PLAN.md §13, v1.0 quorum; the commandBatches group): a fleet-wide reimage, wipe or power
// action waits, held, until k operators sign its scope with approver keys held off the control plane. The console
// shows what is waiting, what it would touch and who approved; approving stays in the approver's terminal
// (`better-compute batch approve`), where the key is and where the CLI recomputes the scope root itself. A browser
// never holds an approver key.

export type BatchState = 'pending' | 'approved' | 'expired' | 'cancelled';

export interface BatchRow {
  batchId: string;
  tenantId: string;
  reason: string;
  state: BatchState;
  scopeRoot: string;
  scopeSize: number;
  requiredApprovals: number;
  notAfter: number;
  approvals: { kid: string; at: number; approvedBy?: string }[];
  /** Member commands by state. */
  commands: Record<string, number>;
  createdAt: number;
  approvedAt?: number;
  createdBy?: string;
  trustDomain?: string;
}

export interface BatchScopeItem {
  leafIndex: number;
  subject: string;
  kind: string;
}

/** A batch's scope for display: subjects by kind, in order. */
export function scopeByKind(items: readonly BatchScopeItem[]): { kind: string; subjects: string[] }[] {
  const byKind = new Map<string, string[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item.subject);
    byKind.set(item.kind, list);
  }
  return [...byKind].map(([kind, subjects]) => ({ kind, subjects: subjects.sort() }));
}

/** How a subject reads to a person: `node_…`, `BMC 10.0.0.7 (via node_site)`, `HTTP to node_…`. */
export function describeSubject(subject: string): string {
  if (subject.startsWith('bmc:')) {
    const rest = subject.slice(4);
    const slash = rest.indexOf('/');
    return slash > 0 ? `BMC ${rest.slice(slash + 1)} (via ${rest.slice(0, slash)})` : `BMC ${rest}`;
  }
  if (subject.startsWith('node:')) return `HTTP to ${subject.slice(5)}`;
  return subject;
}

/** The approver's command for a batch (the CLI shows the scope, recomputes the root and signs). */
export const batchApproveCommand = (batchId: string): string =>
  `better-compute batch approve --batch ${batchId} --key <approver key>`;

export interface BatchesView extends ValueResource<{ items: BatchRow[]; next?: string }> {
  /** Only batches in this state (default: pending), or every batch. */
  filter(state: BatchState | 'all'): Promise<void>;
  detail(batchId: string): Promise<BatchRow>;
  /** Every (subject, kind) of the batch, paged from commandBatches.scope (at most `max`, default 20 000). */
  scope(batchId: string, max?: number): Promise<{ items: BatchScopeItem[]; truncated: boolean }>;
  /** Ends a pending batch: none of its commands run (compute:batches:approve). */
  cancel(batchId: string): Promise<BatchRow>;
}

export function createBatchesView(
  api: ComputeRequester,
  options: { tenantId: string; state?: BatchState | 'all' },
): BatchesView {
  const { tenantId } = options;
  let state = options.state ?? 'pending';
  const list = createValueResource({
    load: (signal) =>
      api.$request<{ items: BatchRow[]; next?: string }>(
        'commandBatches/list',
        { tenantId, ...(state === 'all' ? {} : { state }), limit: 100 },
        { signal },
      ),
  });
  return {
    get: list.get,
    subscribe: list.subscribe,
    refresh: list.refresh,
    async filter(next) {
      state = next;
      await list.refresh();
    },
    detail: (batchId) => api.$request<BatchRow>('commandBatches/get', { tenantId, batchId }),
    async scope(batchId, max = 20_000) {
      const items: BatchScopeItem[] = [];
      let cursor: number | undefined;
      for (;;) {
        const page = await api.$request<{ items: BatchScopeItem[]; next?: number }>('commandBatches/scope', {
          tenantId,
          batchId,
          limit: 5_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        items.push(...page.items);
        // A page that does not advance ends the listing (a server bug must not spin the page).
        if (page.next === undefined || page.items.length === 0 || (cursor !== undefined && page.next <= cursor))
          return { items, truncated: false };
        if (items.length >= max) return { items: items.slice(0, max), truncated: true };
        cursor = page.next;
      }
    },
    async cancel(batchId) {
      const row = await api.$request<BatchRow>('commandBatches/cancel', { tenantId, batchId });
      await list.refresh().catch(() => undefined);
      return row;
    },
  };
}
