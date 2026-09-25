'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { RiArrowRightLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';

export interface DeepDive {
  id: string;
  label: string;
  title: string;
  claim: string;
  href: string;
  linkLabel: string;
  stage: ReactNode;
}

/**
 * The landing page's interactive diagrams as channels of one monitor: a channel strip on top, the selected diagram
 * below at full width. Only the selected diagram is mounted, so the others cost nothing until chosen. Arrow keys move
 * between channels.
 */
export function DeepDives({ dives }: { dives: DeepDive[] }) {
  const [active, setActive] = useState(dives[0]!.id);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    dives.findIndex((dive) => dive.id === active),
  );
  const dive = dives[index]!;

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + dives.length) % dives.length;
    setActive(dives[next]!.id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col border border-border-button-default bg-surface-raised">
      <div
        role="tablist"
        aria-label="Deep dives"
        onKeyDown={onKeyDown}
        data-lenis-prevent-horizontal
        className="flex overflow-x-auto border-b border-separator-border [scrollbar-width:none]"
      >
        {dives.map((item, i) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              ref={(element) => {
                tabs.current[i] = element;
              }}
              type="button"
              role="tab"
              id={`dive-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="dive-stage"
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              className={cx(
                'relative flex shrink-0 items-center gap-2 px-4 py-3 font-mono text-caption-1-regular transition-colors',
                i > 0 && 'border-s border-separator-border',
                selected
                  ? 'bg-background-secondary-default text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {selected ? (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-signal-fill" />
              ) : null}
              <span className="led" data-on={selected} />
              <span className={selected ? 'text-signal' : 'text-text-tertiary'}>
                CH{String(i + 1).padStart(2, '0')}
              </span>
              {item.label}
            </button>
          );
        })}
      </div>

      <div
        id="dive-stage"
        role="tabpanel"
        aria-labelledby={`dive-tab-${dive.id}`}
        className="flex flex-col"
      >
        <div className="flex flex-col gap-3 border-b border-separator-border px-5 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div className="flex max-w-2xl flex-col gap-1.5">
            <h3 className="font-mono text-headline-medium tracking-[-0.03em] text-text-primary">
              {dive.title}
            </h3>
            <p className="text-body-2-regular leading-5 text-pretty text-text-secondary">
              {dive.claim}
            </p>
          </div>
          <Link
            href={dive.href}
            className="group inline-flex shrink-0 items-center gap-1.5 font-mono text-caption-1-medium text-signal"
          >
            {dive.linkLabel}
            <RiArrowRightLine
              className="size-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </div>
        <div key={dive.id} className="animate-float-in min-w-0 p-3 sm:p-5">
          {dive.stage}
        </div>
      </div>
    </div>
  );
}
