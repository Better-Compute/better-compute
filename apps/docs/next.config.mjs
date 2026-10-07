import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX({ macro: false });

// The canonical origin, resolved the same way as `siteUrl` in lib/shared.ts (read at build time): DOCS_SITE_URL,
// else https://better-compute.com in production (next sets NODE_ENV before it loads this file), else none.
const siteUrl =
  process.env.DOCS_SITE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://better-compute.com' : undefined);
const canonical = siteUrl ? new URL(siteUrl) : undefined;
const escapeHost = (host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One address per page for search engines: the `www.` host redirects permanently to the canonical origin. */
function canonicalHostRedirects() {
  if (!canonical || canonical.hostname === 'localhost') return [];
  return [
    {
      source: '/:path*',
      has: [{ type: 'host', value: `www\\.${escapeHost(canonical.hostname)}` }],
      destination: `${canonical.origin}/:path*`,
      permanent: true,
    },
  ];
}

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Concurrent `next dev` and `next build` runs must not share one output directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async redirects() {
    return [
      ...canonicalHostRedirects(),
      { source: '/docs', destination: '/docs/guides', permanent: true },
    ];
  },
  async headers() {
    // Plain-text copies of the whole site for AI tools; search results should show the pages themselves.
    return ['/llms.txt', '/llms-full.txt'].map((source) => ({
      source,
      headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
    }));
  },
};

export default withMDX(config);
