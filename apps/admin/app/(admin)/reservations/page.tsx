import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReservationsPage } from '@/components/capacity/pages/reservations';

export const metadata: Metadata = { title: 'Reservations' };

export default function Page() {
  return (
    <Suspense>
      <ReservationsPage />
    </Suspense>
  );
}