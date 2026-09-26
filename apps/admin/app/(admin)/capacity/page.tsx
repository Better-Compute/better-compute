import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CapacityOverviewPage } from '@/components/capacity/pages/overview';

export const metadata: Metadata = { title: 'Capacity' };

export default function Page() {
  return (
    <Suspense>
      <CapacityOverviewPage />
    </Suspense>
  );
}