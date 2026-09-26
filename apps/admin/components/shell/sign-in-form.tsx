'use client';

import { useState, type FormEvent } from 'react';
import { RiLockLine, RiShieldKeyholeLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { safeNext } from '@/lib/redirect';
import { adminHeaders, rotateSessionKey } from '@/lib/session-key';
import { BrandMark } from './sidebar';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string; hint?: string };

const field =
  'h-10 w-full border border-border-button-default bg-background-primary-default px-3 text-body-regular text-text-primary outline-none placeholder:text-text-placeholder focus:ring-2 focus:ring-border-focus-ring';

/**
 * Sign in with the operator's better-iam account. The admin server exchanges the credentials for the operator's
 * own session and keeps it in an HttpOnly cookie; the browser never sees the bearer. After sign-in the live
 * connection acts as this person (changes allowed, as far as their policies allow).
 */
export function SignInForm({ next }: { next: string }) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [organization, setOrganization] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A new sign-in gets a new browser key; the code step must use the key its challenge was made for.
      if (step.kind === 'password') rotateSessionKey();
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders() },
        body: JSON.stringify(
          step.kind === 'password'
            ? { organization: organization.trim() || undefined, email: email.trim(), password }
            : { challenge: step.challenge, code: code.trim() },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; step?: 'code'; challenge?: string; hint?: string; error?: { message: string } };
      if (body.ok) {
        // Checked again here against the real origin (the page already passed it through safeNext).
        window.location.assign(safeNext(next, window.location.origin));
        return;
      }
      if (body.step === 'code' && body.challenge) {
        setStep({ kind: 'code', challenge: body.challenge, ...(body.hint ? { hint: body.hint } : {}) });
        setPassword('');
        return;
      }
      setError(body.error?.message ?? 'Sign-in failed.');
    } catch {
      setError('The admin server did not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-[380px] max-w-full border border-separator-border bg-surface-raised">
      <header className="flex items-center gap-3 border-b border-separator-border px-5 py-4">
        <BrandMark />
        <div>
          <div className="font-mono text-[13px] font-medium tracking-wide text-text-primary uppercase">Better Compute admin</div>
          <div className="text-caption-1-regular text-text-secondary">Sign in as yourself to make changes</div>
        </div>
      </header>
      <div className="flex flex-col gap-4 px-5 py-5">
        {step.kind === 'password' ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Organization</span>
              <input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Leave empty for the platform (root)" autoComplete="organization" className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="username" autoFocus className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Password</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required autoComplete="current-password" className={field} />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
              <RiShieldKeyholeLine className="size-3.5" aria-hidden />
              Verification code
            </span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required autoFocus className={`${field} font-mono tracking-[0.3em]`} />
            <span className="text-caption-1-regular text-text-secondary">{step.hint ?? 'Enter the code from your authenticator or your email.'}</span>
          </label>
        )}
        {error && (
          <p role="alert" className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-caption-1-regular text-text-error-primary">
            {error}
          </p>
        )}
        <Button type="submit" leadingIcon={RiLockLine} disabled={busy}>
          {busy ? 'Signing in…' : step.kind === 'password' ? 'Sign in' : 'Verify'}
        </Button>
        <p className="text-caption-1-regular text-text-tertiary">
          Your credentials go to the compute API&apos;s identity service; the admin keeps only your session, in an HttpOnly cookie.
        </p>
      </div>
    </form>
  );
}
