import type { ComponentType, ReactNode } from 'react';
import { cx } from '@/utils/cx';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

/**
 * A raised instrument panel: hairline border, square corners, a mono caption bar. The basic unit of every page.
 * `flush` drops the body padding (tables, charts that bleed to the edge).
 */
export function Panel({
  title,
  icon: IconComponent,
  meta,
  actions,
  flush,
  className,
  bodyClassName,
  children,
  id,
}: {
  title?: ReactNode;
  icon?: Icon;
  /** Small mono text right of the title: counts, units, "updated 3s ago". */
  meta?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cx(
        'flex min-w-0 flex-col border border-separator-border bg-surface-raised',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex min-h-10 items-center gap-2 border-b border-separator-border px-3">
          {IconComponent && <IconComponent className="size-4 shrink-0 text-text-tertiary" aria-hidden />}
          {title && (
            <h2 className="truncate font-mono text-[12px] font-medium tracking-wide text-text-secondary uppercase">
              {title}
            </h2>
          )}
          {meta && <span className="truncate font-mono text-[11px] text-text-tertiary">{meta}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={cx('min-h-0 flex-1', !flush && 'p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/** The top of a page: title, one-line description, meta chips and primary actions. */
export function PageHeader({
  title,
  description,
  icon: IconComponent,
  meta,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: Icon;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Tabs or filters under the header. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {IconComponent && (
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center border border-separator-border bg-surface-raised">
              <IconComponent className="size-[18px] text-text-secondary" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="font-mono text-[20px] leading-7 font-medium tracking-tight text-text-primary">{title}</h1>
            {description && <p className="mt-0.5 max-w-3xl text-body-regular text-text-secondary">{description}</p>}
            {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Nothing to show, said plainly, with the next step. */
export function EmptyState({
  icon: IconComponent,
  title,
  children,
  action,
  className,
}: {
  icon?: Icon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {IconComponent && (
        <span className="grid size-10 place-items-center border border-dashed border-separator-border-strong">
          <IconComponent className="size-5 text-text-tertiary" aria-hidden />
        </span>
      )}
      <p className="font-mono text-[13px] font-medium text-text-primary">{title}</p>
      {children && <p className="max-w-sm text-caption-1-regular text-text-secondary">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Label/value pairs for detail views, in a responsive grid of definition rows. */
export function KeyValue({
  items,
  columns = 2,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[];
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <dl
      className={cx(
        'grid gap-x-6 gap-y-3',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 sm:grid-cols-2',
        columns === 3 && 'grid-cols-1 sm:grid-cols-3',
        columns === 4 && 'grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={index} className="min-w-0">
          <dt className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">{item.label}</dt>
          <dd className={cx('mt-0.5 truncate text-body-regular text-text-primary', item.mono && 'font-mono tabular-nums')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A 12-column responsive grid for page layouts: <Grid><Panel className="col-span-12 lg:col-span-8" /></Grid>. */
export function Grid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('grid grid-cols-12 gap-3', className)}>{children}</div>;
}
