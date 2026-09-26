import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// PXE discovery (PLAN.md §3.5; metal.discovered and metal.confirmMac): the machines a site's agents saw
// PXE-booting with no boot entry, and the operator's decision that one of them is the PXE MAC of a machine
// enrolled without MACs. Discovery data is unauthenticated DHCP, so nothing here binds by itself: a
// candidate (proposed by metal right after it power-cycled the machine) waits for confirmMac.

export interface DiscoveredMachineRow {
  mac: string;
  productUuid?: string;
  arch?: string;
  firstSeen?: string;
  lastSeen?: string;
  count: number;
  relays: string[];
  agentNodeIds: string[];
  /** The enrolled machine with this MAC. */
  nodeId?: string;
  /** The machine enrolled without MACs this MAC is the candidate of, awaiting confirmMac. */
  candidateFor?: string;
}

/** What a row is to the operator. */
export type DiscoveredKind = 'candidate' | 'enrolled' | 'unknown';

/** Rows sorted into what needs a decision first: candidates, then unknown machines, then enrolled ones. */
export function pxeCandidates(
  rows: readonly DiscoveredMachineRow[],
): { kind: DiscoveredKind; row: DiscoveredMachineRow }[] {
  const kindOf = (row: DiscoveredMachineRow): DiscoveredKind =>
    row.candidateFor ? 'candidate' : row.nodeId ? 'enrolled' : 'unknown';
  const order: Record<DiscoveredKind, number> = { candidate: 0, unknown: 1, enrolled: 2 };
  return rows
    .map((row) => ({ kind: kindOf(row), row }))
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        (b.row.lastSeen ?? '').localeCompare(a.row.lastSeen ?? '') ||
        a.row.mac.localeCompare(b.row.mac),
    );
}

/** "3 min ago", "2 h ago", or "just now", for a discovered machine's last DHCP request. */
export function seenAgo(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  return `${Math.floor(ms / 3_600_000)} h ago`;
}

const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** A MAC as the API takes it (lower case, colons), or undefined when it is not one. */
export function normalizeMac(value: string): string | undefined {
  const mac = value.trim().toLowerCase().replace(/-/g, ':');
  return macPattern.test(mac) ? mac : undefined;
}

export interface PxeDiscoveryView
  extends ValueResource<{ siteId: string; machines: DiscoveredMachineRow[] }> {
  /** Another site (only its owner sees its list). */
  site(siteId: string): Promise<void>;
  /** Binds `mac` as `nodeId`'s PXE MAC (metal.confirmMac); the list reloads. Audited as node.pxe-mac.confirmed. */
  confirmMac(nodeId: string, mac: string): Promise<unknown>;
}

export function createPxeDiscoveryView(
  api: ComputeRequester,
  options: { tenantId: string; siteId: string },
): PxeDiscoveryView {
  const { tenantId } = options;
  let siteId = options.siteId;
  const list = createValueResource({
    load: (signal) =>
      api.$request<{ siteId: string; machines: DiscoveredMachineRow[] }>(
        'metal/discovered',
        { tenantId, siteId },
        { signal },
      ),
  });
  return {
    get: list.get,
    subscribe: list.subscribe,
    refresh: list.refresh,
    async site(next) {
      siteId = next;
      await list.refresh();
    },
    async confirmMac(nodeId, mac) {
      const normalized = normalizeMac(mac);
      if (!normalized) throw new Error(`${mac} is not a MAC address (aa:bb:cc:dd:ee:ff)`);
      const result = await api.$request('metal/confirmMac', { tenantId, nodeId, mac: normalized });
      await list.refresh().catch(() => undefined);
      return result;
    },
  };
}
