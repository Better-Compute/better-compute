import { afterEach, describe, expect, it } from 'vitest';
import { CommandState } from '@better-compute/protocol';
import { agentFrame, gatewayFixture, type GatewayFixture } from './support/gateway.js';

// `commandOwner` (the server's `commandOwner` bound to its reconcilers): a settled command wakes the
// work item its idempotency key names (`<reconciler>:<key>:…`) with its node, on a result and on a
// rejoin that settles it, so a reconciler waiting on the result runs now, not at its periodic pass.

let f: GatewayFixture;
afterEach(() => f.close());

const update = (commandId: string, state: CommandState) =>
  agentFrame({ case: 'update', value: { commandId, state, bootId: 'boot-1' } });

const owners = new Set(['vps.sandboxes']);
const commandOwner = (key: string) => {
  const [kind, id] = key.split(':');
  return kind && id && owners.has(kind) ? { kind, key: id } : undefined;
};

describe('command owners', () => {
  it('wakes the owner of a settled command set-wise, and nothing for unowned or non-terminal updates', async () => {
    f = await gatewayFixture({ commandOwner });
    const node = await f.addNode();
    const owned = await f.enqueue(node);
    const other = await f.enqueue(node);
    const plain = await f.enqueue(node);
    await f.db.query(`UPDATE commands SET idempotency_key = 'vps.sandboxes:snap_1:snapshot' WHERE id = $1`, [owned]);
    await f.db.query(`UPDATE commands SET idempotency_key = 'unknown.kind:x:y' WHERE id = $1`, [other]);
    const ownerWork = async () =>
      (await f.db.query<{ key: string }>("SELECT key FROM work_queue WHERE kind = 'vps.sandboxes'")).rows.map((row) => row.key);
    const { handle } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();

    await handle.receive(update(owned, CommandState.RUNNING));
    await handle.receive(update(plain, CommandState.SUCCEEDED));
    await handle.receive(update(other, CommandState.FAILED));
    expect(await ownerWork()).toEqual([]);
    await handle.receive(update(owned, CommandState.SUCCEEDED));
    expect(await ownerWork()).toEqual(['snap_1']);
  });

  it('wakes the owner when a rejoin settles its command (a reboot completes it)', async () => {
    f = await gatewayFixture({ commandOwner });
    const node = await f.addNode();
    const reboot = await f.enqueue(node, { kind: 'node.reboot' });
    await f.db.query(`UPDATE commands SET idempotency_key = 'vps.sandboxes:snap_2:reboot' WHERE id = $1`, [reboot]);
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.receive(update(reboot, CommandState.RUNNING));
    await first.handle.end();
    await f.connect(node, { bootId: 'boot-2' });
    expect(await f.command(reboot)).toMatchObject({ state: 'succeeded', reason: 'rebooted' });
    const { rows } = await f.db.query("SELECT key FROM work_queue WHERE kind = 'vps.sandboxes'");
    expect(rows).toEqual([{ key: 'snap_2' }]);
  });
});
