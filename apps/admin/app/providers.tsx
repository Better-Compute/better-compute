'use client';

import { ThemeProvider } from '@/components/shell/theme';
import { RouterProvider } from 'react-aria-components';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConnectionProvider } from '@/components/shell/connection';
import { StreamOrphanSweeper } from '@/components/shell/stream-orphans';
import { WorkspaceProvider } from '@/components/shell/workspace';
import { FeedbackProvider } from '@/components/ui/feedback';

export function Providers({ initialNow, children }: { initialNow: number; children: ReactNode }) {
  const router = useRouter();
  return (
    // Dark first, like a control room; the toggle and a saved choice still win (see THEME_BOOTSTRAP).
    <ThemeProvider>
      <RouterProvider navigate={router.push}>
        <ConnectionProvider>
          <WorkspaceProvider initialNow={initialNow}>
            <FeedbackProvider>
              {children}
              <StreamOrphanSweeper />
            </FeedbackProvider>
          </WorkspaceProvider>
        </ConnectionProvider>
      </RouterProvider>
    </ThemeProvider>
  );
}
