import type { Metadata } from 'next';
import { AttentionPage } from '@/components/overview/attention-page';

export const metadata: Metadata = { title: 'Needs attention' };

export default function Page() {
  return <AttentionPage />;
}
