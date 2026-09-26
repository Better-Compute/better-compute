'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { RiArrowLeftLine, RiExternalLinkLine } from 'react-icons/ri';
import { peekFor } from '@/lib/modules';
import { Drawer } from '@/components/ui/overlay';
import { WidgetBoundary } from '@/components/widgets/widget-frame';
import { cx } from '@/utils/cx';

// Peek: any module's entity (a node, a pool, a reservation, a tenant) opened in a side sheet over the current
// page, from any other module's page. Peeks stack, so node → its reservation → its tenant keeps a back button.
// Modules register renderers in their descriptor (`peeks: { node: { title, href, component } }`).

interface Target {
  kind: string;
  id: string;
}

interface PeekApi {
  open(kind: string, id: string): void;
  close(): void;
  canPeek(kind: string): boolean;
}

const PeekContext = createContext<PeekApi | null>(null);

export function PeekProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Target[]>([]);
  const router = useRouter();
  const current = stack.at(-1);
  const def = current ? peekFor(current.kind) : undefined;

  const open = useCallback((kind: string, id: string) => {
    setStack((s) => (s.at(-1)?.kind === kind && s.at(-1)?.id === id ? s : [...s.slice(-6), { kind, id }]));
  }, []);
  const close = useCallback(() => setStack([]), []);
  const api = useMemo<PeekApi>(() => ({ open, close, canPeek: (kind) => Boolean(peekFor(kind)) }), [open, close]);

  return (
    <PeekContext.Provider value={api}>
      {children}
      <Drawer
        open={Boolean(current && def)}
        onOpenChange={(isOpen) => !isOpen && close()}
        width={600}
        title={
          <span className="flex items-center gap-2">
            {stack.length > 1 && (
              <button
                type="button"
                onClick={() => setStack((s) => s.slice(0, -1))}
                aria-label="Back"
                className="grid size-6 place-items-center text-text-tertiary hover:text-text-primary"
              >
                <RiArrowLeftLine className="size-4" aria-hidden />
              </button>
            )}
            {def?.icon && <def.icon className="size-4 text-text-tertiary" aria-hidden />}
            <span className="truncate">{current && def ? def.title(current.id) : ''}</span>
          </span>
        }
        subtitle={current ? <span className="font-mono">{current.kind} · {current.id}</span> : undefined}
        actions={
          current && def ? (
            <button
              type="button"
              onClick={() => {
                const href = def.href(current.id);
                close();
                router.push(href);
              }}
              className="inline-flex h-8 items-center gap-1.5 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:text-text-primary"
            >
              open page
              <RiExternalLinkLine className="size-3.5" aria-hidden />
            </button>
          ) : undefined
        }
      >
        {current && def && (
          <WidgetBoundary name={`${current.kind} ${current.id}`}>
            <def.component key={`${current.kind}:${current.id}`} id={current.id} />
          </WidgetBoundary>
        )}
      </Drawer>
    </PeekContext.Provider>
  );
}

export function usePeek(): PeekApi {
  return useContext(PeekContext) ?? { open: () => {}, close: () => {}, canPeek: () => false };
}

/**
 * A link to an entity. A plain click peeks when some module can render that kind; ⌘/Ctrl/Shift-click or a
 * middle click still opens the page. Without a peek it is an ordinary link.
 */
export function EntityLink({
  kind,
  id,
  href,
  children,
  className,
}: {
  kind: string;
  id: string;
  /** Page to open; defaults to the peek's href. */
  href?: string;
  children?: ReactNode;
  className?: string;
}) {
  const peek = usePeek();
  const def = peekFor(kind);
  const target = href ?? def?.href(id) ?? '#';
  const onClick = (event: MouseEvent) => {
    if (!def || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    peek.open(kind, id);
  };
  return (
    <Link
      href={target}
      onClick={onClick}
      className={cx('font-mono text-[12px] text-text-primary underline decoration-separator-border-strong decoration-dotted underline-offset-2 hover:decoration-signal-fill', className)}
    >
      {children ?? id}
    </Link>
  );
}
