'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RiAddLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiEdit2Line,
  RiLayoutMasonryLine,
  RiMore2Fill,
  RiRefreshLine,
  RiSearchLine,
  RiShareLine,
} from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { PALETTE_EVENTS, takeDashboardAction } from '@/components/shell/command-palette';
import { useFeedback } from '@/components/ui/feedback';
import { useKiosk } from '@/components/shell/kiosk';
import { Drawer, Menu, ToolButton } from '@/components/ui/overlay';
import { allWidgets, modules, widgetById, widgetSettings, type WidgetDef } from '@/lib/modules';
import { ConfigureWidget, settingsSummary } from './configure';
import { cx } from '@/utils/cx';
import {
  defaultState,
  loadState,
  PRESETS,
  saveState,
  uniqueKey,
  decodeDashboard,
  encodeDashboard,
  type Dashboard,
  type DashboardState,
  type WidgetInstance,
} from './layout';
import { WidgetFrame, WidgetMaximized } from './widget-frame';

const ROW = 80;
const GAP = 12;

/**
 * Named dashboards of module widgets. View mode is a dense 12-column grid; edit mode (`e`) adds drag to
 * reorder, a resize corner, remove, and the widget catalog. Layouts persist per browser.
 */
export function Dashboards() {
  const [state, setState] = useState<DashboardState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [editing, setEditing] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [maximized, setMaximized] = useState<WidgetInstance | null>(null);
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);
  const { confirm, toast } = useFeedback();

  const [incoming, setIncoming] = useState<Pick<Dashboard, 'name' | 'items'> | null>(null);

  useEffect(() => {
    setState(loadState());
    setHydrated(true);
    // A share link (?dashboard=…) offers the dashboard; the param leaves the URL either way.
    const url = new URL(window.location.href);
    const shared = url.searchParams.get('dashboard');
    if (shared) {
      setIncoming(decodeDashboard(shared));
      url.searchParams.delete('dashboard');
      window.history.replaceState(window.history.state, '', url.href);
    }
  }, []);
  useEffect(() => {
    if (hydrated) saveState(state);
  }, [state, hydrated]);
  useEffect(() => {
    const onEdit = () => setEditing((current) => !current);
    // From the palette: switch dashboard, or add a widget to the active one (then show it being arranged).
    // Queued in sessionStorage so it survives the navigation here; the event covers "already on the Overview".
    const onAction = () => {
      const action = takeDashboardAction();
      if (!action) return;
      if (action.type === 'open') {
        setState((current) => (current.dashboards.some((d) => d.id === action.id) ? { ...current, active: action.id } : current));
        return;
      }
      const def = widgetById(action.id);
      if (!def) return;
      setState((current) => ({
        ...current,
        dashboards: current.dashboards.map((d) =>
          d.id === current.active ? { ...d, items: [{ key: uniqueKey(def.id, d.items), widget: def.id, w: def.defaultSize.w, h: def.defaultSize.h }, ...d.items] } : d,
        ),
      }));
      setEditing(true);
      toast({ title: `Added “${def.title}”`, detail: 'At the top of this dashboard; drag it or use the arrow keys to place it.', status: 'ok' });
    };
    // After the saved state loads (the effect above runs first), apply anything queued before we mounted.
    const pending = window.setTimeout(onAction, 0);
    window.addEventListener(PALETTE_EVENTS.editDashboard, onEdit);
    window.addEventListener(PALETTE_EVENTS.dashboardAction, onAction);
    return () => {
      window.clearTimeout(pending);
      window.removeEventListener(PALETTE_EVENTS.editDashboard, onEdit);
      window.removeEventListener(PALETTE_EVENTS.dashboardAction, onAction);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wall display: rotate through the dashboards without touching the saved active one.
  const kiosk = useKiosk();
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    if (!kiosk.on || !kiosk.rotateSeconds || state.dashboards.length < 2) return;
    const timer = window.setInterval(() => setRotation((r) => r + 1), kiosk.rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [kiosk.on, kiosk.rotateSeconds, state.dashboards.length]);
  const activeIndex = Math.max(0, state.dashboards.findIndex((d) => d.id === state.active));
  const dashboard = kiosk.on
    ? state.dashboards[(activeIndex + rotation) % state.dashboards.length]!
    : (state.dashboards.find((d) => d.id === state.active) ?? state.dashboards[0]!);

  const update = useCallback(
    (change: (items: WidgetInstance[]) => WidgetInstance[]) =>
      setState((current) => ({
        ...current,
        dashboards: current.dashboards.map((d) => (d.id === dashboard.id ? { ...d, items: change(d.items) } : d)),
      })),
    [dashboard.id],
  );

  const addWidget = (def: WidgetDef) => {
    update((items) => [{ key: uniqueKey(def.id, items), widget: def.id, w: def.defaultSize.w, h: def.defaultSize.h }, ...items]);
    setCatalog(false);
    setEditing(true);
  };

  const newDashboard = (from?: (typeof PRESETS)[number]) => {
    const id = `d-${Date.now().toString(36)}`;
    const name = from ? `${from.name} copy` : `Dashboard ${state.dashboards.length + 1}`;
    setState((current) => ({
      ...current,
      active: id,
      dashboards: [...current.dashboards, { id, name, items: from ? from.items.map((i) => ({ ...i })) : [] }],
    }));
    if (!from) setCatalog(true);
    setEditing(true);
  };

  const rename = (d: Dashboard) => {
    const name = window.prompt('Dashboard name', d.name)?.trim();
    if (name) setState((current) => ({ ...current, dashboards: current.dashboards.map((x) => (x.id === d.id ? { ...x, name } : x)) }));
  };

  const remove = async (d: Dashboard) => {
    if (state.dashboards.length === 1) return;
    const ok = await confirm({
      title: `Delete “${d.name}”?`,
      body: `Its ${d.items.length} widgets and their sizes go with it. Other dashboards are not affected.`,
      confirmLabel: 'Delete dashboard',
      danger: true,
    });
    if (!ok) return;
    toast({ title: `Deleted “${d.name}”`, status: 'ok', action: { label: 'undo', onAction: () => setState((current) => ({ ...current, active: d.id, dashboards: [...current.dashboards, d] })) } });
    setState((current) => {
      const dashboards = current.dashboards.filter((x) => x.id !== d.id);
      return { ...current, dashboards, active: current.active === d.id ? dashboards[0]!.id : current.active };
    });
  };

  const shareLink = async (d: Dashboard) => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('dashboard', encodeDashboard(d));
    try {
      await navigator.clipboard.writeText(url.href);
      toast({ title: 'Share link copied', detail: `“${d.name}”, ${d.items.length} widgets and their settings. Anyone with the admin can import it.`, status: 'ok' });
    } catch {
      window.prompt('Copy this link', url.href);
    }
  };

  const importShared = () => {
    if (!incoming) return;
    const id = `d-${Date.now().toString(36)}`;
    setState((current) => ({ ...current, active: id, dashboards: [...current.dashboards, { id, name: incoming.name, items: incoming.items }] }));
    toast({ title: `Imported “${incoming.name}”`, status: 'ok' });
    setIncoming(null);
  };

  const resetToPreset = () => {
    const preset = PRESETS.find((p) => p.id === dashboard.id);
    update(() => (preset ? preset.items.map((i) => ({ ...i })) : []));
  };

  return (
    <div className="flex flex-col gap-3">
      {incoming && (
        <div role="status" className="flex flex-wrap items-center gap-3 border border-signal-fill/50 bg-signal-soft px-3 py-2">
          <RiShareLine className="size-4 text-signal" aria-hidden />
          <span className="text-body-regular text-text-primary">
            Someone shared the dashboard <b className="font-medium">“{incoming.name}”</b> ({incoming.items.length} widgets).
          </span>
          <span className="flex-1" />
          <Button size="xs" onClick={importShared}>
            Import
          </Button>
          <Button size="xs" variant="secondary" onClick={() => setIncoming(null)}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-separator-border">
        <div role="tablist" aria-label="Dashboards" data-tour="dashboards" className="-mb-px flex min-w-0 flex-1 items-end gap-0 overflow-x-auto">
          {state.dashboards.map((d) => {
            const active = d.id === dashboard.id;
            return (
              <button
                key={d.id}
                role="tab"
                aria-selected={active}
                onClick={() => setState((current) => ({ ...current, active: d.id }))}
                onDoubleClick={() => rename(d)}
                title="Double-click to rename"
                className={cx(
                  'relative h-9 shrink-0 border-b-2 px-3 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                  active ? 'border-signal-fill text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
                )}
              >
                {d.name}
                <span className="ml-1.5 text-text-tertiary tabular-nums">{d.items.length}</span>
              </button>
            );
          })}
          {!kiosk.on && <Menu
            label="New dashboard"
            placement="bottom start"
            trigger={<ToolButton icon={RiAddLine} label="New dashboard" className="mb-1 ml-1" />}
            items={[
              { id: 'blank', label: 'Blank dashboard', icon: RiLayoutMasonryLine, onAction: () => newDashboard() },
              ...PRESETS.map((preset, index) => ({
                id: `preset-${preset.id}`,
                label: `From “${preset.name}”`,
                icon: RiLayoutMasonryLine,
                separator: index === 0,
                onAction: () => newDashboard(preset),
              })),
            ]}
          />}
        </div>
        <div className={cx('mb-1.5 flex items-center gap-1.5', kiosk.on && 'hidden')}>
          {editing && (
            <Button variant="secondary" size="small" leadingIcon={RiAddLine} onClick={() => setCatalog(true)}>
              Add widget
            </Button>
          )}
          <Button
            variant={editing ? 'primary' : 'secondary'}
            size="small"
            leadingIcon={editing ? RiCheckLine : RiEdit2Line}
            onClick={() => setEditing((e) => !e)}
            title="Arrange widgets (e)"
            data-tour="arrange"
          >
            {editing ? 'Done' : 'Arrange'}
          </Button>
          <Menu
            label="Dashboard options"
            trigger={<ToolButton icon={RiMore2Fill} label="Dashboard options" />}
            items={[
              { id: 'rename', label: 'Rename…', icon: RiEdit2Line, onAction: () => rename(dashboard) },
              { id: 'share', label: 'Copy share link', icon: RiShareLine, onAction: () => void shareLink(dashboard) },
              { id: 'reset', label: PRESETS.some((p) => p.id === dashboard.id) ? 'Reset to preset' : 'Clear widgets', icon: RiRefreshLine, onAction: resetToPreset },
              { id: 'delete', label: 'Delete dashboard', icon: RiDeleteBinLine, danger: true, disabled: state.dashboards.length === 1, separator: true, onAction: () => remove(dashboard) },
              { id: 'factory', label: 'Restore all defaults', icon: RiRefreshLine, danger: true, onAction: () => setState(defaultState()) },
            ]}
          />
        </div>
      </div>

      {editing && (
        <p className="font-mono text-[11px] text-text-tertiary">
          Drag a widget by its handle to move it, pull the amber corner to resize, <kbd>e</kbd> when done.
        </p>
      )}

      <WidgetGrid
        items={dashboard.items}
        editing={editing}
        onChange={(items) => update(() => items)}
        onMaximize={setMaximized}
        onConfigure={setConfiguring}
        onEmpty={() => setCatalog(true)}
      />

      <WidgetCatalog open={catalog} onOpenChange={setCatalog} onAdd={addWidget} present={new Set(dashboard.items.map((i) => i.widget))} />
      <WidgetMaximized
        def={maximized ? (widgetById(maximized.widget) ?? null) : null}
        settings={maximized?.settings}
        title={maximized?.title}
        onClose={() => setMaximized(null)}
      />
      <ConfigureWidget
        def={configuring ? (widgetById(configuring.widget) ?? null) : null}
        instance={configuring}
        onClose={() => setConfiguring(null)}
        onSave={(patch) => update((items) => items.map((i) => (i.key === configuring?.key ? { ...i, title: patch.title, settings: patch.settings } : i)))}
      />
    </div>
  );
}

function WidgetGrid({
  items,
  editing,
  onChange,
  onMaximize,
  onConfigure,
  onEmpty,
}: {
  items: WidgetInstance[];
  editing: boolean;
  onChange(items: WidgetInstance[]): void;
  onMaximize(instance: WidgetInstance): void;
  onConfigure(instance: WidgetInstance): void;
  onEmpty(): void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<WidgetInstance[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [columns, setColumns] = useState(12);
  const shown = preview ?? items;

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 1200;
      setColumns(width < 600 ? 1 : width < 860 ? 6 : 12);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const resolved = shown
    .map((instance) => ({ instance, def: widgetById(instance.widget) }))
    .filter((entry) => entry.def || editing);

  const span = (w: number) => (columns === 12 ? w : columns === 6 ? Math.min(6, Math.max(3, Math.ceil(w / 2))) : 1);

  const startResize = (instance: WidgetInstance, def: WidgetDef) => (event: React.PointerEvent) => {
    event.preventDefault();
    const grid = gridRef.current;
    if (!grid) return;
    const colWidth = (grid.clientWidth - GAP * (columns - 1)) / columns;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { w: instance.w, h: instance.h };
    const scale = 12 / columns;
    const min = def.minSize ?? { w: 2, h: 2 };
    const max = def.maxSize ?? { w: 12, h: 10 };
    const move = (e: PointerEvent) => {
      const w = Math.round(start.w + ((e.clientX - startX) / (colWidth + GAP)) * scale);
      const h = Math.round(start.h + (e.clientY - startY) / (ROW + GAP));
      const next = { w: Math.min(max.w, Math.max(min.w, w)), h: Math.min(max.h, Math.max(min.h, h)) };
      setPreview(items.map((i) => (i.key === instance.key ? { ...i, ...next } : i)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPreview((current) => {
        if (current) onChange(current);
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const reorder = (overKey: string, after: boolean) => {
    if (!dragging || dragging === overKey) return;
    const base = preview ?? items;
    const moving = base.find((i) => i.key === dragging);
    if (!moving) return;
    const without = base.filter((i) => i.key !== dragging);
    const index = without.findIndex((i) => i.key === overKey);
    const next = [...without];
    next.splice(after ? index + 1 : index, 0, moving);
    if (next.map((i) => i.key).join() !== base.map((i) => i.key).join()) setPreview(next);
  };

  if (items.length === 0)
    return (
      <div className="grid place-items-center border border-dashed border-separator-border-strong py-20">
        <div className="flex flex-col items-center gap-3 text-center">
          <RiLayoutMasonryLine className="size-6 text-text-tertiary" aria-hidden />
          <p className="font-mono text-[13px] text-text-primary">This dashboard is empty</p>
          <Button size="small" leadingIcon={RiAddLine} onClick={onEmpty}>
            Add a widget
          </Button>
        </div>
      </div>
    );

  return (
    <div
      ref={gridRef}
      className="grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: ROW, gap: GAP, gridAutoFlow: 'row dense' }}
    >
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {resolved.map(({ instance, def }) => (
        <div
          key={instance.key}
          data-widget-key={instance.key}
          style={{ gridColumn: `span ${span(instance.w)}`, gridRow: `span ${instance.h}` }}
          className={cx('min-w-0 transition-opacity', dragging === instance.key && 'opacity-40')}
          onDragOver={(event) => {
            if (!dragging) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            reorder(instance.key, event.clientX > box.left + box.width / 2);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (preview) onChange(preview);
            setPreview(null);
            setDragging(null);
          }}
        >
          {def ? (
            <WidgetFrame
              def={def}
              editing={editing}
              size={{ w: instance.w, h: instance.h }}
              onRemove={() => onChange(items.filter((i) => i.key !== instance.key))}
              onDuplicate={() => {
                const index = items.findIndex((i) => i.key === instance.key);
                const copy = { ...instance, key: uniqueKey(instance.widget, items) };
                onChange([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]);
              }}
              onResize={(w, h) => onChange(items.map((i) => (i.key === instance.key ? { ...i, w, h } : i)))}
              onMaximize={() => onMaximize(instance)}
              onConfigure={() => onConfigure(instance)}
              title={instance.title}
              summary={settingsSummary(def, instance.settings)}
              onResizeStart={startResize(instance, def)}
              dragHandleProps={{
                draggable: true,
                onDragStart: (event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', instance.key);
                  setDragging(instance.key);
                },
                onDragEnd: () => {
                  setDragging(null);
                  setPreview(null);
                },
                // Keyboard arranging: arrows move, Shift+arrows resize, Delete removes.
                onKeyDown: (event) => {
                  const index = items.findIndex((i) => i.key === instance.key);
                  const min = def.minSize ?? { w: 2, h: 2 };
                  const max = def.maxSize ?? { w: 12, h: 10 };
                  let next: WidgetInstance[] | null = null;
                  let said = '';
                  if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                    const w = Math.min(max.w, Math.max(min.w, instance.w + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)));
                    const h = Math.min(max.h, Math.max(min.h, instance.h + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)));
                    next = items.map((i) => (i.key === instance.key ? { ...i, w, h } : i));
                    said = `${def.title} resized to ${w} by ${h}`;
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    if (index > 0) {
                      next = [...items];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      said = `${def.title} moved to position ${index} of ${items.length}`;
                    }
                  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    if (index < items.length - 1) {
                      next = [...items];
                      [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                      said = `${def.title} moved to position ${index + 2} of ${items.length}`;
                    }
                  } else if (event.key === 'Delete' || event.key === 'Backspace') {
                    next = items.filter((i) => i.key !== instance.key);
                    said = `${def.title} removed`;
                  } else return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!next) return;
                  onChange(next);
                  setAnnouncement(said);
                  // The node moves in the DOM; put focus back on its handle.
                  requestAnimationFrame(() =>
                    gridRef.current?.querySelector<HTMLElement>(`[data-widget-key="${CSS.escape(instance.key)}"] [aria-roledescription="movable widget"]`)?.focus(),
                  );
                },
              }}
            >
              <def.component
                size={{ w: instance.w, h: instance.h }}
                editing={editing}
                settings={widgetSettings(def, instance.settings)}
                updateSettings={(patch) =>
                  onChange(items.map((i) => (i.key === instance.key ? { ...i, settings: { ...i.settings, ...patch } } : i)))
                }
              />
            </WidgetFrame>
          ) : (
            <div className="flex h-full items-center justify-between gap-2 border border-dashed border-separator-border px-3 font-mono text-[11px] text-text-tertiary">
              <span>“{instance.widget}” is not installed</span>
              <button type="button" onClick={() => onChange(items.filter((i) => i.key !== instance.key))} className="text-signal hover:underline">
                remove
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WidgetCatalog({
  open,
  onOpenChange,
  onAdd,
  present,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdd(def: WidgetDef): void;
  present: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules
      .map((module) => ({
        module,
        widgets: module.widgets.filter((w) => !q || `${w.title} ${w.description} ${w.id}`.toLowerCase().includes(q)),
      }))
      .filter((group) => group.widgets.length);
  }, [query]);
  const total = allWidgets().length;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Add a widget" subtitle={`${total} widgets from ${modules.length} modules`} width={520}>
      <label className="mb-4 flex h-9 items-center gap-2 border border-border-button-default bg-background-primary-default px-2 focus-within:ring-2 focus-within:ring-border-focus-ring">
        <RiSearchLine className="size-4 text-text-tertiary" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search widgets…"
          className="flex-1 bg-transparent text-body-regular text-text-primary outline-none placeholder:text-text-placeholder"
        />
      </label>
      <div className="flex flex-col gap-5">
        {groups.map(({ module, widgets }) => (
          <section key={module.id}>
            <h3 className="mb-2 font-mono text-[10px] tracking-[0.14em] text-text-tertiary uppercase">{module.title}</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {widgets.map((widget) => (
                <li key={widget.id}>
                  <button
                    type="button"
                    onClick={() => onAdd(widget)}
                    className="group flex h-full w-full flex-col gap-1.5 border border-separator-border bg-surface-raised p-3 text-left outline-none hover:border-signal-fill/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    <span className="flex items-center gap-2">
                      <widget.icon className="size-4 text-text-tertiary group-hover:text-signal" aria-hidden />
                      <span className="flex-1 truncate text-body-medium text-text-primary">{widget.title}</span>
                      {widget.live && <span className="border border-signal-fill/50 px-1 font-mono text-[9px] text-signal uppercase">live</span>}
                      {present.has(widget.id) && <span className="font-mono text-[10px] text-text-tertiary">on board</span>}
                    </span>
                    <span className="line-clamp-2 text-caption-1-regular text-text-secondary">{widget.description}</span>
                    <span className="mt-auto font-mono text-[10px] text-text-tertiary">
                      {widget.defaultSize.w}×{widget.defaultSize.h} · {widget.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="text-caption-1-regular text-text-tertiary">No widget matches “{query}”.</p>}
      </div>
    </Drawer>
  );
}
