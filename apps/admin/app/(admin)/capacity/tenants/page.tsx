import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TenantsPage } from '@/components/capacity/pages/tenants';

export const metadata: Metadata = { title: 'Tenants' };

export default function Page() {
  return (
    <Suspense>
      <TenantsPage />
    </Suspense>
  );
}