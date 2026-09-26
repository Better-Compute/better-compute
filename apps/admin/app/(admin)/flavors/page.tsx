import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FlavorsPage } from '@/components/capacity/pages/flavors';

export const metadata: Metadata = { title: 'Flavors' };

export default function Page() {
  return (
    <Suspense>
      <FlavorsPage />
    </Suspense>
  );
}