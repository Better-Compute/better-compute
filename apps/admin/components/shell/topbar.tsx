'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import {
  RiArrowRightSLine,
  RiGlobalLine,
  RiMenuLine,
  RiNotification3Line,
  RiSearchLine,
  RiTimeLine,
} from 'react-icons/ri';
import { fmtRelative, fmtStamp, sites } from '@/lib/data';
import { collectAttention, navForPath } from '@/lib/modules';
import { Select } from '@/components/ui/overlay';
import { SeverityIcon } from '@/components/ui/signal';
import { cx } from '@/utils/cx';
import { useAcks } from './pins';
import { TimeMachine } from './time-machine';
import { OperatorMenu } from './operator-menu';
import { RANGES, useLive, useNow, useWorkspaceSettings, type RangeKey } from './workspace';
import { useAttentionItems } from './use-attention';

/** Breadcrumbs on the left; the workspace controls (search, scope, range, clock, attention) on the right. */
export function Topbar({ onOpenPalette, onOpenNav }: { onOpenPalette(): void; onOpenNav(): void }) {
  const pathname = usePathname();
  const { range, setRange, siteId, setSiteId, compareAt, setCompareAt } = useWorkspaceSettings();
  const nav = navForPath(pathname);
  const rest = nav && pathname !== nav.href ? pathname.slice(nav.href.length).split('/').filter(Boolean) : [];

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 border-b border-separator-border bg-background-full px-4">
      <button type="button" onClick={onOpenNav} aria-label="Open navigation" className="-ml-1 grid size-8 place-items-center text-text-secondary md:hidden">
        <RiMenuLine className="size-5" aria-hidden />
      </button>
      <ol className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[12px]" aria-label="Breadcrumb">
        {nav ? (
          <>
            <li className="hidden text-text-tertiary sm:block">{nav.group}</li>
            <li aria-hidden className="hidden text-text-tertiary sm:block">
              <RiArrowRightSLine className="size-3.5" />
            </li>
            <li className="truncate">
              <Link href={nav.href} className={cx(rest.length ? 'text-text-secondary hover:text-text-primary' : 'text-text-primary')}>
                {nav.label}
              </Link>
            </li>
            {rest.map((segment, index) => (
              <li key={segment + index} className="flex min-w-0 items-center gap-1">
                <RiArrowRightSLine className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                <span className={cx('truncate', index === rest.length - 1 ? 'text-text-primary' : 'text-text-secondary')}>
                  {decodeURIComponent(segment)}
                </span>
              </li>
            ))}
          </>
        ) : (
          <li className="text-text-primary">{pathname === '/settings' ? 'Settings' : 'Admin'}</li>
        )}
      </ol>

      <button
        type="button"
        data-tour="palette"
        onClick={onOpenPalette}
        className="hidden h-8 w-64 items-center gap-2 border border-border-button-default bg-background-primary-default px-2 text-left text-body-regular text-text-placeholder outline-none hover:border-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring md:flex"
      >
        <RiSearchLine className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">Search or run a command…</span>
        <kbd className="font-mono text-[10px] text-text-tertiary">⌘K</kbd>
      </button>
      <button type="button" onClick={onOpenPalette} aria-label="Search or run a command" className="grid size-8 place-items-center text-text-secondary md:hidden">
        <RiSearchLine className="size-4" aria-hidden />
      </button>

      <div data-tour="scope" className="hidden items-center gap-3 lg:flex">
      <Select
        label="Site scope"
        icon={RiGlobalLine}
        className="w-40"
        value={siteId ?? 'all'}
        onChange={(value) => setSiteId(value === 'all' ? undefined : value)}
        options={[{ id: 'all', label: 'All sites' }, ...sites.map((site) => ({ id: site.id, label: `${site.id} · ${site.city}`, description: site.provider }))]}
      />
      <Select
        label="Time range"
        icon={RiTimeLine}
        className="w-40"
        value={range}
        onChange={(value) => setRange(value as RangeKey)}
        options={(Object.keys(RANGES) as RangeKey[]).map((key) => ({ id: key, label: RANGES[key].label }))}
      />
      </div>

      {compareAt && (
        <span className="hidden h-8 items-center border border-signal-fill/50 bg-signal-soft font-mono text-[11px] text-signal xl:inline-flex">
          <Link href="/" className="px-2 hover:underline" title="What changed since this moment (on the Overview)">
            vs {fmtStamp(compareAt)}
          </Link>
          <button type="button" onClick={() => setCompareAt(undefined)} aria-label="Stop comparing" className="grid h-full w-6 place-items-center border-l border-signal-fill/40 hover:bg-signal-fill/20">
            ×
          </button>
        </span>
      )}
      <TimeMachine />

      <AttentionBell />
      <OperatorMenu />
    </header>
  );
}

function AttentionBell() {
  const all = useAttentionItems();
  const acks = useAcks();
  const items = all.filter((item) => !acks.has(item.id));
  const now = useNow(10_000);
  const critical = items.filter((item) => item.severity === 'critical').length;
  // The badge counts what needs action (critical + warning); info items are in the list, not the count.
  const urgent = items.filter((item) => item.severity !== 'info').length;
  return (
    <DialogTrigger>
      <AriaButton
        data-tour="bell"
        aria-label={`${urgent} items need attention, ${items.length - urgent} for information`}
        className="relative grid size-8 place-items-center text-text-secondary outline-none hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiNotification3Line className="size-[18px]" aria-hidden />
        {urgent > 0 && (
          <span
            className={cx(
              'absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center px-1 font-mono text-[10px] leading-none font-medium',
              critical ? 'bg-red-500 text-white' : 'bg-signal-fill text-neutral-950',
            )}
          >
            {urgent > 99 ? '99+' : urgent}
          </span>
        )}
        {urgent === 0 && items.length > 0 && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-text-tertiary" />}
      </AriaButton>
      <Popover placement="bottom end" offset={6} className="w-96 max-w-[calc(100vw-2rem)] border border-separator-border bg-surface-raised shadow-dropdown outline-none">
        <Dialog aria-label="Needs attention" className="outline-none">
          <div className="flex items-center justify-between border-b border-separator-border px-3 py-2">
            <span className="font-mono text-[11px] tracking-wide text-text-secondary uppercase">Needs attention</span>
            <Link href="/attention" className="font-mono text-[11px] text-signal hover:underline">
              open queue
            </Link>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="border-b border-separator-border/70 last:border-0">
                <Link href={item.href} className="flex gap-2.5 px-3 py-2.5 hover:bg-background-secondary-default">
                  <SeverityIcon severity={item.severity} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-medium text-text-primary">{item.title}</span>
                    <span className="line-clamp-2 text-caption-1-regular text-text-secondary">{item.detail}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-tertiary" suppressHydrationWarning>
                    {fmtRelative(item.at, now)}
                  </span>
                </Link>
              </li>
            ))}
            {items.length === 0 && <li className="px-3 py-6 text-center text-caption-1-regular text-text-tertiary">Quiet. Nothing needs you.</li>}
          </ul>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
