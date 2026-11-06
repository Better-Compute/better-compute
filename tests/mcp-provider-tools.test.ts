import { describe, expect, it } from 'vitest';
import { createComputeMcp, gateTools, type ComputeApi } from '@better-compute/mcp';

// The provider-account MCP tools (P9): opt-in, read-only, one compute call each as the caller. A check names one
// account, and the gate checks `compute:providers:read` on it; a malformed id never reaches compute.

const PACCT = 'pacct_01k5w0000000000000000000cc';

function recorder() {
  const calls: { path: string; input: unknown }[] = [];
  const api: ComputeApi = {
    async $request<Output>(path: string, input?: unknown) {
      calls.push({ path, input });
      return { ok: true, missing: [] } as Output;
    },
  };
  return { api, calls };
}

const mcpWith = (api: ComputeApi, providers?: boolean) =>
  createComputeMcp({
    client: api,
    tenantId: 'org_acme',
    newKey: () => 'key',
    ...(providers !== undefined ? { providers } : {}),
  });

async function call(mcp: ReturnType<typeof createComputeMcp>, name: string, args: unknown) {
  const response = await mcp.handler(
    new Request('https://mcp.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  return (await response.json()).result;
}

describe('provider account tools', () => {
  it('are built only when asked for, and are read-only', () => {
    const { api } = recorder();
    expect(mcpWith(api).tools.map((tool) => tool.name)).not.toContain('check_provider_account');
    expect(mcpWith(api).tools.map((tool) => tool.name)).not.toContain('list_billing_leaks');
    const names = [
      'list_provider_accounts',
      'check_provider_account',
      'provider_account_findings',
      'list_billing_leaks',
    ];
    const tools = mcpWith(api, true).tools.filter((tool) => names.includes(tool.name));
    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it('list and check call compute as the tenant; a malformed id is refused before compute', async () => {
    const { api, calls } = recorder();
    const mcp = mcpWith(api, true);
    await call(mcp, 'list_provider_accounts', {});
    const checked = await call(mcp, 'check_provider_account', { accountId: PACCT });
    expect(checked.structuredContent).toEqual({ ok: true, missing: [] });
    expect(calls).toEqual([
      { path: 'providerAccounts/list', input: { tenantId: 'org_acme' } },
      { path: 'providerAccounts/check', input: { tenantId: 'org_acme', accountId: PACCT } },
    ]);
    const refused = await call(mcp, 'check_provider_account', { accountId: 'pool_x' });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('findings name one account; leaks read the platform billing over the days asked', async () => {
    const { api, calls } = recorder();
    const mcp = mcpWith(api, true);
    await call(mcp, 'provider_account_findings', { accountId: PACCT });
    await call(mcp, 'list_billing_leaks', { days: 7 });
    expect(calls[0]).toEqual({
      path: 'providerAccounts/findings',
      input: { tenantId: 'org_acme', accountId: PACCT },
    });
    const leaks = calls[1]!;
    expect(leaks.path).toBe('billing/leaks');
    const { from, to } = leaks.input as { from: number; to: number };
    expect(to - from).toBe(8 * 86_400_000);
    expect(to).toBeGreaterThan(Date.now());
    expect((await call(mcp, 'list_billing_leaks', { days: 0 })).isError).toBe(true);
    expect((await call(mcp, 'provider_account_findings', { accountId: 'x' })).isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('the gate checks providers:read on the account a check names', () => {
    expect(gateTools().check_provider_account).toBeUndefined();
    const rules = gateTools({ providers: true });
    expect(rules.list_provider_accounts).toEqual({ public: true });
    const rule = rules.check_provider_account as {
      action: string;
      resource(args: object): unknown;
    };
    expect(rule.action).toBe('compute:providers:read');
    expect(rule.resource({ accountId: PACCT })).toEqual({
      type: 'compute-provider-account',
      id: PACCT,
    });
    expect(() => rule.resource({ accountId: '../x' })).toThrow();
    expect(rules.provider_account_findings).toBe(rule);
    const leaks = rules.list_billing_leaks as { action: string; resource(args: object): unknown };
    expect(leaks.action).toBe('compute:billing:read');
    expect(leaks.resource({})).toEqual({ type: 'compute-fleet', id: 'global' });
  });
});
