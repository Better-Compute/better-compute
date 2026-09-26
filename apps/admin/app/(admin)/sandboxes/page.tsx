import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SandboxesPage } from '@/components/fleet/sandboxes-page';

export const metadata: Metadata = { title: 'Sandboxes' };

export default function Page() {
  return (
    <Suspense>
      <SandboxesPage />
    </Suspense>
  );
}
