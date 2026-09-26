import type { Metadata } from 'next';
import { VolumesPage } from '@/components/fleet/volumes-page';

export const metadata: Metadata = { title: 'Volumes' };

export default function Page() {
  return <VolumesPage />;
}
