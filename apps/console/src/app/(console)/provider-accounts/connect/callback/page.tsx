'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine } from '@/components/ui';
import { connectRequestOf, pendingKey, type PendingConnect } from '../pending';

type Outcome =
  | { status: 'working' }
  | { status: 'connected'; accountId: string; name: string }
  | { status: 'failed'; error: unknown };

/**
 * The redirect back from DigitalOcean (P9). The state must be the one this tab sent (anti-forgery) and is spent
 * here; the code goes to compute (providerAccounts.connect) once, keyed by the state, so a retry replays the same
 * account instead of spending the code twice, for the tenant the flow was started for (not whichever tenant is
 * selected now). The code is removed from the address bar first.
 */
export default function ConnectCallbackPage() {
  const { api } = useConsole();
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
    const connect = connectRequestOf(pending, params, Date.now());
    if ('error' in connect)
      return setOutcome({ status: 'failed', error: new Error(connect.error) });
    void api
      .$request<{ id: string; name: string }>('providerAccounts/connect', connect.request)
      .then(
        (account) => setOutcome({ status: 'connected', accountId: account.id, name: account.name }),
        (error: unknown) => setOutcome({ status: 'failed', error }),
      );
  }, [api]);

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
