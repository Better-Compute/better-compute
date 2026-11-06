'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine } from '@/components/ui';
import { pendingKey, pendingTtlMs, type PendingConnect } from '../pending';

type Outcome =
  | { status: 'working' }
  | { status: 'connected'; accountId: string; name: string }
  | { status: 'failed'; error: unknown };

/**
 * The redirect back from DigitalOcean (P9). The state must be the one this tab sent (anti-forgery) and is spent
 * here; the code goes to compute (providerAccounts.connect) once, keyed by the state, so a retry replays the same
 * account instead of spending the code twice. The code is removed from the address bar first.
 */
export default function ConnectCallbackPage() {
  const { api, tenantId } = useConsole();
  const [outcome, setOutcome] = useState<Outcome>({ status: 'working' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, '', window.location.pathname);
    let pending: PendingConnect | undefined;
    try {
      pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null') ?? undefined;
    } catch {
      pending = undefined;
    }
    sessionStorage.removeItem(pendingKey);
    const fail = (message: string) => setOutcome({ status: 'failed', error: new Error(message) });
    if (params.get('error')) return fail(`DigitalOcean answered ${params.get('error')}`);
    const code = params.get('code');
    const state = params.get('state');
    if (!pending || !state || state !== pending.state)
      return fail('This sign-in was not started from this tab: start again');
    if (Date.now() - pending.startedAt > pendingTtlMs)
      return fail('The sign-in expired: start again');
    if (!code) return fail('DigitalOcean sent no authorization code');
    void api
      .$request<{ id: string; name: string }>('providerAccounts/connect', {
        tenantId,
        provider: pending.provider,
        name: pending.name,
        code,
        redirectUri: pending.redirectUri,
        config: { regions: pending.regions },
        idempotencyKey: `connect:${state.slice(0, 120)}`,
      })
      .then(
        (account) => setOutcome({ status: 'connected', accountId: account.id, name: account.name }),
        (error: unknown) => setOutcome({ status: 'failed', error }),
      );
  }, [api, tenantId]);

  return (
    <>
      <h2>Connect a DigitalOcean account</h2>
      <section className="panel">
        {outcome.status === 'working' && <p className="muted">Connecting…</p>}
        {outcome.status === 'connected' && (
          <p>
            Connected {outcome.name} ({outcome.accountId}).{' '}
            <Link href="/provider-accounts">Check it on the provider accounts page.</Link>
          </p>
        )}
        {outcome.status === 'failed' && (
          <>
            <ErrorLine error={outcome.error} />
            <Link href="/provider-accounts/connect">Start again</Link>
          </>
        )}
      </section>
    </>
  );
}
