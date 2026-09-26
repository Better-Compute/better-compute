// Saved dashboards: an ordered list of widget instances with their sizes. The grid packs them densely, so the
// order is the layout (no x/y to keep consistent across screen widths). Stored per browser in localStorage.

export interface WidgetInstance {
  /** Unique within the dashboard (a widget can appear twice). */
  key: string;
  widget: string;
  w: number;
  h: number;
  /** A custom title for this instance ("H100 only"). */
  title?: string;
  /** Values for the widget's declared settings. */
  settings?: Record<string, string | number | boolean>;
}

export interface Dashboard {
  id: string;
  name: string;
  items: WidgetInstance[];
}

export interface DashboardState {
  version: 1;
  active: string;
  dashboards: Dashboard[];
  /** Preset ids this browser has already been given, so new presets arrive once and deleted ones stay gone. */
  presetsSeen?: string[];
}

const item = (widget: string, w: number, h: number): WidgetInstance => ({ key: widget, widget, w, h });

/** Starting points. Widget ids a deployment doesn't have are skipped when rendering. */
export const PRESETS: { id: string; name: string; description: string; items: WidgetInstance[] }[] = [
  {
    id: 'operations',
    name: 'Operations',
    description: 'The whole fleet at a glance: health, attention, control plane, activity.',
    items: [
      item('overview.kpis', 12, 2),
      item('overview.pulse', 8, 4),
      item('overview.attention', 4, 4),
      item('overview.fleet-wall', 8, 4),
      item('fleet.health', 4, 4),
      item('capacity.heatmap', 12, 4),
      item('overview.control-plane', 4, 4),
      item('overview.sites', 4, 4),
      item('fleet.batches', 4, 4),
      item('fleet.rollout', 4, 2),
      item('fleet.sandboxes', 4, 2),
      item('overview.activity', 4, 4),
    ],
  },
  {
    id: 'fleet',
    name: 'Fleet',
    description: 'Machines and devices: health by pool, every GPU, what is unhealthy, rollouts and quorum batches.',
    items: [
      item('fleet.health', 4, 4),
      item('fleet.gpu-wall', 8, 4),
      item('fleet.unhealthy', 4, 4),
      item('overview.fleet-wall', 8, 4),
      item('fleet.rollout', 4, 2),
      item('fleet.sandboxes', 4, 2),
      item('fleet.batches', 4, 3),
      item('overview.sites', 8, 4),
    ],
  },
  {
    id: 'capacity',
    name: 'Capacity',
    description: 'Booked vs free, per pool and model, with what is coming.',
    items: [
      item('capacity.kpis', 12, 2),
      item('capacity.heatmap', 12, 4),
      item('capacity.pools', 7, 5),
      item('capacity.models', 5, 5),
      item('reservations.upcoming', 6, 4),
      item('quotas.alerts', 6, 4),
      item('usage.spend', 8, 4),
      item('capacity.finder', 4, 4),
    ],
  },
  {
    id: 'oncall',
    name: 'On-call',
    description: 'What is broken and what changed: attention, control plane, activity.',
    items: [
      item('overview.attention', 6, 5),
      item('fleet.unhealthy', 6, 5),
      item('overview.watching', 4, 4),
      { ...item('fleet.gpu-wall', 8, 4), settings: { unhealthyOnly: true } },
      item('fleet.batches', 4, 4),
      item('overview.control-plane', 4, 4),
      { ...item('overview.activity', 8, 4), settings: { severity: 'warning' } },
    ],
  },
];

export const STORAGE_KEY = 'bc-admin:dashboards';

export function defaultState(): DashboardState {
  return {
    version: 1,
    active: 'operations',
    dashboards: PRESETS.map((preset) => ({ id: preset.id, name: preset.name, items: preset.items.map((i) => ({ ...i })) })),
    presetsSeen: PRESETS.map((preset) => preset.id),
  };
}

/** Presets added since this browser last loaded are appended (once). */
function withNewPresets(state: DashboardState): DashboardState {
  const seen = new Set(state.presetsSeen ?? state.dashboards.map((d) => d.id));
  const fresh = PRESETS.filter((preset) => !seen.has(preset.id) && !state.dashboards.some((d) => d.id === preset.id));
  return {
    ...state,
    dashboards: [...state.dashboards, ...fresh.map((preset) => ({ id: preset.id, name: preset.name, items: preset.items.map((i) => ({ ...i })) }))],
    presetsSeen: [...new Set([...seen, ...PRESETS.map((preset) => preset.id)])],
  };
}

export function loadState(): DashboardState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<DashboardState> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.dashboards)) return defaultState();
    // Every stored dashboard is re-validated: a malformed entry is dropped, never rendered.
    const dashboards: Dashboard[] = parsed.dashboards.flatMap((d: unknown) => {
      const x = d as Partial<Dashboard> | null;
      if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || !Array.isArray(x.items)) return [];
      return [{ id: x.id.slice(0, 40), name: x.name.slice(0, 60), items: sanitizeItems(x.items, true) }];
    });
    if (!dashboards.length) return defaultState();
    const active = typeof parsed.active === 'string' && dashboards.some((d) => d.id === parsed.active) ? parsed.active : dashboards[0]!.id;
    const presetsSeen = Array.isArray(parsed.presetsSeen) ? parsed.presetsSeen.filter((p): p is string => typeof p === 'string') : undefined;
    return withNewPresets({ version: 1, active, dashboards, ...(presetsSeen ? { presetsSeen } : {}) });
  } catch {
    return defaultState();
  }
}

export function saveState(state: DashboardState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Layout changes just don't persist (private window).
  }
}

/** A dashboard as a URL-safe string (base64url of its JSON), for share links. */
export function encodeDashboard(dashboard: Pick<Dashboard, 'name' | 'items'>): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, name: dashboard.name, items: dashboard.items }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The dashboard in a share link, or null when it isn't one (validated field by field; nothing is executed). */
export function decodeDashboard(encoded: string): Pick<Dashboard, 'name' | 'items'> | null {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as {
      v?: number;
      name?: unknown;
      items?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.name !== 'string' || !Array.isArray(parsed.items)) return null;
    return { name: parsed.name.slice(0, 60) || 'Shared dashboard', items: sanitizeItems(parsed.items, false) };
  } catch {
    return null;
  }
}

/**
 * Widget instances from an untrusted source (a share link, or storage), field by field: sizes clamped, only
 * string/number/boolean settings, at most 40. Share links get fresh keys so crafted duplicates can't collide;
 * stored dashboards keep theirs unless duplicated.
 */
export function sanitizeItems(list: unknown[], keepKeys: boolean): WidgetInstance[] {
  const items: WidgetInstance[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const i = raw as Partial<WidgetInstance>;
    if (typeof i.widget !== 'string' || typeof i.w !== 'number' || typeof i.h !== 'number') continue;
    if (!Number.isFinite(i.w) || !Number.isFinite(i.h)) continue;
    const settings =
      i.settings && typeof i.settings === 'object'
        ? Object.fromEntries(Object.entries(i.settings).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)))
        : undefined;
    const widget = i.widget.slice(0, 80);
    const key = keepKeys && typeof i.key === 'string' && !items.some((x) => x.key === i.key) ? i.key : uniqueKey(widget, items);
    items.push({
      key,
      widget,
      w: Math.min(12, Math.max(1, Math.round(i.w))),
      h: Math.min(10, Math.max(1, Math.round(i.h))),
      ...(typeof i.title === 'string' ? { title: i.title.slice(0, 80) } : {}),
      ...(settings ? { settings: settings as WidgetInstance['settings'] } : {}),
    });
    if (items.length >= 40) break;
  }
  return items;
}

export const uniqueKey = (widget: string, items: WidgetInstance[]) => {
  let n = 1;
  let key = widget;
  while (items.some((i) => i.key === key)) key = `${widget}#${++n}`;
  return key;
};
