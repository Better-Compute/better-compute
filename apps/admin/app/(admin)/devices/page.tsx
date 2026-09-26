import type { Metadata } from 'next';
import { DevicesPage } from '@/components/fleet/devices-page';

export const metadata: Metadata = { title: 'GPUs' };

export default function Page() {
  return <DevicesPage />;
}
