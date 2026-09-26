import type { Metadata } from 'next';
import { SignInForm } from '@/components/shell/sign-in-form';
import { safeNext } from '@/lib/redirect';

export const metadata: Metadata = { title: 'Sign in' };

/** Operator sign-in: outside the shell, one centred form. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center bg-background-full px-4">
      <SignInForm next={safeNext(next)} />
    </main>
  );
}
