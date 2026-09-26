import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PoolDetailPage } from '@/components/capacity/pages/pool-detail';

export async function generateMetadata({ params }: { params: Promise<{ poolId: string }> }): Promise<Metadata> {
  const { poolId } = await params;
  return { title: `Pool ${poolId}` };
}

export default async function Page({ params }: { params: Promise<{ poolId: string }> }) {
  const { poolId } = await params;
  return (
    <Suspense>
      <PoolDetailPage poolId={decodeURIComponent(poolId)} />
    </Suspense>
  );
}