import { afterEach, describe, expect, it } from 'vitest';
import {
  defineModule,
  defineSink,
  type AuditRecord,
  type ComputeEvent,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { fakeIam } from './support/fake-iam.js';
import { options } from './support/server.js';

// Sinks (§5.2 "sinks"): `sinks.audit` and the AuditSinks a module lists in `extensions` receive
// every committed audit row once per cursor advance, in commit order, each with its own cursor and
// back-off; event sinks a module lists run like `sinks.events`; usage sinks are refused loudly
// (usage goes to IAM billing through the bridge, §12.7) instead of being ignored.

afterEach(closeFixtures);

function recordingAuditSink(id: string, fail = { times: 0 }) {
  const received: AuditRecord[] = [];
  return {
    received,
    sink: defineSink({
      id,
      kind: 'audit',
      async write(records) {
        if (fail.times > 0) {
          fail.times--;
          throw new Error(`${id} is down`);
        }
        received.push(...records);
      },
    }),
  };
}

describe('audit sinks', () => {
  it('deliver committed audit rows in order to options’ and modules’ sinks, each at its own pace', async () => {
    const siem = recordingAuditSink('siem', { times: 1 });
    const events: ComputeEvent[] = [];
    const listed = defineModule({
      name: 'siem-export',
      extensions: [
        siem.sink,
        defineSink({
          id: 'module-events',
          kind: 'events',
          async deliver(batch) {
            events.push(...batch);
          },
        }),
      ],
    });
    const fixture = await computeFixture({ clock: 'sim', modules: [listed] });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.acme.token, action: 'compute:projects:manage' });
    for (const name of ['one', 'two', 'three'])
      await compute.api.projects.create(
        { token: tenants.acme.token },
        { tenantId: tenants.acme.id, name, idempotencyKey: `audit-${name}` },
      );
    const tick = () => compute.jobs['audit-sinks']!.tick();
    await tick();
    // The module's sink failed once: nothing for it yet, and it backs off.
    expect(siem.received).toEqual([]);
    // The next periodic run (every 5 s) is past its 1 s back-off.
    await fixture.advance(5_000);
    await tick();
    expect(siem.received.map((record) => record.action)).toEqual([
      'compute:projects:manage',
      'compute:projects:manage',
      'compute:projects:manage',
    ]);
    expect(siem.received[0]).toMatchObject({
      tenantId: tenants.acme.id,
      resource: { type: expect.stringMatching(/tenant$/), id: tenants.acme.id },
      admission: expect.objectContaining({ action: 'compute:projects:manage' }),
    });
    // Nothing is delivered twice once the cursor moved.
    await fixture.advance(10_000);
    await tick();
    expect(siem.received).toHaveLength(3);
    const { rows } = await fixture.database.query<{ sink_id: string }>(
      'SELECT sink_id FROM audit_sink_cursors ORDER BY sink_id',
    );
    expect(rows.map((row) => row.sink_id)).toEqual(['siem']);

    // A module's event sink is delivered to like `sinks.events`.
    await compute.jobs['outbox-dispatch']!.tick();
    expect(events.map((event) => event.type)).toContain('project.created');
  });

  it('are wired from sinks.audit, and usage sinks are refused instead of ignored', async () => {
    const database = pglite();
    const iam = fakeIam();
    const archive = recordingAuditSink('archive');
    const compute = betterCompute({ ...options(database, iam), sinks: { audit: [archive.sink] } });
    expect(Object.keys(compute.jobs)).toContain('audit-sinks');
    // No audit sinks: no module, no job.
    const bare = betterCompute(options(database, iam));
    expect(Object.keys(bare.jobs)).not.toContain('audit-sinks');
    const usage = defineSink({ id: 'warehouse', kind: 'usage', write: async () => [] });
    expect(() => betterCompute({ ...options(database, iam), sinks: { usage: [usage] } })).toThrow(
      /Usage sinks are not supported yet/,
    );
    expect(() =>
      betterCompute({
        ...options(database, iam),
        modules: [defineModule({ name: 'billing-export', extensions: [usage] })],
      }),
    ).toThrow(/Usage sinks are not supported yet/);
    await database.close();
  });
});
