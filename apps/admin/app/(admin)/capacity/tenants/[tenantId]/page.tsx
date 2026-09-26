import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TenantDetailPage } from '@/components/capacity/pages/tenants';

export async function generateMetadata({ params }: { params: Promise<{ tenantId: string }> }): Promise<Metadata> {
  const { tenantId } = await params;
  return { title: `Tenant ${tenantId}` };
}

export default async function Page({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  return (
    <Suspense>
      <TenantDetailPage tenantId={decodeURIComponent(tenantId)} />
    </Suspense>
  );
}