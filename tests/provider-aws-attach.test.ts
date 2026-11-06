import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type ComputeError,
  type ExternalMachine,
  type Logger,
} from '@better-compute/core';
import {
  awsConfig,
  awsProvider,
  type AwsCompute,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function world(overrides: Partial<AwsConfig> = {}) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig),
    ...overrides,
  };
  const impl = (await provider.create(config, {
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  })) as AwsCompute;
  const call = (key = 'attach'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  return { emu, ec2emu, impl, call };
}

async function all(iterable: AsyncIterable<ExternalMachine>): Promise<ExternalMachine[]> {
  const out: ExternalMachine[] = [];
  for await (const machine of iterable) out.push(machine);
  return out;
}

async function rejection(run: () => Promise<unknown>): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(isComputeError(error)).toBe(true);
    return error as ComputeError;
  }
  throw new Error('expected a failure');
}

describe('provider-aws attach', () => {
  it('discover yields foreign instances and honors discoverTag', async () => {
    const { ec2emu, impl, call } = await world();
    const a = ec2emu.addInstance({ tags: { team: 'ml' } });
    const b = ec2emu.addInstance({ tags: { team: 'web' } });
    const dead = ec2emu.addInstance({ state: 'terminated' });
    const found = (await all(impl.discover(call()))).map((m) => m.id);
    expect(found.sort()).toEqual([a.id, b.id].sort());
    expect(found).not.toContain(dead.id);
    const filtered = await world({ discoverTag: 'team=ml' });
    const ml = filtered.ec2emu.addInstance({ tags: { team: 'ml' } });
    filtered.ec2emu.addInstance({ tags: { team: 'web' } });
    expect((await all(filtered.impl.discover(filtered.call()))).map((m) => m.id)).toEqual([ml.id]);
  });

  it('claim writes the ownership tag and returns claimedBy', async () => {
    const { ec2emu, impl, call } = await world();
    const foreign = ec2emu.addInstance();
    const claimed = await impl.claim(foreign.id, 'ins_attach1', call());
    expect(claimed.claimedBy).toBe('ins_attach1');
    expect(foreign.tags.get('better-compute:instance')).toBe('ins_attach1');
    expect(foreign.tags.has('better-compute:managed')).toBe(false);
    // Claiming again for the same instance is a no-op success.
    expect((await impl.claim(foreign.id, 'ins_attach1', call())).claimedBy).toBe('ins_attach1');
    expect(
      (await rejection(() => impl.claim('i-0000000000000dead', 'ins_attach1', call()))).code,
    ).toBe('NOT_FOUND');
  });

  it('claim with managed hands deletion to better-compute', async () => {
    const { ec2emu, impl, call } = await world();
    const foreign = ec2emu.addInstance();
    await expect(impl.delete(foreign.id, call())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await impl.claim(foreign.id, 'ins_attach2', call(), { managed: true });
    expect(foreign.tags.get('better-compute:managed')).toBe('true');
    await impl.delete(foreign.id, call());
    expect(foreign.state).toBe('shutting-down');
  });

  it('claim refuses an instance another instance holds', async () => {
    const { ec2emu, impl, call, emu } = await world();
    const held = ec2emu.addInstance({ tags: { 'better-compute:instance': 'ins_other' } });
    const error = await rejection(() => impl.claim(held.id, 'ins_attach3', call()));
    expect(error.code).toBe('CONFLICT');
    expect(emu.calls('CreateTags')).toHaveLength(0);
  });

  it('claim detects a lost race on re-read', async () => {
    const { ec2emu, impl, call, emu } = await world();
    const foreign = ec2emu.addInstance();
    // Another control plane's write lands right after ours.
    emu.afterAction('CreateTags', () => {
      foreign.tags.set('better-compute:instance', 'ins_rival');
    });
    const error = await rejection(() => impl.claim(foreign.id, 'ins_attach4', call()));
    expect(error.code).toBe('CONFLICT');
    expect(foreign.tags.get('better-compute:instance')).toBe('ins_rival');
  });

  it('release removes only its own tag', async () => {
    const { ec2emu, impl, call } = await world();
    const foreign = ec2emu.addInstance();
    await impl.claim(foreign.id, 'ins_attach5', call(), { managed: true });
    await impl.release(foreign.id, 'ins_someone_else', call());
    expect(foreign.tags.get('better-compute:instance')).toBe('ins_attach5');
    await impl.release(foreign.id, 'ins_attach5', call());
    expect(foreign.tags.has('better-compute:instance')).toBe(false);
    expect(foreign.tags.has('better-compute:managed')).toBe(false);
    expect((await impl.get(foreign.id, call()))?.claimedBy).toBeUndefined();
  });

  it('release of a vanished instance succeeds', async () => {
    const { impl, call } = await world();
    await impl.release('i-0000000000000dead', 'ins_attach6', call());
  });
});
