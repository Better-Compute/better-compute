import type { ProfileDocument, ProvisionState } from '@better-compute/core';
import { defineProfile } from '@better-compute/provision';

// The workflows behind metal's provision states (PLAN.md §3.5, §11.1). Deploy is the exception: it
// runs the tenant's own profile (for example §11.4's `ubuntu-24.04-gpu-host`).

/** enrolling → inspecting: the BMC answers with the stored credentials; OOB inspection finds the PXE MACs. */
export const enrollProfile = defineProfile({
  id: 'metal-enroll',
  version: 1,
  target: 'metal',
  description: 'Verify BMC access and inspect out of band',
  steps: [{ use: 'power.getPower' }, { use: 'inspect.oob' }],
});

/** inspecting → commissioning: boot the ramdisk and take the in-band inventory. */
export const inspectProfile = defineProfile({
  id: 'metal-inspect',
  version: 1,
  target: 'metal',
  description: 'Boot the ramdisk and inspect in band',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'inventory.refresh' }],
});

/** commissioning → ready: DCGM level 2, a quick wipe, then power off (§3.5 step 3). */
export const commissionProfile = defineProfile({
  id: 'metal-commission',
  version: 1,
  target: 'metal',
  description: 'Burn in, wipe and power off',
  steps: [
    { use: 'metal.ensureRamdisk' },
    { use: 'diag.dcgm', with: { level: 2 } },
    { use: 'disk.wipe', with: { mode: 'quick' } },
    { use: 'power.setPower', with: { action: 'off' } },
  ],
  cleanup: [{ use: 'boot.cleanUp' }],
});

/** releasing → ready: wipe (the mode `metal.undeploy` chose), then power off. Only a verified wipe completes it. */
export const releaseProfile = defineProfile({
  id: 'metal-release',
  version: 1,
  target: 'metal',
  description: 'Wipe and power off after a lease',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'disk.wipe' }, { use: 'power.setPower', with: { action: 'off' } }],
  cleanup: [{ use: 'boot.cleanUp' }],
});

/** retiring → retired: crypto-erase, power off, revoke the identity and forget the BMC credentials. */
export const retireProfile = defineProfile({
  id: 'metal-retire',
  version: 1,
  target: 'metal',
  description: 'Erase, power off and revoke identity',
  steps: [
    { use: 'metal.ensureRamdisk', onFailure: 'continue' },
    { use: 'disk.wipe', with: { mode: 'crypto-erase' }, onFailure: 'continue' },
    { use: 'power.setPower', with: { action: 'off' }, onFailure: 'continue' },
    { use: 'metal.revokeIdentity' },
  ],
  cleanup: [{ use: 'boot.cleanUp' }],
});

/** rescue: boot the ramdisk on a deployed machine; the node stays in `rescue` until released or unrescued. */
export const rescueProfile = defineProfile({
  id: 'metal-rescue',
  version: 1,
  target: 'metal',
  description: 'Boot the rescue ramdisk',
  steps: [{ use: 'metal.ensureRamdisk' }],
});

// Agentless machines (`pool.agent = 'none'`: Talos, appliances, §5.6 walkthrough 3) never run a
// ramdisk or bcd, so everything happens out of band through the BMC and the site agent. Their wipe
// can never be node-attested: a release only returns to `ready` when the pool opts in with
// `policy.allowUnverifiedRelease` (the reconciler records it as `node.release.unverified`).

/** inspecting → commissioning, out of band: Redfish inventory (MACs, addresses). */
export const inspectOobProfile = defineProfile({
  id: 'metal-inspect-oob',
  version: 1,
  target: 'metal',
  description: 'Inspect an agentless machine through its BMC',
  steps: [{ use: 'inspect.oob' }],
});
/** commissioning → ready, out of band: power off. */
export const commissionOobProfile = defineProfile({
  id: 'metal-commission-oob',
  version: 1,
  target: 'metal',
  description: 'Power off an agentless machine',
  steps: [{ use: 'power.setPower', with: { action: 'off' } }],
});
/** releasing → ready, out of band: eject media, power off. */
export const releaseOobProfile = defineProfile({
  id: 'metal-release-oob',
  version: 1,
  target: 'metal',
  description: 'Release an agentless machine (no attested wipe)',
  steps: [{ use: 'media.eject', onFailure: 'continue' }, { use: 'power.setPower', with: { action: 'off' } }],
});
/** retiring → retired, out of band. */
export const retireOobProfile = defineProfile({
  id: 'metal-retire-oob',
  version: 1,
  target: 'metal',
  description: 'Power off an agentless machine and revoke its identity',
  steps: [{ use: 'power.setPower', with: { action: 'off' }, onFailure: 'continue' }, { use: 'metal.revokeIdentity' }],
});

/** The profile a workflow-driven state runs for a pool's agent mode; `rescue` needs an agent. */
export function stateProfile(state: ProvisionState, agent: 'bcd' | 'none' | null | undefined): ProfileDocument | undefined {
  if (agent !== 'none') return stateProfiles[state];
  return (
    {
      enrolling: enrollProfile,
      inspecting: inspectOobProfile,
      commissioning: commissionOobProfile,
      releasing: releaseOobProfile,
      retiring: retireOobProfile,
    } as Partial<Record<ProvisionState, ProfileDocument>>
  )[state];
}

/** Every profile metal ships. */
export const metalProfiles: readonly ProfileDocument[] = Object.freeze([
  enrollProfile,
  inspectProfile,
  commissionProfile,
  releaseProfile,
  retireProfile,
  rescueProfile,
  inspectOobProfile,
  commissionOobProfile,
  releaseOobProfile,
  retireOobProfile,
]);

/** The shipped profile each workflow-driven provision state runs (`deploying` runs the tenant's). */
export const stateProfiles: Readonly<Partial<Record<ProvisionState, ProfileDocument>>> = Object.freeze({
  enrolling: enrollProfile,
  inspecting: inspectProfile,
  commissioning: commissionProfile,
  releasing: releaseProfile,
  retiring: retireProfile,
  rescue: rescueProfile,
});

/** Provision states a workflow drives; the metal reconciler starts one on entering them. */
export const workflowStates: readonly ProvisionState[] = [
  'enrolling',
  'inspecting',
  'commissioning',
  'deploying',
  'releasing',
  'retiring',
  'rescue',
];
