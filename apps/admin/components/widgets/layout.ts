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
      item('overview.control-plane', 4, 4),
      item('overview.sites', 6, 4),
      item('overview.activity', 6, 4),
      item('capacity.heatmap', 12, 4),
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
      item('overview.control-plane', 6, 5),
      item('overview.fleet-wall', 12, 4),
      item('overview.activity', 12, 4),
    ],
  },
];

export const STORAGE_KEY = 'bc-admin:dashboards';

export function defaultState(): DashboardState {
  return {
    version: 1,
    active: 'operations',
    dashboards: PRESETS.map((preset) => ({ id: preset.id, name: preset.name, items: preset.items.map((i) => ({ ...i })) })),
  };
}

export function loadState(): DashboardState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as DashboardState;
    if (parsed.version !== 1 || !Array.isArray(parsed.dashboards) || parsed.dashboards.length === 0) return defaultState();
    return parsed;
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

export const uniqueKey = (widget: string, items: WidgetInstance[]) => {
  let n = 1;
  let key = widget;
  while (items.some((i) => i.key === key)) key = `${widget}#${++n}`;
  return key;
};
