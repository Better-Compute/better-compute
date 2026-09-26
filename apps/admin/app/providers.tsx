'use client';

import { ThemeProvider } from 'next-themes';
import { RouterProvider } from 'react-aria-components';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { WorkspaceProvider } from '@/components/shell/workspace';

export function Providers({ initialNow, children }: { initialNow: number; children: ReactNode }) {
  const router = useRouter();
  return (
    // Dark first, like a control room; the toggle and a saved choice still win.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      <RouterProvider navigate={router.push}>
        <WorkspaceProvider initialNow={initialNow}>{children}</WorkspaceProvider>
      </RouterProvider>
    </ThemeProvider>
  );
}
