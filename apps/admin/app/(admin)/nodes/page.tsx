import type { Metadata } from 'next';
import { NodesPage } from '@/components/fleet/nodes-page';

export const metadata: Metadata = { title: 'Nodes' };

export default function Page() {
  return <NodesPage />;
}
