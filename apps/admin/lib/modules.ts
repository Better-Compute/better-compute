import type { ComponentType } from 'react';
import type { IconType } from 'react-icons';

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
}

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
  component: ComponentType<WidgetProps>;
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

/** The nav item a path belongs to: the longest href that prefixes it. */
export function navForPath(pathname: string): NavItem | undefined {
  return allNav()
    .filter((item) => pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
