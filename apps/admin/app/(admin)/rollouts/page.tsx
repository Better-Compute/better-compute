import type { Metadata } from 'next';
import { RolloutsPage } from '@/components/fleet/rollouts-page';

export const metadata: Metadata = { title: 'Rollouts' };

export default function Page() {
  return <RolloutsPage />;
}
