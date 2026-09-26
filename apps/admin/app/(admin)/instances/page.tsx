import type { Metadata } from 'next';
import { InstancesPage } from '@/components/fleet/instances-page';

export const metadata: Metadata = { title: 'Instances' };

export default function Page() {
  return <InstancesPage />;
}
