import 'server-only';
import { createIamNext } from '@better-iam/next';
import { getStack } from './stack';

// better-iam's App Router helpers over the console's embedded instance: the session from the request cookies,
// `requireSession` for pages, and the server actions behind the sign-in form.

export const iamNext = createIamNext(async () => (await getStack()).iam as never, {
  loginPath: '/login',
});

export const authActions = iamNext.authActions({ afterSignIn: '/', loginPath: '/login' });

export interface ConsoleSession {
  tenantId: string;
  identityId: string;
  name?: string;
  email?: string;
  root: boolean;
}

/** The signed-in person, or null. */
export async function currentSession(): Promise<ConsoleSession | null> {
  const session = (await iamNext.getSession()) as {
    session?: { tenantId?: string };
    identity?: { id?: string; name?: string; email?: string; tenantId?: string };
  } | null;
  if (!session) return null;
  const { rootTenantId } = await getStack();
  const tenantId = session.session?.tenantId ?? session.identity?.tenantId;
  if (!tenantId || !session.identity?.id) return null;
  return {
    tenantId,
    identityId: session.identity.id,
    ...(session.identity.name ? { name: session.identity.name } : {}),
    ...(session.identity.email ? { email: session.identity.email } : {}),
    root: tenantId === rootTenantId,
  };
}
