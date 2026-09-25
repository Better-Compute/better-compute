import { afterEach, describe, expect, it } from 'vitest';
import type { IamPlugin } from '@better-iam/core';
import { createComputeIamBridge, memoryInbox, type InboxEvent } from '@better-compute/iam';
import { createMetrics, standardMetrics } from '@better-compute/observability';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// PLAN.md §15 v0.1 sim scenario "the compute inbox down": better-iam's audit dispatch keeps reaching its other
// subscribers while compute's inbox fails or hangs; compute's events spill (iam_inbox_spill_total and the
// pending spill rise) instead of blocking or failing IAM, and reach the inbox exactly once when it is back.

afterEach(closeIamFixtures);

describe('the compute inbox down', () => {
  it('IAM keeps dispatching to other subscribers; compute spills, then catches up once', async () => {
    const stored = memoryInbox();
    let mode: 'up' | 'down' | 'hang' = 'up';
    const inbox = {
      async put(events: InboxEvent[]) {
        if (mode === 'down') throw new Error('compute database unreachable');
        if (mode === 'hang') await new Promise(() => {});
        await stored.put(events);
      },
    };
    const registry = createMetrics();
    const metrics = standardMetrics(registry);
    const bridge = createComputeIamBridge();
    const plugin = bridge.plugin({
      inbox,
      timeoutMs: 50,
      onSpill: () => metrics.iamInboxSpill.inc(),
    });
    // Another subscriber on the same IAM host (a SIEM export, the console's own hooks).
    const mirrored: string[] = [];
    const mirror: IamPlugin = {
      id: 'audit-mirror',
      async afterAudit(event) {
        mirrored.push(`${event.action}:${event.resourceId ?? ''}`);
      },
    };
    const f = await iamFixture({
      plugins: [plugin, mirror],
      resolveResource: bridge.resolveResource(),
    });

    // Events compute reacts to: agent suspensions.
    const agents = [];
    for (let i = 0; i < 6; i++)
      agents.push(
        await f.iam.api.agents.create(f.ownerCredential, {
          tenantId: f.tenantId,
          name: `Agent ${i}`,
          model: 'claude-sonnet-5',
        }),
      );
    const suspend = (index: number) =>
      f.iam.api.agents.suspend(f.ownerCredential, {
        tenantId: f.tenantId,
        agentId: agents[index]!.id,
      });
    await f.iam.events.dispatch();
    mirrored.length = 0;
    stored.clear();

    // Down: writes fail at once. Then hanging: writes time out after 50 ms each.
    mode = 'down';
    await suspend(0);
    await suspend(1);
    await f.iam.events.dispatch();
    mode = 'hang';
    await suspend(2);
    await suspend(3);
    const started = Date.now();
    await f.iam.events.dispatch();
    expect(Date.now() - started).toBeLessThan(2_000);

    // Every subscriber else got every event; compute got none, and says so.
    const suspended = (ids: string[]) => ids.map((id) => `agent:suspend:${id}`);
    expect(mirrored.filter((line) => line.startsWith('agent:suspend'))).toEqual(
      suspended(agents.slice(0, 4).map((agent) => agent.id)),
    );
    expect(stored.events).toHaveLength(0);
    expect(plugin.stats()).toMatchObject({ pending: 4, dropped: 0 });
    expect(plugin.stats().spilled).toBeGreaterThanOrEqual(4);
    expect(registry.value('iam_inbox_spill_total')).toBeGreaterThanOrEqual(4);

    // Back up: the next event is written, and the spill after it, each event exactly once.
    mode = 'up';
    await suspend(4);
    await f.iam.events.dispatch();
    await plugin.flush();
    expect(plugin.stats().pending).toBe(0);
    const actions = stored.events
      .filter((event) => event.action === 'agent:suspend')
      .map((event) => (event.body as { resourceId?: string }).resourceId);
    expect([...actions].sort()).toEqual(
      agents
        .slice(0, 5)
        .map((agent) => agent.id)
        .sort(),
    );
    expect(new Set(stored.events.map((event) => event.eventId)).size).toBe(stored.events.length);
  }, 60_000);
});
