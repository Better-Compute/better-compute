'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { allCommands, allNav } from '@/lib/modules';
import { CommandPalette, PALETTE_EVENTS } from './command-palette';
import { PageCommandsProvider } from './page-commands';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { useWorkspace } from './workspace';

const SIDEBAR_KEY = 'bc-admin:sidebar-collapsed';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.getAttribute('role') === 'textbox');

/**
 * The frame around every page: sidebar, top bar, the ⌘K palette and the global keyboard map
 * (⌘K palette, g-chords to pages, [ sidebar, p pause, e arrange dashboard, ? shortcut sheet).
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { live, setLive } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const chord = useRef<{ key: string; at: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === '1');
    } catch {
      // default
    }
  }, []);

  const toggleSidebar = () =>
    setCollapsed((current) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, current ? '0' : '1');
      } catch {
        // not persisted
      }
      return !current;
    });

  useEffect(() => {
    const onToggle = () => toggleSidebar();
    const onKeys = () => setKeys(true);
    window.addEventListener(PALETTE_EVENTS.toggleSidebar, onToggle);
    window.addEventListener(PALETTE_EVENTS.showShortcuts, onKeys);
    return () => {
      window.removeEventListener(PALETTE_EVENTS.toggleSidebar, onToggle);
      window.removeEventListener(PALETTE_EVENTS.showShortcuts, onKeys);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || palette) return;
      const pending = chord.current;
      if (pending && Date.now() - pending.at < 1200) {
        chord.current = null;
        const combo = `${pending.key} ${event.key.toLowerCase()}`;
        const target = [...allNav(), ...allCommands()].find((item) => item.shortcut === combo);
        if (target) {
          event.preventDefault();
          if ('run' in target && target.run) target.run();
          else if (target.href) router.push(target.href);
        }
        return;
      }
      if (event.key === 'g') {
        chord.current = { key: 'g', at: Date.now() };
      } else if (event.key === '/') {
        event.preventDefault();
        setPalette(true);
      } else if (event.key === '[') {
        toggleSidebar();
      } else if (event.key === 'p') {
        setLive(!live);
      } else if (event.key === 'e') {
        window.dispatchEvent(new Event(PALETTE_EVENTS.editDashboard));
      } else if (event.key === '?') {
        setKeys(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, live, setLive, palette]);

  return (
    // App shell: the window never scrolls; <main> does, so the sidebar and top bar stay put and scroll position
    // is per page (reset on navigation below).
    <PageCommandsProvider>
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:bg-surface-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} className="hidden md:flex" />
      <ModalOverlay isOpen={mobileNav} onOpenChange={setMobileNav} isDismissable className="fixed inset-0 z-50 bg-neutral-950/50 md:hidden entering:animate-[fade-in_120ms_ease-out]">
        <Modal className="h-full w-fit outline-none">
          <Dialog aria-label="Navigation" className="h-full outline-none">
            <Sidebar collapsed={false} onToggle={() => setMobileNav(false)} onNavigate={() => setMobileNav(false)} />
          </Dialog>
        </Modal>
      </ModalOverlay>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPalette(true)} onOpenNav={() => setMobileNav(true)} />
        <main id="main" ref={mainRef} tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 outline-none lg:px-6">
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <ShortcutSheet open={keys} onOpenChange={setKeys} />
    </div>
    </PageCommandsProvider>
  );
}

function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const chords = [...allNav(), ...allCommands()].filter((item) => item.shortcut);
  const global = [
    ['⌘K  /', 'Command palette'],
    ['p', 'Pause or resume the clock'],
    ['e', 'Arrange the dashboard'],
    ['[', 'Collapse the sidebar'],
    ['j  k', 'Move through table rows'],
    ['↵', 'Open the selected row'],
    ['x', 'Select the row'],
    ['?', 'This sheet'],
  ];
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable className="fixed inset-0 z-[60] grid place-items-center bg-neutral-950/50 p-4">
      <Modal className="w-[560px] max-w-full border border-separator-border bg-surface-raised shadow-lg outline-none">
        <Dialog className="outline-none">
          <div className="border-b border-separator-border px-4 py-3">
            <Heading slot="title" className="font-mono text-[13px] font-medium tracking-wide text-text-primary uppercase">
              Keyboard
            </Heading>
          </div>
          <div className="grid gap-6 p-4 sm:grid-cols-2">
            <ShortcutList title="Everywhere" rows={global} />
            <ShortcutList title="Go to (g, then…)" rows={chords.map((item) => [item.shortcut!, item.label])} />
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ShortcutList({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] tracking-[0.14em] text-text-tertiary uppercase">{title}</div>
      <dl className="flex flex-col gap-1.5">
        {rows.map(([keys, label]) => (
          <div key={`${keys}${label}`} className="flex items-center justify-between gap-3">
            <dt className="text-body-regular text-text-secondary">{label}</dt>
            <dd className="flex gap-1">
              {keys!.split(/\s+/).map((key) => (
                <kbd key={key} className="min-w-5 border border-separator-border bg-background-secondary-default px-1 text-center font-mono text-[11px] text-text-primary">
                  {key}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
        {rows.length === 0 && <p className="text-caption-1-regular text-text-tertiary">None yet.</p>}
      </dl>
    </div>
  );
}
