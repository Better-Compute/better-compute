import { describe, expect, it } from 'vitest';
import {
  connectRequestOf,
  pendingTtlMs,
  type PendingConnect,
} from '../apps/console/src/app/(console)/provider-accounts/connect/pending.js';

// The console's "Connect a DigitalOcean account" callback (P9): the redirect back becomes providerAccounts.connect
// for the flow this tab started, and for the tenant it was started for, not whichever tenant is selected on return.

const pending: PendingConnect = {
  state: 'state-0123456789abcdef',
  tenantId: 'tenant-started',
  provider: 'digitalocean',
  name: 'do-main',
  regions: ['nyc3'],
  redirectUri: 'https://console.example.test/provider-accounts/connect/callback',
  startedAt: 1_000,
};
const back = (query: string) => new URLSearchParams(query);

describe('connectRequestOf', () => {
  it('connects the account to the tenant the flow was started for', () => {
    expect(connectRequestOf(pending, back('code=c1&state=state-0123456789abcdef'), 2_000)).toEqual({
      request: {
        tenantId: 'tenant-started',
        provider: 'digitalocean',
        name: 'do-main',
        code: 'c1',
        redirectUri: pending.redirectUri,
        config: { regions: ['nyc3'] },
        idempotencyKey: 'connect:state-0123456789abcdef',
      },
    });
  });

  it('refuses a forged or stale redirect, and a flow that does not name its tenant', () => {
    const refused = (p: PendingConnect | undefined, query: string, now = 2_000) =>
      'error' in connectRequestOf(p, back(query), now);
    expect(refused(pending, 'code=c1&state=other')).toBe(true);
    expect(refused(undefined, 'code=c1&state=state-0123456789abcdef')).toBe(true);
    expect(refused(pending, 'code=c1&state=state-0123456789abcdef', 1_000 + pendingTtlMs + 1)).toBe(
      true,
    );
    expect(refused(pending, 'state=state-0123456789abcdef')).toBe(true);
    expect(refused(pending, 'error=access_denied&state=state-0123456789abcdef')).toBe(true);
    const { tenantId: _dropped, ...older } = pending;
    expect(refused(older as PendingConnect, 'code=c1&state=state-0123456789abcdef')).toBe(true);
  });
});
