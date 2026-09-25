import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { ConsoleProvider } from '@/components/console-provider';
import { Nav } from '@/components/nav';
import { currentSession } from '@/lib/iam';
import { getStack } from '@/lib/stack';
import { signOut } from '../login/actions';

export const dynamic = 'force-dynamic';

/** Every console page needs a session; pages render client-side over console-kit with the tenant it names. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const { origin } = await getStack();
  return (
    <ConsoleProvider tenantId={session.tenantId} root={session.root} origin={origin}>
      <div className="shell">
        <Nav
          root={session.root}
          who={session.email ?? session.name ?? session.identityId}
          signOut={signOut}
        />
        <main>{children}</main>
      </div>
    </ConsoleProvider>
  );
}
