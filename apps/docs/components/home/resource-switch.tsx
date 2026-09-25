'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { RiArrowRightLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';

export interface ResourcePane {
  id: string;
  label: string;
  /** The unit that is booked, shown in the tab. */
  unit: string;
  summary: string;
  /** [label, value] rows of the pane's spec sheet. */
  specs: [string, string][];
  code: ReactNode;
  href: string;
  linkLabel: string;
}

/**
 * GPU, CPU and sandbox capacity as three channels of one instrument: a tab per resource, each with its spec rows
 * and the real API calls that book it (highlighted on the server by components/home/resources.tsx).
 */
export function ResourceSwitch({ panes }: { panes: ResourcePane[] }) {
  const [active, setActive] = useState(panes[0]!.id);
  const pane = panes.find((item) => item.id === active) ?? panes[0]!;

  return (
    <div className="border border-border-button-default bg-surface-raised">
      <div role="tablist" aria-label="Resource" className="grid grid-cols-3 border-b border-separator-border">
        {panes.map((item, index) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`resource-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`resource-panel-${item.id}`}
              onClick={() => setActive(item.id)}
              className={cx(
                'relative flex flex-col items-start gap-1 px-4 py-3 text-start font-mono transition-colors',
                index > 0 && 'border-s border-separator-border',
                selected
                  ? 'bg-background-secondary-default text-text-primary'
                  : 'text-text-secondary hover:bg-background-secondary-default/50 hover:text-text-primary',
              )}
            >
              {selected ? (
                <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-signal-fill" />
              ) : null}
              <span className="flex items-center gap-2 text-body-medium">
                <span className="led" data-on={selected} />
                {item.label}
              </span>
              <span className="hidden text-caption-1-regular text-text-tertiary sm:block">
                {item.unit}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`resource-panel-${pane.id}`}
        aria-labelledby={`resource-tab-${pane.id}`}
        className="grid grid-cols-1 lg:grid-cols-12"
      >
        <div className="flex flex-col gap-5 border-b border-separator-border p-5 sm:p-6 lg:col-span-5 lg:border-e lg:border-b-0">
          <p className="text-body-regular leading-6 text-pretty text-text-secondary">{pane.summary}</p>
          <dl className="flex flex-col border-t border-separator-border font-mono text-caption-1-regular">
            {pane.specs.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-separator-border py-2"
              >
                <dt className="tracking-[0.04em] text-text-tertiary uppercase">{label}</dt>
                <dd className="text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          <Link
            href={pane.href}
            className="group inline-flex w-fit items-center gap-1.5 font-mono text-caption-1-medium text-signal"
          >
            {pane.linkLabel}
            <RiArrowRightLine
              className="size-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </div>
        <div className="home-code code-lines min-w-0 overflow-x-auto bg-surface-sunken p-5 font-mono text-[0.8125rem] leading-6 sm:p-6 lg:col-span-7">
          {pane.code}
        </div>
      </div>
    </div>
  );
}
