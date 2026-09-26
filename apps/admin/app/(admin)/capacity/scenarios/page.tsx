import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ScenariosPage } from '@/components/capacity/pages/scenarios';

export const metadata: Metadata = { title: 'What-if' };

export default function Page() {
  return (
    <Suspense>
      <ScenariosPage />
    </Suspense>
  );
}