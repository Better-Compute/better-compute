'use server';

import type { AuthFormState } from '@better-iam/next';
import { authActions } from '@/lib/iam';

// Server actions behind the sign-in form (better-iam's password, emailed code, MFA and enrollment steps).

export async function signIn(
  state: AuthFormState | null,
  form: FormData,
): Promise<AuthFormState | null> {
  return authActions.signIn(state, form);
}

export async function signOut(): Promise<never> {
  return authActions.signOut();
}
