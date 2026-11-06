import type { AttentionItem, Severity } from '@/lib/data/platform';

// The provider accounts' entries in the operator's attention queue (DigitalOcean P9), from what the live poller
// last read: billing leaks (billing.leaks: hours a provider billed that compute did not meter) and each
// account's findings (providerAccounts.findings: DigitalOcean's security scan). Pure in (parts, now): nothing is
// opened in the future, so time travel works. The simulation has no provider accounts, so it has no items.

/** A provider account as `providerAccounts/list` answers it (config is the provider's, never a secret value). */
export interface ProviderAccountRow {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  version?: number;
}

/** One raised leak, as `billing/leaks` answers it. */
export interface LeakRow {
  accountId: string;
  accountName: string;
  provider: string;
  instanceId: string;
  tenantId: string | null;
  day: string;
  providerHours: number;
  meteredHours: number;
  raisedAt: number;
}

/** One finding, as `providerAccounts/findings` answers it. */
export interface FindingRow {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  detail?: string;
  at?: number;
  group?: string;
}

/** The provider module's live answer. */
export interface ProviderParts {
  accounts: ProviderAccountRow[];
  /** Absent when billing.leaks could not be read (no billing module, or not root). */
  leaks?: LeakRow[];
  /** Per account id; an account whose provider reports no findings has none. */
  findings: Record<string, { readAt: number; items: FindingRow[] }>;
}

/** The provider accounts page; an account opens at its anchor. */
export const providersHref = '/providers';
export const accountHref = (accountId: string) => `${providersHref}#${encodeURIComponent(accountId)}`;

const hours = (value: number) => `${Math.round(value * 100) / 100} h`;

/** A leak's item: the provider billed hours compute did not meter, so the platform pays for them unbilled. */
export function leakItem(leak: LeakRow): AttentionItem {
  const gap = leak.providerHours - leak.meteredHours;
  return {
    id: `providers:leak:${leak.instanceId}:${leak.day}`,
    severity: 'warning',
    title: `Billed hours not metered on ${leak.accountName}`,
    detail: `${leak.provider} billed ${hours(leak.providerHours)} for ${leak.instanceId} from ${leak.day}; compute metered ${hours(leak.meteredHours)} (${hours(gap)} unbilled).`,
    source: 'providers',
    href: accountHref(leak.accountId),
    at: leak.raisedAt,
    subject: `provider-account/${leak.accountId}`,
    group: 'Billed hours not metered',
    action: { label: 'Open the account', href: accountHref(leak.accountId) },
  };
}

/** A finding's item, named after its account. */
export function findingItem(account: ProviderAccountRow, finding: FindingRow, readAt: number): AttentionItem {
  return {
    id: `providers:${account.id}:${finding.id}`,
    severity: finding.severity,
    title: `${finding.title} on ${account.name}`,
    detail: finding.detail ?? `Reported by ${account.provider}.`,
    source: 'providers',
    href: accountHref(account.id),
    at: finding.at ?? readAt,
    subject: `provider-account/${account.id}`,
    group: finding.group ?? finding.title,
    action: { label: 'Open the account', href: accountHref(account.id) },
  };
}

/** Every item at `now`: leaks and findings that exist by then, most severe first, then newest. */
export function providerAttention(parts: ProviderParts | undefined, now: number): AttentionItem[] {
  if (!parts) return [];
  const items: AttentionItem[] = [];
  for (const leak of parts.leaks ?? []) if (leak.raisedAt <= now) items.push(leakItem(leak));
  for (const account of parts.accounts) {
    const read = parts.findings[account.id];
    if (!read) continue;
    for (const finding of read.items) {
      const item = findingItem(account, finding, read.readAt);
      if (item.at <= now) items.push(item);
    }
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at);
}
