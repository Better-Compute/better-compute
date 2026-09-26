'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { useTheme } from 'next-themes';
import {
  RiArrowRightLine,
  RiBuilding2Line,
  RiContrast2Line,
  RiDashboardLine,
  RiGlobalLine,
  RiHistoryLine,
  RiKeyboardLine,
  RiLayoutColumnLine,
  RiPauseLine,
  RiServerLine,
  RiTeamLine,
  RiTimeLine,
} from 'react-icons/ri';
import { pools, sites, tenants } from '@/lib/data';
import { allCommands, allNav } from '@/lib/modules';
import { cx } from '@/utils/cx';
import { RANGES, useWorkspace, type RangeKey } from './workspace';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

interface Entry {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: Icon;
  keywords?: string[];
  shortcut?: string;
  perform: () => void;
}

/** Fuzzy score: every query char in order; bonuses for word starts and runs. -1 when it doesn't match. */
function score(text: string, query: string): { score: number; hits: number[] } {
  if (!query) return { score: 0, hits: [] };
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const direct = hay.indexOf(needle);
  if (direct !== -1) {
    const start = direct === 0 || /[\s\-_/.·]/.test(hay[direct - 1]!) ? 30 : 10;
    return { score: 100 + start - direct * 0.5, hits: Array.from({ length: needle.length }, (_, i) => direct + i) };
  }
  let total = 0;
  let last = -2;
  const hits: number[] = [];
  let from = 0;
  for (const char of needle) {
    if (char === ' ') continue;
    const at = hay.indexOf(char, from);
    if (at === -1) return { score: -1, hits: [] };
    total += at === last + 1 ? 6 : 1;
    if (at === 0 || /[\s\-_/.·]/.test(hay[at - 1]!)) total += 5;
    hits.push(at);
    last = at;
    from = at + 1;
  }
  return { score: total - hay.length * 0.05, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((char, i) =>
        set.has(i) ? (
          <mark key={i} className="bg-transparent text-signal">
            {char}
          </mark>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </>
  );
}

const RECENT_KEY = 'bc-admin:palette-recent';

export const PALETTE_EVENTS = {
  editDashboard: 'bc-admin:edit-dashboard',
  toggleSidebar: 'bc-admin:toggle-sidebar',
  showShortcuts: 'bc-admin:show-shortcuts',
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    try {
      setRecent(JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]'));
    } catch {
      setRecent([]);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (href: string) => () => router.push(href);
    const emit = (name: string) => () => window.dispatchEvent(new Event(name));
    return [
      ...allNav().map((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        group: 'Go to',
        hint: item.description ?? item.group,
        icon: item.icon,
        keywords: item.keywords,
        shortcut: item.shortcut,
        perform: go(item.href),
      })),
      ...allCommands().map((command) => ({
        id: `cmd:${command.id}`,
        label: command.label,
        group: command.group,
        icon: command.icon,
        keywords: command.keywords,
        shortcut: command.shortcut,
        perform: command.run ?? go(command.href ?? '/'),
      })),
      { id: 'ws:edit', label: 'Arrange dashboard widgets', group: 'Workspace', icon: RiDashboardLine, shortcut: 'e', keywords: ['edit', 'layout', 'customize'], perform: () => { router.push('/'); setTimeout(emit(PALETTE_EVENTS.editDashboard), 60); } },
      { id: 'ws:live', label: workspace.live ? 'Pause the clock' : 'Resume live updates', group: 'Workspace', icon: RiPauseLine, shortcut: 'p', keywords: ['freeze', 'stop', 'live'], perform: () => workspace.setLive(!workspace.live) },
      { id: 'ws:theme', label: `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`, group: 'Workspace', icon: RiContrast2Line, keywords: ['dark', 'light', 'appearance'], perform: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark') },
      { id: 'ws:density', label: `Use ${workspace.density === 'compact' ? 'comfortable' : 'compact'} density`, group: 'Workspace', icon: RiLayoutColumnLine, keywords: ['rows', 'dense', 'spacing'], perform: () => workspace.setDensity(workspace.density === 'compact' ? 'comfortable' : 'compact') },
      { id: 'ws:sidebar', label: 'Toggle the sidebar', group: 'Workspace', icon: RiLayoutColumnLine, shortcut: '[', perform: emit(PALETTE_EVENTS.toggleSidebar) },
      { id: 'ws:keys', label: 'Keyboard shortcuts', group: 'Workspace', icon: RiKeyboardLine, shortcut: '?', perform: emit(PALETTE_EVENTS.showShortcuts) },
      ...(Object.keys(RANGES) as RangeKey[]).map((key) => ({
        id: `range:${key}`,
        label: `Time range: ${RANGES[key].label.toLowerCase()}`,
        group: 'Workspace',
        icon: RiTimeLine,
        keywords: ['range', key],
        perform: () => workspace.setRange(key),
      })),
      { id: 'scope:all', label: 'Scope: all sites', group: 'Scope', icon: RiGlobalLine, perform: () => workspace.setSiteId(undefined) },
      ...sites.map((site) => ({
        id: `scope:${site.id}`,
        label: `Scope: ${site.id} · ${site.name}`,
        group: 'Scope',
        hint: `${site.city} · ${site.provider}`,
        icon: RiGlobalLine,
        keywords: [site.city, site.region],
        perform: () => workspace.setSiteId(site.id),
      })),
      ...pools.map((pool) => ({
        id: `pool:${pool.id}`,
        label: `${pool.name} (${pool.id})`,
        group: 'Pools',
        hint: `${pool.short} · ${pool.nodes} nodes · ${pool.siteId}`,
        icon: RiServerLine,
        keywords: [pool.model, pool.kind, pool.siteId],
        perform: go(`/pools/${pool.id}`),
      })),
      ...tenants.map((tenant) => ({
        id: `tenant:${tenant.id}`,
        label: tenant.name,
        group: 'Tenants',
        hint: tenant.id,
        icon: tenant.id === 'ten_root' ? RiBuilding2Line : RiTeamLine,
        keywords: [tenant.slug],
        perform: go(`/quotas?tenant=${tenant.id}`),
      })),
    ];
  }, [router, workspace, resolvedTheme, setTheme]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const recents = recent.map((id) => byId.get(id)).filter(Boolean).map((entry) => ({ entry: { ...entry!, group: 'Recent' }, hits: [] as number[] }));
      const defaults = entries.filter((entry) => entry.group === 'Go to' || entry.group === 'Workspace').slice(0, 24);
      return [...recents, ...defaults.map((entry) => ({ entry, hits: [] as number[] }))];
    }
    return entries
      .map((entry) => {
        const main = score(entry.label, q);
        const extra = Math.max(-1, ...[entry.hint ?? '', ...(entry.keywords ?? []), entry.group].map((text) => score(text, q).score * 0.6));
        return { entry, hits: main.hits, s: Math.max(main.score, extra) };
      })
      .filter((result) => result.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ entry, hits }) => ({ entry, hits }));
  }, [entries, query, recent]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (entry: Entry) => {
    const baseId = entry.id;
    try {
      const next = [baseId, ...recent.filter((id) => id !== baseId)].slice(0, 5);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Recents are a convenience.
    }
    onOpenChange(false);
    entry.perform();
  };

  // Group while keeping the score order within each group; groups appear in first-hit order.
  const grouped: { group: string; items: { entry: Entry; hits: number[]; index: number }[] }[] = [];
  results.forEach((result, index) => {
    let bucket = grouped.find((g) => g.group === result.entry.group);
    if (!bucket) grouped.push((bucket = { group: result.entry.group, items: [] }));
    bucket.items.push({ ...result, index });
  });
  const flat = grouped.flatMap((g) => g.items);

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-[60] bg-neutral-950/50 backdrop-blur-[2px] entering:animate-[fade-in_120ms_ease-out] exiting:animate-[fade-out_100ms_ease-in]"
    >
      <Modal className="fixed top-[12vh] left-1/2 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 border border-separator-border bg-surface-raised shadow-lg outline-none entering:animate-[pop-in_140ms_ease-out]">
        <Dialog aria-label="Command palette" className="outline-none">
          <div className="flex items-center gap-2 border-b border-separator-border px-3">
            <RiArrowRightLine className="size-4 text-signal" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCursor((c) => Math.min(flat.length - 1, c + 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const target = flat.find((item) => item.index === cursor);
                  if (target) run(target.entry);
                }
              }}
              placeholder="Jump to a page, pool, tenant, or run a command…"
              aria-label="Command"
              className="h-12 flex-1 bg-transparent font-mono text-[14px] text-text-primary outline-none placeholder:text-text-placeholder"
            />
            <kbd className="font-mono text-[10px] text-text-tertiary">esc</kbd>
          </div>
          <div ref={listRef} role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto py-1">
            {grouped.map((group) => (
              <div key={group.group} role="group" aria-label={group.group}>
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 font-mono text-[10px] tracking-[0.14em] text-text-tertiary uppercase">
                  {group.group === 'Recent' && <RiHistoryLine className="size-3" aria-hidden />}
                  {group.group}
                </div>
                {group.items.map(({ entry, hits, index }) => (
                  <div
                    key={`${group.group}:${entry.id}`}
                    role="option"
                    aria-selected={index === cursor}
                    data-index={index}
                    onPointerMove={() => setCursor(index)}
                    onClick={() => run(entry)}
                    className={cx(
                      'mx-1 flex h-9 cursor-default items-center gap-2.5 px-2 text-body-regular',
                      index === cursor ? 'bg-background-secondary-default text-text-primary shadow-[inset_2px_0_0_var(--color-signal-fill)]' : 'text-text-secondary',
                    )}
                  >
                    {entry.icon ? <entry.icon className="size-4 shrink-0 text-text-tertiary" aria-hidden /> : <span className="size-4" />}
                    <span className="min-w-0 truncate text-text-primary">
                      <Highlight text={entry.label} hits={hits} />
                    </span>
                    {entry.hint && <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary">{entry.hint}</span>}
                    {!entry.hint && <span className="flex-1" />}
                    {entry.shortcut && <kbd className="shrink-0 border border-separator-border px-1 font-mono text-[10px] text-text-tertiary">{entry.shortcut}</kbd>}
                  </div>
                ))}
              </div>
            ))}
            {flat.length === 0 && <div className="px-4 py-8 text-center text-caption-1-regular text-text-tertiary">No match for “{query}”.</div>}
          </div>
          <div className="flex items-center gap-4 border-t border-separator-border px-3 py-1.5 font-mono text-[10px] text-text-tertiary">
            <span>↑↓ move</span>
            <span>↵ run</span>
            <span>esc close</span>
            <span className="ml-auto">{flat.length} results</span>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
