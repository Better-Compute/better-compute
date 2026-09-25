import { createGetUrl } from 'fumadocs-core/source';
import { docsContentRoute, docsImageRoute } from './routes';
import { stats } from './stats';

export { docsContentRoute, docsImageRoute, docsRoute } from './routes';
export { newIssueUrl, repositoryBranch, repositoryUrl, sourceFileUrl } from './repository';

export const appName = 'Better Compute';
export const appDescription =
  'An embeddable TypeScript control plane for GPU and bare-metal capacity: nodes, reservations, provisioning, and VPS instances, authorized by Better IAM.';
/**
 * The released version, as the CLI reports it (every package shares one version; see lib/stats.ts). This pulls in
 * the generated reference data, so client components import lib/repository.ts or lib/routes.ts instead.
 */
export const version: string = stats.version;
/** Better Compute's creator, credited in page metadata, llms.txt, the site and docs footers, every docs page, and social cards. */
export const creator = 'Sean Filimon';

/** Canonical origin used for metadata, sitemap and llms.txt links. */
export const siteUrl = (process.env.DOCS_SITE_URL ?? 'http://localhost:4100').replace(/\/$/, '');

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
