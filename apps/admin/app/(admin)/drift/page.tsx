import type { Metadata } from 'next';
import { DriftPage } from '@/components/fleet/drift-page';

export const metadata: Metadata = { title: 'Fleet drift' };

export default function Page() {
  return <DriftPage />;
}
