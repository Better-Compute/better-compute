import type { Metadata } from 'next';
import { ReportPage } from '@/components/capacity/pages/report';

export const metadata: Metadata = { title: 'Capacity report' };

export default function Page() {
  return <ReportPage />;
}