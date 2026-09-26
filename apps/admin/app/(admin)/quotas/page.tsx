import type { Metadata } from 'next';
import { Suspense } from 'react';
import { QuotasPage } from '@/components/capacity/pages/quotas';

export const metadata: Metadata = { title: 'Quotas' };

export default function Page() {
  return (
    <Suspense>
      <QuotasPage />
    </Suspense>
  );
}