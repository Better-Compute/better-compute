import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import SearchDialog from '@/components/search';
import {
  pageMetadata,
  siteDescription,
  siteImages,
  siteTitle,
  siteVerification,
} from '@/lib/metadata';
import { appName, creator, siteUrl } from '@/lib/shared';
import './global.css';

// IBM Plex: Sans for reading, Mono for headings, labels and numbers (styles/instrument.css reads both variables).
// BoardUI's Figma spec names Plex Mono as its code face; the Better IAM site uses Inter and JetBrains Mono.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

// Defaults for every page. Pages set their own title, description, canonical URL, and social card through
// pageMetadata(); these cover the rest (404s included). Icons come from scripts/generate-icons.mjs, and
// app/manifest.ts adds the web app manifest link.
export const metadata: Metadata = {
  ...pageMetadata({
    title: siteTitle,
    absolute: true,
    description: siteDescription,
    image: siteImages.home,
  }),
  metadataBase: new URL(siteUrl),
  title: { template: `%s | ${appName}`, default: siteTitle },
  applicationName: appName,
  authors: [{ name: creator }],
  creator,
  publisher: creator,
  category: 'technology',
  // Version numbers and ports in code samples are not phone numbers.
  formatDetection: { telephone: false, email: false, address: false },
  robots: {
    googleBot: { 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
  },
  icons: {
    // `sizes` on the ICO keeps browsers that read SVG favicons on the SVG.
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { title: appName, statusBarStyle: 'default' },
  verification: siteVerification(),
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0f' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        {/* Dark first, like a control room; the theme toggle and a saved choice still win. */}
        <RootProvider search={{ SearchDialog }} theme={{ defaultTheme: 'dark' }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
