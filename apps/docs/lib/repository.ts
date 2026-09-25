/**
 * The public repository behind the "GitHub", "Edit this page", source-file, and issue links. Client components
 * import this module rather than lib/shared.ts, which reads the generated reference data (through lib/stats.ts)
 * that has no place in a browser bundle.
 *
 * Defaults to github.com/better-compute/better-compute (the `repository` of every package.json); a fork sets
 * `NEXT_PUBLIC_DOCS_REPOSITORY_URL=https://github.com/acme/better-compute`.
 */
export const repositoryUrl: string =
  process.env.NEXT_PUBLIC_DOCS_REPOSITORY_URL?.replace(/\/$/, '') ||
  'https://github.com/better-compute/better-compute';
export const repositoryBranch = process.env.NEXT_PUBLIC_DOCS_REPOSITORY_BRANCH || 'main';

/** A link to a file in the repository, or undefined when no repository is configured. */
export function sourceFileUrl(path: string): string | undefined {
  return repositoryUrl ? `${repositoryUrl}/blob/${repositoryBranch}/${path}` : undefined;
}

/** A prefilled "new issue" link, or undefined when no repository is configured. */
export function newIssueUrl(title: string, body: string): string | undefined {
  if (!repositoryUrl) return undefined;
  return `${repositoryUrl}/issues/new?${new URLSearchParams({ title, body, labels: 'documentation' })}`;
}
