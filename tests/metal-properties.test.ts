import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// PLAN.md §15 unit properties, §11.1 tested invariant: "`ready` follows `releasing` only through a
// workflow whose wipe succeeded, as shown by a node-signed attested result verified by the worker".
// Random operator verbs and wipe faults (unsigned, read-back failure, gateway forgery, a foreign
// signer) against the simulated site; the sim records the ground truth of every wipe. Whenever a
// machine that was deployed or rescued is `ready` again, a trusted wipe of it ran since.

const SITE = 'node_s1tea00000000000000000000p';
const deployProfile = defineProfile({
  id: 'prop-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'power.setPower', with: { action: 'off' } }],
});

type Fault = 'none' | 'unsigned' | 'readBack' | 'forged' | 'foreign';
type Action =
  | { verb: 'deploy' | 'rescue' | 'unrescue' | 'recover' | 'abort' }
  | { verb: 'undeploy'; wipe: 'quick' | 'secure-erase' | 'crypto-erase' }
  | { verb: 'fault'; fault: Fault };

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.constantFrom<Action>({ verb: 'deploy' }, { verb: 'rescue' }, { verb: 'unrescue' }, { verb: 'recover' }, { verb: 'abort' }),
  fc.record({ verb: fc.constant('undeploy' as const), wipe: fc.constantFrom('quick' as const, 'secure-erase' as const, 'crypto-erase' as const) }),
  fc.record({ verb: fc.constant('fault' as const), fault: fc.constantFrom<Fault>('none', 'unsigned', 'readBack', 'forged', 'foreign') }),
);

let sim: MetalSim;
let n = 0;
let checked = 0;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [deployProfile] });
  await sim.addSiteAgent(SITE, 'site_a');
});
afterAll(() => sim.close());

function setFault(fault: Fault) {
  Object.assign(sim.faults, { attestWipe: fault !== 'unsigned', failWipeReadBack: fault === 'readBack' || fault === 'forged', forgeWipe: fault === 'forged', foreignSigner: fault === 'foreign' });
}

describe('metal properties', () => {
  it('a used machine is ready again only after a trusted wipe of it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 10 }), async (actions) => {
        setFault('none');
        const { nodeId } = await sim.call('enroll', {
          tenantId: 'root',
          siteId: 'site_a',
          poolId: 'pool_metal',
          bmc: { address: `https://10.14.${Math.floor(++n / 250)}.${n % 250}`, driver: 'redfish', credentials: 'secret://root/bmc' },
        });
        await sim.settle();
        // Commissioning never counts: nothing was deployed yet.
        let usedSince: number | undefined;
        for (const step of actions) {
          if (step.verb === 'fault') setFault(step.fault);
          else {
            const input: Record<string, unknown> = { tenantId: 'root', nodeId };
            if (step.verb === 'deploy') Object.assign(input, { profileId: 'prop-deploy', profileVersion: 1 });
            if (step.verb === 'undeploy') input.wipe = step.wipe;
            try {
              await sim.call(step.verb, input);
              // A deploy or a rescue boots something on the machine: from here on it is used.
              if ((step.verb === 'deploy' || step.verb === 'rescue') && usedSince === undefined) usedSince = sim.seen.length;
            } catch (error) {
              // Illegal in the current state (INVALID_STATE) or busy (CONFLICT): the property holds either way.
              if (!['INVALID_STATE', 'CONFLICT'].includes((error as { code?: string }).code ?? '')) throw error;
            }
          }
          await sim.settle();
          const { provision_state: state } = await sim.state(nodeId);
          if (state === 'deployed' || state === 'rescue') sim.machineOf(nodeId).installed = true;
          if (state === 'ready' && usedSince !== undefined) {
            const since = usedSince;
            const wiped = sim.trustedWipes.some((wipe) => wipe.nodeId === nodeId && wipe.trusted && wipe.at > since);
            expect(wiped, `ready without a trusted wipe after ${JSON.stringify(actions)}`).toBe(true);
            checked++;
            usedSince = undefined;
          }
        }
      }),
      { numRuns: 25, seed: 20260924 },
    );
    // Not vacuous: releases back to ready happened, and faulty wipes were refused along the way.
    expect(checked).toBeGreaterThan(3);
    expect(sim.trustedWipes.some((wipe) => !wipe.trusted)).toBe(true);
  });
});
