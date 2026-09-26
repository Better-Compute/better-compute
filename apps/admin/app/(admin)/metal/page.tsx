import type { Metadata } from 'next';
import { MetalPage } from '@/components/fleet/metal-page';

export const metadata: Metadata = { title: 'Bare metal' };

export default function Page() {
  return <MetalPage />;
}
