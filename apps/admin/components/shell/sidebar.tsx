'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RiArrowDownSLine, RiLayoutLeft2Line, RiLayoutRight2Line, RiPushpinFill, RiPushpinLine, RiSettings3Line } from 'react-icons/ri';
import { ThemeToggle } from '@/components/application/theme/theme-toggle';
import { allNav, navForPath, navGroups, type NavItem } from '@/lib/modules';
import { cx } from '@/utils/cx';
import { useFoldedGroups, usePins } from './pins';
import { useModuleVersion } from './use-modules';
import { useWorkspaceSettings } from './workspace';

/**
 * The rack rail: module navigation grouped by section, collapsible to an icon rail (`[` toggles it). The active
 * item is marked with the amber signal; everything else stays graphite.
 */
export function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
  className,
}: {
  collapsed: boolean;
  onToggle(): void;
  /** Called on every link click (the mobile drawer closes itself). */
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();
  const active = navForPath(pathname);
  const { source, live } = useWorkspaceSettings();
  useModuleVersion();
  const groups = navGroups();
  const { pins, toggle } = usePins();
  const folded = useFoldedGroups();
  const pinned = pins.map((href) => allNav().find((item) => item.href === href)).filter((item): item is NavItem => Boolean(item));

  return (
    <nav
      aria-label="Admin"
      data-tour="sidebar"
      className={cx(
        'flex h-full shrink-0 flex-col border-r border-separator-border bg-surface-sunken transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-60',
        className,
      )}
    >
      <div className={cx('flex h-12 shrink-0 items-center gap-2 border-b border-separator-border', collapsed ? 'justify-center px-0' : 'px-3')}>
        <Link href="/" className="flex min-w-0 items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring" aria-label="Better Compute admin, overview">
          <BrandMark />
          {!collapsed && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-mono text-[12px] font-medium tracking-wide text-text-primary uppercase">Better Compute</span>
              <span className="block truncate font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">Admin · {source === 'simulated' ? 'Simulated' : 'Live'}</span>
            </span>
          )}
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {[...(pinned.length ? [{ group: 'Pinned', items: pinned }] : []), ...groups].map(({ group, items: all }) => {
          const isFolded = !collapsed && folded.has(group);
          // A folded section still shows the page you're on, so the sidebar always says where you are.
          const items = isFolded ? all.filter((item) => item.href === active?.href) : all;
          return (
          <div key={group} className="mb-3">
            {!collapsed ? (
              <button
                type="button"
                onClick={() => folded.toggle(group)}
                aria-expanded={!isFolded}
                className="group/fold flex w-full items-center gap-2 px-3 pt-1 pb-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <span className={cx('font-mono text-[10px] tracking-[0.16em] uppercase', group === 'Pinned' ? 'text-signal' : 'text-text-tertiary group-hover/fold:text-text-secondary')}>{group}</span>
                <span className="h-px flex-1 bg-separator-border" />
                {isFolded && <span className="font-mono text-[10px] text-text-tertiary tabular-nums">{all.length}</span>}
                <RiArrowDownSLine className={cx('size-3.5 text-text-tertiary opacity-0 transition-[transform,opacity] group-hover/fold:opacity-100', isFolded && '-rotate-90 opacity-100')} aria-hidden />
              </button>
            ) : (
              <div className="mx-3 my-1.5 h-px bg-separator-border" />
            )}
            <ul className="flex flex-col gap-px px-2">
              {items.map((item) => {
                const isActive = active?.href === item.href;
                const isPinned = pins.includes(item.href);
                return (
                  <li key={item.href} className="group/item relative">
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      title={collapsed ? item.label : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      className={cx(
                        'group relative flex h-8 items-center gap-2.5 px-2 text-body-regular outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-background-secondary-default text-text-primary'
                          : 'text-text-secondary hover:bg-background-secondary-default/60 hover:text-text-primary',
                      )}
                    >
                      {isActive && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-signal-fill" />}
                      <item.icon className={cx('size-4 shrink-0', isActive ? 'text-signal' : 'text-text-tertiary group-hover:text-text-secondary')} aria-hidden />
                      {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                      {!collapsed && item.shortcut && (
                        <kbd className="hidden pr-5 font-mono text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 lg:inline">{item.shortcut}</kbd>
                      )}
                    </Link>
                    {!collapsed && (
                      <button
                        type="button"
                        onClick={() => toggle(item.href)}
                        aria-label={isPinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                        aria-pressed={isPinned}
                        className={cx(
                          'absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center outline-none focus-visible:opacity-100',
                          isPinned ? 'text-signal opacity-0 group-hover/item:opacity-100' : 'text-text-tertiary opacity-0 group-hover/item:opacity-100 hover:text-text-primary',
                          group === 'Pinned' && 'text-signal',
                        )}
                      >
                        {isPinned ? <RiPushpinFill className="size-3.5" aria-hidden /> : <RiPushpinLine className="size-3.5" aria-hidden />}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          );
        })}
      </div>

      <div className={cx('flex shrink-0 flex-col gap-2 border-t border-separator-border p-2', collapsed && 'items-center')}>
        <Link
          href="/settings"
          title="Settings"
          onClick={onNavigate}
          className={cx(
            'flex h-8 items-center gap-2.5 px-2 text-body-regular text-text-secondary hover:bg-background-secondary-default/60 hover:text-text-primary',
            pathname === '/settings' && 'bg-background-secondary-default text-text-primary',
            collapsed && 'justify-center px-0',
          )}
        >
          <RiSettings3Line className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          {!collapsed && <span>Settings</span>}
        </Link>
        <div className={cx('flex items-center gap-2', collapsed ? 'flex-col' : 'justify-between px-1')}>
          {!collapsed && <ThemeToggle size="sm" />}
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar  [`}
            className="grid size-7 place-items-center text-text-tertiary outline-none hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {collapsed ? <RiLayoutRight2Line className="size-4" aria-hidden /> : <RiLayoutLeft2Line className="size-4" aria-hidden />}
          </button>
        </div>
        {!collapsed && (
          <p className="px-1 font-mono text-[10px] leading-4 text-text-tertiary">
            {live ? 'clock live' : 'clock paused'} · ⌘K commands · ? keys
          </p>
        )}
      </div>
    </nav>
  );
}

/** The rack-unit mark: four stacked units, the second one lit. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-7 shrink-0', className)} aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" fill="none" stroke="var(--color-separator-border-strong)" />
      {[5, 9.5, 14, 18.5].map((y, i) => (
        <g key={y}>
          <rect x="5" y={y - 1.25} width="14" height="2.5" fill={i === 1 ? 'var(--color-signal-fill)' : 'var(--color-text-tertiary)'} opacity={i === 1 ? 1 : 0.55} />
        </g>
      ))}
    </svg>
  );
}
