import { createGetUrl } from 'fumadocs-core/source';
import { docsContentRoute, docsImageRoute } from './routes';
import { stats } from './stats';

export { docsContentRoute, docsImageRoute, docsRoute } from './routes';
export { newIssueUrl, repositoryBranch, repositoryUrl, sourceFileUrl } from './repository';

export const appName = 'Better Compute';
export const appDescription =
  'An embeddable TypeScript control plane for GPU, CPU and sandbox capacity: nodes, reservations, bare-metal provisioning, and isolated VMs, authorized by Better IAM.';
/**
 * The released version, as the CLI reports it (every package shares one version; see lib/stats.ts). This pulls in
 * the generated reference data, so client components import lib/repository.ts or lib/routes.ts instead.
 */
export const version: string = stats.version;
/** Better Compute's creator, credited in page metadata, llms.txt, the site and docs footers, every docs page, and social cards. */
export const creator = 'Sean Filimon';

/** The production site; `DOCS_SITE_URL` overrides it. */
export const productionSiteUrl = 'https://better-compute.com';

/**
 * Canonical origin used for metadata, sitemap and llms.txt links: `DOCS_SITE_URL` when set, else the production
 * site in production builds (`next build`, `next start`) and the local dev server (`next dev`) otherwise.
 */
export const siteUrl = (
  process.env.DOCS_SITE_URL ||
  (process.env.NODE_ENV === 'production' ? productionSiteUrl : 'http://localhost:4100')
).replace(/\/$/, '');

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
