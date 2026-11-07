import type { Metadata } from 'next';
import { ProvidersPage } from '@/components/providers/providers-page';

export const metadata: Metadata = { title: 'Provider accounts' };

export default function Page() {
  return <ProvidersPage />;
}
