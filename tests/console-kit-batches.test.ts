import { describe, expect, it } from 'vitest';
import {
  batchApproveCommand,
  createBatchesView,
  describeSubject,
  scopeByKind,
  type ComputeRequester,
} from '@better-compute/console-kit';

// The console's destructive-batch view (PLAN.md §13): pending batches by default, the full scope paged from
// commandBatches.scope for review, and cancel; approving is the approver's CLI (no key in a browser).

const BATCH = 'batch_01k5w00000000000000000000q';

function requester(pages: { items: { leafIndex: number; subject: string; kind: string }[]; next?: number }[]) {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  let page = 0;
  const api = {
    async $request(path: string, input: Record<string, unknown>) {
      calls.push({ path, input });
      if (path === 'commandBatches/list') return { items: [{ batchId: BATCH, state: 'pending' }] };
      if (path === 'commandBatches/scope') return pages[page++] ?? { items: [] };
      if (path === 'commandBatches/members') return { items: [{ commandId: 'cmd_1', nodeId: 'node_a', subject: 'node_a', kind: 'disk.wipe', state: 'pending', awaitingApproval: true }] };
      return { batchId: BATCH, state: path === 'commandBatches/cancel' ? 'cancelled' : 'pending' };
    },
  } as unknown as ComputeRequester;
  return { api, calls };
}

describe('batches view', () => {
  it('lists pending batches, filters, pages the whole scope and cancels', async () => {
    const { api, calls } = requester([
      { items: [{ leafIndex: 0, subject: 'node_b', kind: 'disk.wipe' }, { leafIndex: 1, subject: 'node_a', kind: 'disk.wipe' }], next: 2 },
      { items: [{ leafIndex: 2, subject: 'bmc:node_site/10.0.0.7', kind: 'bmc.power' }] },
    ]);
    const view = createBatchesView(api, { tenantId: 'org_acme' });
    await view.refresh();
    expect(view.get().value?.items).toHaveLength(1);
    await view.filter('all');
    const scope = await view.scope(BATCH);
    expect(scope).toMatchObject({ truncated: false });
    expect(scopeByKind(scope.items)).toEqual([
      { kind: 'disk.wipe', subjects: ['node_a', 'node_b'], unbound: 0 },
      { kind: 'bmc.power', subjects: ['bmc:node_site/10.0.0.7'], unbound: 0 },
    ]);
    expect(scopeByKind([{ leafIndex: 0, subject: 'node_a', kind: 'disk.wipe', payloadSha256: '' }])[0]).toMatchObject({ unbound: 1 });
    const members = await view.members(BATCH, { state: 'pending' });
    expect(members.items[0]).toMatchObject({ commandId: 'cmd_1', awaitingApproval: true });
    await view.cancel(BATCH);
    expect(calls.map((call) => [call.path, call.input])).toEqual([
      ['commandBatches/list', { tenantId: 'org_acme', state: 'pending', limit: 100 }],
      ['commandBatches/list', { tenantId: 'org_acme', limit: 100 }],
      ['commandBatches/scope', { tenantId: 'org_acme', batchId: BATCH, limit: 5_000 }],
      ['commandBatches/scope', { tenantId: 'org_acme', batchId: BATCH, limit: 5_000, cursor: 2 }],
      ['commandBatches/members', { tenantId: 'org_acme', batchId: BATCH, limit: 100, state: 'pending' }],
      ['commandBatches/cancel', { tenantId: 'org_acme', batchId: BATCH }],
      ['commandBatches/list', { tenantId: 'org_acme', limit: 100 }],
    ]);
  });

  it('stops paging on a page that does not advance', async () => {
    const { api, calls } = requester([
      { items: [{ leafIndex: 0, subject: 'node_a', kind: 'disk.wipe' }], next: 1 },
      { items: [{ leafIndex: 1, subject: 'node_b', kind: 'disk.wipe' }], next: 1 },
      { items: [{ leafIndex: 1, subject: 'node_b', kind: 'disk.wipe' }], next: 1 },
    ]);
    const scope = await createBatchesView(api, { tenantId: 'org_acme' }).scope(BATCH);
    expect(scope.items).toHaveLength(2);
    // Never shown as complete.
    expect(scope.truncated).toBe(true);
    expect(calls.filter((call) => call.path === 'commandBatches/scope')).toHaveLength(2);
  });

  it('reads subjects the way a person names them, and gives the approver command', () => {
    expect(describeSubject('node_a')).toBe('node_a');
    expect(describeSubject('bmc:node_site/10.0.0.7')).toBe('BMC 10.0.0.7 (via node_site)');
    expect(describeSubject('node:node_b')).toBe('HTTP to node_b');
    expect(batchApproveCommand(BATCH)).toBe(`better-compute batch approve --batch ${BATCH} --key <approver key>`);
    expect(batchApproveCommand(BATCH, 'org_acme')).toBe(
      `better-compute batch approve --tenant org_acme --batch ${BATCH} --key <approver key>`,
    );
  });
});
