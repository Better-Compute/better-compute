import { redirect } from 'next/navigation';
import { SignInForm } from '@better-iam/next/client';
import { currentSession } from '@/lib/iam';
import { getStack } from '@/lib/stack';
import { signIn } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Sign-in. Platform administrators sign in to the root tenant (the default); members of an organization use
 * `?org=<slug>`. better-iam's form handles the password, emailed codes, MFA and first-time enrollment.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; org?: string }>;
}) {
  const { next, org } = await searchParams;
  if (await currentSession()) redirect(next?.startsWith('/') ? next : '/');
  const { rootTenantId } = await getStack();
  return (
    <main style={{ maxWidth: 420, margin: '10vh auto' }}>
      <h2>Sign in to better-compute</h2>
      <div className="panel">
        {org ? (
          <SignInForm
            action={signIn}
            org={org}
            showOrganization={false}
            keepSignedIn
            {...(next ? { next } : {})}
          />
        ) : (
          <SignInForm
            action={signIn}
            tenantId={rootTenantId}
            showOrganization={false}
            keepSignedIn
            {...(next ? { next } : {})}
          />
        )}
      </div>
      <p className="muted">
        {org ? (
          <a href="/login">Platform administrator sign-in</a>
        ) : (
          <>Organization members: open /login?org=&lt;your organization&gt;.</>
        )}
      </p>
    </main>
  );
}
