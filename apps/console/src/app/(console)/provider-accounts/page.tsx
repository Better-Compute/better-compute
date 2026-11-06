'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine } from '@/components/ui';

interface AccountRow {
  id: string;
  provider: string;
  name: string;
  config?: Record<string, unknown>;
}

interface CheckResult {
  ok: boolean;
  missing: string[];
  optional?: string[];
  checkedAt: number;
}

/**
 * The organization's provider accounts (P9), each with a read-only check of what its credential may do
 * (providerAccounts.check): ok, the permissions instances need that it lacks, and the ones only optional features
 * (costs, metrics, security findings) need. Credentials show as secret references only.
 */
export default function ProviderAccountsPage() {
  const { api, tenantId } = useConsole();
  const [accounts, setAccounts] = useState<AccountRow[]>();
  const [error, setError] = useState<unknown>();
  const [checks, setChecks] = useState<Record<string, CheckResult | { error: unknown }>>({});
  const [busy, setBusy] = useState<string>();

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const page = await api.$request<{ items: AccountRow[] }>('providerAccounts/list', {
        tenantId,
      });
      setAccounts(page.items);
    } catch (failure) {
      setError(failure);
    }
  }, [api, tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async (accountId: string) => {
    setBusy(accountId);
    try {
      const result = await api.$request<CheckResult>('providerAccounts/check', {
        tenantId,
        accountId,
      });
      setChecks((current) => ({ ...current, [accountId]: result }));
    } catch (failure) {
      setChecks((current) => ({ ...current, [accountId]: { error: failure } }));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <h2>Provider accounts</h2>
      <p>
        <Link href="/provider-accounts/connect">Connect a DigitalOcean account</Link>
      </p>
      <section className="panel">
        <ErrorLine error={error} />
        {!accounts && !error && <p className="muted">Loading…</p>}
        {accounts && accounts.length === 0 && (
          <p className="muted">This organization has no provider accounts.</p>
        )}
        {accounts && accounts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Provider</th>
                <th>Credential</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const result = checks[account.id];
                const oauth = typeof account.config?.refreshToken === 'string';
                return (
                  <tr key={account.id}>
                    <td>
                      {account.name}
                      <div className="muted">{account.id}</div>
                    </td>
                    <td>{account.provider}</td>
                    <td>{oauth ? 'OAuth (connected)' : 'token reference'}</td>
                    <td>
                      <button
                        type="button"
                        disabled={busy === account.id}
                        onClick={() => void check(account.id)}
                      >
                        {busy === account.id ? 'Checking…' : 'Check'}
                      </button>
                      {result && 'error' in result && <ErrorLine error={result.error} />}
                      {result && !('error' in result) && (
                        <div className={result.ok ? 'muted' : 'warning'}>
                          {result.ok ? 'ok' : 'cannot create instances'}
                          {result.missing.length > 0 && ` · missing ${result.missing.join(', ')}`}
                          {result.optional && result.optional.length > 0
                            ? ` · optional features lack ${result.optional.join(', ')}`
                            : ''}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
