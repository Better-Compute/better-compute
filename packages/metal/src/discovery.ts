import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { EventPublisher, SqlTx } from '@better-compute/core';
import { ComputeError } from '@better-compute/core';
import { decodeInventorySection, type DiscoveredMachine, type StatusReport } from '@better-compute/protocol';
import { metalWorkKind } from './reconcile.js';

// PXE discovery (PLAN.md §3.5): a site agent lists the machines it saw PXE/HTTP-booting from a MAC with
// no live boot entry (StatusReport.discovered, e763001), with the SMBIOS UUID the client sent (DHCP option
// 97). Nothing here answers or enrolls a machine. metal keeps each agent's list (`metal_discovered`) and
// serves it per site (`metal.discovered`).
// For an enrolled machine without MACs (an IPMI BMC cannot name its NICs), metal.ensureRamdisk PXE-boots
// it with the BMC and looks for a MAC first seen right after that, under its product UUID. The data is
// unauthenticated DHCP (review 2, LOW 6), so a MAC found this way is only a candidate: an operator
// confirms it (`metal.confirmMac`) before it gets a boot entry and its discovery token. Only a pool whose
// policy says `trustProvisioningNetwork: true` binds it at once. After the ramdisk joins, inventory.refresh
// checks its UUID and MACs against the machine's (`verifyMachineIdentity`).
// Tables: metal/0007_discovered, metal/0008_mac_source (migrations.ts).

/** How many entries of one report are kept (the site agent caps its list at the same). */
export const maxDiscoveredPerAgent = 256;
/** An entry not seen for this long is left out of `metal.discovered` and never matched. */
export const discoveredTtlHours = 24;

const macPattern = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * UUIDs firmware reports when nobody set one: all zeros, all ones, and the well-known OEM placeholder
 * of boards shipped with "To be filled by O.E.M." (03000200-0400-0500-0006-000700080009). They never match.
 */
const placeholderUuids: ReadonlySet<string> = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009',
  '00020003-0004-0005-0006-000700080009',
]);

/** A UUID in lower-case 8-4-4-4-12 form (braces and upper case accepted), or undefined. */
export function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().toLowerCase().replace(/^\{|\}$/g, '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a UUID can identify a machine: well-formed and not a firmware placeholder. */
export function isMatchableUuid(uuid: string | null | undefined): uuid is string {
  return typeof uuid === 'string' && uuidPattern.test(uuid) && !placeholderUuids.has(uuid);
}

/**
 * The spellings one SMBIOS UUID takes: as given, with its first three fields byte-swapped (SMBIOS 2.6+
 * stores them little-endian, and a PXE client sends the stored bytes), and fully byte-reversed (IPMI's
 * Get System GUID order). A BMC and a DHCP client may report different ones.
 */
export function uuidSpellings(uuid: string): string[] {
  const hex = uuid.replace(/-/g, '');
  const bytes = hex.match(/../g)!;
  const swap = (from: number, to: number) => bytes.slice(from, to).reverse().join('');
  const mixed = swap(0, 4) + swap(4, 6) + swap(6, 8) + bytes.slice(8).join('');
  const reversed = [...bytes].reverse().join('');
  return [...new Set([hex, mixed, reversed])].map((h) => normalizeUuid(h)!);
}

/** One discovered machine as stored. */
export interface DiscoveredEntry {
  mac: string;
  productUuid?: string;
  arch: string;
  firstSeen?: Date;
  lastSeen?: Date;
  count: number;
  relay?: string;
}

const timestampOf = (value: DiscoveredMachine['firstSeen']): Date | undefined => {
  if (!value) return undefined;
  const ms = Number(value.seconds) * 1000 + Math.floor((value.nanos ?? 0) / 1e6);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : undefined;
};

/**
 * The entries of a report, checked: a well-formed MAC (the first entry per MAC), a well-formed UUID or none,
 * a short arch name, an IP relay or none, a count within uint32. At most `maxDiscoveredPerAgent`, newest first.
 */
export function discoveredEntries(machines: readonly DiscoveredMachine[]): DiscoveredEntry[] {
  const byMac = new Map<string, DiscoveredEntry>();
  for (const machine of machines) {
    const mac = typeof machine.mac === 'string' ? machine.mac.trim().toLowerCase().replace(/-/g, ':') : '';
    if (!macPattern.test(mac) || byMac.has(mac)) continue;
    const productUuid = normalizeUuid(machine.productUuid);
    const firstSeen = timestampOf(machine.firstSeen);
    const lastSeen = timestampOf(machine.lastSeen);
    const relay = typeof machine.relay === 'string' && isIP(machine.relay) !== 0 ? machine.relay.toLowerCase() : undefined;
    byMac.set(mac, {
      mac,
      ...(productUuid ? { productUuid } : {}),
      arch: typeof machine.arch === 'string' && /^[a-z0-9_-]{1,32}$/i.test(machine.arch) ? machine.arch.toLowerCase() : '',
      ...(firstSeen ? { firstSeen } : {}),
      ...(lastSeen ? { lastSeen } : {}),
      count: Math.min(Math.max(Math.trunc(Number(machine.count) || 0), 0), 0xffff_ffff),
      ...(relay ? { relay } : {}),
    });
  }
  return [...byMac.values()]
    .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0) || (a.mac < b.mac ? -1 : 1))
    .slice(0, maxDiscoveredPerAgent);
}

const digestOf = (entries: readonly DiscoveredEntry[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...entries]
          .sort((a, b) => (a.mac < b.mac ? -1 : 1))
          .map((e) => [e.mac, e.productUuid ?? '', e.arch, e.firstSeen?.getTime() ?? 0, e.lastSeen?.getTime() ?? 0, e.count, e.relay ?? '']),
      ),
    )
    .digest();

/**
 * Replaces a site agent's discovered list with `entries` (nothing when the digest is unchanged). Storing
 * binds nothing: only `matchDiscoveredMachine` does, for a machine metal itself just power-cycled. Returns
 * the rows now stored for the agent, or `undefined` for a node that is not a live site agent (never stored).
 */
export async function recordDiscovered(
  tx: SqlTx,
  agentNodeId: string,
  entries: readonly DiscoveredEntry[],
): Promise<{ stored: number; changed: boolean } | undefined> {
  const agents = await tx.query<{ site_id: string }>(
    `SELECT site_id FROM nodes WHERE id = $1 AND role = 'site' AND deleted_at IS NULL`,
    [agentNodeId],
  );
  const siteId = agents.rows[0]?.site_id;
  if (!siteId) return undefined;
  const sha256 = digestOf(entries);
  const last = await tx.query<{ sha256: Uint8Array }>('SELECT sha256 FROM metal_discovery_reports WHERE agent_node_id = $1', [agentNodeId]);
  if (last.rows[0] && Buffer.from(last.rows[0].sha256).equals(sha256)) return { stored: entries.length, changed: false };
  const macs = entries.map((e) => e.mac);
  await tx.query('DELETE FROM metal_discovered WHERE agent_node_id = $1 AND NOT (mac = ANY($2::text[]))', [agentNodeId, macs]);
  if (entries.length)
    await tx.query(
      `INSERT INTO metal_discovered (agent_node_id, site_id, mac, product_uuid, arch, first_seen, last_seen, count, relay)
       SELECT $1, $2, e.mac, e.uuid, e.arch, e.first_seen, e.last_seen, e.count, e.relay
         FROM unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::bigint[], $9::text[])
           AS e(mac, uuid, arch, first_seen, last_seen, count, relay)
       ON CONFLICT (agent_node_id, mac) DO UPDATE SET site_id = EXCLUDED.site_id, product_uuid = EXCLUDED.product_uuid,
         arch = EXCLUDED.arch, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen, count = EXCLUDED.count,
         relay = EXCLUDED.relay`,
      [
        agentNodeId,
        siteId,
        macs,
        entries.map((e) => e.productUuid ?? null),
        entries.map((e) => e.arch),
        entries.map((e) => e.firstSeen ?? null),
        entries.map((e) => e.lastSeen ?? null),
        entries.map((e) => String(e.count)),
        entries.map((e) => e.relay ?? null),
      ],
    );
  await tx.query(
    `INSERT INTO metal_discovery_reports (agent_node_id, sha256) VALUES ($1, $2)
     ON CONFLICT (agent_node_id) DO UPDATE SET sha256 = EXCLUDED.sha256, reported_at = compute_now()`,
    [agentNodeId, sha256],
  );
  return { stored: entries.length, changed: true };
}

/** How long after metal's own power cycle a discovered MAC may first appear and still count (ms). */
export const discoveryWindowMs = 10 * 60_000;
/** Slack for the site agent's clock against the control plane's, before the power cycle (ms). */
const clockSlackMs = 30_000;

/** What `matchDiscoveredMachine` found for a machine without MACs. */
export interface DiscoveryOutcome {
  /** The MAC now bound (`macs`), or the candidate awaiting `metal.confirmMac`. */
  mac?: string;
  /** The MAC is the machine's now (it had MACs, or the pool trusts its provisioning network). */
  bound: boolean;
  /** Why there is no candidate: nothing seen yet, the UUID was seen from several MACs or is another machine's, or the MAC is. */
  reason?: 'not-seen' | 'ambiguous' | 'shared-uuid' | 'mac-enrolled' | 'no-uuid';
}

/**
 * Looks for the PXE MAC of an enrolled machine without MACs that metal itself has just PXE-booted with its
 * BMC (a power action issued at `since`). Discovery data is spoofable (any host can claim any MAC and UUID),
 * so a MAC counts only when all of these hold:
 * - the machine's product UUID, in any spelling, was seen from exactly that one MAC in the last 24 h;
 * - that MAC was first seen after `since` (within `discoveryWindowMs`);
 * - no other enrolled machine of the site shares the UUID, and the MAC is no enrolled machine's.
 * The MAC is then a candidate (`metal_nodes.discovered_mac`) for an operator to confirm (`metal.confirmMac`).
 * It is bound at once (`mac_source` `discovered`) only when the machine's pool policy says
 * `trustProvisioningNetwork: true`. Publishes `node.pxe-mac.discovered` when the candidate or binding is new.
 */
export async function matchDiscoveredMachine(
  tx: SqlTx,
  input: { nodeId: string; since: Date; trust: boolean },
  options: { events?: EventPublisher; work?: { enqueue(tx: SqlTx, kind: string, key: string): Promise<void> } } = {},
): Promise<DiscoveryOutcome> {
  const { rows } = await tx.query<{
    tenant_id: string;
    site_id: string;
    product_uuid: string | null;
    macs: string[];
    discovered_mac: string | null;
  }>(
    `SELECT m.tenant_id, n.site_id, m.product_uuid, m.macs, m.discovered_mac
       FROM metal_nodes m JOIN nodes n ON n.id = m.node_id WHERE m.node_id = $1 FOR UPDATE OF m`,
    [input.nodeId],
  );
  const node = rows[0];
  if (!node) return { bound: false, reason: 'not-seen' };
  if (node.macs.length > 0) return { mac: node.macs[0]!, bound: true };
  if (!isMatchableUuid(node.product_uuid)) return { bound: false, reason: 'no-uuid' };
  const spellings = uuidSpellings(node.product_uuid);
  const shared = await tx.query(
    `SELECT 1 FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.site_id = $1 AND n.deleted_at IS NULL AND n.provision_state <> 'retired' AND m.node_id <> $2
        AND m.product_uuid = ANY($3::text[]) LIMIT 1`,
    [node.site_id, input.nodeId, spellings],
  );
  if (shared.rowCount) return { bound: false, reason: 'shared-uuid' };
  const { rows: seen } = await tx.query<{ mac: string; agent_node_id: string; fresh: boolean }>(
    `SELECT d.mac, d.agent_node_id,
            (d.first_seen IS NOT NULL AND d.first_seen >= $4::timestamptz - make_interval(secs => $5)
              AND d.first_seen <= $4::timestamptz + make_interval(secs => $6)) AS fresh
       FROM metal_discovered d JOIN nodes agent ON agent.id = d.agent_node_id
      WHERE d.site_id = $1 AND d.product_uuid = ANY($2::text[]) AND agent.role = 'site' AND agent.deleted_at IS NULL
        AND (d.last_seen IS NULL OR d.last_seen > compute_now() - make_interval(hours => $3))
      ORDER BY d.last_seen DESC NULLS LAST, d.agent_node_id`,
    [node.site_id, spellings, discoveredTtlHours, input.since, clockSlackMs / 1000, discoveryWindowMs / 1000],
  );
  const macs = [...new Set(seen.map((row) => row.mac))];
  if (macs.length === 0) return { bound: false, reason: 'not-seen' };
  // Seen from another MAC in the last 24 h, or only before metal's own power cycle: an operator decides.
  if (macs.length > 1) return { bound: false, reason: 'ambiguous' };
  const mac = macs[0]!;
  if (!seen.some((row) => row.fresh)) return { bound: false, reason: 'not-seen' };
  const taken = await tx.query(
    `SELECT 1 FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.site_id = $1 AND n.deleted_at IS NULL AND $2 = ANY(m.macs) LIMIT 1`,
    [node.site_id, mac],
  );
  if (taken.rowCount) return { bound: false, reason: 'mac-enrolled' };
  if (!input.trust && node.discovered_mac === mac) return { mac, bound: false };
  await tx.query(
    input.trust
      ? `UPDATE metal_nodes SET macs = ARRAY[$2::text], mac_source = 'discovered', discovered_mac = NULL, discovered_mac_at = NULL,
           updated_at = compute_now(), version = version + 1 WHERE node_id = $1`
      : `UPDATE metal_nodes SET discovered_mac = $2, discovered_mac_at = compute_now(), updated_at = compute_now(), version = version + 1
          WHERE node_id = $1`,
    [input.nodeId, mac],
  );
  await tx.query('UPDATE metal_discovered SET matched_node_id = $3 WHERE site_id = $1 AND mac = $2', [node.site_id, mac, input.nodeId]);
  await options.events?.publish(tx, {
    type: 'node.pxe-mac.discovered',
    tenantId: node.tenant_id,
    subject: `node/${input.nodeId}`,
    data: {
      nodeId: input.nodeId,
      mac,
      productUuid: node.product_uuid,
      siteId: node.site_id,
      agentNodeId: seen[0]!.agent_node_id,
      bound: input.trust,
    },
  });
  if (input.trust) await options.work?.enqueue(tx, metalWorkKind, input.nodeId);
  return { mac, bound: input.trust };
}

/**
 * `reports.status` for site agents: stores `StatusReport.discovered` (`recordDiscovered`). Reports of other
 * nodes, and unchanged lists, write nothing. A node's role is read once per `roleCacheMs` per process, so a
 * host's reports cost no query.
 *
 * ```ts
 * createGateway({ reports: { ...gatewayReportHandlers, status: [xidStatusHandler, metalDiscoveryStatusHandler()] } })
 * ```
 */
export function metalDiscoveryStatusHandler(options: { roleCacheMs?: number } = {}) {
  const ttl = options.roleCacheMs ?? 10 * 60_000;
  // Nodes known not to be site agents, until when.
  const notSite = new Map<string, number>();
  return async function metalDiscoveryStatus(
    tx: SqlTx,
    context: { nodeId: string },
    report: Pick<StatusReport, 'discovered'>,
  ): Promise<{ stored: number; changed: boolean } | undefined> {
    const until = notSite.get(context.nodeId);
    if (until !== undefined && until > Date.now()) return undefined;
    const outcome = await recordDiscovered(tx, context.nodeId, discoveredEntries(report.discovered ?? []));
    if (!outcome) {
      if (notSite.size >= 100_000) notSite.clear();
      notSite.set(context.nodeId, Date.now() + ttl);
      return undefined;
    }
    notSite.delete(context.nodeId);
    return outcome;
  };
}

/** One machine of `metal.discovered`: merged over the site's agents. */
export interface DiscoveredMachineView {
  mac: string;
  productUuid?: string;
  arch?: string;
  firstSeen?: string;
  lastSeen?: string;
  /** DHCP requests seen, summed over the agents. */
  count: number;
  /** giaddr, when relayed. */
  relays: string[];
  /** The site agents that saw it. */
  agentNodeIds: string[];
  /** The enrolled machine with this MAC. */
  nodeId?: string;
  /** The enrolled machine without MACs this entry is the candidate of, awaiting `metal.confirmMac`. */
  candidateFor?: string;
}

/** The site's discovered machines (seen in the last 24 h by a live site agent), newest first. */
export async function listDiscovered(tx: SqlTx, siteId: string, limit = 256): Promise<DiscoveredMachineView[]> {
  const { rows } = await tx.query<{
    mac: string;
    product_uuid: string | null;
    arch: string | null;
    first_seen: Date | null;
    last_seen: Date | null;
    count: string;
    relays: string[];
    agents: string[];
    node_id: string | null;
    candidate_for: string | null;
  }>(
    `SELECT d.mac, max(d.product_uuid) AS product_uuid, max(NULLIF(d.arch, '')) AS arch, min(d.first_seen) AS first_seen,
            max(d.last_seen) AS last_seen, sum(d.count)::text AS count,
            array_remove(array_agg(DISTINCT d.relay), NULL) AS relays, array_agg(DISTINCT d.agent_node_id ORDER BY d.agent_node_id) AS agents,
            (SELECT m.node_id FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
              WHERE n.site_id = $1 AND n.deleted_at IS NULL AND d.mac = ANY(m.macs) ORDER BY m.node_id LIMIT 1) AS node_id,
            (SELECT m.node_id FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
              WHERE n.site_id = $1 AND n.deleted_at IS NULL AND m.discovered_mac = d.mac AND cardinality(m.macs) = 0
              ORDER BY m.node_id LIMIT 1) AS candidate_for
       FROM metal_discovered d JOIN nodes agent ON agent.id = d.agent_node_id
      WHERE d.site_id = $1 AND agent.role = 'site' AND agent.deleted_at IS NULL
        AND (d.last_seen IS NULL OR d.last_seen > compute_now() - make_interval(hours => $2))
      GROUP BY d.mac
      ORDER BY max(d.last_seen) DESC NULLS LAST, d.mac
      LIMIT $3`,
    [siteId, discoveredTtlHours, limit],
  );
  return rows.map((row) => ({
    mac: row.mac,
    ...(row.product_uuid ? { productUuid: row.product_uuid } : {}),
    ...(row.arch ? { arch: row.arch } : {}),
    ...(row.first_seen ? { firstSeen: new Date(row.first_seen).toISOString() } : {}),
    ...(row.last_seen ? { lastSeen: new Date(row.last_seen).toISOString() } : {}),
    count: Number(row.count),
    relays: row.relays,
    agentNodeIds: row.agents,
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    ...(row.candidate_for ? { candidateFor: row.candidate_for } : {}),
  }));
}

/** What `verifyMachineIdentity` found. */
export interface IdentityCheck {
  /** false: the sections it needs are not in yet (only for a MAC PXE discovery bound). */
  checked: boolean;
  productUuid?: string;
  macs?: string[];
}

/**
 * After the ramdisk joined and reported its inventory (inventory.refresh): does the machine that booted
 * match the one enrolled? Its product UUID (the ramdisk's `system` section) must be a spelling of the
 * enrolled or BMC-reported one. For a MAC PXE discovery bound (`mac_source` `discovered`), its NICs must
 * also include that MAC, and both sections must have been received since the ramdisk connected.
 * Otherwise sections that are missing are not checked. A mismatch is `DRIVER_ERROR`
 * (reason `machine-identity-mismatch`), and the workflow fails before anything is written to the machine.
 */
export async function verifyMachineIdentity(
  tx: SqlTx,
  node: { node_id: string; product_uuid: string | null; macs: readonly string[]; mac_source?: string },
): Promise<IdentityCheck> {
  const strict = node.mac_source === 'discovered';
  const { rows } = await tx.query<{ section: string; content: Uint8Array }>(
    `SELECT s.section, s.content FROM node_inventory_sections s
       LEFT JOIN node_sessions ses ON ses.node_id = s.node_id
      WHERE s.node_id = $1 AND s.section IN ('system', 'nics')
        AND (NOT $2 OR (ses.connected_at IS NOT NULL AND s.received_at >= ses.connected_at))`,
    [node.node_id, strict],
  );
  const decoded = <N extends 'system' | 'nics'>(name: N) => {
    const row = rows.find((r) => r.section === name);
    if (!row) return undefined;
    try {
      return decodeInventorySection(name, new Uint8Array(row.content));
    } catch {
      return undefined;
    }
  };
  const system = decoded('system');
  const nics = decoded('nics');
  if (strict && (!system || !nics)) return { checked: false };
  const mismatch = (message: string, details: Record<string, string | string[]>) =>
    new ComputeError('DRIVER_ERROR', `Node ${node.node_id}: ${message}`, undefined, {
      reason: 'machine-identity-mismatch',
      ...details,
    });
  const booted = normalizeUuid(system?.productUuid);
  if (booted && isMatchableUuid(node.product_uuid) && !uuidSpellings(node.product_uuid).includes(booted))
    throw mismatch(`the machine that booted reports product UUID ${booted}, not ${node.product_uuid}`, {
      expected: node.product_uuid,
      reported: booted,
    });
  const reportedMacs = (nics?.nics ?? []).map((nic) => nic.mac.toLowerCase());
  if (strict) {
    if (!booted) throw mismatch('the machine that booted reports no product UUID to check its discovered MAC against', {});
    const missing = node.macs.filter((mac) => !reportedMacs.includes(mac));
    if (missing.length) throw mismatch(`the machine that booted has no NIC ${missing.join(', ')}`, { missing, reported: reportedMacs });
  }
  return { checked: true, ...(booted ? { productUuid: booted } : {}), ...(nics ? { macs: reportedMacs } : {}) };
}
