import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

// IBM Plex: Sans for reading, Mono for headings, labels and numbers — the docs' instrument theme.
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-mono' });

export const metadata: Metadata = {
  title: { template: '%s · Better Compute Admin', default: 'Better Compute Admin' },
  description: 'Operate a better-compute fleet: capacity, nodes, workloads and the control plane.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0f' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request: the workspace clock starts at the server's "now", and the client continues from it.
  await connection();
  const initialNow = Math.floor(Date.now() / 2000) * 2000;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">
        <Providers initialNow={initialNow}>{children}</Providers>
      </body>
    </html>
  );
}
