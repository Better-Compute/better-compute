'use client';

import Link from 'next/link';
import { Component, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiDraggable,
  RiEqualizerLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiFullscreenLine,
  RiMore2Fill,
  RiRulerLine,
} from 'react-icons/ri';
import { widgetSettings, type WidgetDef } from '@/lib/modules';
import { ScopeOverrideProvider, useWorkspaceSettings } from '@/components/shell/workspace';
import { overrideFrom } from './configure';
import { Menu, ToolButton } from '@/components/ui/overlay';
import { EmptyState } from '@/components/ui/panel';
import { cx } from '@/utils/cx';

/** Contains a widget's crash to its own frame. */
export class WidgetBoundary extends Component<{ children: ReactNode; name: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <EmptyState title={`${this.props.name} failed to render`}>
          <span className="font-mono">{this.state.error.message}</span>
        </EmptyState>
      );
    return this.props.children;
  }
}

export const SIZE_PRESETS = [
  { id: 's', label: 'Small', w: 4, h: 3 },
  { id: 'm', label: 'Medium', w: 6, h: 4 },
  { id: 'l', label: 'Large', w: 8, h: 4 },
  { id: 'xl', label: 'Full width', w: 12, h: 4 },
];

/** The chrome around one widget: title bar, menu, and in edit mode the drag handle and resize corner. */
export function WidgetFrame({
  def,
  editing,
  size,
  onRemove,
  onDuplicate,
  onResize,
  onMaximize,
  onResizeStart,
  onConfigure,
  title: customTitle,
  summary,
  dragHandleProps,
  children,
}: {
  def: WidgetDef;
  editing: boolean;
  size: { w: number; h: number };
  onRemove(): void;
  onDuplicate(): void;
  onResize(w: number, h: number): void;
  onMaximize(): void;
  onResizeStart(event: React.PointerEvent): void;
  onConfigure(): void;
  /** The instance's own title, if renamed. */
  title?: string;
  /** Mono summary of non-default settings, e.g. "gpu · fra1". */
  summary?: string;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  children: ReactNode;
}) {
  const title = customTitle || def.title;
  const { source } = useWorkspaceSettings();
  return (
    <div
      data-tour="widget"
      className={cx(
        'group/widget relative flex h-full min-w-0 flex-col border bg-surface-raised',
        editing ? 'border-dashed border-signal-fill/50' : 'border-separator-border',
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-separator-border pr-1 pl-3">
        {editing && (
          <span
            {...dragHandleProps}
            role="button"
            tabIndex={0}
            aria-roledescription="movable widget"
            aria-label={`${title}, ${size.w} by ${size.h}. Arrow keys move, Shift+arrows resize, Delete removes.`}
            className="-ml-1.5 cursor-grab text-text-tertiary outline-none focus-visible:text-signal focus-visible:ring-2 focus-visible:ring-border-focus-ring active:cursor-grabbing"
          >
            <RiDraggable className="size-4" aria-hidden />
          </span>
        )}
        <def.icon className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
        <h3 className="flex min-w-0 flex-1 items-baseline gap-2 truncate font-mono text-[11px] font-medium tracking-wide text-text-secondary uppercase">
          {def.href && !editing ? (
            <Link href={def.href} className="truncate hover:text-text-primary">
              {title}
            </Link>
          ) : (
            <span className="truncate">{title}</span>
          )}
          {summary && <span className="truncate text-[10px] font-normal tracking-normal text-text-tertiary normal-case">{summary}</span>}
        </h3>
        {source === 'live' && !def.live && (
          <span title="This widget has no live source yet; it shows the simulation" className="shrink-0 border border-dashed border-separator-border-strong px-1 font-mono text-[9px] tracking-wide text-text-tertiary uppercase">
            sim
          </span>
        )}
        {editing && (
          <span className="font-mono text-[10px] text-text-tertiary tabular-nums">
            {size.w}×{size.h}
          </span>
        )}
        <div className={cx('flex items-center', !editing && 'opacity-0 transition-opacity group-hover/widget:opacity-100 focus-within:opacity-100')}>
          {!editing && (def.settings?.length || def.pins?.site !== false || def.pins?.range) ? <ToolButton icon={RiEqualizerLine} label={`Configure ${title}`} onPress={onConfigure} /> : null}
          {!editing && <ToolButton icon={RiFullscreenLine} label={`Expand ${title}`} onPress={onMaximize} />}
          <Menu
            label={`${title} options`}
            trigger={<ToolButton icon={RiMore2Fill} label={`${title} options`} />}
            items={[
              ...(def.href ? [{ id: 'open', label: 'Open page', icon: RiExternalLinkLine, onAction: () => { window.location.href = def.href!; } }] : []),
              { id: 'configure', label: 'Configure…', icon: RiEqualizerLine, onAction: onConfigure },
              { id: 'max', label: 'Expand', icon: RiFullscreenLine, onAction: onMaximize },
              ...SIZE_PRESETS.map((preset, index) => ({
                id: `size-${preset.id}`,
                label: `Size: ${preset.label}`,
                icon: RiRulerLine,
                separator: index === 0,
                onAction: () => onResize(Math.max(preset.w, def.minSize?.w ?? 1), Math.max(preset.h, def.minSize?.h ?? 1)),
              })),
              { id: 'dup', label: 'Duplicate', icon: RiFileCopyLine, separator: true, onAction: onDuplicate },
              { id: 'remove', label: 'Remove from dashboard', icon: RiDeleteBinLine, danger: true, onAction: onRemove },
            ]}
          />
          {editing && <ToolButton icon={RiCloseLine} label={`Remove ${title}`} onPress={onRemove} />}
        </div>
      </header>
      <div className={cx('relative min-h-0 flex-1 overflow-hidden', editing && 'pointer-events-none opacity-80')}>
        <WidgetBoundary name={title}>{children}</WidgetBoundary>
      </div>
      {editing && (
        <span
          role="separator"
          aria-label={`Resize ${def.title}`}
          onPointerDown={onResizeStart}
          className="absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize touch-none"
          style={{
            background:
              'linear-gradient(135deg, transparent 0 50%, var(--color-signal-fill) 50% 58%, transparent 58% 70%, var(--color-signal-fill) 70% 78%, transparent 78%)',
          }}
        />
      )}
    </div>
  );
}

/** A widget blown up to fill the screen. */
export function WidgetMaximized({
  def,
  settings,
  title,
  onClose,
}: {
  def: WidgetDef | null;
  settings?: Record<string, string | number | boolean>;
  title?: string;
  onClose(): void;
}) {
  return (
    <ModalOverlay isOpen={Boolean(def)} onOpenChange={(open) => !open && onClose()} isDismissable className="fixed inset-0 z-50 bg-neutral-950/50 p-4 sm:p-8">
      <Modal className="flex h-full w-full flex-col border border-separator-border bg-surface-raised shadow-lg outline-none">
        <Dialog className="flex h-full flex-col outline-none">
          {def && (
            <>
              <header className="flex h-11 shrink-0 items-center gap-2 border-b border-separator-border pr-2 pl-4">
                <def.icon className="size-4 text-text-tertiary" aria-hidden />
                <Heading slot="title" className="flex-1 truncate font-mono text-[12px] font-medium tracking-wide text-text-secondary uppercase">
                  {title || def.title}
                </Heading>
                {def.href && (
                  <Link href={def.href} onClick={onClose} className="font-mono text-[11px] text-signal hover:underline">
                    open page →
                  </Link>
                )}
                <ToolButton icon={RiCloseLine} label="Close" onPress={onClose} />
              </header>
              <div className="min-h-0 flex-1 overflow-auto">
                <WidgetBoundary name={def.title}>
                  <ScopeOverrideProvider value={overrideFrom(settings)}>
                    <def.component size={{ w: 12, h: 8 }} editing={false} settings={widgetSettings(def, settings)} />
                  </ScopeOverrideProvider>
                </WidgetBoundary>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
