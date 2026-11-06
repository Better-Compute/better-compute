import { describe, expect, it } from 'vitest';
import { modules, navForPath } from '@/lib/modules';
import { accountHref, providerAttention, type ProviderParts } from '@/components/providers/attention';
import { providersModule } from '@/components/providers/module';

// The provider accounts module (DigitalOcean P9): billing leaks and provider findings as attention items, from the
// live poller's answer. Pure in (parts, now).

const account = { id: 'pacct_1', tenantId: 'ten_root', provider: 'digitalocean', name: 'do-main' };

const parts: ProviderParts = {
  accounts: [account, { id: 'pacct_2', tenantId: 'ten_root', provider: 'test', name: 'other' }],
  leaks: [
    {
      accountId: 'pacct_1',
      accountName: 'do-main',
      provider: 'digitalocean',
      instanceId: 'ins_1',
      tenantId: 'ten_acme',
      day: '2026-10-01',
      providerHours: 48,
      meteredHours: 6,
      raisedAt: 2_000,
    },
  ],
  findings: {
    pacct_1: {
      readAt: 1_500,
      items: [
        { id: 'security:rule-ssh', kind: 'security', severity: 'warning', title: 'SSH open to the internet', detail: '3 resources affected.', at: 1_000, group: 'SSH open to the internet' },
        { id: 'security:root', kind: 'security', severity: 'critical', title: 'Root login allowed' },
        { id: 'security:later', kind: 'security', severity: 'info', title: 'Found later', at: 9_000 },
      ],
    },
  },
};

describe('provider attention', () => {
  it('turns leaks and findings into items, most severe first, none from the future', () => {
    const items = providerAttention(parts, 5_000);
    expect(items.map((item) => item.id)).toEqual([
      'providers:pacct_1:security:root',
      'providers:leak:ins_1:2026-10-01',
      'providers:pacct_1:security:rule-ssh',
    ]);
    expect(items[0]).toMatchObject({
      severity: 'critical',
      title: 'Root login allowed on do-main',
      detail: 'Reported by digitalocean.',
      // a finding without a time takes the read's
      at: 1_500,
      source: 'providers',
      href: accountHref('pacct_1'),
      subject: 'provider-account/pacct_1',
      group: 'Root login allowed',
    });
    expect(items[1]).toMatchObject({
      severity: 'warning',
      title: 'Billed hours not metered on do-main',
      detail: 'digitalocean billed 48 h for ins_1 from 2026-10-01; compute metered 6 h (42 h unbilled).',
      at: 2_000,
      group: 'Billed hours not metered',
    });
    expect(providerAttention(parts, 1_200).map((item) => item.id)).toEqual(['providers:pacct_1:security:rule-ssh']);
    expect(providerAttention(parts, 10_000)).toHaveLength(4);
  });

  it('has nothing before the poller answered, nor without leaks or findings', () => {
    expect(providerAttention(undefined, 5_000)).toEqual([]);
    expect(providerAttention({ accounts: [account], findings: {} }, 5_000)).toEqual([]);
  });

  it('is installed, live only, under Operations', () => {
    expect(modules).toContain(providersModule);
    expect(navForPath('/providers')?.label).toBe('Provider accounts');
    expect(providersModule.attention!(5_000, {}, { source: 'simulated' })).toEqual([]);
    // live, before the poller has answered
    expect(providersModule.attention!(5_000, {}, { source: 'live' })).toEqual([]);
  });
});
