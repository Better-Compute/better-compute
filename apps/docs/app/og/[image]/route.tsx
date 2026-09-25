import { notFound } from 'next/navigation';
import { socialCard, type SocialCard } from '@/lib/og';
import { stats } from '@/lib/stats';

export const revalidate = false;

/** Social cards for the pages outside the docs (`siteImages` in lib/metadata.ts points at these). */
const cards: Record<string, SocialCard> = {
  'home.png': {
    trail: ['Open source', 'Apache 2.0'],
    title: 'GPU, CPU and sandbox capacity for TypeScript',
    description:
      'Nodes, reservations, PXE provisioning, and VPS instances in your own PostgreSQL, with double booking impossible by construction.',
    tags: [
      `${stats.methods} API methods`,
      `${stats.packages} packages`,
      `${stats.errorCodes} error codes`,
    ],
  },
};

export async function GET(_req: Request, { params }: RouteContext<'/og/[image]'>) {
  const { image } = await params;
  const card = cards[image];
  if (!card) notFound();
  return socialCard(card);
}

export function generateStaticParams() {
  return Object.keys(cards).map((image) => ({ image }));
}

export const dynamicParams = false;
