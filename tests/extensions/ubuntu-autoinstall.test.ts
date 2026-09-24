import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePlugin, manifest, type MethodContext } from '@better-compute/core';
import { defineProfile, defineStep, renderTemplate } from '@better-compute/provision';
import { createMetalSim, type MetalSim } from './metal-sim.js';

// PLAN.md §5.6 walkthrough 1 — Ubuntu autoinstall via Redfish virtual media, with zero edits to
// @better-compute/*: the third-party plugin `acme-autoinstall` ships a control-plane step that
// renders a per-node autoinstall ISO carrying a single-use `provisioned` join token, and a profile
// that mounts it with the built-in `media.insert` on the site agent, so the installed OS runs bcd and
// joins. Then the §16 v0.2 acceptance in sim form: 20 consecutive unattended enroll → ready →
// deployed → released → ready loops, and every `ready` follows a verified wipe.

// --- @acme/bc-autoinstall ------------------------------------------------------------------------

/** The plugin's ISO store (object storage behind the site cache): unguessable per-node URLs. */
const isoStore = new Map<string, { nodeId: string; token: string }>();
const autoinstall = `#cloud-config
autoinstall:
  version: 1
  identity: { hostname: {{hostname}} }
  late-commands:
    - curtin in-target -- sh -c "echo {{joinToken}} > /etc/bcd/join-token && chmod 600 /etc/bcd/join-token"
    - curtin in-target -- systemctl enable bcd
`;
const renderAutoinstallIso = defineStep({
  id: 'autoinstall.renderIso',
  runsOn: 'control-plane',
  timeout: '5m',
  retrySafe: false,
  input: manifest({}),
  async run(_input, context) {
    const node = context.node!;
    const { token } = await context.sql.transaction((tx) =>
      context.pki!.issueJoinToken(tx, { tenantId: 'root', role: 'provisioned', siteId: node.siteId, ttlSeconds: 7200, maxUses: 1 }),
    );
    const userData = renderTemplate(autoinstall, { hostname: node.id.replace(/_/g, '-'), joinToken: token });
    const digest = createHash('sha256').update(userData).digest('hex');
    isoStore.set(digest, { nodeId: node.id, token });
    return { url: `https://cache.site-a/autoinstall/${digest}.iso` };
  },
});
const ubuntuAutoinstall = defineProfile({
  id: 'ubuntu-24.04-autoinstall',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [
    { use: 'autoinstall.renderIso' },
    { use: 'media.insert', on: 'site', with: { fromStep: 'autoinstall.renderIso' } },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'cd' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
    { use: 'wait.agentJoined', with: { role: 'node' } },
    { use: 'media.eject', on: 'site' },
  ],
});
const acmeAutoinstall = definePlugin({ id: 'acme-autoinstall', extensions: [renderAutoinstallIso], profiles: [ubuntuAutoinstall] });

// --- The site -----------------------------------------------------------------------------------

let sim: MetalSim;
const installs: { nodeId: string; token: string }[] = [];

beforeAll(async () => {
  sim = await createMetalSim({
    modules: [acmeAutoinstall],
    // A machine booting a mounted autoinstall ISO for itself installs and its bcd joins.
    install(nodeId, machine) {
      const digest = /autoinstall\/([0-9a-f]{64})\.iso$/.exec(machine.mounted)?.[1];
      const iso = digest ? isoStore.get(digest) : undefined;
      if (!iso || iso.nodeId !== nodeId) return undefined;
      installs.push(iso);
      return `installed-${installs.length}`;
    },
  });
  await sim.addSiteAgent('node_s1te0000000000000000000001');
});
afterAll(() => sim.close());

async function enroll(n: number): Promise<string> {
  const node = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.10.0.${n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  return node.nodeId;
}

describe('walkthrough 1: Ubuntu autoinstall via Redfish virtual media', () => {
  it('resolves every step of the plugin profile', async () => {
    const validate = sim.provision.api!(sim.context).profiles.validate as unknown as {
      validate(i: unknown): unknown;
      handler(c: MethodContext, i: unknown): Promise<unknown>;
    };
    expect(await validate.handler(sim.context, validate.validate({ tenantId: 'root', profileId: 'ubuntu-24.04-autoinstall', profileVersion: 1 }))).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('enroll → ready → deployed → released → ready, with the token only inside the ISO', async () => {
    const id = await enroll(1);
    await sim.settle();
    expect(await sim.state(id)).toMatchObject({ provision_state: 'ready' });
    await sim.call('deploy', { tenantId: 'root', nodeId: id, profileId: 'ubuntu-24.04-autoinstall', profileVersion: 1 });
    await sim.settle();
    expect(await sim.state(id)).toMatchObject({ provision_state: 'deployed', role: 'host' });
    expect(installs.at(-1)).toEqual({ nodeId: id, token: sim.tokens.at(-1) });
    expect(sim.machines.get(id)!.mounted).toBe(''); // ejected
    expect(JSON.stringify(sim.seen)).not.toContain(sim.tokens.at(-1)!);
    await sim.call('undeploy', { tenantId: 'root', nodeId: id, wipe: 'quick' });
    await sim.settle();
    expect((await sim.state(id)).provision_state).toBe('ready');
  });
});

describe('§16 v0.2 acceptance (sim): 20 unattended loops, every ready after a verified wipe', () => {
  it('runs 20 consecutive enroll → ready → deployed → released → ready loops', async () => {
    const node = await enroll(2);
    await sim.settle();
    for (let loop = 1; loop <= 20; loop++) {
      expect((await sim.state(node)).provision_state).toBe('ready');
      await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'ubuntu-24.04-autoinstall', profileVersion: 1 });
      await sim.settle();
      expect(await sim.state(node), `loop ${loop} deploy`).toMatchObject({ provision_state: 'deployed', maintenance: false });
      await sim.call('undeploy', { tenantId: 'root', nodeId: node });
      await sim.settle();
      expect((await sim.state(node)).provision_state, `loop ${loop} release`).toBe('ready');
    }
    // One fresh single-use token per install.
    const mine = installs.filter((i) => i.nodeId === node);
    expect(mine).toHaveLength(20);
    expect(new Set(mine.map((i) => i.token)).size).toBe(20);
  });

  it('invariant: every transition into ready follows a verified (attested, read-back) wipe in that workflow', async () => {
    const { rows } = await sim.db.query<{ node_id: string; profile_id: string; wipes: number }>(
      `SELECT w.node_id, w.profile_id,
              count(s.*) FILTER (WHERE s.action = 'disk.wipe' AND s.state = 'succeeded' AND (s.result->>'attested')::boolean) AS wipes
         FROM workflows w LEFT JOIN workflow_steps s ON s.workflow_id = w.id
        WHERE w.owner = 'metal' AND w.state = 'succeeded' AND w.profile_id IN ('metal-commission', 'metal-release')
        GROUP BY w.id, w.node_id, w.profile_id`,
    );
    const readies = sim.events.filter((e) => e.type === 'node.provision.ready');
    expect(rows.length).toBe(readies.length); // one wipe-bearing workflow behind each ready
    expect(rows.every((row) => Number(row.wipes) === 1)).toBe(true);
    expect(readies.length).toBe(2 + 1 + 20); // two commissions, one release, twenty releases
  });

  it('a release whose wipe is not attested never reaches ready', async () => {
    const node = await enroll(3);
    await sim.settle();
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'ubuntu-24.04-autoinstall', profileVersion: 1 });
    await sim.settle();
    sim.faults.attestWipe = false;
    await sim.call('undeploy', { tenantId: 'root', nodeId: node });
    await sim.settle();
    sim.faults.attestWipe = true;
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'releasing', maintenance: true });
  });
});
