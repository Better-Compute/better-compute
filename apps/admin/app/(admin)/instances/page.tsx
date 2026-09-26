import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InstancesPage } from '@/components/fleet/instances-page';

export const metadata: Metadata = { title: 'Instances' };

export default function Page() {
  return (
    <Suspense>
      <InstancesPage />
    </Suspense>
  );
}
