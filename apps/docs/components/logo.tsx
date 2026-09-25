import type { SVGProps } from 'react';
import { cx } from '@/utils/cx';

/**
 * The Better Compute mark: a solid chip package with three pins on each side, its die window cut out and the die
 * itself left standing in the middle. One even-odd path on a 24 px grid, spanning 1.75 to 22.25 on both axes
 * (20.5 units around the center, like the Better IAM shield). scripts/generate-icons.mjs and lib/og.tsx draw the
 * same path; change all three together.
 */
export const logoMarkPath =
  'M7.25 5.25H7.75V1.75H9.25V5.25H11.25V1.75H12.75V5.25H14.75V1.75H16.25V5.25H16.75A2 2 0 0 1 18.75 7.25V7.75H22.25V9.25H18.75V11.25H22.25V12.75H18.75V14.75H22.25V16.25H18.75V16.75A2 2 0 0 1 16.75 18.75H16.25V22.25H14.75V18.75H12.75V22.25H11.25V18.75H9.25V22.25H7.75V18.75H7.25A2 2 0 0 1 5.25 16.75V16.25H1.75V14.75H5.25V12.75H1.75V11.25H5.25V9.25H1.75V7.75H5.25V7.25A2 2 0 0 1 7.25 5.25ZM9.25 8.25A1 1 0 0 0 8.25 9.25V14.75A1 1 0 0 0 9.25 15.75H14.75A1 1 0 0 0 15.75 14.75V9.25A1 1 0 0 0 14.75 8.25H9.25ZM10.75 10.25A.5 .5 0 0 0 10.25 10.75V13.25A.5 .5 0 0 0 10.75 13.75H13.25A.5 .5 0 0 0 13.75 13.25V10.75A.5 .5 0 0 0 13.25 10.25H10.75Z';

export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path fill="currentColor" fillRule="evenodd" d={logoMarkPath} />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    // Block-level flex, not inline-flex: an inline box sits on the parent's text baseline and rides a few pixels high.
    <span className={cx('flex w-fit items-center gap-2 text-headline-semibold', className)}>
      <LogoMark className="size-5 text-text-primary" />
      <span className="tracking-[-0.01em]">
        Better<span className="text-text-secondary">Compute</span>
      </span>
    </span>
  );
}
