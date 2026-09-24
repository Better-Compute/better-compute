import { describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ProviderImpl } from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import {
  hasUserData,
  managedTag,
  parseOffer,
  proxmox,
  proxmoxProvider,
  toMachine,
  vmidFor,
  vmName,
  type ProxmoxOptions,
} from '@better-compute/provider-proxmox';

// Proxmox VE against an in-memory emulator of the endpoints the provider uses (cluster resources, clone,
// config, resize, status, tasks, the guest agent), plugged in through the provider's `fetch` option: the
// generic providerConformance suite plus PVE specifics (VMID slots, races, tasks, safety, offers).

interface EmulatedVm {
  vmid: number;
  name: string;
  node: string;
  status: 'running' | 'stopped';
  template: 0 | 1;
  tags: string;
  lock?: string;
  description: string;
  cores: number;
  memory: number;
  config: Record<string, string>;
  disk?: string;
  agent?: string[];
}

interface Task {
  node: string;
  polls: number;
  exitstatus: string;
  apply: () => void;
}

const TOKEN = 'root@pam!bc=s3cret';

class PveEmulator {
  vms = new Map<number, EmulatedVm>();
  tasks = new Map<string, Task>();
  nodes = [
    { node: 'pve1', status: 'online', maxcpu: 32, maxmem: 128 * 2 ** 30, mem: 16 * 2 ** 30 },
    { node: 'pve2', status: 'online', maxcpu: 8, maxmem: 16 * 2 ** 30, mem: 14 * 2 ** 30 },
    { node: 'pve3', status: 'offline', maxcpu: 128, maxmem: 1024 * 2 ** 30, mem: 0 },
  ];
  requests: { method: string; path: string; body: Record<string, string> }[] = [];
  /** How many status polls a task takes to finish. */
  taskPolls = 1;
  /** Runs before a clone is accepted (race injection). */
  beforeClone?: (newid: number) => void;
  /** The next task's exit status. */
  failNextTask?: string;
  private upids = 0;

  constructor() {
    this.vms.set(9000, this.vm({ vmid: 9000, name: 'ubuntu-24.04', template: 1, disk: '10G' }));
    this.vms.set(9001, this.vm({ vmid: 9001, name: 'debian-12', node: 'pve2', template: 1 }));
    this.vms.set(100, this.vm({ vmid: 100, name: 'operators-db', status: 'running' }));
  }

  vm(fields: Partial<EmulatedVm> & { vmid: number; name: string }): EmulatedVm {
    return {
      node: 'pve1',
      status: 'stopped',
      template: 0,
      tags: '',
      description: '',
      cores: 1,
      memory: 1024,
      config: {},
      ...fields,
    };
  }

  /** Finishes every outstanding task (the start that `create` does not wait for). */
  settle(): void {
    for (const task of this.tasks.values()) {
      if (task.exitstatus === 'OK') task.apply();
      task.apply = () => {};
      task.polls = 0;
    }
  }

  task(node: string, apply: () => void): string {
    const upid = `UPID:${node}:0000${++this.upids}:qm:`;
    const exitstatus = this.failNextTask ?? 'OK';
    delete this.failNextTask;
    this.tasks.set(upid, { node, polls: this.taskPolls, exitstatus, apply });
    return upid;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    const path = url.pathname.replace(/^\/api2\/json/, '');
    this.requests.push({ method, path, body });
    if (headers.get('authorization') !== `PVEAPIToken=${TOKEN}`)
      return this.fail(401, 'authentication failure');
    if (method === 'GET' && path === '/cluster/resources') {
      const type = url.searchParams.get('type');
      if (type === 'node') return this.ok(this.nodes.map((node) => ({ type: 'node', ...node })));
      return this.ok(
        [...this.vms.values()].map((vm) => ({
          type: 'qemu',
          vmid: vm.vmid,
          name: vm.name,
          node: vm.node,
          status: vm.status,
          template: vm.template,
          ...(vm.tags ? { tags: vm.tags } : {}),
          ...(vm.lock ? { lock: vm.lock } : {}),
        })),
      );
    }
    let match = /^\/nodes\/([^/]+)\/tasks\/([^/]+)\/status$/.exec(path);
    if (match && method === 'GET') {
      const task = this.tasks.get(decodeURIComponent(match[2]!));
      if (!task) return this.fail(500, 'no such task');
      if (task.polls-- > 0) return this.ok({ status: 'running' });
      if (task.exitstatus === 'OK') task.apply();
      task.apply = () => {};
      return this.ok({ status: 'stopped', exitstatus: task.exitstatus });
    }
    match = /^\/nodes\/([^/]+)\/qemu\/(\d+)(?:\/(.+))?$/.exec(path);
    if (!match) return this.fail(501, `Method '${method} ${path}' not implemented`);
    const [, node, id, rest] = match;
    const vm = this.vms.get(Number(id));
    if (!vm || vm.node !== node)
      return this.fail(
        500,
        `Configuration file 'nodes/${node}/qemu-server/${id}.conf' does not exist`,
      );
    if (rest === 'clone' && method === 'POST') {
      const newid = Number(body.newid);
      this.beforeClone?.(newid);
      if (this.vms.has(newid))
        return this.fail(500, `unable to create VM ${newid}: config file already exists`);
      const clone = this.vm({
        vmid: newid,
        name: body.name!,
        node: body.target ?? vm.node,
        lock: 'clone',
        description: body.description ?? '',
        ...(vm.disk ? { disk: vm.disk } : {}),
      });
      this.vms.set(newid, clone);
      return this.ok(this.task(vm.node, () => delete clone.lock));
    }
    if (vm.lock && method !== 'GET') return this.fail(500, `VM is locked (${vm.lock})`);
    if (rest === 'config' && method === 'GET')
      return this.ok({
        ...vm.config,
        name: vm.name,
        description: vm.description,
        cores: vm.cores,
        memory: String(vm.memory),
        ...(vm.disk ? { scsi0: `local-lvm:vm-${vm.vmid}-disk-0,size=${vm.disk}` } : {}),
      });
    if (rest === 'config' && method === 'PUT') {
      if (body.tags !== undefined) vm.tags = body.tags;
      if (body.cores) vm.cores = Number(body.cores);
      if (body.memory) vm.memory = Number(body.memory);
      Object.assign(vm.config, body);
      return this.ok(null);
    }
    if (rest === 'resize' && method === 'PUT') {
      if (vm.disk && parseInt(vm.disk) > parseInt(body.size!))
        return this.fail(500, 'shrinking disks is not supported');
      vm.disk = body.size;
      return this.ok(null);
    }
    if (rest === 'agent/network-get-interfaces' && method === 'GET') {
      if (!vm.agent || vm.status !== 'running')
        return this.fail(500, 'QEMU guest agent is not running');
      return this.ok({
        result: [
          {
            name: 'lo',
            'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }],
          },
          {
            name: 'eth0',
            'ip-addresses': vm.agent.map((address) => ({
              'ip-address': address,
              'ip-address-type': address.includes(':') ? 'ipv6' : 'ipv4',
            })),
          },
        ],
      });
    }
    const status = /^status\/(\w+)$/.exec(rest ?? '');
    if (status && method === 'POST') {
      const command = status[1]!;
      if (command === 'start' && vm.status === 'running')
        return this.fail(500, `VM ${id} already running`);
      const next =
        command === 'start' || command === 'reboot' || command === 'reset' ? 'running' : 'stopped';
      return this.ok(this.task(vm.node, () => (vm.status = next)));
    }
    if (!rest && method === 'DELETE') {
      if (vm.status === 'running') return this.fail(500, `VM ${id} is running - destroy failed`);
      vm.lock = 'destroyed';
      return this.ok(this.task(vm.node, () => this.vms.delete(vm.vmid)));
    }
    return this.fail(501, `Method '${method} ${path}' not implemented`);
  };

  ok(data: unknown): Response {
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  fail(status: number, message: string): Response {
    return new Response(JSON.stringify({ data: null, message }), {
      status,
      statusText: message,
      headers: { 'content-type': 'application/json' },
    });
  }
}

const secrets = {
  resolve: async (ref: string) => {
    if (ref !== 'env://PVE_TOKEN') throw new Error(`unexpected secret ${ref}`);
    return TOKEN;
  },
};
const clock = { now: () => Date.UTC(2026, 8, 24, 12) };
const log = { debug() {}, info() {}, warn() {}, error() {} };
const baseConfig = { url: 'https://pve.test:8006', token: 'env://PVE_TOKEN' };
const immediate: ProxmoxOptions['sleep'] = async () => {};

async function client(
  api: PveEmulator,
  config: Record<string, unknown> = {},
  options: ProxmoxOptions = {},
): Promise<ProviderImpl> {
  const provider = proxmoxProvider({ fetch: api.fetch, sleep: immediate, ...options });
  const parsed = await provider.config['~standard'].validate({ ...baseConfig, ...config });
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return provider.create((parsed as { value: never }).value, { clock, secrets, log });
}

const call = (key: string): CallContext => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock,
  secrets,
  log,
});

const request = (name: string, offerId = '2c-4g') => ({
  offerId,
  image: 'ubuntu-24.04',
  userData: '#cloud-config\n',
  name,
});

describe('proxmox: providerConformance', () => {
  it('passes every case of the ProviderImpl contract', async () => {
    const report = await runConformance(providerConformanceCases(), () => ({
      provider: proxmoxProvider({ fetch: new PveEmulator().fetch, sleep: immediate }),
      config: baseConfig,
      offerId: '2c-4g',
      image: 'ubuntu-24.04',
      context: { secrets, clock },
    }));
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toHaveLength(providerConformanceCases().length);
  });

  it('is a well-formed definition whose config demands a secret reference', async () => {
    expect(proxmox).toMatchObject({ id: 'proxmox', provides: ['vps'], extension: 'provider' });
    const bad = await proxmox.config['~standard'].validate({ ...baseConfig, token: TOKEN });
    expect('issues' in bad && bad.issues?.length).toBeTruthy();
    const badOffer = await proxmox.config['~standard'].validate({
      ...baseConfig,
      offers: ['2 cores'],
    });
    expect('issues' in badOffer && badOffer.issues?.length).toBeTruthy();
    const good = await proxmox.config['~standard'].validate(baseConfig);
    expect(good).toMatchObject({
      value: {
        region: 'pve',
        fullClone: true,
        disk: 'scsi0',
        vmidMin: 100_000_000,
        vmidMax: 999_999_999,
        offers: ['1c-2g', '2c-4g', '4c-8g', '8c-32g'],
      },
    });
    await expect(client(new PveEmulator(), { vmidMin: 5000, vmidMax: 4000 })).rejects.toThrow(
      /above vmidMax/,
    );
  });
});

describe('proxmox helpers', () => {
  it('parses offers, names VMs, spots user data and maps states', async () => {
    expect(parseOffer('4c-16g-100d')).toEqual({ vcpu: 4, memoryGiB: 16, diskGiB: 100 });
    expect(parseOffer('2c-4g')).toEqual({ vcpu: 2, memoryGiB: 4 });
    expect(parseOffer('0c-4g')).toBeUndefined();
    expect(vmName('inst_01ABC')).toBe('inst-01abc');
    expect(vmName('___')).toBe('bc-vm');
    expect(hasUserData('#cloud-config\n\n# nothing\n')).toBe(false);
    expect(hasUserData('#cloud-config\nruncmd: [ls]\n')).toBe(true);
    const base = { type: 'qemu', vmid: 7, node: 'pve1' };
    expect(toMachine({ ...base, status: 'running' }, 'r').state).toBe('running');
    expect(toMachine({ ...base, status: 'paused' }, 'r').state).toBe('stopped');
    expect(toMachine({ ...base, status: 'stopped', lock: 'clone' }, 'r').state).toBe('pending');
    expect(toMachine({ ...base, status: 'stopped', lock: 'destroyed' }, 'r').state).toBe(
      'deleting',
    );
    expect(toMachine({ ...base, status: 'prelaunch' }, 'r').state).toBe('unknown');
    const slot = await vmidFor('inst_01abc', 1000, 1999);
    expect(slot).toBeGreaterThanOrEqual(1000);
    expect(slot).toBeLessThanOrEqual(1999);
    expect(await vmidFor('inst_01abc', 1000, 1999)).toBe(slot);
  });
});

describe('proxmox specifics', () => {
  it('clones into the key’s VMID slot, sizes, tags and starts it, then reports agent addresses', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    const machine = await impl.create(request('inst_01ABC', '4c-8g'), call('inst_01abc'));
    const vmid = await vmidFor('inst_01abc', 100_000_000, 999_999_999);
    expect(machine).toEqual({
      id: String(vmid),
      name: 'inst-01abc',
      state: 'pending',
      region: 'pve',
      addresses: [],
    });
    const clone = api.requests.find((entry) => entry.path.endsWith('/clone'))!;
    expect(clone).toMatchObject({
      path: '/nodes/pve1/qemu/9000/clone',
      body: {
        newid: String(vmid),
        name: 'inst-01abc',
        full: '1',
        description: 'better-compute-idempotency-key: inst_01abc',
      },
    });
    const vm = api.vms.get(vmid)!;
    expect(vm).toMatchObject({ cores: 4, memory: 8192, tags: managedTag, status: 'stopped' });
    expect(vm.config).toMatchObject({ ipconfig0: 'ip=dhcp' });
    expect(api.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `/nodes/pve1/qemu/${vmid}/status/start`,
    });
    // The start task finishes on PVE's time: the machine converges to running through get.
    api.settle();
    vm.agent = ['192.0.2.10', 'fe80::1', '2001:db8::10'];
    expect(await impl.get(machine.id, call('get'))).toMatchObject({
      state: 'running',
      addresses: ['192.0.2.10', '2001:db8::10'],
    });
  });

  it('a retried create finds the machine by its slot and never clones twice', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    const first = await impl.create(request('inst_02'), call('inst_02'));
    const again = await impl.create(request('inst_02'), call('inst_02'));
    expect(again.id).toBe(first.id);
    expect(api.requests.filter((entry) => entry.path.endsWith('/clone'))).toHaveLength(1);
  });

  it('concurrent creates under one key meet on one VMID: exactly one clone, both return it', async () => {
    const api = new PveEmulator();
    api.taskPolls = 3;
    const impl = await client(api);
    const [a, b] = await Promise.all([
      impl.create(request('inst_03'), call('inst_03')),
      impl.create(request('inst_03'), call('inst_03')),
    ]);
    expect(a.id).toBe(b.id);
    expect([...api.vms.values()].filter((vm) => vm.description.includes('inst_03'))).toHaveLength(
      1,
    );
  });

  it('probes past a slot that another key (or an operator VM) holds', async () => {
    const api = new PveEmulator();
    const impl = await client(api, { vmidMin: 5000, vmidMax: 5001 });
    const slot = await vmidFor('inst_04', 5000, 5001);
    api.vms.set(slot, api.vm({ vmid: slot, name: 'someone-else', description: 'hand made' }));
    const machine = await impl.create(request('inst_04'), call('inst_04'));
    expect(machine.id).toBe(String(slot === 5000 ? 5001 : 5000));
    // The range is now full of foreign or used slots: another key has nowhere to go.
    const other = await vmidFor('inst_05', 5000, 5001);
    expect(other === 5000 || other === 5001).toBe(true);
    await expect(impl.create(request('inst_05'), call('inst_05'))).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'CAPACITY_UNAVAILABLE'),
    );
  });

  it('retries a slot taken between its read and the clone, then finds whose it is', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    api.beforeClone = (newid) => {
      api.beforeClone = undefined;
      api.vms.set(
        newid,
        api.vm({
          vmid: newid,
          name: 'inst-06',
          description: 'better-compute-idempotency-key: inst_06',
          tags: managedTag,
        }),
      );
    };
    const machine = await impl.create(request('inst_06'), call('inst_06'));
    expect(machine.id).toBe(String(await vmidFor('inst_06', 100_000_000, 999_999_999)));
    expect(api.vms.size).toBe(4);
  });

  it('finishes a clone that was interrupted before configuration', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    const vmid = await vmidFor('inst_07', 100_000_000, 999_999_999);
    api.vms.set(
      vmid,
      api.vm({ vmid, name: 'inst-07', description: 'better-compute-idempotency-key: inst_07' }),
    );
    const machine = await impl.create(request('inst_07'), call('inst_07'));
    expect(machine).toMatchObject({ id: String(vmid), state: 'pending' });
    api.settle();
    expect(api.vms.get(vmid)).toMatchObject({
      tags: managedTag,
      cores: 2,
      memory: 4096,
      status: 'running',
    });
  });

  it('grows the boot disk for sized offers and leaves a larger template disk alone', async () => {
    const api = new PveEmulator();
    const impl = await client(api, { offers: ['2c-4g-40d', '2c-4g-5d'] });
    const big = await impl.create(request('inst_08', '2c-4g-40d'), call('inst_08'));
    expect(api.vms.get(Number(big.id))!.disk).toBe('40G');
    const small = await impl.create(request('inst_09', '2c-4g-5d'), call('inst_09'));
    expect(api.vms.get(Number(small.id))).toMatchObject({ disk: '10G', tags: managedTag });
  });

  it('delivers user data only through writeSnippet', async () => {
    const api = new PveEmulator();
    const userData = '#cloud-config\nruncmd: [echo hi]\n';
    const plain = await client(api);
    await expect(
      plain.create({ ...request('inst_10'), userData }, call('inst_10')),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'UNSUPPORTED'));
    const written: [string, string][] = [];
    const withSnippets = await client(
      api,
      {},
      {
        writeSnippet: async (name, content) => {
          written.push([name, content]);
          return `local:snippets/${name}`;
        },
      },
    );
    const machine = await withSnippets.create({ ...request('inst_10'), userData }, call('inst_10'));
    expect(written).toEqual([[`bc-${machine.id}.yaml`, userData]]);
    expect(api.vms.get(Number(machine.id))!.config.cicustom).toBe(
      `user=local:snippets/bc-${machine.id}.yaml`,
    );
  });

  it('clones onto the configured node, into a pool and storage', async () => {
    const api = new PveEmulator();
    const impl = await client(api, { node: 'pve2', pool: 'tenants', storage: 'ceph' });
    const machine = await impl.create(request('inst_11'), call('inst_11'));
    expect(api.requests.find((entry) => entry.path.endsWith('/clone'))!.body).toMatchObject({
      target: 'pve2',
      pool: 'tenants',
      storage: 'ceph',
    });
    expect(api.vms.get(Number(machine.id))!.node).toBe('pve2');
  });

  it('refuses to delete or power VMs it did not create, and deletes its own after stopping them', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    for (const act of [
      () => impl.delete('100', call('d')),
      () => impl.power!('100', 'off', call('p')),
    ])
      await expect(act()).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'ACCESS_DENIED'),
      );
    await expect(impl.delete('9000', call('t'))).rejects.toSatisfy((error: unknown) =>
      isComputeError(error, 'NOT_FOUND'),
    );
    expect(api.vms.has(100) && api.vms.has(9000)).toBe(true);

    const machine = await impl.create(request('inst_12'), call('inst_12'));
    api.settle();
    expect(api.vms.get(Number(machine.id))!.status).toBe('running');
    await impl.delete(machine.id, call('delete'));
    expect(api.vms.has(Number(machine.id))).toBe(false);
    await expect(impl.delete(machine.id, call('again'))).rejects.toSatisfy((error: unknown) =>
      isComputeError(error, 'NOT_FOUND'),
    );
  });

  it('maps power actions to tasks and waits for them; nmi is unsupported', async () => {
    const api = new PveEmulator();
    api.taskPolls = 2;
    const impl = await client(api);
    const { id } = await impl.create(request('inst_13'), call('inst_13'));
    await impl.power!(id, 'off', call('off'));
    expect((await impl.get(id, call('g')))!.state).toBe('stopped');
    await impl.power!(id, 'cycle', call('cycle'));
    expect((await impl.get(id, call('g')))!.state).toBe('running');
    await impl.power!(id, 'graceful-off', call('shutdown'));
    expect(api.requests.map((entry) => entry.path)).toContain(
      `/nodes/pve1/qemu/${id}/status/shutdown`,
    );
    await expect(impl.power!(id, 'nmi', call('nmi'))).rejects.toSatisfy((error: unknown) =>
      isComputeError(error, 'UNSUPPORTED'),
    );
  });

  it('reinstalls under the same VMID, keeping key, name, size, disk and cloud-init', async () => {
    const api = new PveEmulator();
    const impl = await client(
      api,
      { offers: ['4c-8g-40d'] },
      {
        writeSnippet: async (name) => `local:snippets/${name}`,
      },
    );
    const userData = '#cloud-config\nruncmd: [echo hi]\n';
    const { id } = await impl.create(
      { ...request('inst_16', '4c-8g-40d'), userData },
      call('inst_16'),
    );
    api.settle();
    await impl.reinstall!(id, 'debian-12', call('reinstall'));
    api.settle();
    const vm = api.vms.get(Number(id))!;
    expect(vm).toMatchObject({
      name: 'inst-16',
      node: 'pve1',
      cores: 4,
      memory: 8192,
      disk: '40G',
      tags: managedTag,
      status: 'running',
      description: 'better-compute-idempotency-key: inst_16',
    });
    expect(vm.config.cicustom).toBe(`user=local:snippets/bc-${id}.yaml`);
    const clones = api.requests.filter((entry) => entry.path.endsWith('/clone'));
    expect(clones.map((entry) => [entry.path, entry.body.newid, entry.body.target])).toEqual([
      ['/nodes/pve1/qemu/9000/clone', id, undefined],
      ['/nodes/pve2/qemu/9001/clone', id, 'pve1'],
    ]);
    // A retried create under the key still finds the same machine.
    expect((await impl.create(request('inst_16', '4c-8g-40d'), call('inst_16'))).id).toBe(id);
    await expect(impl.reinstall!('100', 'debian-12', call('r'))).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'ACCESS_DENIED'),
    );
  });

  it('turns a failed task into a PROVIDER_ERROR', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    const { id } = await impl.create(request('inst_14'), call('inst_14'));
    api.failNextTask = 'command failed: timeout';
    await expect(impl.power!(id, 'off', call('off'))).rejects.toSatisfy(
      (error: unknown) =>
        isComputeError(error, 'PROVIDER_ERROR') && /timeout/.test((error as Error).message),
    );
  });

  it('lists only managed VMs, and gets unknown or template ids as undefined', async () => {
    const api = new PveEmulator();
    const impl = await client(api);
    const { id } = await impl.create(request('inst_15'), call('inst_15'));
    const listed: string[] = [];
    for await (const machine of impl.list!(call('list'))) listed.push(machine.id);
    expect(listed).toEqual([id]);
    for (const unknown of ['9000', '424242', 'not-a-vmid'])
      expect(await impl.get(unknown, call('g'))).toBeUndefined();
  });

  it('offers the configured sizes, available where an online node has the headroom', async () => {
    const api = new PveEmulator();
    const impl = await client(api, { offers: ['2c-4g', '16c-64g', '64c-256g', '2c-4g'] });
    const offers = await impl.listOffers({});
    expect(offers.map(({ id, available }) => [id, available])).toEqual([
      ['2c-4g', true],
      ['16c-64g', true],
      ['64c-256g', false],
    ]);
    expect(await impl.listOffers({ minVcpu: 1_000_000 })).toEqual([]);
    expect(await impl.listOffers({ kind: 'metal' })).toEqual([]);
    expect(await impl.listOffers({ region: 'elsewhere' })).toEqual([]);
    const pinned = await client(api, { node: 'pve2', offers: ['2c-4g', '4c-8g'] });
    expect((await pinned.listOffers({})).map(({ id, available }) => [id, available])).toEqual([
      ['2c-4g', false],
      ['4c-8g', false],
    ]);
  });

  it('maps API failures: a bad token, an unreachable host, a busy cluster', async () => {
    const api = new PveEmulator();
    const wrong = proxmoxProvider({ fetch: api.fetch, sleep: immediate });
    const parsed = await wrong.config['~standard'].validate(baseConfig);
    const impl = await wrong.create((parsed as { value: never }).value, {
      clock,
      log,
      secrets: { resolve: async () => 'root@pam!bc=wrong' },
    });
    await expect(impl.listOffers({})).rejects.toSatisfy(
      (error: unknown) =>
        isComputeError(error, 'PROVIDER_ERROR') && /token/.test((error as Error).message),
    );
    const down = await client(
      api,
      {},
      {
        fetch: async () => {
          throw new TypeError('connect ECONNREFUSED');
        },
      },
    );
    await expect(down.listOffers({})).rejects.toSatisfy(
      (error: unknown) =>
        isComputeError(error, 'PROVIDER_ERROR') && /unreachable/.test((error as Error).message),
    );
    const busy = await client(api, {}, { fetch: async () => api.fail(503, 'too many requests') });
    await expect(busy.listOffers({})).rejects.toSatisfy((error: unknown) =>
      isComputeError(error, 'RATE_LIMITED'),
    );
  });
});
