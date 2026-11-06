import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// `provider-accounts check` and the DigitalOcean verbs (`digitalocean check|offers|discover`, alias `do …`, P9):
// bodies over a fetch stub. A DigitalOcean verb reads the account first and refuses one of another provider
// before calling anything else.

const PACCT = 'pacct_01k5w0000000000000000000cc';

async function run(argv: string[], provider = 'digitalocean') {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test'], {
      out() {},
      env: {
        BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij',
        BETTER_COMPUTE_TENANT: 'org_acme',
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname.replace('/api/compute/', '');
        calls.push({ path, body: JSON.parse(await request.text()) });
        return Response.json({ data: path === 'providerAccounts/get' ? { id: PACCT, provider } : {} });
      },
    });
    return { ok: true as const, calls };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code };
  }
}

const ref = { tenantId: 'org_acme', accountId: PACCT };

describe('provider account checks', () => {
  it('provider-accounts check calls providerAccounts.check', async () => {
    expect((await run(['provider-accounts', 'check', PACCT])).calls).toEqual([
      { path: 'providerAccounts/check', body: ref },
    ]);
    expect(await run(['provider-accounts', 'check', 'nope'])).toMatchObject({ ok: false, calls: [] });
  });

  it('digitalocean check, offers and discover read the account, then call the verb', async () => {
    expect((await run(['digitalocean', 'check', PACCT])).calls).toEqual([
      { path: 'providerAccounts/get', body: ref },
      { path: 'providerAccounts/check', body: ref },
    ]);
    expect((await run(['do', 'discover', PACCT])).calls).toEqual([
      { path: 'providerAccounts/get', body: ref },
      { path: 'providerAccounts/discover', body: ref },
    ]);
    expect((await run(['digitalocean', 'offers', PACCT, '--region', 'nyc3'])).calls).toEqual([
      { path: 'providerAccounts/get', body: ref },
      { path: 'providerAccounts/offers', body: { ...ref, query: { kind: 'vps', region: 'nyc3' } } },
    ]);
  });

  it('refuses an account of another provider after the read', async () => {
    const result = await run(['digitalocean', 'check', PACCT], 'hetzner');
    expect(result).toMatchObject({ ok: false });
    expect(result.calls.map((call) => call.path)).toEqual(['providerAccounts/get']);
  });
});
