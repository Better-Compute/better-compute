import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type ComputeError } from '@better-compute/core';
import {
  bareMetalClaim,
  bareMetalClaimPath,
  bareMetalJoinTokenPath,
  claimCommand,
  digitaloceanMetalProvider,
  productUuidCommand,
  readClaimCommand,
  rebootCommand,
  releaseCommand,
  writeTokenCommand,
  type DoBareMetalConfig,
  type DoBareMetalMachine,
  type DoBareMetalOptions,
  type DoSshExecutor,
} from '@better-compute/provider-digitalocean';
import { noopLog, platformAccount } from './support/do-harness.js';

// provider-digitalocean P3: Bare Metal GPUs as metal hosts (DO-D17's fallback), over a fake SSH
// executor that keeps each machine's files.

const privateKey =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nTESTKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----';
const secrets = {
  resolve: async (ref: string): Promise<string> => {
    if (ref === 'secret://do/metal-key') return privateKey;
    throw new Error('no such secret');
  },
};
const uuid = '4c4c4544-0042-3510-8051-b4c04f565432';
const pins = {
  servingCa: `sha256/${'A'.repeat(43)}=`,
  joinSigning: `sha256/${'B'.repeat(43)}=`,
  joinEncryption: `sha256/${'C'.repeat(43)}=`,
};
const call = (key = 'inst_1') => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock: manualClock(0),
  secrets,
  log: noopLog,
});

const machines: DoBareMetalMachine[] = [
  {
    id: 'bm-h100-1',
    region: 'nyc3',
    address: '198.51.100.10',
    vcpu: 192,
    memoryGiB: 2048,
    diskGiB: 30_000,
    gpus: { model: 'H100', count: 8 },
    hostKeySha256: `SHA256:${'h'.repeat(43)}`,
  },
  {
    id: 'bm-h100-2',
    region: 'nyc3',
    address: '198.51.100.11',
    vcpu: 192,
    memoryGiB: 2048,
    gpus: { model: 'H100', count: 8 },
  },
  { id: 'bm-ams', region: 'ams3', address: '198.51.100.12', vcpu: 96, memoryGiB: 1024 },
];

/** Machines by address: their files, and every command run on them. */
function fakeSsh() {
  const hosts = new Map<string, { files: Map<string, string>; down?: boolean }>();
  const runs: { host: string; command: string; stdin?: string; target: unknown }[] = [];
  for (const m of machines) hosts.set(m.address, { files: new Map() });
  const ssh: DoSshExecutor = async (target, command, stdin) => {
    runs.push({ host: target.host, command, ...(stdin !== undefined ? { stdin } : {}), target });
    const host = hosts.get(target.host);
    if (!host || host.down) throw new Error(`connect ${target.host}: refused (key /root/.ssh/id)`);
    if (target.privateKey !== privateKey) return { code: 255, stdout: '', stderr: 'denied' };
    const files = host.files;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (command === readClaimCommand) return ok(files.get(bareMetalClaimPath) ?? '');
    if (command === claimCommand) {
      const claim = stdin!.split('\n')[0]!;
      if (!files.has(bareMetalClaimPath)) files.set(bareMetalClaimPath, `${claim}\n`);
      return ok(files.get(bareMetalClaimPath));
    }
    if (command === releaseCommand) {
      if ((files.get(bareMetalClaimPath) ?? '').trim() !== stdin!.trim())
        return { code: 3, stdout: '', stderr: '' };
      files.delete(bareMetalClaimPath);
      files.delete(bareMetalJoinTokenPath);
      return ok();
    }
    if (command === productUuidCommand) return ok(`${uuid.toUpperCase()}\n`);
    if (command === writeTokenCommand) {
      files.set(bareMetalJoinTokenPath, stdin!);
      return ok();
    }
    if (command === 'sh -s') {
      files.set('install-script', stdin!);
      return ok();
    }
    if (command === rebootCommand) return ok();
    return { code: 127, stdout: '', stderr: 'unknown command' };
  };
  return { ssh, hosts, runs };
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

async function build(
  options: DoBareMetalOptions,
  account: { id: string; tenantId: string; platform: boolean } | null = platformAccount,
  config: Record<string, unknown> = { sshKey: 'secret://do/metal-key', regions: ['nyc3'] },
) {
  const provider = digitaloceanMetalProvider({ machines, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return provider.create((parsed as { value: DoBareMetalConfig }).value, {
    clock: manualClock(0),
    secrets,
    log: noopLog,
    ...(account ? { account } : {}),
  });
}

const createRequest = (offerId = 'bm-h100-1') => ({
  offerId,
  image: 'ignored',
  userData: '',
  name: 'inst_1',
});

describe('digitaloceanMetal', () => {
  it('is a metal provider for platform accounts only', async () => {
    expect(digitaloceanMetalProvider().provides).toEqual(['metal']);
    const { ssh } = fakeSsh();
    for (const account of [null, { id: 'a', tenantId: 'acme', platform: false }]) {
      await expect(build({ ssh }, account)).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        details: { reason: 'platformOnly' },
      });
    }
  });

  it('refuses a malformed machine list when the provider is defined', () => {
    const bad: Partial<DoBareMetalMachine>[] = [
      { id: 'Bad_Id' },
      { address: '198.51.100.300' },
      { address: 'host.example.com' },
      { region: 'NYC3' },
      { hostKeySha256: 'md5:aa' },
      { vcpu: 0 },
    ];
    for (const over of bad)
      expect(() => digitaloceanMetalProvider({ machines: [{ ...machines[0]!, ...over }] })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() => digitaloceanMetalProvider({ machines: [machines[0]!, machines[0]!] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });

  it("offers the account's unclaimed machines; an unreachable one is unavailable", async () => {
    const { ssh, hosts } = fakeSsh();
    const compute = await build({ ssh });
    expect((await compute.listOffers({})).map((o) => [o.id, o.available])).toEqual([
      ['bm-h100-1', true],
      ['bm-h100-2', true],
    ]);
    expect(await compute.listOffers({ kind: 'vps' })).toEqual([]);
    expect((await compute.listOffers({ minGpus: 8, gpuModel: 'h100' })).length).toBe(2);
    expect(await compute.listOffers({ gpuModel: 'MI300X' })).toEqual([]);
    hosts.get('198.51.100.11')!.down = true;
    hosts.get('198.51.100.10')!.files.set(bareMetalClaimPath, 'someone-else\n');
    expect((await compute.listOffers({})).map((o) => [o.id, o.available])).toEqual([
      ['bm-h100-2', false],
    ]);
  });

  it('claims atomically and idempotently; a second claimer gets CONFLICT', async () => {
    const { ssh, hosts, runs } = fakeSsh();
    const compute = await build({ ssh });
    const machine = await compute.create(createRequest(), call('inst_1'));
    expect(machine).toMatchObject({
      id: 'bm-h100-1',
      state: 'running',
      region: 'nyc3',
      addresses: ['198.51.100.10'],
      gpus: { model: 'H100', count: 8 },
    });
    const claim = bareMetalClaim('default', 'inst_1');
    expect(hosts.get('198.51.100.10')!.files.get(bareMetalClaimPath)).toBe(`${claim}\n`);
    // The claim travels on stdin; the host key pin and the resolved key reach the executor.
    const write = runs.find((r) => r.command === claimCommand)!;
    expect(write.stdin).toBe(`${claim}\n`);
    expect(write.target).toMatchObject({
      host: '198.51.100.10',
      username: 'root',
      hostKeySha256: `SHA256:${'h'.repeat(43)}`,
    });
    expect((await compute.create(createRequest(), call('inst_1'))).id).toBe('bm-h100-1');
    const lost = await failure(compute.create(createRequest(), call('inst_2')));
    expect([lost.code, lost.details?.reason]).toEqual(['CONFLICT', 'claimed']);
    expect(hosts.get('198.51.100.10')!.files.get(bareMetalClaimPath)).toBe(`${claim}\n`);
  });

  it('a machine outside the list or the account regions is NOT_FOUND', async () => {
    const { ssh, runs } = fakeSsh();
    const compute = await build({ ssh });
    for (const offerId of ['bm-ams', 'nope']) {
      const error = await failure(compute.create(createRequest(offerId), call()));
      expect(error.code).toBe('NOT_FOUND');
    }
    expect(runs).toHaveLength(0);
  });

  it("get and list see only this deployment's claims", async () => {
    const { ssh, hosts } = fakeSsh();
    const compute = await build({ ssh });
    await compute.create(createRequest(), call('inst_1'));
    hosts
      .get('198.51.100.11')!
      .files.set(bareMetalClaimPath, `${bareMetalClaim('other', 'inst_9')}\n`);
    expect((await compute.get('bm-h100-1', call()))?.id).toBe('bm-h100-1');
    expect(await compute.get('bm-h100-2', call())).toBeUndefined();
    expect(await compute.get('nope', call())).toBeUndefined();
    const listed: string[] = [];
    for await (const machine of compute.list!(call())) listed.push(machine.id);
    expect(listed).toEqual(['bm-h100-1']);
  });

  it("delete releases this deployment's claim only; the machine stays", async () => {
    const { ssh, hosts } = fakeSsh();
    const compute = await build({ ssh });
    await compute.create(createRequest(), call('inst_1'));
    hosts.get('198.51.100.10')!.files.set(bareMetalJoinTokenPath, 'tok');
    await compute.delete('bm-h100-1', call());
    expect(hosts.get('198.51.100.10')!.files.has(bareMetalClaimPath)).toBe(false);
    expect(hosts.get('198.51.100.10')!.files.has(bareMetalJoinTokenPath)).toBe(false);
    await compute.delete('bm-h100-1', call()); // already released: done

    hosts.get('198.51.100.11')!.files.set(bareMetalClaimPath, 'manual-use\n');
    const refused = await failure(compute.delete('bm-h100-2', call()));
    expect([refused.code, refused.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    expect(hosts.get('198.51.100.11')!.files.get(bareMetalClaimPath)).toBe('manual-use\n');
  });

  it('only a reboot is a power action, and only on a claimed machine', async () => {
    const { ssh, runs } = fakeSsh();
    const compute = await build({ ssh });
    for (const action of ['on', 'off', 'graceful-off', 'reset', 'cycle', 'nmi'] as const) {
      const error = await failure(compute.power!('bm-h100-1', action, call()));
      expect([error.code, error.details?.reason]).toEqual(['UNSUPPORTED', 'noBmc']);
    }
    const unclaimed = await failure(compute.power!('bm-h100-1', 'graceful-restart', call()));
    expect(unclaimed.details?.reason).toBe('notManaged');
    await compute.create(createRequest(), call('inst_1'));
    await compute.power!('bm-h100-1', 'graceful-restart', call());
    expect(runs.filter((r) => r.command === rebootCommand)).toHaveLength(1);
  });

  it('identify reads the SMBIOS UUID of a claimed machine', async () => {
    const { ssh } = fakeSsh();
    const compute = await build({ ssh });
    const machine = await compute.create(createRequest(), call('inst_1'));
    expect(await compute.identify!(machine, call())).toEqual({ productUuid: uuid });
  });

  it('bootstrap delivers the token over stdin only and installs a pinned bcd', async () => {
    const { ssh, hosts, runs } = fakeSsh();
    const compute = await build({ ssh });
    const machine = await compute.create(createRequest(), call('inst_1'));
    const joinToken = 'bcjt_SECRET_JOIN_TOKEN';
    await compute.bootstrap!(
      machine,
      {
        joinToken,
        bcdUrl: 'https://releases.example.test/bcd-linux-amd64',
        sha256: 'f'.repeat(64),
        controlPlaneUrl: 'https://cp.example.test',
        pins,
      },
      call(),
    );
    const files = hosts.get('198.51.100.10')!.files;
    expect(files.get(bareMetalJoinTokenPath)).toBe(joinToken);
    const script = files.get('install-script')!;
    expect(script).toContain(`${'f'.repeat(64)}  /usr/local/bin/bcd.new`);
    expect(script).toContain('--attestor provisioned');
    expect(script).toContain(`--serving-ca-pin ${pins.servingCa}`);
    expect(script).not.toContain(joinToken);
    // The token is the stdin of the token write only: never a command, never another stdin.
    for (const run of runs) {
      expect(run.command).not.toContain(joinToken);
      if (run.command !== writeTokenCommand) expect(run.stdin ?? '').not.toContain(joinToken);
    }
  });

  it('bootstrap refuses missing pins, a bad digest or URL, and an unclaimed machine', async () => {
    const { ssh, runs } = fakeSsh();
    const compute = await build({ ssh });
    const base = {
      joinToken: 't',
      bcdUrl: 'https://releases.example.test/bcd',
      sha256: 'f'.repeat(64),
      controlPlaneUrl: 'https://cp.example.test',
      pins,
    };
    const machine = { id: 'bm-h100-1', state: 'running' as const, addresses: [] };
    const cases: [Record<string, unknown>, string][] = [
      [{ pins: undefined }, 'pins'],
      [{ controlPlaneUrl: 'http://cp.example.test' }, 'controlPlaneUrl'],
      [{ sha256: 'abc' }, 'sha256'],
      [{ bcdUrl: "https://x.test/a'b" }, 'bcdUrl'],
    ];
    for (const [over, reason] of cases) {
      const error = await failure(
        compute.bootstrap!(machine, { ...base, ...over } as never, call()),
      );
      expect(error.details?.reason, reason).toBe(reason);
    }
    expect(runs).toHaveLength(0);
    const unclaimed = await failure(compute.bootstrap!(machine, base, call()));
    expect(unclaimed.details?.reason).toBe('notManaged');
    expect(runs.some((r) => r.command === writeTokenCommand)).toBe(false);
  });

  it('an unreachable machine is UNAVAILABLE and the error carries no key or target detail', async () => {
    const { ssh, hosts } = fakeSsh();
    const compute = await build({ ssh });
    hosts.get('198.51.100.10')!.down = true;
    const error = await failure(compute.create(createRequest(), call()));
    expect([error.code, error.details?.reason]).toEqual(['UNAVAILABLE', 'ssh']);
    const text = JSON.stringify({ message: error.message, details: error.details });
    expect(text).not.toContain('TESTKEYMATERIAL');
    expect(text).not.toContain('/root/.ssh');
  });

  it('without an ssh executor every machine call is INVALID_CONFIG', async () => {
    const compute = await build({});
    const error = await failure(compute.create(createRequest(), call()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_CONFIG', 'ssh']);
  });
});
