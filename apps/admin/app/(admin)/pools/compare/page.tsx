import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ComparePage } from '@/components/capacity/pages/compare';

export const metadata: Metadata = { title: 'Compare pools' };

export default function Page() {
  return (
    <Suspense>
      <ComparePage />
    </Suspense>
  );
}