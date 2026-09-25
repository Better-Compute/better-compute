import type { ComponentProps, ReactNode } from 'react';
import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiInformationLine,
  RiLightbulbLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';

type CalloutType = 'info' | 'warn' | 'warning' | 'error' | 'success' | 'idea' | 'tip' | 'note';

const kinds = {
  info: { icon: RiInformationLine, strong: false },
  warning: { icon: RiAlertLine, strong: true },
  error: { icon: RiCloseCircleLine, strong: true },
  success: { icon: RiCheckboxCircleLine, strong: false },
  idea: { icon: RiLightbulbLine, strong: false },
} as const;

function resolve(type: CalloutType): keyof typeof kinds {
  if (type === 'warn') return 'warning';
  if (type === 'tip' || type === 'note') return 'info';
  return type;
}

/**
 * MDX callouts (also produced by `:::note` admonitions), drawn as a panel annotation: a square sunken card with a
 * stripe down its left edge and a mono label. Warnings and errors take the signal amber (stripe and label), the
 * only place prose uses it; the rest stay graphite.
 */
export function Callout({
  type = 'info',
  title,
  icon,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  type?: CalloutType;
  title?: ReactNode;
  icon?: ReactNode;
}) {
  const resolved = resolve(type);
  const kind = kinds[resolved] ?? kinds.info;
  const Icon = kind.icon;
  return (
    <div
      role="note"
      className={cx(
        'relative my-5 flex gap-3 border border-border-button-default bg-surface-sunken py-3.5 ps-5 pe-4 text-body-regular leading-6',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-0 start-0 w-[3px]',
          kind.strong ? 'bg-signal-fill' : 'bg-text-tertiary',
        )}
      />
      <span
        aria-hidden
        className={cx(
          'flex size-6 shrink-0 items-center justify-center [&_svg]:size-4',
          kind.strong ? 'text-signal' : 'text-foreground-icon-secondary',
        )}
      >
        {icon ?? <Icon />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-px">
        {title ? (
          <p className="my-0! font-mono text-body-medium tracking-[-0.02em] text-text-primary">
            {title}
          </p>
        ) : null}
        <div className="prose-no-margin text-body-regular leading-6 text-text-secondary empty:hidden [&_a]:text-text-primary">
          {children}
        </div>
      </div>
    </div>
  );
}
