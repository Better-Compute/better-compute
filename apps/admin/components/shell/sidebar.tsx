'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RiLayoutLeft2Line, RiLayoutRight2Line, RiSettings3Line } from 'react-icons/ri';
import { ThemeToggle } from '@/components/application/theme/theme-toggle';
import { navForPath, navGroups } from '@/lib/modules';
import { cx } from '@/utils/cx';
import { useWorkspace } from './workspace';

/**
 * The rack rail: module navigation grouped by section, collapsible to an icon rail (`[` toggles it). The active
 * item is marked with the amber signal; everything else stays graphite.
 */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  const pathname = usePathname();
  const active = navForPath(pathname);
  const { source, live } = useWorkspace();
  const groups = navGroups();

  return (
    <nav
      aria-label="Admin"
      className={cx(
        'flex h-full shrink-0 flex-col border-r border-separator-border bg-surface-sunken transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-60',
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
        {groups.map(({ group, items }) => (
          <div key={group} className="mb-3">
            {!collapsed ? (
              <div className="flex items-center gap-2 px-3 pt-1 pb-1.5">
                <span className="font-mono text-[10px] tracking-[0.16em] text-text-tertiary uppercase">{group}</span>
                <span className="h-px flex-1 bg-separator-border" />
              </div>
            ) : (
              <div className="mx-3 my-1.5 h-px bg-separator-border" />
            )}
            <ul className="flex flex-col gap-px px-2">
              {items.map((item) => {
                const isActive = active?.href === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
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
                        <kbd className="hidden font-mono text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 lg:inline">{item.shortcut}</kbd>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className={cx('flex shrink-0 flex-col gap-2 border-t border-separator-border p-2', collapsed && 'items-center')}>
        <Link
          href="/settings"
          title="Settings"
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
