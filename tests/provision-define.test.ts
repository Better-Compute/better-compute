import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  field,
  isComputeError,
  manifest,
  type ComputeError,
  type Json,
  type StepContext,
} from '@better-compute/core';
import {
  defineProfile,
  defineStep,
  type ProfileDocument,
  type StepDefinition,
} from '@better-compute/provision';

function configError(run: () => unknown): ComputeError {
  try {
    run();
  } catch (error) {
    if (isComputeError(error, 'INVALID_CONFIG')) return error;
    throw error;
  }
  throw new Error('expected INVALID_CONFIG');
}

const role = manifest({ role: field.option(['node', 'ramdisk']) });
const level = manifest({ level: field.int({ min: 1, max: 4 }) });

describe('defineStep', () => {
  it('declares a control-plane step with a typed run()', async () => {
    const agentJoined = defineStep({
      id: 'wait.agentJoined',
      runsOn: 'control-plane',
      timeout: '15m',
      retrySafe: true,
      input: role,
      run: async (input) => ({ joined: input.role }),
    });
    expect(agentJoined.extension).toBe('step');
    expect(Object.isFrozen(agentJoined)).toBe(true);
    expect(await agentJoined.run!({ role: 'ramdisk' }, {} as StepContext)).toEqual({
      joined: 'ramdisk',
    });
    expectTypeOf(agentJoined).toEqualTypeOf<StepDefinition<{ role: 'node' | 'ramdisk' }>>();
    expectTypeOf(agentJoined.run!).parameter(0).toEqualTypeOf<{ role: 'node' | 'ramdisk' }>();
  });

  it('declares agent steps as one command, optionally awaiting a rejoin', () => {
    const dcgm = defineStep({
      id: 'diag.dcgm',
      runsOn: 'ramdisk',
      timeout: '30m',
      retries: 2,
      retrySafe: true,
      input: level,
      command: 'diag.dcgm',
    });
    expect(dcgm).toMatchObject({ id: 'diag.dcgm', command: 'diag.dcgm', extension: 'step' });
    const kexec = defineStep({
      id: 'boot.kexec',
      version: '1.0.0',
      runsOn: 'ramdisk',
      timeout: '15m',
      retrySafe: false,
      await: 'rejoin',
      input: manifest({}),
      command: 'boot.kexec',
      cleanup: [{ use: 'boot.cleanUp', on: 'site' }],
    });
    expect(kexec.await).toBe('rejoin');
  });

  it('accepts any Standard Schema as input', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as { url: string } }),
      },
    };
    const step = defineStep({
      id: 'acme-autoinstall.renderIso',
      runsOn: 'control-plane',
      timeout: '5m',
      retrySafe: true,
      input: schema,
      run: async (input) => input.url,
    });
    expectTypeOf(step).toEqualTypeOf<StepDefinition<{ url: string }>>();
  });

  const base = {
    id: 'power.setPower',
    runsOn: 'site',
    timeout: '2m',
    retrySafe: true,
    input: manifest({ action: field.option(['on', 'off', 'cycle']) }),
    command: 'driver.invoke',
  } as const;
  const invalid: [label: string, change: Record<string, unknown>, path: string][] = [
    ['an id without a namespace', { id: 'setPower' }, 'id'],
    ['an upper-case namespace', { id: 'Power.setPower' }, 'id'],
    ['a malformed version', { version: 'v 1' }, 'version'],
    ['an unknown runsOn', { runsOn: 'cloud' }, 'runsOn'],
    ['a zero timeout', { timeout: '0s' }, 'timeout'],
    ['an unparsable timeout', { timeout: 'soon' }, 'timeout'],
    ['negative retries', { retries: -1 }, 'retries'],
    ['fractional retries', { retries: 1.5 }, 'retries'],
    ['too many retries', { retries: 101 }, 'retries'],
    ['no retrySafe', { retrySafe: undefined }, 'retrySafe'],
    ['an input that is not a schema', { input: {} }, 'input'],
    ['an agent step without a command', { command: undefined }, 'command'],
    ['a malformed command kind', { command: 'invoke' }, 'command'],
    ['an agent step with run()', { run: async () => undefined }, 'run'],
    ['an await other than rejoin', { await: 'reboot' }, 'await'],
    ['a misspelt field', { retrysafe: true }, 'retrysafe'],
    ['a malformed cleanup step', { cleanup: [{ use: 'cleanUp' }] }, 'cleanup[0].use'],
    ['a control-plane step without run()', { runsOn: 'control-plane', command: undefined }, 'run'],
    [
      'a control-plane step with a command',
      { runsOn: 'control-plane', run: async () => undefined },
      'command',
    ],
    [
      'a control-plane step awaiting a rejoin',
      { runsOn: 'control-plane', command: undefined, run: async () => undefined, await: 'rejoin' },
      'await',
    ],
  ];
  it.each(invalid)('rejects %s', (_label, change, path) => {
    const error = configError(() => defineStep({ ...base, ...change } as never));
    expect(error.details).toEqual({ path });
    expect(error.message).toMatch(/^Step /);
  });

  it('rejects values that are not objects', () => {
    expect(configError(() => defineStep(null as never)).details).toEqual({ path: '' });
  });
});

// The three profiles of PLAN.md §11.4.
const adoptExisting: ProfileDocument = {
  id: 'adopt-existing',
  version: 1,
  target: 'metal',
  entry: 'adopt',
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 }, fallback: 'diag.nvml' }],
  hostConfig: { 'container-toolkit': { cdi: true } },
};
const gpuHost: ProfileDocument = {
  id: 'ubuntu-24.04-gpu-host',
  version: 1,
  target: 'metal',
  role: 'host',
  drivers: {
    power: 'redfish',
    management: 'redfish',
    boot: 'ipxe',
    deploy: 'image-stream',
    inspect: 'agent',
  },
  image: { ref: 'ubuntu-24.04-server@2026.09', format: 'raw', compression: 'zstd' },
  userData: { kind: 'cloud-init', template: 'bcd-host.yaml.hbs' },
  hostConfig: {
    'nvidia-driver': { branch: '580' },
    'fabric-manager': { when: 'nvswitch' },
    'mig-layout': { from: 'pool' },
  },
  steps: [
    { use: 'boot.prepareRamdisk', on: 'site' },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'pxe' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
    { use: 'wait.agentJoined', with: { role: 'ramdisk' } },
    { use: 'inspect.inspect', on: 'ramdisk' },
    { use: 'diag.dcgm', on: 'ramdisk', with: { level: 2 } },
    { use: 'deploy.deploy', on: 'ramdisk', timeout: '30m' },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'disk' } },
    {
      use: 'boot.kexec',
      on: 'ramdisk',
      await: 'rejoin',
      timeout: '15m',
      onFailure: { use: 'power.setPower', on: 'site', with: { action: 'reset' } },
    },
    { use: 'wait.generationObserved' },
  ],
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 } }],
  cleanup: [{ use: 'boot.cleanUp', on: 'site' }],
};
const vpsUbuntu: ProfileDocument = {
  id: 'vps-ubuntu-24.04',
  version: 1,
  target: 'vps',
  runtime: 'libvirt-kvm',
  image: { ref: 'ubuntu-24.04-cloud@2026.09', format: 'qcow2' },
  flavors: {
    'g1.small': { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
    'gpu1.l40s': { vcpu: 16, memoryGiB: 96, diskGiB: 200, gpus: 1 },
  },
  userData: { kind: 'cloud-init', template: 'vps-default.yaml.hbs' },
  network: { mode: 'bridge', ipam: 'pool' },
};

const isDeepFrozen = (value: unknown): boolean =>
  typeof value !== 'object' ||
  value === null ||
  (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

describe('defineProfile', () => {
  it.each([adoptExisting, gpuHost, vpsUbuntu])('accepts the §11.4 profile $id', (profile) => {
    const defined = defineProfile(profile);
    expect(defined).toEqual(profile);
    expect(defined).not.toBe(profile);
    expect(isDeepFrozen(defined)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(false);
    expectTypeOf(defined).toEqualTypeOf<ProfileDocument>();
  });

  const step = (change: Record<string, unknown>) => ({
    ...gpuHost,
    steps: [{ use: 'deploy.deploy', on: 'ramdisk', ...change }],
  });
  const invalid: [label: string, profile: unknown, path: string][] = [
    ['a non-object', null, ''],
    ['an upper-case id', { ...adoptExisting, id: 'Adopt' }, 'id'],
    ['version 0', { ...adoptExisting, version: 0 }, 'version'],
    ['a fractional version', { ...adoptExisting, version: 1.5 }, 'version'],
    ['an unknown target', { ...adoptExisting, target: 'cloud' }, 'target'],
    ['a misspelt field', { ...adoptExisting, step: [] }, 'step'],
    ['a runtime on a metal profile', { ...gpuHost, runtime: 'libvirt-kvm' }, 'runtime'],
    ['an entry on a vps profile', { ...vpsUbuntu, entry: 'deploy' }, 'entry'],
    ['a vps profile without a runtime', { ...vpsUbuntu, runtime: undefined }, 'runtime'],
    ['an image on an adopt profile', { ...adoptExisting, image: gpuHost.image }, 'image'],
    ['steps on an adopt profile', { ...adoptExisting, steps: [] }, 'steps'],
    ['an unknown role', { ...gpuHost, role: 'worker' }, 'role'],
    ['a malformed driver id', { ...gpuHost, drivers: { power: 'Redfish' } }, 'drivers.power'],
    [
      'an unknown driver binding field',
      { ...gpuHost, drivers: { power: { driver: 'redfish', extra: 1 } } },
      'drivers.power.extra',
    ],
    ['an image ref without a version', { ...gpuHost, image: { ref: 'ubuntu' } }, 'image.ref'],
    [
      'an unknown image format',
      { ...gpuHost, image: { ref: 'a@1', format: 'vmdk' } },
      'image.format',
    ],
    [
      'an unknown user-data kind',
      { ...gpuHost, userData: { kind: 'shell', template: 'x' } },
      'userData.kind',
    ],
    [
      'config-unit settings that are not an object',
      { ...gpuHost, hostConfig: { 'nvidia-driver': '580' } },
      'hostConfig.nvidia-driver',
    ],
    [
      'a malformed step id',
      { ...gpuHost, steps: [gpuHost.steps![0], { use: 'deploy' }] },
      'steps[1].use',
    ],
    ['an unknown step field', step({ retry: 1 }), 'steps[0].retry'],
    ['an unknown runsOn', step({ on: 'cloud' }), 'steps[0].on'],
    ['a zero step timeout', step({ timeout: '0m' }), 'steps[0].timeout'],
    ['a function in with', step({ with: { fn: () => 1 } }), 'steps[0].with.fn'],
    ['NaN in with', step({ with: { n: Number.NaN } }), 'steps[0].with.n'],
    ['undefined in with', step({ with: { list: [1, undefined] } }), 'steps[0].with.list[1]'],
    ['a class instance in with', step({ with: { at: new Date(0) } }), 'steps[0].with.at'],
    [
      'awaiting a rejoin on the control plane',
      step({ on: 'control-plane', await: 'rejoin' }),
      'steps[0].await',
    ],
    ['an unknown failure mode', step({ onFailure: 'retry' }), 'steps[0].onFailure'],
    [
      'a nested onFailure step',
      step({ onFailure: { use: 'power.setPower', onFailure: { use: 'power.setPower' } } }),
      'steps[0].onFailure.onFailure',
    ],
    ['a malformed fallback', step({ fallback: 'nvml' }), 'steps[0].fallback'],
    ['acceptance that is not a list', { ...adoptExisting, acceptance: {} }, 'acceptance'],
    [
      'a zero-vCPU flavor',
      { ...vpsUbuntu, flavors: { 'g1.small': { vcpu: 0, memoryGiB: 1, diskGiB: 1 } } },
      'flavors.g1.small.vcpu',
    ],
    [
      'an unknown flavor field',
      { ...vpsUbuntu, flavors: { 'g1.small': { vcpu: 1, memoryGiB: 1, diskGiB: 1, cpu: 1 } } },
      'flavors.g1.small.cpu',
    ],
    ['a malformed network mode', { ...vpsUbuntu, network: { mode: 'Bridge' } }, 'network.mode'],
  ];
  it.each(invalid)('rejects %s', (_label, profile, path) => {
    const error = configError(() => defineProfile(profile as ProfileDocument));
    expect(error.details).toEqual({ path });
    expect(error.message).toMatch(/^Profile/);
  });

  it('names the profile and version in errors', () => {
    const error = configError(() => defineProfile({ ...adoptExisting, target: 'cloud' } as never));
    expect(error.message).toBe('Profile adopt-existing@1: target must be one of metal, vps');
  });

  it('keeps JSON values as they are', () => {
    const payload: Json = { nested: [1, 'two', true, null, { deep: { deeper: [] } }] };
    const defined = defineProfile(step({ with: { payload } }) as ProfileDocument);
    expect(defined.steps![0]!.with).toEqual({ payload });
  });
});
