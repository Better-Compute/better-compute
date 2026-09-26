import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlannerPage } from '@/components/capacity/pages/planner';

export const metadata: Metadata = { title: 'Plan a reservation' };

export default function Page() {
  return (
    <Suspense>
      <PlannerPage />
    </Suspense>
  );
}