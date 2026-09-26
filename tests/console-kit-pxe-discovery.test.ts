import { describe, expect, it } from 'vitest';
import {
  createPxeDiscoveryView,
  normalizeMac,
  pxeCandidates,
  seenAgo,
  type ComputeRequester,
} from '@better-compute/console-kit';

// console-kit's PXE discovery view (metal.discovered, metal.confirmMac): the site's list, candidates first,
// and the operator's confirmation (a normalized MAC), after which the list reloads.

const NODE = 'node_01k5w0000000000000000000abc';

function requester() {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const api = {
    async $request(path: string, input: Record<string, unknown>) {
      calls.push({ path, input });
      if (path === 'metal/discovered')
        return {
          siteId: input.siteId,
          machines: [
            {
              mac: '52:54:00:00:00:01',
              count: 1,
              relays: [],
              agentNodeIds: ['node_agent'],
              nodeId: 'node_enrolled',
              lastSeen: '2026-09-26T10:00:00Z',
            },
            {
              mac: '52:54:00:00:00:02',
              count: 4,
              relays: [],
              agentNodeIds: ['node_agent'],
              lastSeen: '2026-09-26T10:05:00Z',
            },
            {
              mac: '52:54:00:00:00:03',
              count: 2,
              relays: ['10.0.0.1'],
              agentNodeIds: ['node_agent'],
              candidateFor: NODE,
              lastSeen: '2026-09-26T09:00:00Z',
            },
          ],
        };
      return { nodeId: input.nodeId, macs: [input.mac] };
    },
  } as unknown as ComputeRequester;
  return { api, calls };
}

describe('PXE discovery view', () => {
  it('lists a site, puts candidates first, confirms a normalized MAC and reloads', async () => {
    const { api, calls } = requester();
    const view = createPxeDiscoveryView(api, { tenantId: 'org_acme', siteId: 'site_a' });
    await view.refresh();
    const rows = pxeCandidates(view.get().value!.machines);
    expect(rows.map((row) => [row.kind, row.row.mac])).toEqual([
      ['candidate', '52:54:00:00:00:03'],
      ['unknown', '52:54:00:00:00:02'],
      ['enrolled', '52:54:00:00:00:01'],
    ]);
    await view.confirmMac(NODE, '52-54-00-00-00-03'.toUpperCase());
    await view.site('site_b');
    expect(calls).toEqual([
      { path: 'metal/discovered', input: { tenantId: 'org_acme', siteId: 'site_a' } },
      {
        path: 'metal/confirmMac',
        input: { tenantId: 'org_acme', nodeId: NODE, mac: '52:54:00:00:00:03' },
      },
      { path: 'metal/discovered', input: { tenantId: 'org_acme', siteId: 'site_a' } },
      { path: 'metal/discovered', input: { tenantId: 'org_acme', siteId: 'site_b' } },
    ]);
    await expect(view.confirmMac(NODE, 'not-a-mac')).rejects.toThrow(/MAC/);
    expect(calls).toHaveLength(4);
  });

  it('formats MACs and last-seen times', () => {
    expect(normalizeMac(' AA-BB-CC-DD-EE-FF ')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabbccddeeff')).toBeUndefined();
    const now = Date.parse('2026-09-26T10:00:00Z');
    expect(seenAgo('2026-09-26T09:59:30Z', now)).toBe('just now');
    expect(seenAgo('2026-09-26T09:45:00Z', now)).toBe('15 min ago');
    expect(seenAgo('2026-09-26T07:00:00Z', now)).toBe('3 h ago');
    expect(seenAgo(undefined, now)).toBe('never');
  });
});
