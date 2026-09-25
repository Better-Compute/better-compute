import { describe, expect, it } from 'vitest';
import {
  createSandboxesView,
  sandboxExecCommand,
  timeLeft,
  type ComputeRequester,
} from '@better-compute/console-kit';

// console-kit's sandboxes view (PLAN.md §3.7): the list by scope, templates, and the actions, each one call to
// the vps module's sandboxes group (recorded here), with a reload after every change; and the TTL countdown.

const SBX = 'sbx_01k5w0000000000000000000abc';

function requester() {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const api = {
    async $request(path: string, input: Record<string, unknown>) {
      calls.push({ path, input });
      if (path === 'sandboxes/list') return { items: [{ id: SBX, expiresAt: Date.now() + 60_000 }] };
      if (path === 'sandboxTemplates/list') return { items: [{ id: 'sbxt_1', warm: { min: 2, max: 4 } }] };
      return { id: SBX };
    },
  } as unknown as ComputeRequester;
  return { api, calls };
}

describe('sandboxes view', () => {
  it('lists by scope and runs each action, reloading the list after changes', async () => {
    const { api, calls } = requester();
    const view = createSandboxesView(api, { tenantId: 'org_acme' });
    await view.refresh();
    expect(view.get().value?.items[0]?.id).toBe(SBX);
    await view.scope('all');
    expect(await view.templates()).toMatchObject([{ warm: { min: 2, max: 4 } }]);
    await view.detail(SBX);
    await view.create({ templateId: 'sbxt_1', ttlSeconds: 900 });
    await view.extend(SBX, 30 * 60_000);
    await view.snapshot(SBX, { keep: true });
    await view.remove(SBX);
    const shape = calls.map(({ path, input }) => {
      const { idempotencyKey, ...rest } = input;
      return { path, input: rest, keyed: typeof idempotencyKey === 'string' && idempotencyKey.startsWith('console-') };
    });
    expect(shape).toEqual([
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'mine' }, keyed: false },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'all' }, keyed: false },
      { path: 'sandboxTemplates/list', input: { tenantId: 'org_acme' }, keyed: false },
      { path: 'sandboxes/get', input: { tenantId: 'org_acme', sandboxId: SBX }, keyed: false },
      {
        path: 'sandboxes/create',
        input: { tenantId: 'org_acme', templateId: 'sbxt_1', ttlSeconds: 900, wait: { timeoutMs: 20_000 } },
        keyed: true,
      },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'all' }, keyed: false },
      { path: 'sandboxes/extend', input: { tenantId: 'org_acme', sandboxId: SBX, by: 1_800_000 }, keyed: false },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'all' }, keyed: false },
      {
        path: 'sandboxes/snapshot',
        input: { tenantId: 'org_acme', sandboxId: SBX, includeMemory: true, keep: true },
        keyed: true,
      },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'all' }, keyed: false },
      { path: 'sandboxes/delete', input: { tenantId: 'org_acme', sandboxId: SBX }, keyed: false },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', scope: 'all' }, keyed: false },
    ]);
    expect(sandboxExecCommand(SBX)).toBe(`better-compute sandbox exec ${SBX}`);
  });

  it('counts down to the expiry', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    expect(timeLeft(now + 12 * 60_000 + 3_000, now)).toEqual({ ms: 723_000, text: '12m 03s', urgent: false });
    expect(timeLeft(now + 65 * 60_000, now)).toMatchObject({ text: '1h 05m', urgent: false });
    expect(timeLeft(now + 4 * 60_000, now)).toMatchObject({ text: '4m 00s', urgent: true });
    expect(timeLeft(now - 1, now)).toEqual({ ms: 0, text: 'expired', urgent: true });
  });
});
