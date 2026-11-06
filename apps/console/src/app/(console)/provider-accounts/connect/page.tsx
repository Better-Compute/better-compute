'use client';

import { useState } from 'react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine } from '@/components/ui';
import { callbackUri, newState, pendingKey, type PendingConnect } from './pending';

/**
 * "Connect a DigitalOcean account" (P9): asks compute for DigitalOcean's authorization URL
 * (providerAccounts.connectSetup) with a fresh anti-forgery state kept in this tab, then sends the browser there.
 * DigitalOcean redirects back to the callback page with a code, which compute trades for the account's credential.
 */
export default function ConnectDigitalOceanPage() {
  const { api, tenantId } = useConsole();
  const [name, setName] = useState('do-main');
  const [regions, setRegions] = useState('nyc3');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const pending: PendingConnect = {
        state: newState(),
        provider: 'digitalocean',
        name: name.trim(),
        regions: regions
          .split(',')
          .map((region) => region.trim())
          .filter(Boolean),
        redirectUri: callbackUri(window.location.origin),
        startedAt: Date.now(),
      };
      const { authorizeUrl } = await api.$request<{ authorizeUrl: string }>(
        'providerAccounts/connectSetup',
        {
          tenantId,
          provider: pending.provider,
          redirectUri: pending.redirectUri,
          state: pending.state,
        },
      );
      // Only DigitalOcean's own authorization page.
      if (new URL(authorizeUrl).origin !== 'https://cloud.digitalocean.com')
        throw new Error('The authorization URL is not DigitalOcean’s');
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      window.location.assign(authorizeUrl);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Connect a DigitalOcean account</h2>
      <section className="panel">
        <p className="muted">
          You sign in at DigitalOcean and approve access for this platform. No token is copied: the
          platform keeps an OAuth refresh token, sealed, and rotates it on every use.
        </p>
        <label>
          Account name <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Regions (comma-separated){' '}
          <input value={regions} onChange={(event) => setRegions(event.target.value)} />
        </label>
        <button type="button" disabled={busy || !name.trim()} onClick={() => void start()}>
          {busy ? 'Opening DigitalOcean…' : 'Continue to DigitalOcean'}
        </button>
        <ErrorLine error={error} />
      </section>
    </>
  );
}
