'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RiArrowRightLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';

export interface RackUnit {
  /** The section's element id. */
  id: string;
  /** Its unit number, `01` for U01. */
  unit: string;
  label: string;
}

/**
 * The console's index, pinned beside the units: one row per unit, the one in view lit like a selected channel.
 * The unit whose band crosses the middle of the viewport is the active one; before the console is reached, the
 * first unit is.
 */
export function RackIndex({ units }: { units: RackUnit[] }) {
  const [active, setActive] = useState(units[0]?.id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((entry) => entry.isIntersecting);
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const { id } of units) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [units]);

  const position = Math.max(
    0,
    units.findIndex((item) => item.id === active),
  );

  return (
    <nav aria-label="On this page" className="sticky top-20 flex flex-col gap-5 py-10">
      <p className="eyebrow flex items-center justify-between px-5">
        <span>Rack</span>
        <span className="text-text-tertiary tabular-nums">
          {String(position + 1).padStart(2, '0')}/{String(units.length).padStart(2, '0')}
        </span>
      </p>
      <ol className="flex flex-col border-y border-separator-border">
        {units.map((item) => {
          const on = item.id === active;
          return (
            <li key={item.id} className="border-b border-separator-border last:border-b-0">
              <a
                href={`#${item.id}`}
                aria-current={on ? 'location' : undefined}
                className={cx(
                  'relative flex items-center gap-3 px-5 py-2.5 font-mono text-caption-1-regular transition-colors',
                  on
                    ? 'bg-signal-soft text-text-primary'
                    : 'text-text-secondary hover:bg-background-secondary-default hover:text-text-primary',
                )}
              >
                {on ? (
                  <span aria-hidden className="absolute inset-y-1 start-0 w-[2px] bg-signal-fill" />
                ) : null}
                <span className="led" data-on={on ? 'true' : undefined} />
                <span className={cx('tabular-nums', on ? 'text-signal' : 'text-text-tertiary')}>
                  U{item.unit}
                </span>
                <span className="truncate">{item.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
      <Link
        href="/docs/guides/quickstart"
        className="group flex items-center justify-between px-5 font-mono text-caption-1-medium text-text-secondary hover:text-signal"
      >
        Start the quickstart
        <RiArrowRightLine
          className="size-3.5 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
    </nav>
  );
}
