import type { NextConfig } from 'next';

const config: NextConfig = {
  // The control plane, IAM and their stores run in Node.js at runtime; never bundle them.
  serverExternalPackages: [
    'better-compute',
    'better-iam',
    '@better-iam/core',
    '@better-iam/auth',
    '@better-iam/server',
    '@better-iam/adapter-sqlite',
    '@better-iam/adapter-postgres',
    '@better-iam/adapter-libsql',
    '@libsql/client',
    'libsql',
    '@electric-sql/pglite',
    'better-sqlite3',
    'argon2',
    'kysely',
    'pg',
  ],
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // A console must never be framed (clickjacking of release/delete buttons), sniffed, or leak URLs via Referer.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
