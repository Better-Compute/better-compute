import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type ExternalMachine,
  type ImageRef,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderImpl,
  type SecretRef,
} from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';

// Proxmox VE (https://pve.proxmox.com/pve-docs/api-viewer/): QEMU VMs cloned from a template as VPS
// instances. PVE has no idempotency keys, but VMIDs are unique: each key hashes to a VMID slot in the
// account's range, the clone carries the key in its description, and a slot held under another key
// probes the next. Retried and concurrent creates meet on one VMID and PVE lets one clone through.
// Only VMs tagged `better-compute` can be deleted or powered. PVE has no server types, so offers are the
// sizes the account lists (`2c-4g-40d`), available when an online node has the headroom.

/** A size such as `2c-4g` or `4c-16g-100d` (vCPUs, GiB of memory, optional GiB of boot disk). */
export const offerPattern = /^([1-9]\d{0,3})c-([1-9]\d{0,4})g(?:-([1-9]\d{0,5})d)?$/;

/** An account's configuration: the API token is a SecretRef, never a value. */
export const proxmoxConfig = manifest({
  url: field.url().describe('The PVE API endpoint, such as https://pve.example.com:8006'),
  token: field
    .secret()
    .describe('A PVE API token `user@realm!tokenid=secret`, as a secret reference'),
  region: field
    .string({ maxLength: 64 })
    .default('pve')
    .describe('The region offers and machines report'),
  node: field
    .string({ pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/ })
    .optional()
    .describe('Clone onto this node (default: the template’s node)'),
  pool: field.string({ maxLength: 64 }).optional().describe('Add every VM to this resource pool'),
  storage: field.string({ maxLength: 64 }).optional().describe('Target storage for full clones'),
  fullClone: field.boolean().default(true).describe('Full clones (default) or linked clones'),
  disk: field
    .string({ pattern: /^(scsi|virtio|sata|ide)\d{1,2}$/ })
    .default('scsi0')
    .describe('The boot disk an offer’s `d` resizes'),
  vmidMin: field
    .int({ min: 100, max: 999_999_999 })
    .default(100_000_000)
    .describe('Lowest VMID this account uses'),
  vmidMax: field
    .int({ min: 100, max: 999_999_999 })
    .default(999_999_999)
    .describe('Highest VMID this account uses'),
  offers: field
    .list(field.string({ pattern: offerPattern }), { min: 1, max: 64 })
    .default(['1c-2g', '2c-4g', '4c-8g', '8c-32g'])
    .describe('The sizes offered, as `<vcpu>c-<GiB>g[-<GiB>d]`'),
});

/** The validated account configuration. */
export interface ProxmoxConfig {
  url: string;
  token: SecretRef;
  region: string;
  node?: string;
  pool?: string;
  storage?: string;
  fullClone: boolean;
  disk: string;
  vmidMin: number;
  vmidMax: number;
  offers: string[];
}

export interface ProxmoxOptions {
  /** The fetch implementation (tests emulate; self-signed clusters pass one bound to a pinned CA). */
  fetch?: typeof fetch;
  /**
   * Writes a cloud-init snippet and returns its volume id (`local:snippets/<name>.yaml`). The PVE API
   * cannot upload snippets, so an operator supplies this (SFTP, a shared mount); without it, `create`
   * refuses user data beyond an empty `#cloud-config`.
   */
  writeSnippet?: (name: string, content: string, context: CallContext) => Promise<string>;
  /** How often to poll a task (default 1 s) and how long to wait for one (default 10 min). */
  taskPollMs?: number;
  taskTimeoutMs?: number;
  /** Waits between task polls (tests pass an immediate one). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The tag every VM this provider creates carries. */
export const managedTag = 'better-compute';
const keyLine = 'better-compute-idempotency-key: ';

interface PveResource {
  type: string;
  vmid?: number;
  name?: string;
  node: string;
  status?: string;
  template?: number;
  tags?: string;
  lock?: string;
  maxcpu?: number;
  cpu?: number;
  maxmem?: number;
  mem?: number;
}

interface PveInterface {
  name?: string;
  'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string }[];
}

/** Parses an offer id such as `4c-16g-100d`. */
export function parseOffer(
  id: string,
): { vcpu: number; memoryGiB: number; diskGiB?: number } | undefined {
  const match = offerPattern.exec(id);
  if (!match) return undefined;
  return {
    vcpu: Number(match[1]),
    memoryGiB: Number(match[2]),
    ...(match[3] ? { diskGiB: Number(match[3]) } : {}),
  };
}

/**
 * The VMID slot a key starts at: SHA-256 of the key, reduced into `[min, max]`. Every create under
 * one key targets the same VMID, so PVE's own uniqueness check lets exactly one clone through.
 */
export async function vmidFor(key: string, min: number, max: number): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  );
  const value = new DataView(digest.buffer).getBigUint64(0);
  return min + Number(value % BigInt(max - min + 1));
}

/** VM names are DNS names: `inst_01…` becomes `inst-01…`, at most 63 characters. */
export function vmName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return cleaned || 'bc-vm';
}

const tagsOf = (resource: PveResource) =>
  (resource.tags ?? '')
    .split(/[;, ]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

/** Whether user data says anything (an empty `#cloud-config` does not). */
export function hasUserData(userData: string): boolean {
  return userData
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line !== '' && !line.startsWith('#'));
}

/** A PVE VM as the contract's ExternalMachine. */
export function toMachine(
  resource: PveResource,
  region: string,
  addresses: string[] = [],
): ExternalMachine {
  const locked = resource.lock === 'clone' || resource.lock === 'create';
  const state: ExternalMachine['state'] =
    resource.lock === 'destroyed'
      ? 'deleting'
      : locked
        ? 'pending'
        : resource.status === 'running'
          ? 'running'
          : resource.status === 'stopped' || resource.status === 'paused'
            ? 'stopped'
            : 'unknown';
  const machine: ExternalMachine = { id: String(resource.vmid), state, region, addresses };
  if (resource.name) machine.name = resource.name;
  return machine;
}

const powerCommands: Partial<Record<PowerAction, string>> = {
  on: 'start',
  off: 'stop',
  'graceful-off': 'shutdown',
  reset: 'reset',
  'graceful-restart': 'reboot',
};

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });

class ProxmoxClient implements ProviderImpl {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #config: ProxmoxConfig;
  readonly #context: ProviderContext;
  readonly #options: ProxmoxOptions;

  constructor(config: ProxmoxConfig, context: ProviderContext, options: ProxmoxOptions) {
    if (config.vmidMin > config.vmidMax)
      throw new ComputeError(
        'INVALID_CONFIG',
        `vmidMin ${config.vmidMin} is above vmidMax ${config.vmidMax}`,
      );
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpoint = `${config.url.replace(/\/+$/, '')}/api2/json`;
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params?: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const token = await this.#context.secrets.resolve(this.#config.token);
    const entries = Object.entries(params ?? {}).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    const form = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
    const hasBody = method === 'POST' || method === 'PUT';
    const query = hasBody ? '' : form.toString();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}${query ? `?${query}` : ''}`, {
        method,
        headers: {
          authorization: `PVEAPIToken=${token}`,
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(hasBody ? { body: form.toString() } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ComputeError(
        'PROVIDER_ERROR',
        `Proxmox VE unreachable: ${(error as Error).message}`,
        undefined,
        {
          provider: 'proxmox',
        },
      );
    }
    const text = await response.text();
    let payload: { data?: unknown; errors?: Record<string, string>; message?: string } = {};
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      // PVE answers some errors as plain text.
    }
    if (response.ok) return payload.data as T;
    // PVE reports a missing VM as 500 "Configuration file … does not exist" and a missing route as 501.
    const message = `${payload.message ?? response.statusText ?? ''}`.trim();
    if (response.status === 404 || /does not exist|no such VM/i.test(message)) return undefined;
    const details: Record<string, unknown> = { provider: 'proxmox', status: response.status };
    if (payload.errors) details.errors = payload.errors;
    if (response.status === 401)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'Proxmox VE rejected the API token',
        undefined,
        details,
      );
    if (response.status === 429 || response.status === 503)
      throw new ComputeError('RATE_LIMITED', `Proxmox VE is busy: ${message}`, undefined, {
        ...details,
        retryAfterMs: 1000,
      });
    throw new ComputeError(
      'PROVIDER_ERROR',
      `Proxmox VE ${method} ${path}: ${message || `HTTP ${response.status}`}`,
      undefined,
      details,
    );
  }

  async #resources(type: 'vm' | 'node', signal?: AbortSignal): Promise<PveResource[]> {
    return (
      (await this.#request<PveResource[]>('GET', '/cluster/resources', { type }, signal)) ?? []
    );
  }

  async #vms(signal?: AbortSignal): Promise<PveResource[]> {
    return (await this.#resources('vm', signal)).filter((resource) => resource.type === 'qemu');
  }

  async #find(id: string, signal?: AbortSignal): Promise<PveResource | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    return (await this.#vms(signal)).find((vm) => vm.vmid === Number(id) && vm.template !== 1);
  }

  /** The VM `id`, refusing ones this provider did not create (a shared cluster's other VMs are off limits). */
  async #managed(id: string, signal?: AbortSignal): Promise<PveResource> {
    const vm = await this.#find(id, signal);
    if (!vm) throw new ComputeError('NOT_FOUND', `VM ${id} not found`);
    if (!tagsOf(vm).includes(managedTag))
      throw new ComputeError(
        'ACCESS_DENIED',
        `VM ${id} is not managed by better-compute`,
        undefined,
        {
          provider: 'proxmox',
        },
      );
    return vm;
  }

  /** Waits for a task (UPID) to finish; a failed task is a PROVIDER_ERROR. */
  async #wait(node: string, upid: string | undefined, signal: AbortSignal): Promise<void> {
    if (!upid) return;
    const sleep = this.#options.sleep ?? defaultSleep;
    const pollMs = this.#options.taskPollMs ?? 1000;
    const deadline = this.#context.clock.now() + (this.#options.taskTimeoutMs ?? 600_000);
    for (;;) {
      const status = await this.#request<{ status: string; exitstatus?: string }>(
        'GET',
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
        undefined,
        signal,
      );
      if (status?.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK')
          throw new ComputeError(
            'PROVIDER_ERROR',
            `Proxmox VE task failed: ${status.exitstatus}`,
            undefined,
            {
              provider: 'proxmox',
              upid,
            },
          );
        return;
      }
      if (this.#context.clock.now() > deadline)
        throw new ComputeError(
          'PROVIDER_ERROR',
          `Proxmox VE task ${upid} did not finish in time`,
          undefined,
          {
            provider: 'proxmox',
            upid,
          },
        );
      await sleep(pollMs, signal);
    }
  }

  async #addresses(vm: PveResource, signal?: AbortSignal): Promise<string[]> {
    if (vm.status !== 'running') return [];
    try {
      const result = await this.#request<{ result?: PveInterface[] }>(
        'GET',
        `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/agent/network-get-interfaces`,
        undefined,
        signal,
      );
      return (result?.result ?? [])
        .filter((nic) => nic.name !== 'lo')
        .flatMap((nic) => nic['ip-addresses'] ?? [])
        .map((address) => address['ip-address'])
        .filter(
          (address) =>
            !address.startsWith('127.') && !address.startsWith('fe80:') && address !== '::1',
        );
    } catch {
      // No guest agent (or not up yet): addresses arrive once it answers.
      return [];
    }
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.kind === 'metal' || (query.minGpus ?? 0) > 0 || query.gpuModel !== undefined)
      return [];
    if (query.region !== undefined && query.region !== this.#config.region) return [];
    const nodes = (await this.#resources('node')).filter(
      (node) =>
        node.type === 'node' &&
        node.status === 'online' &&
        (!this.#config.node || node.node === this.#config.node),
    );
    return [...new Set(this.#config.offers)]
      .map((id) => ({ id, size: parseOffer(id)! }))
      .filter(
        ({ size }) =>
          size.vcpu >= (query.minVcpu ?? 0) && size.memoryGiB >= (query.minMemoryGiB ?? 0),
      )
      .map(({ id, size }) => ({
        id,
        kind: 'vps' as const,
        region: this.#config.region,
        vcpu: size.vcpu,
        memoryGiB: size.memoryGiB,
        ...(size.diskGiB ? { diskGiB: size.diskGiB } : {}),
        available: nodes.some(
          (node) =>
            (node.maxcpu ?? 0) >= size.vcpu &&
            (node.maxmem ?? 0) - (node.mem ?? 0) >= size.memoryGiB * 2 ** 30,
        ),
      }))
      .sort((a, b) => a.vcpu - b.vcpu || a.memoryGiB - b.memoryGiB || (a.id < b.id ? -1 : 1));
  }

  /** The key a VM was created under, from its description; waits out a clone still writing it. */
  async #ownerOf(vm: PveResource, signal: AbortSignal): Promise<string | undefined> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const deadline = this.#context.clock.now() + (this.#options.taskTimeoutMs ?? 600_000);
    for (let current: PveResource | undefined = vm; current; ) {
      const config = await this.#request<{ description?: string }>(
        'GET',
        `/nodes/${encodeURIComponent(current.node)}/qemu/${current.vmid}/config`,
        undefined,
        signal,
      );
      const line = (config?.description ?? '').split('\n').find((text) => text.startsWith(keyLine));
      if (line) return line.slice(keyLine.length).trim();
      if (!current.lock || this.#context.clock.now() > deadline) return undefined;
      await sleep(this.#options.taskPollMs ?? 1000, signal);
      current = await this.#find(String(current.vmid), signal);
    }
    return undefined;
  }

  async #template(image: ImageRef, signal: AbortSignal): Promise<PveResource> {
    const templates = (await this.#vms(signal)).filter((vm) => vm.template === 1);
    const found =
      templates.find((vm) => String(vm.vmid) === image) ??
      templates.find((vm) => vm.name === image);
    if (!found)
      throw new ComputeError('INVALID_INPUT', `No Proxmox VE template ${JSON.stringify(image)}`);
    return found;
  }

  async create(
    request: { offerId: string; image: ImageRef; userData: string; name: string },
    context: CallContext,
  ): Promise<ExternalMachine> {
    const { signal } = context;
    const key = context.idempotencyKey;
    const size = this.#config.offers.includes(request.offerId)
      ? parseOffer(request.offerId)
      : undefined;
    if (!size)
      throw new ComputeError(
        'INVALID_INPUT',
        `Offer ${request.offerId} is not offered by this account`,
      );
    if (hasUserData(request.userData) && !this.#options.writeSnippet)
      throw new ComputeError(
        'UNSUPPORTED',
        'Proxmox VE cannot receive user data over its API; configure writeSnippet to deliver cloud-init',
      );

    // The key's VMID slot is the lock: a retried or concurrent create under one key lands on the same
    // VMID, where PVE lets exactly one clone through. A slot held under another key moves to the next.
    const { vmidMin: min, vmidMax: max } = this.#config;
    const probes = Math.min(64, max - min + 1);
    let slot = await vmidFor(key, min, max);
    for (let probe = 0; probe < probes; ) {
      const vm = (await this.#vms(signal)).find((candidate) => candidate.vmid === slot);
      if (!vm) {
        const template = await this.#template(request.image, signal);
        const node = this.#config.node ?? template.node;
        try {
          await this.#clone(template, slot, node, vmName(request.name), key, signal);
        } catch (error) {
          // Someone cloned into the slot first: look again at who holds it.
          if (/already exists/i.test((error as Error).message)) continue;
          throw error;
        }
        const cicustom = await this.#snippet(slot, request.userData, context);
        return this.#finish(slot, node, vmName(request.name), size, cicustom, context);
      }
      if ((await this.#ownerOf(vm, signal)) === key) {
        // Ours. A clone still running (a concurrent create) or already configured is returned as is; one
        // interrupted between clone and configuration is finished now.
        if (vm.lock || tagsOf(vm).includes(managedTag)) return toMachine(vm, this.#config.region);
        const cicustom = await this.#snippet(slot, request.userData, context);
        return this.#finish(
          slot,
          vm.node,
          vm.name ?? vmName(request.name),
          size,
          cicustom,
          context,
        );
      }
      slot = slot >= max ? min : slot + 1;
      probe++;
    }
    throw new ComputeError(
      'CAPACITY_UNAVAILABLE',
      `No free VMID near ${key}'s slot in ${min}-${max}`,
      undefined,
      {
        provider: 'proxmox',
      },
    );
  }

  /** Clones `template` into `vmid` on `node`, recording the key; waits for the clone task. */
  async #clone(
    template: PveResource,
    vmid: number,
    node: string,
    name: string,
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    const upid = await this.#request<string>(
      'POST',
      `/nodes/${encodeURIComponent(template.node)}/qemu/${template.vmid}/clone`,
      {
        newid: vmid,
        name,
        description: `${keyLine}${key}`,
        full: this.#config.fullClone ? 1 : 0,
        ...(node !== template.node ? { target: node } : {}),
        ...(this.#config.pool ? { pool: this.#config.pool } : {}),
        ...(this.#config.fullClone && this.#config.storage
          ? { storage: this.#config.storage }
          : {}),
      },
      signal,
    );
    await this.#wait(template.node, upid, signal);
  }

  /** The `cicustom` user volume for user data, written through `writeSnippet`; none for empty data. */
  async #snippet(
    vmid: number,
    userData: string,
    context: CallContext,
  ): Promise<string | undefined> {
    if (!hasUserData(userData) || !this.#options.writeSnippet) return undefined;
    return `user=${await this.#options.writeSnippet(`bc-${vmid}.yaml`, userData, context)}`;
  }

  /** Sizes, tags and starts a fresh clone; every step tolerates having been done already. */
  async #finish(
    vmid: number,
    node: string,
    name: string,
    size: { vcpu: number; memoryGiB: number; diskGiB?: number },
    cicustom: string | undefined,
    context: CallContext,
  ): Promise<ExternalMachine> {
    const { signal } = context;
    const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`;
    if (size.diskGiB)
      try {
        await this.#request(
          'PUT',
          `${path}/resize`,
          { disk: this.#config.disk, size: `${size.diskGiB}G` },
          signal,
        );
      } catch (error) {
        // PVE never shrinks: a template disk at least this large already satisfies the offer.
        if (!/shrink|smaller/i.test((error as Error).message)) throw error;
        context.log.warn('proxmox: the template disk is larger than the offer; left as is', {
          vmid,
        });
      }
    // The managed tag goes on last: it marks the VM configured.
    await this.#request(
      'PUT',
      `${path}/config`,
      {
        cores: size.vcpu,
        memory: size.memoryGiB * 1024,
        ipconfig0: 'ip=dhcp',
        ...(cicustom ? { cicustom } : {}),
        tags: managedTag,
      },
      signal,
    );
    try {
      // Starting converges through `get`: the machine is pending until it runs.
      await this.#request('POST', `${path}/status/start`, {}, signal);
    } catch (error) {
      if (!/already running/i.test((error as Error).message)) throw error;
    }
    return { id: String(vmid), name, state: 'pending', region: this.#config.region, addresses: [] };
  }

  /**
   * Rebuilds the VM from `image` under the same VMID: PVE cannot rebuild in place, so the VM is
   * destroyed and the template cloned into its VMID again, keeping its key, name, size, boot disk
   * size and cloud-init volume. A create under the key meanwhile lands on the same VMID and meets it.
   */
  async reinstall(id: string, image: ImageRef, context: CallContext): Promise<void> {
    const { signal } = context;
    const vm = await this.#managed(id, signal);
    const config = await this.#request<Record<string, string | number | undefined>>(
      'GET',
      `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/config`,
      undefined,
      signal,
    );
    const key = String(config?.description ?? '')
      .split('\n')
      .find((line) => line.startsWith(keyLine))
      ?.slice(keyLine.length)
      .trim();
    if (!config || !key)
      throw new ComputeError(
        'INVALID_STATE',
        `VM ${id} carries no idempotency key to reinstall under`,
      );
    const template = await this.#template(image, signal);
    const disk = /(?:^|,)size=(\d+)G(?:,|$)/.exec(String(config[this.#config.disk] ?? ''));
    const size = {
      vcpu: Number(config.cores ?? 1),
      memoryGiB: Math.max(1, Math.round(Number(config.memory ?? 1024) / 1024)),
      ...(disk ? { diskGiB: Number(disk[1]) } : {}),
    };
    const name = vm.name ?? String(config.name ?? `bc-${vm.vmid}`);
    await this.#destroy(vm, signal);
    await this.#clone(template, vm.vmid!, vm.node, name, key, signal);
    const cicustom = typeof config.cicustom === 'string' ? config.cicustom : undefined;
    await this.#finish(vm.vmid!, vm.node, name, size, cicustom, context);
  }

  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    const vm = await this.#find(id, context.signal);
    if (!vm) return undefined;
    return toMachine(vm, this.#config.region, await this.#addresses(vm, context.signal));
  }

  async #destroy(vm: PveResource, signal: AbortSignal): Promise<void> {
    const path = `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}`;
    if (vm.status === 'running')
      await this.#wait(
        vm.node,
        await this.#request<string>('POST', `${path}/status/stop`, {}, signal),
        signal,
      );
    const upid = await this.#request<string>(
      'DELETE',
      path,
      { purge: 1, 'destroy-unreferenced-disks': 1 },
      signal,
    );
    if (upid === undefined) throw new ComputeError('NOT_FOUND', `VM ${vm.vmid} not found`);
    await this.#wait(vm.node, upid, signal);
  }

  async delete(id: string, context: CallContext): Promise<void> {
    await this.#destroy(await this.#managed(id, context.signal), context.signal);
  }

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    const vm = await this.#managed(id, context.signal);
    const path = `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/status`;
    if (action === 'cycle') {
      if (vm.status === 'running')
        await this.#wait(
          vm.node,
          await this.#request<string>('POST', `${path}/stop`, {}, context.signal),
          context.signal,
        );
      await this.#wait(
        vm.node,
        await this.#request<string>('POST', `${path}/start`, {}, context.signal),
        context.signal,
      );
      return;
    }
    const command = powerCommands[action];
    if (!command) throw new ComputeError('UNSUPPORTED', `Proxmox VE has no ${action} action`);
    const upid = await this.#request<string>('POST', `${path}/${command}`, {}, context.signal);
    if (upid === undefined) throw new ComputeError('NOT_FOUND', `VM ${id} not found`);
    await this.#wait(vm.node, upid, context.signal);
  }

  async *list(context: CallContext): AsyncIterable<ExternalMachine> {
    for (const vm of await this.#vms(context.signal))
      if (vm.template !== 1 && tagsOf(vm).includes(managedTag))
        yield toMachine(vm, this.#config.region);
  }
}

/** A Proxmox VE provider definition; pass `fetch` to emulate the API or pin a self-signed CA. */
export function proxmoxProvider(options: ProxmoxOptions = {}): ProviderDefinition<ProxmoxConfig> {
  return defineProvider<ProxmoxConfig>({
    id: 'proxmox',
    version: '0.1.0',
    provides: ['vps'],
    config: proxmoxConfig as unknown as ProviderDefinition<ProxmoxConfig>['config'],
    capabilities: ['power', 'reinstall', 'list'],
    create: (config, context) => new ProxmoxClient(config, context, options),
  });
}

/** The Proxmox VE provider (`vps({ providers: [proxmox] })`). */
export const proxmox: ProviderDefinition<ProxmoxConfig> = proxmoxProvider();
