/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Concurrent `next dev` and `next build` runs must not share one output directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default config;
