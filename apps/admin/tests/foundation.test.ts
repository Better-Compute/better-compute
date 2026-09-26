import { describe, expect, it } from 'vitest';
import { drift, noise } from '@/lib/data/core';
import { attention, attentionGroup, controlPlane, fleetPulse, nodeStates, poolPulse, type AttentionItem } from '@/lib/data/platform';
import { pools, poolNodePlacement, sites } from '@/lib/data/topology';
import { collectAttention, modules, navForPath, searchAll, widgetById, widgetSettings } from '@/lib/modules';
import { decodeDashboard, encodeDashboard, PRESETS } from '@/components/widgets/layout';

// The foundation's pure logic: the simulated platform signals, the module registry helpers and dashboard
// share links. A fixed T0 in the past, never the wall clock.
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

describe('simulation core', () => {
  it('is deterministic and bounded', () => {
    expect(noise('pool_a', 3)).toBe(noise('pool_a', 3));
    expect(noise('pool_a', 3)).not.toBe(noise('pool_a', 4));
    for (let t = T0; t < T0 + 6 * 3_600_000; t += 600_000) {
      const v = drift('x', t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('fleet pulse', () => {
  it('adds up per pool and across the fleet', () => {
    const pulse = fleetPulse(T0);
    expect(pulse.nodes.total).toBe(pools.reduce((n, p) => n + p.nodes, 0));
    expect(pulse.nodes.ready + pulse.nodes.degraded + pulse.nodes.offline + pulse.nodes.provisioning).toBe(pulse.nodes.total);
    for (const p of pulse.pools) {
      expect(p.allocated + p.reserved + p.available + p.unhealthy).toBeLessThanOrEqual(p.total);
      expect(p.utilization).toBeGreaterThanOrEqual(0);
      expect(p.utilization).toBeLessThanOrEqual(1);
    }
  });

  it('scopes to one site', () => {
    const scoped = fleetPulse(T0, { siteId: 'fra1' });
    expect(scoped.pools.every((p) => p.pool.siteId === 'fra1')).toBe(true);
  });

  it('nodeStates matches the pulse counts, the same way every time', () => {
    for (const pool of pools) {
      const pulse = poolPulse(pool, T0);
      const states = nodeStates(pulse, T0);
      expect(states).toHaveLength(pool.nodes);
      expect(states.filter((s) => s.state === 'offline')).toHaveLength(pulse.nodes.offline);
      expect(states.filter((s) => s.state === 'provisioning')).toHaveLength(pulse.nodes.provisioning);
      expect(states.filter((s) => s.state === 'degraded')).toHaveLength(pulse.nodes.degraded);
      expect(nodeStates(pulse, T0)).toEqual(states);
    }
  });

  it('never puts two pools of a site in the same rack slot', () => {
    for (const site of sites) {
      const seen = new Set<string>();
      for (const pool of pools.filter((p) => p.siteId === site.id))
        for (let i = 0; i < pool.nodes; i++) {
          const { rack, unit } = poolNodePlacement(pool, i);
          const key = `${rack}/${unit}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
    }
  });
});

describe('attention', () => {
  it('never opens items in the future and is stable within a bucket', () => {
    for (let t = T0; t < T0 + 24 * 3_600_000; t += 37 * 60_000) for (const item of attention(t)) expect(item.at).toBeLessThanOrEqual(t);
    expect(attention(T0).map((i) => i.id)).toEqual(attention(T0 + 1_000).map((i) => i.id));
  });

  it('reports a degraded control-plane component', () => {
    let found = false;
    for (let t = T0; t < T0 + 3 * 24 * 3_600_000 && !found; t += 15 * 60_000) {
      const degraded = controlPlane(t).filter((c) => c.status !== 'ok');
      if (!degraded.length) continue;
      found = true;
      const ids = attention(t).map((i) => i.subject);
      for (const c of degraded) expect(ids).toContain(`component/${c.id}`);
    }
    expect(found).toBe(true);
  });

  it('merges module items, most severe first, and survives a failing module', () => {
    const items = collectAttention(T0);
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < items.length; i++) expect(rank[items[i - 1]!.severity]).toBeLessThanOrEqual(rank[items[i]!.severity]);
    const original = modules[0]!.attention;
    modules[0]!.attention = () => {
      throw new Error('boom');
    };
    try {
      expect(() => collectAttention(T0)).not.toThrow();
    } finally {
      modules[0]!.attention = original;
    }
  });

  it('groups by explicit group, else the title without " on <subject>"', () => {
    const base: AttentionItem = { id: 'a', severity: 'warning', title: 'Node unreachable on ams2-a100-008', detail: '', source: 'fleet', href: '/', at: T0, subject: 'node/x' };
    expect(attentionGroup(base)).toBe('Node unreachable');
    expect(attentionGroup({ ...base, group: 'Unreachable nodes' })).toBe('Unreachable nodes');
    expect(attentionGroup({ ...base, title: 'Rollout paused at wave 3' })).toBe('Rollout paused at wave 3');
  });
});

describe('module registry', () => {
  it('has unique widget ids and nav hrefs', () => {
    const widgets = modules.flatMap((m) => m.widgets.map((w) => w.id));
    expect(new Set(widgets).size).toBe(widgets.length);
    const hrefs = modules.flatMap((m) => m.nav.map((n) => n.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every preset widget is installed', () => {
    for (const preset of PRESETS) for (const item of preset.items) expect(widgetById(item.widget), `${preset.id}: ${item.widget}`).toBeDefined();
  });

  it('finds the nav item of a nested path by the longest prefix', () => {
    expect(navForPath('/attention')?.href).toBe('/attention');
    expect(navForPath('/')?.href).toBe('/');
    expect(navForPath('/not-a-page')).toBeUndefined();
  });

  it('searches only from two characters, and finds sites', () => {
    expect(searchAll('f', { now: T0 })).toEqual([]);
    expect(searchAll('frankfurt', { now: T0 }).some((r) => r.group === 'Sites' && r.id === 'fra1')).toBe(true);
  });

  it('fills setting defaults and keeps keys a widget saved itself', () => {
    const def = widgetById('overview.pulse')!;
    expect(widgetSettings(def)).toMatchObject({ metric: 'utilization', compare: true });
    expect(widgetSettings(def, { metric: 'power', text: 'kept' })).toMatchObject({ metric: 'power', compare: true, text: 'kept' });
  });
});

describe('dashboard share links', () => {
  it('round-trips a dashboard, unicode included', () => {
    const dashboard = { name: 'Nuit — équipe', items: [{ key: 'overview.notes', widget: 'overview.notes', w: 6, h: 3, settings: { text: 'Bonjour ✓' } }] };
    expect(decodeDashboard(encodeDashboard(dashboard))).toEqual(dashboard);
  });

  it('rejects garbage and sanitises what it accepts', () => {
    expect(decodeDashboard('not base64 at all ***')).toBeNull();
    expect(decodeDashboard(btoa(JSON.stringify({ v: 2, name: 'x', items: [] })))).toBeNull();
    const raw = btoa(
      JSON.stringify({
        v: 1,
        name: 'x'.repeat(200),
        items: [
          { widget: 'overview.kpis', w: 99, h: -4, settings: { ok: 1, nested: { evil: true }, fn: null } },
          { widget: 7, w: 1, h: 1 },
        ],
      }),
    );
    const decoded = decodeDashboard(raw)!;
    expect(decoded.name).toHaveLength(60);
    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({ w: 12, h: 1, settings: { ok: 1 } });
    expect(decoded.items[0]!.settings).not.toHaveProperty('nested');
    expect(decoded.items[0]!.settings).not.toHaveProperty('fn');
  });
});
