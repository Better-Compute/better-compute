import type { ComponentType } from 'react';
import type { IconType } from 'react-icons';
import { attention as platformAttention, type AttentionItem } from '@/lib/data/platform';

// The admin panel is a set of modules. Each one contributes navigation, dashboard widgets and command-palette
// commands through one descriptor, and owns its pages under app/(admin)/<route>/. The shell, the Overview grid
// and the ⌘K palette read everything from `modules` below, so a module appears everywhere by adding one line.

export interface NavItem {
  href: string;
  label: string;
  icon: IconType;
  /** Sidebar section; see GROUP_ORDER. */
  group: string;
  keywords?: string[];
  /** Two-key chord shown in the palette and the shortcut sheet, e.g. 'g c'. */
  shortcut?: string;
  /** One line for the palette and the module map. */
  description?: string;
}

export interface WidgetProps {
  /** The widget's current size in grid units (12 columns, 80 px rows). */
  size: { w: number; h: number };
  /** True while the dashboard is being arranged: pause animations, skip heavy work. */
  editing: boolean;
  /** This instance's settings (defaults filled in from WidgetDef.settings). */
  settings: Record<string, string | number | boolean>;
  /**
   * Persist values into this instance's settings from inside the widget (a filter it offers, a note's text).
   * Absent where there is no instance to save to (the configure preview, an expanded copy).
   */
  updateSettings?: (patch: Record<string, string | number | boolean>) => void;
}

/** One per-instance option a widget offers in its "Configure" form. */
export type WidgetSetting =
  | { id: string; label: string; type: 'select'; options: { value: string; label: string }[]; default: string; hint?: string }
  | { id: string; label: string; type: 'toggle'; default: boolean; hint?: string }
  | { id: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number; hint?: string };

export interface WidgetDef {
  /** `<module>.<name>`, e.g. 'capacity.heatmap'. Stored in saved layouts, so never rename one. */
  id: string;
  title: string;
  description: string;
  icon: IconType;
  module: string;
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  /** Where "Open" in the widget menu goes. */
  href?: string;
  /** Per-instance options; the component reads them from `props.settings`. */
  settings?: WidgetSetting[];
  /**
   * True when the widget reads the live API while the workspace source is 'live'. In live mode, widgets
   * without it keep showing the simulation and their frame says so.
   */
  live?: boolean;
  component: ComponentType<WidgetProps>;
}

/**
 * An instance's settings with the definition's defaults filled in. Keys a widget saved itself through
 * updateSettings (a note's text) are kept even when they aren't declared settings.
 */
export function widgetSettings(def: WidgetDef, saved?: Record<string, string | number | boolean>) {
  const out: Record<string, string | number | boolean> = { ...saved };
  for (const setting of def.settings ?? []) out[setting.id] = saved?.[setting.id] ?? setting.default;
  return out;
}

export interface CommandDef {
  id: string;
  label: string;
  group: string;
  icon?: IconType;
  keywords?: string[];
  href?: string;
  run?: () => void;
  shortcut?: string;
}

/** One entity a module finds for the ⌘K search (a node, a reservation, a tenant…). */
export interface SearchResult {
  id: string;
  label: string;
  /** Palette section, e.g. 'Nodes'. */
  group: string;
  hint?: string;
  icon?: IconType;
  href: string;
  /** When set, Shift+Enter in the palette peeks instead of navigating. */
  peek?: { kind: string; id: string };
}

/**
 * A peek: a compact view of one entity, opened in a side sheet from any <EntityLink kind id> without leaving
 * the page. Keyed by entity kind ('node', 'pool', 'reservation', 'tenant', 'site'…).
 */
export interface PeekDef {
  title: (id: string) => string;
  href: (id: string) => string;
  icon?: IconType;
  component: ComponentType<{ id: string }>;
}

export interface AdminModule {
  id: string;
  title: string;
  nav: NavItem[];
  widgets: WidgetDef[];
  commands?: CommandDef[];
  /** Entities for the palette. Called with the query (≥ 2 chars) and the workspace clock; return ≤ 8. */
  search?: (query: string, context: { now: number; siteId?: string }) => SearchResult[];
  peeks?: Record<string, PeekDef>;
  /** Small live readouts for the status bar at the bottom of every page (render one compact inline item). */
  status?: ComponentType[];
  /**
   * Items that need an operator, computed from the module's own data at `now` (pure: time travel calls it for
   * past moments). Merged into the bell, the Needs attention page and the Overview queue.
   */
  attention?: (now: number, scope: { siteId?: string }, context: AttentionContext) => AttentionItem[];
  /**
   * Watchable entity kinds: how to describe one entity's state right now, for the Watching widget and the
   * change toasts. Return null when the entity no longer exists. Pure (time travel asks about the past).
   */
  watch?: Record<string, (id: string, now: number, context: AttentionContext) => WatchState | null>;
}

/** One watched entity's state. A change of `status` (or `summary` for 'live') raises a toast while live. */
export interface WatchState {
  label: string;
  status: 'live' | 'ok' | 'warn' | 'crit' | 'off' | 'pending';
  /** One line: "ready · 6 of 8 GPUs booked", "active until 14:00", "degraded: XID 79". */
  summary: string;
  href: string;
}

export const watchFor = (kind: string) => modules.find((module) => module.watch?.[kind])?.watch?.[kind];

/** What collectAttention tells each module: which source the workspace reads (a module reads its live store). */
export interface AttentionContext {
  source: 'simulated' | 'live';
}

/** Sidebar sections, top to bottom. Unknown groups sort after these, alphabetically. */
export const GROUP_ORDER = ['Overview', 'Capacity', 'Fleet', 'Workloads', 'Operations', 'Security', 'Admin'];

// ── Registry: one line per module ────────────────────────────────────────────────────────────────────────────
import { overviewModule } from '@/components/overview/module';
import { fleetModule } from '@/components/fleet/module';
import { capacityModule } from '@/components/capacity/module';

export const modules: AdminModule[] = [
  overviewModule,
  capacityModule,
  fleetModule,
];
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const groupRank = (group: string) => {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
};

export function navGroups(): { group: string; items: NavItem[] }[] {
  const groups = new Map<string, NavItem[]>();
  for (const item of modules.flatMap((module) => module.nav)) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return [...groups]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map(([group, items]) => ({ group, items }));
}

export const allNav = () => modules.flatMap((module) => module.nav);
export const allWidgets = () => modules.flatMap((module) => module.widgets);
export const allCommands = () => modules.flatMap((module) => module.commands ?? []);
export const widgetById = (id: string) => allWidgets().find((widget) => widget.id === id);
export const peekFor = (kind: string): PeekDef | undefined => modules.find((module) => module.peeks?.[kind])?.peeks?.[kind];

/** Every module's search results for a query, grouped in module order. A failing module is skipped. */
export function searchAll(query: string, context: { now: number; siteId?: string }): SearchResult[] {
  if (query.trim().length < 2) return [];
  return modules.flatMap((module) => {
    try {
      return (module.search?.(query.trim(), context) ?? []).slice(0, 8);
    } catch {
      return [];
    }
  });
}

const severityRank = { critical: 0, warning: 1, info: 2 } as const;

/**
 * Everything that needs an operator at `now`: the platform's own items plus every module's `attention`,
 * most severe first, newest first within a severity. A failing module is skipped.
 */
export function collectAttention(
  now: number,
  scope: { siteId?: string } = {},
  context: AttentionContext = { source: 'simulated' },
): AttentionItem[] {
  const items = [
    ...platformAttention(now, scope),
    ...modules.flatMap((module) => {
      try {
        return module.attention?.(now, scope, context) ?? [];
      } catch {
        return [];
      }
    }),
  ];
  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.at - a.at);
}

/** The nav item a path belongs to: the longest href that prefixes it. */
export function navForPath(pathname: string): NavItem | undefined {
  return allNav()
    .filter((item) => pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
