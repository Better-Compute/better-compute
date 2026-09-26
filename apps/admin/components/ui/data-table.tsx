'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiBookmarkLine,
  RiDownload2Line,
  RiEyeLine,
  RiFilter3Line,
  RiSearchLine,
  RiCloseLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { useWorkspace } from '@/components/shell/workspace';
import { Menu, ToolButton } from './overlay';
import { EmptyState } from './panel';

// The admin's table: search, facet filters, sortable columns, column visibility, row selection with bulk
// actions, keyboard navigation (j/k or arrows, Enter opens) and CSV export of what is on screen. Density follows
// the workspace preference. Plain <table> with a sticky header; paging by "show more" keeps it fast to ~5k rows.

export interface Column<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Sort key, search text and CSV cell. Defaults to nothing (not sortable, not searchable). */
  value?: (row: Row) => string | number | undefined;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Hidden until the viewer turns it on. */
  defaultHidden?: boolean;
  /** Can't be hidden (the id column). */
  pinned?: boolean;
}

export interface Facet<Row> {
  id: string;
  label: string;
  value: (row: Row) => string;
  /** Display label per value; defaults to the value. */
  labels?: Record<string, string>;
}

export interface DataTableProps<Row> {
  rows: Row[];
  columns: Column<Row>[];
  rowId: (row: Row) => string;
  facets?: Facet<Row>[];
  searchPlaceholder?: string;
  onRowClick?: (row: Row) => void;
  activeId?: string;
  /** Enables checkboxes; render the bulk bar from the selected rows. */
  bulkActions?: (selected: Row[], clear: () => void) => ReactNode;
  toolbar?: ReactNode;
  empty?: ReactNode;
  pageSize?: number;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  /** CSV file name, without extension. Omit to hide export. */
  exportName?: string;
  className?: string;
  /** Max height before the body scrolls (sticky header). */
  maxHeight?: number | string;
  /** Controlled search text (drive it from the URL or chips); uncontrolled when omitted. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Marks a row with a left rail: red for 'crit', amber for 'warn'. */
  rowTone?: (row: Row) => 'crit' | 'warn' | undefined;
  /**
   * Persist this table's filters, sort and columns per browser under this key, and offer named saved views
   * ("My H100 nodes", "Stuck reservations") in the toolbar.
   */
  viewKey?: string;
}

interface ViewState {
  query?: string;
  filters: Record<string, string | undefined>;
  sort?: { id: string; dir: 'asc' | 'desc' };
  hidden: string[];
}

interface StoredViews {
  current?: ViewState;
  active?: string;
  saved: { name: string; state: ViewState }[];
}

const viewStorageKey = (key: string) => `bc-admin:table:${key}`;

function loadViews(key: string): StoredViews {
  try {
    const raw = window.localStorage.getItem(viewStorageKey(key));
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredViews>) : {};
    return { ...parsed, saved: parsed.saved ?? [] };
  } catch {
    return { saved: [] };
  }
}

function storeViews(key: string, views: StoredViews) {
  try {
    window.localStorage.setItem(viewStorageKey(key), JSON.stringify(views));
  } catch {
    // Views just don't persist in a private window.
  }
}

function toCsv<Row>(rows: Row[], columns: Column<Row>[]) {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const usable = columns.filter((column) => column.value);
  const header = usable.map((column) => cell(typeof column.header === 'string' ? column.header : column.id));
  return [header.join(','), ...rows.map((row) => usable.map((column) => cell(column.value!(row))).join(','))].join('\r\n');
}

export function DataTable<Row>({
  rows,
  columns,
  rowId,
  facets = [],
  searchPlaceholder = 'Filter…',
  onRowClick,
  activeId,
  bulkActions,
  toolbar,
  empty,
  pageSize = 50,
  initialSort,
  exportName,
  className,
  maxHeight,
  query: controlledQuery,
  onQueryChange,
  rowTone,
  viewKey,
}: DataTableProps<Row>) {
  const { density } = useWorkspace();
  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery;
  const setQuery = (next: string) => {
    if (controlledQuery === undefined) setLocalQuery(next);
    onQueryChange?.(next);
  };
  const [sort, setSort] = useState(initialSort);
  const [hidden, setHidden] = useState(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)));
  const [filters, setFilters] = useState<Record<string, string | undefined>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(pageSize);
  const [cursor, setCursor] = useState(-1);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Saved views: restore the last state once, then keep it current; named views are snapshots of it.
  const [views, setViews] = useState<StoredViews>({ saved: [] });
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const defaultHidden = useMemo(() => columns.filter((c) => c.defaultHidden).map((c) => c.id), [columns]);
  const snapshot = (): ViewState => ({
    ...(controlledQuery === undefined && query ? { query } : {}),
    filters,
    ...(sort ? { sort } : {}),
    hidden: [...hidden],
  });
  const applyState = (state: ViewState) => {
    setFilters(state.filters ?? {});
    setSort(state.sort ?? initialSort);
    setHidden(new Set(state.hidden ?? defaultHidden));
    if (controlledQuery === undefined) setLocalQuery(state.query ?? '');
  };
  useEffect(() => {
    if (!viewKey) return;
    const stored = loadViews(viewKey);
    setViews(stored);
    if (stored.current) applyState(stored.current);
    setViewsLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);
  useEffect(() => {
    if (!viewKey || !viewsLoaded) return;
    const next = { ...views, current: snapshot() };
    storeViews(viewKey, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, viewsLoaded, filters, sort, hidden, localQuery, views]);
  const updateViews = (next: StoredViews) => {
    setViews(next);
    if (viewKey) storeViews(viewKey, { ...next, current: snapshot() });
  };
  const saveViewAs = () => {
    const name = window.prompt('Name this view', views.active ?? '')?.trim();
    if (!name) return;
    updateViews({ ...views, active: name, saved: [...views.saved.filter((v) => v.name !== name), { name, state: snapshot() }] });
  };
  const resetView = () => {
    applyState({ filters: {}, ...(initialSort ? { sort: initialSort } : {}), hidden: defaultHidden });
    updateViews({ ...views, active: undefined });
  };

  const visible = columns.filter((column) => !hidden.has(column.id));

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const searchable = columns.filter((column) => column.value);
    let out = rows.filter((row) =>
      facets.every((facet) => !filters[facet.id] || facet.value(row) === filters[facet.id]),
    );
    if (needle) {
      const terms = needle.split(/\s+/);
      out = out.filter((row) => {
        const text = searchable.map((column) => String(column.value!(row) ?? '')).join(' ').toLowerCase();
        return terms.every((term) => text.includes(term));
      });
    }
    if (sort) {
      const column = columns.find((c) => c.id === sort.id);
      if (column?.value) {
        const dir = sort.dir === 'asc' ? 1 : -1;
        out = [...out].sort((a, b) => {
          const av = column.value!(a);
          const bv = column.value!(b);
          if (av === bv) return 0;
          if (av === undefined) return 1;
          if (bv === undefined) return -1;
          return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'en', { numeric: true })) * dir;
        });
      }
    }
    return out;
  }, [rows, columns, facets, filters, query, sort]);

  useEffect(() => setLimit(pageSize), [query, filters, sort, pageSize]);

  const shown = filtered.slice(0, limit);
  const selectedRows = rows.filter((row) => selected.has(rowId(row)));
  const allShownSelected = shown.length > 0 && shown.every((row) => selected.has(rowId(row)));

  const facetCounts = useMemo(
    () =>
      Object.fromEntries(
        facets.map((facet) => {
          const counts = new Map<string, number>();
          for (const row of rows) counts.set(facet.value(row), (counts.get(facet.value(row)) ?? 0) + 1);
          return [facet.id, [...counts].sort((a, b) => b[1] - a[1])];
        }),
      ),
    [rows, facets],
  );

  const toggleSort = (column: Column<Row>) => {
    if (!column.value) return;
    setSort((current) =>
      current?.id !== column.id
        ? { id: column.id, dir: typeof column.value!(rows[0]!) === 'number' ? 'desc' : 'asc' }
        : current.dir === 'desc'
          ? { id: column.id, dir: 'asc' }
          : current.dir === 'asc' && initialSort?.id !== column.id
            ? undefined
            : { id: column.id, dir: 'desc' },
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (event.key === 'Enter' && cursor >= 0 && shown[cursor]) {
      onRowClick?.(shown[cursor]!);
    } else if (event.key === 'x' && bulkActions && cursor >= 0 && shown[cursor]) {
      const id = rowId(shown[cursor]!);
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  };

  useEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered, visible)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cellPad = density === 'compact' ? 'px-2.5 py-1' : 'px-3 py-2';
  const activeFilters = Object.entries(filters).filter(([, value]) => value);

  return (
    <div className={cx('flex min-w-0 flex-col', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-separator-border px-2 py-2">
        <label className="flex h-8 min-w-48 flex-1 items-center gap-2 border border-border-button-default bg-background-primary-default px-2 focus-within:ring-2 focus-within:ring-border-focus-ring sm:max-w-80">
          <RiSearchLine className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Filter rows"
            className="min-w-0 flex-1 bg-transparent text-body-regular text-text-primary outline-none placeholder:text-text-placeholder"
          />
          {query && (
            <button type="button" aria-label="Clear filter" onClick={() => setQuery('')} className="text-text-tertiary hover:text-text-primary">
              <RiCloseLine className="size-4" aria-hidden />
            </button>
          )}
        </label>
        {facets.map((facet) => (
          <Menu
            key={facet.id}
            label={facet.label}
            placement="bottom start"
            trigger={
              <ToolButton icon={RiFilter3Line} label={`Filter by ${facet.label}`} active={Boolean(filters[facet.id])}>
                {filters[facet.id] ? `${facet.label}: ${facet.labels?.[filters[facet.id]!] ?? filters[facet.id]}` : facet.label}
              </ToolButton>
            }
            items={[
              { id: '__all', label: `All (${rows.length})`, onAction: () => setFilters((f) => ({ ...f, [facet.id]: undefined })) },
              ...((facetCounts[facet.id] ?? []) as [string, number][]).map(([value, count], index) => ({
                id: `v:${value}`,
                label: `${facet.labels?.[value] ?? value} (${count})`,
                separator: index === 0,
                onAction: () => setFilters((f) => ({ ...f, [facet.id]: value })),
              })),
            ]}
          />
        ))}
        {activeFilters.length > 0 && (
          <button type="button" onClick={() => setFilters({})} className="font-mono text-[11px] text-text-tertiary underline-offset-2 hover:text-text-primary hover:underline">
            clear filters
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {toolbar}
          {viewKey && (
            <Menu
              label="Saved views"
              trigger={
                <ToolButton icon={RiBookmarkLine} label="Saved views" active={Boolean(views.active)}>
                  {views.active
                    ? `${views.active}${JSON.stringify(views.saved.find((v) => v.name === views.active)?.state) !== JSON.stringify(snapshot()) ? ' *' : ''}`
                    : 'Views'}
                </ToolButton>
              }
              items={[
                ...views.saved.map((view) => ({
                  id: `view:${view.name}`,
                  label: view.name === views.active ? `● ${view.name}` : view.name,
                  onAction: () => {
                    applyState(view.state);
                    updateViews({ ...views, active: view.name });
                  },
                })),
                { id: 'save', label: views.active ? `Update “${views.active}”` : 'Save current view…', icon: RiBookmarkLine, separator: views.saved.length > 0, onAction: () => (views.active ? updateViews({ ...views, saved: views.saved.map((v) => (v.name === views.active ? { name: v.name, state: snapshot() } : v)) }) : saveViewAs()) },
                ...(views.active ? [{ id: 'save-as', label: 'Save as new view…', icon: RiBookmarkLine, onAction: saveViewAs }] : []),
                { id: 'reset', label: 'Reset to default', onAction: resetView },
                ...(views.active
                  ? [{ id: 'delete', label: `Delete “${views.active}”`, danger: true, onAction: () => updateViews({ ...views, active: undefined, saved: views.saved.filter((v) => v.name !== views.active) }) }]
                  : []),
              ]}
            />
          )}
          <span className="px-1 font-mono text-[11px] text-text-tertiary tabular-nums">
            {filtered.length === rows.length ? rows.length : `${filtered.length} / ${rows.length}`}
          </span>
          <Menu
            label="Columns"
            trigger={<ToolButton icon={RiEyeLine} label="Choose columns" />}
            items={columns
              .filter((column) => !column.pinned)
              .map((column) => ({
                id: column.id,
                label: `${hidden.has(column.id) ? '○' : '●'}  ${typeof column.header === 'string' ? column.header : column.id}`,
                onAction: () =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (next.has(column.id)) next.delete(column.id);
                    else next.add(column.id);
                    return next;
                  }),
              }))}
          />
          {exportName && <ToolButton icon={RiDownload2Line} label="Export CSV" onPress={exportCsv} />}
        </div>
      </div>

      {bulkActions && selected.size > 0 && (
        <div className="flex items-center gap-3 border-b border-signal-fill/40 bg-signal-soft px-3 py-1.5">
          <span className="font-mono text-[12px] text-signal tabular-nums">{selected.size} selected</span>
          <div className="flex items-center gap-2">{bulkActions(selectedRows, () => setSelected(new Set()))}</div>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto font-mono text-[11px] text-text-secondary hover:text-text-primary">
            clear
          </button>
        </div>
      )}

      <div className="min-h-0 overflow-auto" style={{ maxHeight }} tabIndex={0} onKeyDown={onKeyDown} aria-label="Table; j and k move, Enter opens">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-[1] bg-surface-raised">
            <tr className="border-b border-separator-border">
              {bulkActions && (
                <th className={cx('w-8', cellPad)}>
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={allShownSelected}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const row of shown) {
                          if (allShownSelected) next.delete(rowId(row));
                          else next.add(rowId(row));
                        }
                        return next;
                      })
                    }
                    className="accent-[var(--color-signal-fill)]"
                  />
                </th>
              )}
              {visible.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  style={{ width: column.width }}
                  aria-sort={sort?.id === column.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cx(
                    cellPad,
                    'font-mono text-[11px] font-medium tracking-wide whitespace-nowrap text-text-tertiary uppercase',
                    column.align === 'right' && 'text-right',
                    column.align === 'center' && 'text-center',
                  )}
                >
                  {column.value ? (
                    <button type="button" onClick={() => toggleSort(column)} className="inline-flex items-center gap-1 uppercase hover:text-text-primary">
                      {column.header}
                      {sort?.id === column.id &&
                        (sort.dir === 'asc' ? <RiArrowUpLine className="size-3 text-signal" aria-hidden /> : <RiArrowDownLine className="size-3 text-signal" aria-hidden />)}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {shown.map((row, index) => {
              const id = rowId(row);
              const isActive = activeId === id;
              const isCursor = cursor === index;
              const tone = rowTone?.(row);
              return (
                <tr
                  key={id}
                  data-row-index={index}
                  onClick={onRowClick ? () => { setCursor(index); onRowClick(row); } : undefined}
                  className={cx(
                    'border-b border-separator-border/70 text-body-regular text-text-primary transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-background-secondary-default/60',
                    selected.has(id) && 'bg-signal-soft/60',
                    isActive && 'bg-background-secondary-default',
                    tone === 'crit' && 'shadow-[inset_3px_0_0_var(--color-red-500)]',
                    tone === 'warn' && 'shadow-[inset_3px_0_0_var(--color-signal-fill)]',
                    isCursor && 'outline outline-1 -outline-offset-1 outline-signal-fill/70',
                  )}
                >
                  {bulkActions && (
                    <td className={cellPad} onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${id}`}
                        checked={selected.has(id)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                        className="accent-[var(--color-signal-fill)]"
                      />
                    </td>
                  )}
                  {visible.map((column) => (
                    <td
                      key={column.id}
                      className={cx(
                        cellPad,
                        'max-w-0 truncate',
                        column.align === 'right' && 'text-right tabular-nums',
                        column.align === 'center' && 'text-center',
                      )}
                      style={{ width: column.width }}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (empty ?? <EmptyState title="Nothing matches">Loosen the filter or clear the facets.</EmptyState>)}
        {filtered.length > limit && (
          <button
            type="button"
            onClick={() => setLimit((l) => l + pageSize)}
            className="w-full border-t border-separator-border py-2 font-mono text-[12px] text-text-secondary hover:bg-background-secondary-default hover:text-text-primary"
          >
            show {Math.min(pageSize, filtered.length - limit)} more · {filtered.length - limit} hidden
          </button>
        )}
      </div>
    </div>
  );
}
