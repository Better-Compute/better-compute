import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NodesPage } from '@/components/fleet/nodes-page';

export const metadata: Metadata = { title: 'Nodes' };

export default function Page() {
  return (
    <Suspense>
      <NodesPage />
    </Suspense>
  );
}
