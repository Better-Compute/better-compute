import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsagePage } from '@/components/capacity/pages/usage';

export const metadata: Metadata = { title: 'Usage & spend' };

export default function Page() {
  return (
    <Suspense>
      <UsagePage />
    </Suspense>
  );
}