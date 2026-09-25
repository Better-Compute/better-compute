import type { ComponentProps, ReactNode } from 'react';
import { cx } from '@/utils/cx';
import { DrawLine, FadeUp, WordReveal } from './motion-text';

/**
 * Layout primitives for the marketing pages, drawn as a rack. The centered frame hangs between two mounting rails
 * with square holes (`.rack-frame` in app/global.css) that run from the header to the footer. Each band is one unit
 * of the rack: full-width hairlines separate them, a small square screw sits where a rail meets one, and a band with
 * a `unit` shows its number (U02, U03, …) in a tag at its top edge. Content inside uses `gutter`, so left edges line
 * up everywhere.
 */
export const gutter = 'px-5 sm:px-8 lg:px-12';

export function Frame({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cx(
        'rack-frame relative mx-auto w-full max-w-site border-x border-separator-border sm:w-[calc(100%-3.5rem)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Band({
  id,
  unit,
  className,
  frameClassName,
  marks = true,
  children,
  ...props
}: Omit<ComponentProps<'section'>, 'children'> & {
  /** The rack unit this band occupies, shown as a tag on its top edge: `02` renders `U02`. */
  unit?: string;
  frameClassName?: string;
  /** Screws where the rails meet this band's bottom hairline. */
  marks?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cx('relative scroll-mt-28 border-b border-separator-border', className)}
      {...props}
    >
      <Frame className={frameClassName}>
        {unit ? <UnitTag unit={unit} /> : null}
        {children}
        {marks ? (
          <>
            <Screw className="-bottom-[4px] -left-[4px]" />
            <Screw className="-right-[4px] -bottom-[4px]" />
          </>
        ) : null}
      </Frame>
    </section>
  );
}

/** A 7px square screw head whose center sits on a rail/hairline intersection. */
export function Screw({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute z-10 hidden size-[7px] border border-text-tertiary bg-background-full sm:block',
        className,
      )}
    />
  );
}

/** The unit number, hung from the band's top-left corner like a label on a rack. */
function UnitTag({ unit }: { unit: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 z-10 hidden border-e border-b border-separator-border bg-background-full px-2 py-0.5 font-mono text-[0.6875rem] leading-4 tracking-[0.08em] text-text-tertiary sm:block"
    >
      U{unit}
    </span>
  );
}

/** Unit number, eyebrow label, heading, and lede, in the reading order every chapter uses. */
export function SectionHeading({
  index,
  eyebrow,
  title,
  children,
  className,
}: {
  index?: string;
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('flex max-w-2xl flex-col gap-4', className)}>
      <p className="eyebrow flex items-center gap-2.5">
        <span className="led" data-on="true" />
        {index ? <span className="text-signal">U{index}</span> : null}
        {index ? <DrawLine className="h-px w-6 bg-signal-fill" delay={0.1} /> : null}
        {eyebrow}
      </p>
      <h2 className="font-mono text-[1.875rem] leading-[1.12] font-medium tracking-[-0.045em] text-balance md:text-[2.5rem] md:leading-[1.08]">
        <WordReveal text={title} />
      </h2>
      {children ? (
        <FadeUp delay={0.25}>
          <p className="text-headline-regular leading-7 text-pretty text-text-secondary md:text-[1.0625rem]">
            {children}
          </p>
        </FadeUp>
      ) : null}
    </header>
  );
}
