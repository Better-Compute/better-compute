import type { Metadata } from 'next';
import { BatchesPage } from '@/components/fleet/batches-page';

export const metadata: Metadata = { title: 'Command batches' };

export default function Page() {
  return <BatchesPage />;
}
