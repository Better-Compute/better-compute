import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PoolsPage } from '@/components/capacity/pages/pools';

export const metadata: Metadata = { title: 'Pools' };

export default function Page() {
  return (
    <Suspense>
      <PoolsPage />
    </Suspense>
  );
}