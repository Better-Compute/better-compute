import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCertificate, spkiPin } from '@better-compute/pki';
import { provisionModule } from '@better-compute/provision';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import { createDevStack, type DevStack } from '@better-compute/testing';

// PLAN §3.8 against the real Go daemon: fakehw bcd nodes joined to one dev stack.
//  - V, a VPS host whose pool overcommits memory (guests get a balloon) and reserves 2 MiB hugepages
//    (provision's host unit; the fakehw inventory reports what it reserved). Its fake runtime writes
//    the libvirt domain bcd would define (fakehw-plans/<id>.xml), which the test reads: vCPU pinning,
//    NUMA binding, hugepage backing, the balloon, volumes by serial. Under simulated memory pressure
//    (the fake root's /proc/meminfo) bcd inflates the balloon, and deflates it once there is room.
//  - F, a host of a pool that runs the firecracker plugin, which F does not have: an instance there
//    stays Unschedulable (the bc.dev/driver.firecracker label is missing).
//  - G, a GPU node: a reservation with booked vCPUs and memory gets its bcd-alloc-<id>.slice, the
//    AllocationBound's cgroup_parent, which reservations.get returns as binding.cgroupParent.
// Same WSL/Linux gating as bcd.test.ts.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonDir = join(repo, 'daemon');
const binary = join(daemonDir, 'bin', 'bcd-linux-amd64');
const distro = process.env.BCD_WSL_DISTRO ?? 'Ubuntu';
const windows = process.platform === 'win32';
const goBinary = windows ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go';
const hasGo = spawnSync(goBinary, ['version'], { stdio: 'ignore' }).status === 0;
const hasWsl =
  windows && spawnSync('wsl.exe', ['-d', distro, '-e', 'true'], { stdio: 'ignore' }).status === 0;
const enabled = windows
  ? process.env.BCD_E2E === '1' && hasWsl && (hasGo || existsSync(binary))
  : process.platform === 'linux' && hasGo;

const toLinux = (path: string) =>
  windows ? `/mnt/${path[0]!.toLowerCase()}${path.slice(2).split('\\').join('/')}` : path;
const linux = (args: string[]) =>
  windows
    ? { cmd: 'wsl.exe', args: ['-d', distro, '-e', ...args] }
    : { cmd: args[0]!, args: args.slice(1) };
function sh(script: string): string {
  const { cmd, args } = linux(['sh', '-c', script]);
  return (spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '').trim();
}
function runLinux(
  argv: string[],
  input?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cmd, args } = linux(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Parses the kernel's cpulist form ("2-3,8"). */
function cpuList(list: string): number[] {
  return list.split(',').flatMap((part) => {
    const [lo, hi] = part.split('-').map(Number);
    return Array.from({ length: (hi ?? lo!) - lo! + 1 }, (_, i) => lo! + i);
  });
}

const QCOW2 = {
  url: 'https://images.example/base.qcow2',
  sha256: 'ab'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const RAW = {
  url: 'https://images.example/base.raw',
  sha256: 'cd'.repeat(32),
  format: 'raw' as const,
  verified: true,
};
const GiB = 2 ** 30;

interface Bcd {
  name: string;
  nodeId: string;
  dataDir: string;
  config: string;
  process?: ChildProcess;
  log: string;
}

let dev: DevStack;
let api: any;
let host: string;
let configDir: string;
const nodes: Bcd[] = [];
let vpsPoolId: string;
let firecrackerPoolId: string;
let gpuPoolId: string;
let V: Bcd;
let F: Bcd;
let G: Bcd;

const tenantId = () => dev.rootTenantId;
const logOf = (n: Bcd) => `\n--- bcd ${n.name} log ---\n${n.log.slice(-4000)}`;
const plan = (n: Bcd, instanceId: string) =>
  sh(`cat '${n.dataDir}/fakehw-plans/${instanceId}.xml' 2>/dev/null`);
const domains = (n: Bcd) =>
  JSON.parse(sh(`cat '${n.dataDir}/fakehw-runtime.json' 2>/dev/null || echo '{}'`)).domains ?? {};
const balloons = (n: Bcd): Record<string, number> =>
  JSON.parse(sh(`cat '${n.dataDir}/fakehw-runtime.json.balloons' 2>/dev/null || echo '{}'`));
const specOf = async (nodeId: string) =>
  (await dev.database.query<{ spec: any }>('SELECT spec FROM nodes WHERE id = $1', [nodeId]))
    .rows[0]!.spec;

/** Joins a fakehw bcd (seed) to a pool and runs `bcd node`; prepare runs between the two. */
async function joinBcd(
  name: string,
  poolId: string,
  seed: number,
  prepare?: (dataDir: string) => void,
): Promise<Bcd> {
  const token = (
    await api.joinTokens.create(dev.root, {
      tenantId: tenantId(),
      poolId,
      ttlSeconds: 3600,
      maxUses: 1,
      idempotencyKey: `bcd-placement-${name}-${Date.now()}`,
    })
  ).token;
  const url = new URL(dev.externalGatewayUrl!);
  url.hostname = host;
  const dataDir = `/tmp/bcd-placement-${name}-${randomBytes(6).toString('hex')}`;
  const config = join(configDir, `${name}.toml`);
  const pin = (der: Uint8Array) => spkiPin(parseCertificate(der).publicKey);
  writeFileSync(
    config,
    [
      `gateway_url = "${url.origin}"`,
      `gateway_server_name = "gw.dev.local"`,
      `site = "dev"`,
      `serving_ca_spki_pin = "${pin(dev.servingCaCertificate!)}"`,
      `join_signing_key_pin = "${spkiPin(createPublicKey({ key: dev.pins.joinSigningKey as any, format: 'jwk' }))}"`,
      `join_encryption_key_pin = "${spkiPin(createPublicKey({ key: dev.pins.joinEncryptionJwk as any, format: 'jwk' }))}"`,
      `data_dir = "${dataDir}"`,
      `socket_path = "${dataDir}/bcd.sock"`,
      '',
      '[log]',
      'level = "debug"',
      'json = false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const node: Bcd = { name, nodeId: '', dataDir, config, log: '' };
  nodes.push(node);
  const joined = await runLinux(
    ['env', `BCD_FAKEHW_SEED=${seed}`, toLinux(binary), 'join', '--config', toLinux(config)],
    `${token}\n`,
  );
  if (joined.status !== 0) throw new Error(`bcd join (${name}): ${joined.stderr}`);
  node.nodeId = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
  prepare?.(dataDir);
  const { cmd, args } = linux([
    'env',
    `BCD_FAKEHW_SEED=${seed}`,
    toLinux(binary),
    'node',
    '--config',
    toLinux(config),
  ]);
  node.process = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  node.process.stderr!.on('data', (chunk: Buffer) => {
    node.log += chunk.toString();
    if (process.env.BCD_E2E_LOG) process.stderr.write(`[${name}] ${chunk}`);
  });
  await dev.waitFor([node.nodeId], { timeoutMs: 120_000 }).catch((error) => {
    throw new Error(`${error}${logOf(node)}`);
  });
  return node;
}

async function hostResource(nodeId: string, resource: string): Promise<boolean> {
  const { rows } = await dev.database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM node_resources WHERE node_id = $1 AND resource = $2`,
    [nodeId, resource],
  );
  return rows[0]!.count === 1;
}

async function running(instanceId: string, node: Bcd) {
  return until(
    `instance ${instanceId} running`,
    async () => {
      const i = await api.instances.get(dev.root, { tenantId: tenantId(), instanceId });
      return i.state === 'running' ? i : undefined;
    },
    120_000,
  ).catch((error) => {
    throw new Error(`${error}${logOf(node)}`);
  });
}

describe.skipIf(!enabled)(
  'bcd: placement, balloons, volumes, capability labels and hold slices (PLAN §3.8)',
  () => {
    beforeAll(async () => {
      if (hasGo) {
        const built = spawnSync(
          goBinary,
          ['build', '-tags', 'nonvml,fakehw', '-o', 'bin/bcd-linux-amd64', './cmd/bcd'],
          {
            cwd: daemonDir,
            env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
            encoding: 'utf8',
          },
        );
        if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
      }
      host = windows ? sh("ip route show default | awk '{print $3}'") : '127.0.0.1';
      dev = await createDevStack({
        externalTls: { host: '0.0.0.0' },
        modules: [
          provisionModule(),
          vps({
            images: {
              resolve: async (_tx: unknown, _tenant: string, imageId: string) =>
                imageId === 'raw' ? RAW : QCOW2,
            },
            hostSyncEvery: '1s',
            runtimes: ['libvirt-kvm', 'firecracker'],
          } as any),
        ],
        reports: { status: instanceStatusHandler({ log: () => {} }) },
      });
      api = dev.compute.api;
      configDir = mkdtempSync(join(tmpdir(), 'bcd-placement-'));
      const site = await api.sites.create(dev.root, {
        tenantId: tenantId(),
        kind: 'shared',
        region: 'dev-1',
        idempotencyKey: 'bcd-placement-site',
      });
      const vpsPool = await api.pools.create(dev.root, {
        tenantId: tenantId(),
        siteId: site.id,
        class: 'vps-host',
        policy: { overcommit: { memoryGiB: 2 }, hugepages: { size: '2Mi', count: 4096 } },
        ownerQuota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 100_000 },
        idempotencyKey: 'bcd-placement-vps',
      });
      vpsPoolId = vpsPool.id;
      await setIpPool(dev.database, {
        poolId: vpsPoolId,
        cidr: '10.78.0.0/24',
        gateway: '10.78.0.1',
      });
      const flavor = (poolId: string, name: string, extra: object = {}) =>
        api.flavors.create(dev.root, {
          tenantId: tenantId(),
          poolId,
          name,
          vcpu: 2,
          memoryGiB: 4,
          diskGiB: 40,
          ...extra,
        });
      await flavor(vpsPoolId, 's');
      await flavor(vpsPoolId, 'pinned', { placement: { pinned: true, numaAffine: true } });
      await flavor(vpsPoolId, 'huge', { placement: { hugepages: '2Mi' } });

      const fcPool = await api.pools.create(dev.root, {
        tenantId: tenantId(),
        siteId: site.id,
        class: 'vps-host',
        policy: { runtime: 'firecracker' },
        ownerQuota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 100_000 },
        idempotencyKey: 'bcd-placement-fc',
      });
      firecrackerPoolId = fcPool.id;
      await setIpPool(dev.database, {
        poolId: firecrackerPoolId,
        cidr: '10.79.0.0/24',
        gateway: '10.79.0.1',
      });
      await flavor(firecrackerPoolId, 's');

      ({ poolId: gpuPoolId } = await dev.createPool({
        key: 'bcd-placement-gpu',
        expectGpuCount: 8,
      }));
      await api.pools.offer(dev.root, {
        tenantId: tenantId(),
        poolId: gpuPoolId,
        toTenantId: tenantId(),
        quota: { gpu: 16, vcpu: 512, memoryGiB: 4096 },
      });

      writeFileSync(
        join(configDir, 'join-encryption.jwk'),
        JSON.stringify(dev.pins.joinEncryptionJwk),
      );
      // V's kernel: an empty 2 MiB hugepage pool, which provision's hugepages unit fills.
      V = await joinBcd('v', vpsPoolId, 78, (dir) =>
        sh(
          `mkdir -p '${dir}/fakehw-root/sys/kernel/mm/hugepages/hugepages-2048kB' && echo 0 > '${dir}/fakehw-root/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages'`,
        ),
      );
      F = await joinBcd('f', firecrackerPoolId, 79);
      G = await joinBcd('g', gpuPoolId, 80);
      await until('V offers capacity', () => hostResource(V.nodeId, 'vcpu'), 90_000).catch(
        async (error) => {
          const state = await dev.database.query(
            `SELECT n.provision_state, n.trust, n.connectivity, ni.applied_snapshot_id, ni.reported_hashes, n.spec->'host' AS host,
                (SELECT json_agg(r) FROM node_resources r WHERE r.node_id = n.id) AS resources,
                (SELECT json_agg(s.section) FROM node_inventory_sections s WHERE s.node_id = n.id) AS stored,
                (SELECT count(*) FROM inventory_snapshots s WHERE s.node_id = n.id) AS snapshots,
                (SELECT json_agg(c) FROM node_conditions c WHERE c.node_id = n.id) AS conditions
           FROM nodes n LEFT JOIN node_inventory ni ON ni.node_id = n.id WHERE n.id = $1`,
            [V.nodeId],
          );
          const { applyInventory } = await import('@better-compute/inventory');
          const applied = await applyInventory(dev.database as any, V.nodeId).then(
            (r: unknown) => JSON.stringify(r).slice(0, 500),
            (e: Error) => `apply threw: ${e.stack}`,
          );
          throw new Error(`${error}: ${applied}\n${JSON.stringify(state.rows)}${logOf(V)}`);
        },
      );
    }, 480_000);

    afterAll(async () => {
      for (const n of nodes) {
        sh(`pkill -f '${toLinux(n.config)}' ; true`);
        n.process?.kill();
        sh(`rm -rf '${n.dataDir}'`);
      }
      if (configDir) rmSync(configDir, { recursive: true, force: true });
      await dev?.close();
    }, 60_000);

    it('pins a pinned, NUMA-affine flavor to its CPUs and NUMA node in the libvirt domain', async () => {
      const instance = await api.instances.create(dev.root, {
        tenantId: tenantId(),
        poolId: vpsPoolId,
        flavor: 'pinned',
        imageId: 'base',
        idempotencyKey: 'bcd-placement-pinned',
      });
      expect(instance.nodeId).toBe(V.nodeId);
      await running(instance.id, V);
      const wired = (await specOf(V.nodeId)).instances.instances.find(
        (i: any) => i.instanceId === instance.id,
      );
      const cpus = cpuList(wired.placement.cpus);
      expect(cpus).toHaveLength(2);
      expect(wired.placement.mems).toMatch(/^[01]$/);
      const xml = plan(V, instance.id);
      cpus.forEach((cpu, vcpu) =>
        expect(xml).toContain(`<vcpupin vcpu="${vcpu}" cpuset="${cpu}">`),
      );
      expect(xml).toContain(`mode="strict" nodeset="${wired.placement.mems}"`);
      // The fakehw host keeps CPUs 0-1 for itself (hostReserve), and both CPUs lie in the NUMA node.
      const numa =
        wired.placement.mems === '0' ? cpuList('0-55,112-167') : cpuList('56-111,168-223');
      for (const cpu of cpus) {
        expect(cpu).toBeGreaterThanOrEqual(2);
        expect(numa).toContain(cpu);
      }
    }, 200_000);

    it('backs a hugepage flavor with the 2 MiB pages the host unit reserved, and gives it no balloon', async () => {
      await until(
        'V books hugepages2Mi',
        () => hostResource(V.nodeId, 'hugepages2Mi'),
        120_000,
      ).catch((error) => {
        throw new Error(`${error}${logOf(V)}`);
      });
      expect(
        sh(`cat '${V.dataDir}/fakehw-root/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages'`),
      ).toBe('4096');
      const instance = await api.instances.create(dev.root, {
        tenantId: tenantId(),
        poolId: vpsPoolId,
        flavor: 'huge',
        imageId: 'base',
        idempotencyKey: 'bcd-placement-huge',
      });
      await running(instance.id, V);
      const wired = (await specOf(V.nodeId)).instances.instances.find(
        (i: any) => i.instanceId === instance.id,
      );
      expect(wired.placement.hugepageSizeBytes).toBe(String(2 * 2 ** 20));
      expect(wired.placement.balloon).toBeFalsy();
      const xml = plan(V, instance.id);
      expect(xml).toContain('<page size="2048" unit="KiB">');
      expect(xml).toContain('<locked>');
      expect(xml).toContain('<memballoon model="none">');
    }, 200_000);

    it('balloons a guest of an overcommitted pool under memory pressure, never below its floor, and gives it back', async () => {
      const instance = await api.instances.create(dev.root, {
        tenantId: tenantId(),
        poolId: vpsPoolId,
        flavor: 's',
        imageId: 'base',
        idempotencyKey: 'bcd-placement-balloon',
      });
      await running(instance.id, V);
      const wired = (await specOf(V.nodeId)).instances.instances.find(
        (i: any) => i.instanceId === instance.id,
      );
      expect(wired.placement).toEqual({ balloon: true });
      expect(plan(V, instance.id)).toContain('<memballoon model="virtio">');

      const meminfo = (availableGiB: number) =>
        sh(
          `mkdir -p '${V.dataDir}/fakehw-root/proc' && printf 'MemTotal:       ${64 * 2 ** 20} kB\\nMemAvailable:   ${availableGiB * 2 ** 20} kB\\n' > '${V.dataDir}/fakehw-root/proc/meminfo'`,
        );
      // 1 GiB of 64 available: bcd reclaims. The fake reports the guest using half its 4 GiB, so it
      // stops at its use plus 10% headroom (2.4 GiB), above the 50% floor.
      meminfo(1);
      const floor = 2 * GiB + Math.floor(0.1 * 4 * GiB);
      await until(
        'the balloon inflated to its floor',
        async () => balloons(V)[instance.id] === floor,
        180_000,
      ).catch((error) => {
        throw new Error(`${error}: ${JSON.stringify(balloons(V))}${logOf(V)}`);
      });
      // Only guests with a balloon were touched: no hugepage guest, no pinned guest without one.
      const withBalloon = new Set(
        (await specOf(V.nodeId)).instances.instances
          .filter((i: any) => i.placement?.balloon)
          .map((i: any) => i.instanceId),
      );
      for (const id of Object.keys(balloons(V))) expect(withBalloon.has(id)).toBe(true);
      // Room again: it deflates back to its full memory.
      meminfo(60);
      await until(
        'the balloon deflated',
        async () => balloons(V)[instance.id] === 4 * GiB,
        180_000,
      ).catch((error) => {
        throw new Error(`${error}: ${JSON.stringify(balloons(V))}${logOf(V)}`);
      });
    }, 420_000);

    it('attaches a sandbox volume by its serial and removes the domain when the sandbox is deleted', async () => {
      const volume = await api.sandboxVolumes.create(dev.root, {
        tenantId: tenantId(),
        poolId: vpsPoolId,
        name: 'mem',
        sizeGiB: 1,
        idempotencyKey: 'bcd-placement-vol',
      });
      expect(volume.nodeId).toBe(V.nodeId);
      const template = await api.sandboxTemplates.create(dev.root, {
        tenantId: tenantId(),
        name: 'agent',
        poolId: vpsPoolId,
        flavor: 's',
        imageId: 'base',
        volumes: [{ volumeId: volume.id, mountPath: '/data' }],
      });
      const sandbox = await api.sandboxes.create(dev.root, {
        tenantId: tenantId(),
        templateId: template.id,
        idempotencyKey: 'bcd-placement-sbx',
      });
      await until(
        'the sandbox ready',
        async () =>
          (await api.sandboxes.get(dev.root, { tenantId: tenantId(), sandboxId: sandbox.id }))
            .state === 'ready',
        120_000,
      ).catch((error) => {
        throw new Error(`${error}${logOf(V)}`);
      });
      expect(sh(`test -f '${V.dataDir}/volumes/${volume.id}.raw' && echo yes`)).toBe('yes');
      const xml = plan(V, sandbox.instanceId);
      expect(xml).toContain(`<serial>${volume.serial}</serial>`);
      expect(xml).toContain(`${volume.id}.raw`);
      expect(domains(V)[sandbox.instanceId].volumes.map((v: any) => v.ID)).toEqual([volume.id]);

      await api.sandboxes.delete(dev.root, { tenantId: tenantId(), sandboxId: sandbox.id });
      await until(
        'the domain and its plan removed',
        async () => !(sandbox.instanceId in domains(V)) && plan(V, sandbox.instanceId) === '',
        90_000,
      );
      // The volume outlives the sandbox until it is deleted itself.
      expect(sh(`test -f '${V.dataDir}/volumes/${volume.id}.raw' && echo yes`)).toBe('yes');
    }, 300_000);

    it('keeps an instance Unschedulable on a host without its runtime plugin (bc.dev/driver.firecracker)', async () => {
      const instance = await api.instances.create(dev.root, {
        tenantId: tenantId(),
        poolId: firecrackerPoolId,
        flavor: 's',
        imageId: 'raw',
        idempotencyKey: 'bcd-placement-fc',
      });
      expect(instance.nodeId).toBeUndefined();
      await sleep(5_000);
      const current = await api.instances.get(dev.root, {
        tenantId: tenantId(),
        instanceId: instance.id,
      });
      expect(current.state).toBe('scheduling');
      expect(current.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'Unschedulable', reason: 'NoFit' }),
        ]),
      );
      expect(Object.keys(domains(F))).toHaveLength(0);
    }, 60_000);

    it("binds a hold with booked vCPUs and memory to its bcd-alloc slice (the AllocationBound's cgroup parent)", async () => {
      const created = await api.reservations.create(dev.root, {
        tenantId: tenantId(),
        poolId: gpuPoolId,
        devices: [{ class: 'gpu', count: 2 }],
        resources: { vcpu: 16, memoryGiB: 64 },
        duration: '1h',
        idempotencyKey: 'bcd-placement-hold',
      });
      const active = await until(
        'the reservation active with a cgroup parent',
        async () => {
          const r = await api.reservations.get(dev.root, {
            tenantId: tenantId(),
            reservationId: created.id,
          });
          return r.state === 'active' && r.binding?.cgroupParent ? r : undefined;
        },
        120_000,
      ).catch((error) => {
        throw new Error(`${error}${logOf(G)}`);
      });
      const { rows } = await dev.database.query<{ id: string }>(
        `SELECT id FROM allocations WHERE owner_kind = 'reservation' AND owner_id = $1`,
        [created.id],
      );
      const allocationId = rows[0]!.id;
      expect(active.binding.cgroupParent).toBe(`bcd-alloc-${allocationId}.slice`);
      const sliceFile = `${G.dataDir}/fakehw-root/run/bcd/slices/bcd-alloc-${allocationId}.slice.json`;
      const slice = JSON.parse(sh(`cat '${sliceFile}'`));
      // Booked: at least what was asked, bound to the GPUs' NUMA node.
      expect(slice.cpuMillis).toBeGreaterThanOrEqual(16_000);
      expect(slice.memoryBytes).toBeGreaterThanOrEqual(64 * GiB);
      expect(slice.cpus).toBeTruthy();

      await api.reservations.release(dev.root, { tenantId: tenantId(), reservationId: created.id });
      await until(
        'the slice removed',
        async () => sh(`test -e '${sliceFile}' && echo held || echo gone`) === 'gone',
        60_000,
      );
    }, 200_000);
  },
);
