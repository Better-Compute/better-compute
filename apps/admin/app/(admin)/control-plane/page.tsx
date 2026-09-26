import type { Metadata } from 'next';
import { ControlPlanePage } from '@/components/overview/control-plane-page';

export const metadata: Metadata = { title: 'Control plane' };

export default function Page() {
  return <ControlPlanePage />;
}
