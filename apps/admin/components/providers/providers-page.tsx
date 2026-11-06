'use client';

import { useState } from 'react';
import { RiCloudLine, RiMoneyDollarCircleLine, RiRefreshLine, RiShieldCheckLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { useConnection } from '@/components/shell/connection';
import { useNow } from '@/components/shell/workspace';
import { Meter } from '@/components/ui/charts';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import { api, ApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/data/format';
import { findingItem, leakItem, rateGauge, type ProviderAccountRow, type RateLimitRow } from './attention';
import { refreshProviders } from './live';
import { useProviders } from './use-providers';

// Provider accounts (DigitalOcean P9): every account the operator's tenant can see, what its credential may do
// (providerAccounts.check, on demand: a read at the provider), what the provider says needs an operator
// (providerAccounts.findings) and the hours providers billed that compute did not meter (billing.leaks). A check
// also gauges the credential's request rate limit at the provider (every replica and process using the token counts
// against it); DigitalOcean's client holds back sweeps and polls once half of it is spent, hence the 50% mark.
// Live only: the simulation has no provider accounts.

/** What `providerAccounts/check` answers. */
interface AccountCheck {
  ok: boolean;
  missing: string[];
  optional?: string[];
  checkedAt: number;
  /** The credential's request rate limit, as the provider's answers to the check counted it. */
  rateLimit?: RateLimitRow;
}

type CheckState = { running: true } | { running: false; result?: AccountCheck; error?: ApiError };

export function ProvidersPage() {
  const { live, state } = useProviders();
  const now = useNow(10_000);
  const writable = useConnection().status?.writable === true;
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const parts = state.parts;

  async function check(account: ProviderAccountRow) {
    setChecks((all) => ({ ...all, [account.id]: { running: true } }));
    try {
      const result = await api.$request<AccountCheck>('providerAccounts/check', { tenantId: account.tenantId, accountId: account.id });
      setChecks((all) => ({ ...all, [account.id]: { running: false, result } }));
    } catch (error) {
      setChecks((all) => ({
        ...all,
        [account.id]: { running: false, error: error instanceof ApiError ? error : new ApiError('NETWORK', String(error), 0) },
      }));
    }
  }

  const header = (
    <PageHeader
      title="Provider accounts"
      icon={RiCloudLine}
      description="Cloud accounts compute provisions on: what each credential may do, what the provider reports, and billed hours compute did not meter."
      actions={
        live ? (
          <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} onClick={() => void refreshProviders({ findings: 'all' })} disabled={state.loading}>
            Refresh
          </Button>
        ) : undefined
      }
    />
  );
  if (!live)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState icon={RiCloudLine} title="Live data only">
          Provider accounts are read from the compute API. Connect one in Settings → Connection and switch the workspace to live.
        </EmptyState>
      </div>
    );

  const failed = Object.entries(state.errors);
  const leaks = parts?.leaks;
  const findings = (parts?.accounts ?? []).flatMap((account) =>
    (parts?.findings[account.id]?.items ?? []).map((finding) => findingItem(account, finding, parts!.findings[account.id]!.readAt)),
  );
  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-separator-border bg-surface-sunken px-3 py-1.5 font-mono text-[11px] text-text-secondary">
        <Led status={failed.some(([part]) => part === 'accounts') ? 'crit' : state.loading ? 'pending' : 'live'} />
        <span>live API{state.fetchedAt ? ` · updated ${fmtRelative(state.fetchedAt, now)}` : state.loading ? ' · loading…' : ''}</span>
        {failed.map(([part, error]) => (
          <span key={part} className="text-text-tertiary" title={error.message}>
            {part}: {error.code}
          </span>
        ))}
      </div>

      <Panel title="Accounts" meta={parts ? `${parts.accounts.length}` : undefined} flush>
        {!parts || parts.accounts.length === 0 ? (
          <EmptyState icon={RiCloudLine} title={parts ? 'No provider accounts' : 'Loading…'}>
            Create one with <Mono dim>better-compute provider-accounts create</Mono>, or connect a DigitalOcean account from the console.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-separator-border">
            {parts.accounts.map((account) => {
              const checked = checks[account.id];
              const result = checked && !checked.running ? checked.result : undefined;
              const error = checked && !checked.running ? checked.error : undefined;
              const count = parts.findings[account.id]?.items.length ?? 0;
              return (
                <li key={account.id} id={account.id} className="grid grid-cols-[1fr_auto] items-start gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] text-text-primary">{account.name}</span>
                    <span className="block font-mono text-[11px] text-text-tertiary">
                      {account.provider} · {account.id} · tenant {account.tenantId}
                      {count ? ` · ${count} finding${count === 1 ? '' : 's'}` : ''}
                    </span>
                    {result && (
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <Tag status={result.ok ? 'ok' : 'crit'}>{result.ok ? 'usable' : 'not usable'}</Tag>
                        {result.missing.length > 0 && <span className="font-mono text-[11px] text-text-error-primary">missing {result.missing.join(', ')}</span>}
                        {(result.optional ?? []).length > 0 && (
                          <span className="font-mono text-[11px] text-text-secondary" title="Only optional features (costs, metrics, security findings) need these">
                            optional {result.optional!.join(', ')}
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-text-tertiary">checked {fmtRelative(result.checkedAt, now)}</span>
                      </span>
                    )}
                    {result &&
                      (() => {
                        const gauge = rateGauge(result, now);
                        return gauge ? (
                          <Meter
                            className="mt-1.5 max-w-xs"
                            compact
                            value={gauge.used}
                            max={gauge.limit}
                            warnAt={0.5}
                            label="API requests this hour"
                            detail={gauge.detail}
                          />
                        ) : null;
                      })()}
                    {error && (
                      <span className="mt-1 block font-mono text-[11px] text-text-error-primary">
                        {error.code}: {error.message}
                      </span>
                    )}
                  </span>
                  <Button
                    size="small"
                    variant="secondary"
                    leadingIcon={RiShieldCheckLine}
                    onClick={() => void check(account)}
                    disabled={!writable || (checked?.running ?? false)}
                    title={writable ? 'Ask the provider what this credential may do (read-only)' : 'Sign in to check an account'}
                  >
                    {checked?.running ? 'Checking…' : 'Check'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Findings" icon={RiShieldCheckLine} meta={`${findings.length}`} flush>
        {findings.length === 0 ? (
          <EmptyState icon={RiShieldCheckLine} title="Nothing reported">
            No provider reports a finding on these accounts. A DigitalOcean token without security:read says so here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-separator-border">
            {findings.map((item) => (
              <li key={item.id} className="grid grid-cols-[20px_1fr_auto] items-start gap-3 px-3 py-2.5">
                <SeverityIcon severity={item.severity} />
                <span className="min-w-0">
                  <span className="block text-[13px] text-text-primary">{item.title}</span>
                  <span className="block text-caption-1-regular text-text-secondary">{item.detail}</span>
                </span>
                <span className="font-mono text-[11px] text-text-tertiary">{fmtRelative(item.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Billing leaks" icon={RiMoneyDollarCircleLine} meta={leaks ? `${leaks.length} · last 35 days` : undefined} flush>
        {!leaks ? (
          <EmptyState icon={RiMoneyDollarCircleLine} title="Not readable">
            billing.leaks needs billing:read on the fleet (root) and provider costs turned on.
          </EmptyState>
        ) : leaks.length === 0 ? (
          <EmptyState icon={RiMoneyDollarCircleLine} title="No leaks">
            Every billed compute hour of the platform&apos;s accounts was metered.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-separator-border">
            {leaks.map((leak) => {
              const item = leakItem(leak);
              return (
                <li key={item.id} className="grid grid-cols-[1fr_auto] items-start gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-text-primary">{item.title}</span>
                    <span className="block font-mono text-[11px] text-text-secondary">{item.detail}</span>
                  </span>
                  <span className="font-mono text-[11px] text-text-tertiary">{fmtRelative(leak.raisedAt, now)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
