import { afterEach, describe, expect, it } from 'vitest';
import { daemonNodeConditions, xidStatusHandler } from '@better-compute/gateway';
import { ConditionStatus } from '@better-compute/protocol';
import { agentFrame, gatewayFixture, type GatewayFixture } from './support/gateway.js';

// AWS A6: bcd on a spot EC2 instance reports the spot instance-action as the node condition
// SpotInterruption (reason "<action>:<deadline>"); the gateway makes the node NoSchedule while it stands.

let f: GatewayFixture;
afterEach(() => f?.close());

const status = (generation: number, interruption?: string) =>
  agentFrame({
    case: 'status',
    value: {
      observedGeneration: BigInt(generation),
      appliedGeneration: BigInt(generation),
      conditions: interruption
        ? [
            {
              type: 'SpotInterruption',
              status: ConditionStatus.TRUE,
              reason: interruption,
              message: 'the cloud will terminate this instance at 2026-11-05T10:02:00Z',
            },
          ]
        : [],
    },
  });

describe('SpotInterruption', () => {
  it('is a NoSchedule daemon condition', () => {
    expect(daemonNodeConditions.SpotInterruption).toEqual({ noSchedule: true });
  });

  it('makes the node NoSchedule with the deadline while the notice stands, and clears with it', async () => {
    f = await gatewayFixture({ reports: { status: xidStatusHandler } });
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const state = async () => ({
      conditions: (
        await f.db.query<{ status: string; reason: string | null }>(
          `SELECT status, reason FROM node_conditions WHERE node_id = $1 AND type = 'SpotInterruption'`,
          [node],
        )
      ).rows,
      reasons: (await f.db.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1', [node]))
        .rows[0]!.no_schedule_reasons,
    });

    await handle.receive(status(1, 'terminate:2026-11-05T10:02:00Z'));
    await f.gateway.jobs.status.tick();
    expect(await state()).toEqual({
      conditions: [{ status: 'true', reason: 'terminate:2026-11-05T10:02:00Z' }],
      reasons: ['SpotInterruption'],
    });
    const [event] = await f.outbox('node.condition.changed');
    expect(event).toMatchObject({
      payload: { data: { condition: 'SpotInterruption', status: 'true', reason: 'terminate:2026-11-05T10:02:00Z', noSchedule: true } },
    });

    await handle.receive(status(2));
    await f.gateway.jobs.status.tick();
    expect(await state()).toEqual({ conditions: [{ status: 'false', reason: null }], reasons: [] });
  });
});
