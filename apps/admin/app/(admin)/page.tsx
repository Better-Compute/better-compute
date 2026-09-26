import type { Metadata } from 'next';
import { OverviewHeader } from '@/components/overview/header';
import { SinceAway } from '@/components/overview/since-away';
import { Dashboards } from '@/components/widgets/dashboard';

export const metadata: Metadata = { title: 'Overview' };

export default function OverviewPage() {
  return (
    <>
      <OverviewHeader />
      <SinceAway />
      <Dashboards />
    </>
  );
}
