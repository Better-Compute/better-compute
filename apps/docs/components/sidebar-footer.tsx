import Link from 'next/link';
import { RiArrowRightLine, RiTerminalBoxLine } from 'react-icons/ri';
import { ThemeToggle } from '@/components/application/theme/theme-toggle';
import { CreatorCredit } from '@/components/site/creator-credit';
import { version } from '@/lib/shared';

/**
 * Bottom of the docs sidebar: a way to try the control plane locally (`better-compute dev --sim N` runs simulated
 * daemons), the theme toggle (BoardUI), and version links.
 */
export function SidebarFooter() {
  return (
    <div className="flex flex-col gap-3 pt-1">
      <Link
        href="/docs/operations/local-development"
        className="group flex items-center gap-2.5 rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2 text-body-medium shadow-xs transition-colors hover:border-border-button-hover hover:bg-background-primary-hover"
      >
        <RiTerminalBoxLine className="size-4 text-foreground-icon-primary" aria-hidden />
        <span className="flex-1">Run the simulator</span>
        <RiArrowRightLine
          className="size-4 text-foreground-icon-tertiary transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
      <CreatorCredit className="ps-1" />
      <div className="flex items-center gap-2">
        <ThemeToggle size="sm" />
        <span className="ms-auto flex min-w-0 items-center gap-1.5 truncate text-caption-1-regular text-text-secondary">
          <Link
            href="/docs/reference/changelog"
            title="Changelog"
            className="font-mono hover:text-text-primary"
          >
            v{version}
          </Link>
          ·
          <Link href="/docs/reference/ai" className="hover:text-text-primary">
            Use with AI
          </Link>
        </span>
      </div>
    </div>
  );
}
