import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ActivityPage } from '@/components/fleet/activity-page';

export const metadata: Metadata = { title: 'Activity' };

export default function Page() {
  return (
    <Suspense>
      <ActivityPage />
    </Suspense>
  );
}
