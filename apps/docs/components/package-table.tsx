import type { ReactNode } from 'react';
import { RiBox3Line } from 'react-icons/ri';
import packages from '@/generated/packages.json';
import { sourceFileUrl, version } from '@/lib/shared';
import { cx } from '@/utils/cx';

/** One entry of `generated/packages.json`: a workspace package's manifest, as scripts/generate.mjs reads it. */
interface PackageInfo {
  name: string;
  directory: string;
  description: string;
  private: boolean;
  /** Keys of the manifest's `exports`: `.`, `./core`, `./pglite`, ... */
  exports: string[];
}

const cardClass =
  'group flex flex-col gap-2 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-xs transition-[background-color,border-color]';

/** A package card links to its manifest only when a public repository is configured. */
function CardShell({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cx(
        cardClass,
        'hover:border-border-button-hover hover:bg-background-primary-hover',
      )}
    >
      {children}
    </a>
  ) : (
    <div className={cardClass}>{children}</div>
  );
}

/**
 * Package cards generated from the workspace manifests, with their subpath exports. Without a filter it lists every
 * publishable package; a private package appears only when a filter names it.
 */
export function PackageTable({ filter }: { filter?: string[] }) {
  const list = (packages as PackageInfo[]).filter((pkg) =>
    filter ? filter.includes(pkg.name) : !pkg.private,
  );
  return (
    <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">
      {list.map((pkg) => {
        const subpaths = pkg.exports.filter((entry) => entry !== '.');
        return (
          <CardShell key={pkg.name} href={sourceFileUrl(`${pkg.directory}/package.json`)}>
            <div className="flex items-center gap-2">
              <RiBox3Line className="size-4 shrink-0 text-foreground-icon-primary" aria-hidden />
              <code className="min-w-0 truncate font-mono text-body-medium">{pkg.name}</code>
              <span className="ms-auto font-mono text-caption-1-regular text-text-secondary">
                {pkg.private ? 'private' : version}
              </span>
            </div>
            <p className="text-body-regular text-text-secondary">{pkg.description}</p>
            {subpaths.length ? (
              <div className="flex flex-wrap gap-1">
                {subpaths.map((entry) => (
                  <code
                    key={entry}
                    className="rounded-md bg-background-secondary-default px-1.5 py-0.5 font-mono text-[0.7rem] text-text-secondary"
                  >
                    {entry.replace(/^\./, '')}
                  </code>
                ))}
              </div>
            ) : null}
          </CardShell>
        );
      })}
    </div>
  );
}
