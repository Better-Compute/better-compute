import type { ReactNode } from 'react';
import { Frame } from '@/components/site/frame';
import { RackIndex, type RackUnit } from './rack-index';

/**
 * The units below the hero, hung in one rack frame: a pinned index on the left (from lg) and the units on the
 * right. Each unit is still a `Band`; inside `.console-stack` its own frame gives up its rails, width, screws and
 * unit tag (app/global.css), so the whole console reads as one instrument with one set of rails.
 */
export function Console({ units, children }: { units: RackUnit[]; children: ReactNode }) {
  return (
    <div className="relative border-b border-separator-border">
      <Frame className="grid grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="hidden border-e border-separator-border lg:block">
          <RackIndex units={units} />
        </aside>
        <div className="console-stack min-w-0">{children}</div>
      </Frame>
    </div>
  );
}
