import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type Clock,
  type ExternalMachine,
  type ImageRef,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderImpl,
  type RescueAccess,
  type SecretRef,
} from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';

// Hetzner Robot (https://robot.hetzner.com/doc/webservice/en.html): dedicated servers that become
// `metal-host` nodes running bcd (§3.6 "platform-owned provider machines"). Robot servers are bought
// and cancelled by people, never through this provider: "create" claims an existing, unclaimed
// server of the account by naming it, "delete" releases the claim. `bootstrap` installs the OS from
// rescue with installimage and delivers a single-use `provisioned` join token over SSH (stdin, into a
// root-only file), never through user data.

/** Server-name prefix that marks a server as claimed by better-compute. */
export const robotClaimPrefix = 'bc-';

/** An account's configuration: webservice credentials and the rescue SSH key, as secret references. */
export const hetznerRobotConfig = manifest({
  user: field.string({ pattern: '^[A-Za-z0-9#+._-]{1,64}$' }).describe('Robot webservice user'),
  password: field.secret().describe('Robot webservice password, as a secret reference'),
  rescueKeyFingerprint: field
    .string({ pattern: '^([0-9a-f]{2}:){15}[0-9a-f]{2}$' })
    .describe('MD5 fingerprint of an SSH key stored in Robot, authorized in rescue'),
  rescueKey: field.secret().describe('That SSH private key, as a secret reference'),
  image: field
    .string({ pattern: '^[A-Za-z0-9._-]{1,128}$' })
    .default('Ubuntu-2404-noble-amd64-base.tar.gz')
    .describe('installimage image file'),
});

export interface HetznerRobotConfig {
  user: string;
  password: SecretRef;
  rescueKeyFingerprint: string;
  rescueKey: SecretRef;
  image: string;
}

/** Runs one command on a host over SSH; `stdin` carries secrets so they never appear in argv. */
export type SshExecutor = (
  target: { host: string; username: string; privateKey: string },
  command: string,
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface HetznerRobotOptions {
  fetch?: typeof fetch;
  /** Default `https://robot-ws.your-server.de`. */
  endpoint?: string;
  /** Required for `bootstrap`; e.g. an ssh2-backed executor. */
  ssh?: SshExecutor;
  /** Hardware specs by product (Robot's API reports only the product name). */
  products?: Readonly<
    Record<
      string,
      { vcpu: number; memoryGiB: number; diskGiB?: number; gpus?: { model: string; count: number } }
    >
  >;
  /** How long bootstrap waits for rescue SSH (default 10 min) and how often it retries (15 s). */
  rescueTimeoutMs?: number;
  rescuePollMs?: number;
  /** Waits between rescue polls; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/** Specs of common Robot products (threads, GiB). Unknown products report 1/1 until configured. */
export const robotProducts: Readonly<
  Record<
    string,
    { vcpu: number; memoryGiB: number; diskGiB?: number; gpus?: { model: string; count: number } }
  >
> = Object.freeze({
  'AX41-NVMe': { vcpu: 12, memoryGiB: 64, diskGiB: 1024 },
  AX52: { vcpu: 16, memoryGiB: 64, diskGiB: 2048 },
  AX102: { vcpu: 32, memoryGiB: 128, diskGiB: 3840 },
  EX44: { vcpu: 20, memoryGiB: 64, diskGiB: 1024 },
  GEX44: { vcpu: 20, memoryGiB: 64, diskGiB: 3840, gpus: { model: 'RTX-4000-SFF-ADA', count: 1 } },
  GEX130: { vcpu: 24, memoryGiB: 128, diskGiB: 3840, gpus: { model: 'RTX-6000-ADA', count: 1 } },
});

interface RobotServer {
  server_ip: string | null;
  server_ipv6_net?: string | null;
  server_number: number;
  server_name: string;
  product: string;
  dc: string;
  status: 'ready' | 'in process';
  cancelled: boolean;
}

/** The name that claims a server for an idempotency key (Robot names: up to 100 characters). */
export function robotClaimName(idempotencyKey: string): string {
  return `${robotClaimPrefix}${idempotencyKey.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(
    0,
    100,
  );
}

function region(dc: string): string {
  return (dc.split('-')[0] ?? dc).toLowerCase();
}

function toMachine(server: RobotServer): ExternalMachine {
  const machine: ExternalMachine = {
    id: String(server.server_number),
    name: server.server_name,
    // Robot reports provisioning, not power: a ready server is `running` as far as it can tell.
    state: server.cancelled ? 'deleting' : server.status === 'ready' ? 'running' : 'pending',
    offerId: String(server.server_number),
    region: region(server.dc),
    addresses: [server.server_ip, server.server_ipv6_net].filter(
      (address): address is string => typeof address === 'string' && address !== '',
    ),
  };
  return machine;
}

/** Answers 0 only in Hetzner's rescue system (installimage is there, and nowhere else). */
const rescueProbe = 'test -e /root/.oldroot/nfs/install/installimage';

const resetTypes: Partial<Record<PowerAction, string>> = {
  reset: 'hw',
  cycle: 'hw',
  'graceful-restart': 'sw',
  'graceful-off': 'power',
  off: 'power_long',
  on: 'power',
};

/**
 * The script bootstrap runs in rescue (sent over SSH stdin). It writes an installimage autosetup
 * (software RAID 1 over the NVMe, else SATA, disks) and a post-install script. That script puts the
 * join token into the new system as a root-only file (`/etc/better-compute/join-token`), downloads
 * bcd, verifies its sha256, enables it under systemd, then shreds itself. The token comes from
 * `/root/bc-join-token`, written beforehand from SSH stdin with umask 077.
 */
export function bootstrapScript(input: {
  hostname: string;
  image: string;
  bcdUrl: string;
  sha256: string;
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    'set -eu',
    'umask 077',
    'test -s /root/bc-join-token',
    // Every NVMe (else SATA) disk in a software RAID 1, one root filesystem.
    `DRIVES=$(lsblk -dn -o NAME,TYPE | awk '$2=="disk" && $1 ~ /^nvme/ {print "/dev/"$1}')`,
    `[ -n "$DRIVES" ] || DRIVES=$(lsblk -dn -o NAME,TYPE | awk '$2=="disk" && $1 ~ /^sd/ {print "/dev/"$1}')`,
    'N=0; : > /root/bc-autosetup',
    'for D in $DRIVES; do N=$((N+1)); echo "DRIVE$N $D" >> /root/bc-autosetup; done',
    'if [ "$N" -gt 1 ]; then echo "SWRAID 1" >> /root/bc-autosetup; echo "SWRAIDLEVEL 1" >> /root/bc-autosetup; else echo "SWRAID 0" >> /root/bc-autosetup; fi',
    `cat >> /root/bc-autosetup <<'EOF'`,
    `HOSTNAME ${input.hostname}`,
    'PART /boot/efi esp 256M',
    'PART /boot ext3 1024M',
    'PART / ext4 all',
    `IMAGE /root/.oldroot/nfs/install/../images/${input.image}`,
    'EOF',
    // installimage runs the post-install script chrooted into the new system, where rescue's files
    // are not visible: rescue embeds the token (base64, so no quoting) into the script it writes. The
    // token never appears in what is sent over SSH as a script, nor in argv.
    `printf '#!/bin/sh\\nset -eu\\numask 077\\nmkdir -p /etc/better-compute\\necho %s | base64 -d > /etc/better-compute/join-token\\nchmod 0600 /etc/better-compute/join-token\\n' "$(base64 -w0 /root/bc-join-token)" > /root/bc-post-install.sh`,
    `cat >> /root/bc-post-install.sh <<'EOF'`,
    `curl -fsSL --retry 5 -o /usr/local/bin/bcd ${quote(input.bcdUrl)}`,
    `echo ${quote(`${input.sha256}  /usr/local/bin/bcd`)} | sha256sum -c -`,
    'chmod 0755 /usr/local/bin/bcd',
    `cat > /etc/systemd/system/bcd.service <<'UNIT'`,
    '[Unit]',
    'Description=better-compute node daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '[Service]',
    'ExecStart=/usr/local/bin/bcd node --join-token-file /etc/better-compute/join-token',
    'Restart=always',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'systemctl enable bcd.service',
    'shred -u "$0" 2>/dev/null || rm -f "$0"',
    'EOF',
    'chmod 0700 /root/bc-post-install.sh',
    '/root/.oldroot/nfs/install/installimage -a -c /root/bc-autosetup -x /root/bc-post-install.sh',
    'shred -u /root/bc-join-token /root/bc-post-install.sh',
    'reboot',
  ].join('\n');
}

class HetznerRobotClient implements ProviderImpl {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #config: HetznerRobotConfig;
  readonly #context: ProviderContext;
  readonly #options: HetznerRobotOptions;

  constructor(config: HetznerRobotConfig, context: ProviderContext, options: HetznerRobotOptions) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpoint = (options.endpoint ?? 'https://robot-ws.your-server.de').replace(/\/+$/, '');
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    form?: [string, string][],
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const password = await this.#context.secrets.resolve(this.#config.password);
    const authorization = `Basic ${btoa(`${this.#config.user}:${password}`)}`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ComputeError(
        'PROVIDER_ERROR',
        `Hetzner Robot unreachable: ${(error as Error).message}`,
        undefined,
        {
          provider: 'hetzner-robot',
        },
      );
    }
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (response.ok) return payload as T;
    const error = (payload.error ?? {}) as { code?: string; message?: string; interval?: number };
    if (response.status === 404) return undefined;
    const details: Record<string, unknown> = {
      provider: 'hetzner-robot',
      status: response.status,
      code: error.code ?? 'unknown',
    };
    if (error.code === 'RATE_LIMIT_EXCEEDED' || response.status === 429)
      throw new ComputeError('RATE_LIMITED', 'Hetzner Robot rate limit exceeded', undefined, {
        ...details,
        retryAfterMs: Math.max(1, Number(error.interval ?? 60)) * 1000,
      });
    throw new ComputeError(
      'PROVIDER_ERROR',
      `Hetzner Robot ${method} ${path}: ${error.message ?? response.statusText}`,
      undefined,
      details,
    );
  }

  async #servers(signal?: AbortSignal): Promise<RobotServer[]> {
    const list =
      (await this.#request<{ server: RobotServer }[]>('GET', '/server', undefined, signal)) ?? [];
    return list.map((entry) => entry.server);
  }

  async #server(id: string, signal?: AbortSignal): Promise<RobotServer | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    return (await this.#request<{ server: RobotServer }>('GET', `/server/${id}`, undefined, signal))
      ?.server;
  }

  #spec(product: string) {
    return this.#options.products?.[product] ?? robotProducts[product] ?? { vcpu: 1, memoryGiB: 1 };
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.kind === 'vps') return [];
    const offers: Offer[] = [];
    for (const server of await this.#servers()) {
      // Only unnamed servers are free: a name means someone (or another claim) uses the server.
      if (server.cancelled || server.server_name !== '') continue;
      const spec = this.#spec(server.product);
      const offer: Offer = {
        id: String(server.server_number),
        kind: 'metal',
        region: region(server.dc),
        vcpu: spec.vcpu,
        memoryGiB: spec.memoryGiB,
        available: server.status === 'ready',
      };
      if (spec.diskGiB !== undefined) offer.diskGiB = spec.diskGiB;
      if (spec.gpus) offer.gpus = { ...spec.gpus };
      if (query.region && offer.region !== query.region) continue;
      if ((query.minVcpu ?? 0) > offer.vcpu || (query.minMemoryGiB ?? 0) > offer.memoryGiB)
        continue;
      if ((query.minGpus ?? 0) > (offer.gpus?.count ?? 0)) continue;
      if (query.gpuModel && offer.gpus?.model !== query.gpuModel) continue;
      offers.push(offer);
    }
    return offers.sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Claims the server `offerId` for the idempotency key (a retried claim returns the same server). */
  async create(
    request: { offerId: string; image: ImageRef; userData: string; name: string },
    context: CallContext,
  ): Promise<ExternalMachine> {
    const claim = robotClaimName(context.idempotencyKey);
    const owned = (await this.#servers(context.signal)).find(
      (server) => server.server_name === claim,
    );
    if (owned) return toMachine(owned);
    const server = await this.#server(request.offerId, context.signal);
    if (!server || server.cancelled)
      throw new ComputeError('NOT_FOUND', `Robot server ${request.offerId} not found`);
    if (server.server_name !== '')
      throw new ComputeError(
        'CONFLICT',
        `Robot server ${request.offerId} is in use (named ${JSON.stringify(server.server_name)})`,
      );
    await this.#request(
      'POST',
      `/server/${server.server_number}`,
      [['server_name', claim]],
      context.signal,
    );
    // Robot has no compare-and-set: a concurrent claim under another key can rename after us. Read
    // back, so the loser of an observed race answers CONFLICT. This narrows the race but cannot
    // close it (both may read their own name before the other writes); the vps reconciler must
    // not create concurrently on one Robot account (it runs one instance per key, serially).
    const settled = await this.#server(request.offerId, context.signal);
    if (!settled || settled.server_name !== claim)
      throw new ComputeError(
        'CONFLICT',
        `Robot server ${request.offerId} was claimed concurrently`,
      );
    return toMachine(settled);
  }

  /** A claimed server; unclaimed ones are not this provider's and read as absent. */
  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    const server = await this.#server(id, context.signal);
    if (!server || !server.server_name.startsWith(robotClaimPrefix)) return undefined;
    return toMachine(server);
  }

  /** Releases the claim (and rescue). The server itself stays: cancelling is for people, not APIs. */
  async delete(id: string, context: CallContext): Promise<void> {
    const server = await this.#server(id, context.signal);
    if (!server || !server.server_name.startsWith(robotClaimPrefix))
      throw new ComputeError('NOT_FOUND', `Robot server ${id} is not claimed`);
    await this.#request(
      'DELETE',
      `/boot/${server.server_number}/rescue`,
      undefined,
      context.signal,
    );
    await this.#request(
      'POST',
      `/server/${server.server_number}`,
      [['server_name', '']],
      context.signal,
    );
  }

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    const type = resetTypes[action];
    if (!type) throw new ComputeError('UNSUPPORTED', `Hetzner Robot has no ${action} action`);
    const reset = await this.#request('POST', `/reset/${id}`, [['type', type]], context.signal);
    if (reset === undefined) throw new ComputeError('NOT_FOUND', `Robot server ${id} not found`);
  }

  /** Activates the Linux rescue system with the account's key and hardware-resets into it. */
  async rescue(id: string, context: CallContext): Promise<RescueAccess> {
    const activated = await this.#request<{ rescue: { server_ip: string } }>(
      'POST',
      `/boot/${id}/rescue`,
      [
        ['os', 'linux'],
        ['authorized_key[]', this.#config.rescueKeyFingerprint],
      ],
      context.signal,
    );
    if (!activated) throw new ComputeError('NOT_FOUND', `Robot server ${id} not found`);
    await this.power(id, 'reset', context);
    return {
      address: activated.rescue.server_ip,
      username: 'root',
      credential: this.#config.rescueKey,
    };
  }

  async *list(context: CallContext): AsyncIterable<ExternalMachine> {
    for (const server of await this.#servers(context.signal))
      if (server.server_name.startsWith(robotClaimPrefix)) yield toMachine(server);
  }

  #ssh(): SshExecutor {
    const ssh = this.#options.ssh;
    if (!ssh)
      throw new ComputeError(
        'INVALID_CONFIG',
        'hetznerRobotProvider({ ssh }) is required for identify and bootstrap',
      );
    return ssh;
  }

  /** Rescue's SSH target for a server, answering right now; undefined when it does not. */
  async #inRescue(
    machine: ExternalMachine,
  ): Promise<{ host: string; username: string; privateKey: string } | undefined> {
    const host = machine.addresses.find((address) => !address.includes(':'));
    if (!host) return undefined;
    const target = {
      host,
      username: 'root',
      privateKey: await this.#context.secrets.resolve(this.#config.rescueKey),
    };
    const probe = await this.#ssh()(target, rescueProbe).catch(() => undefined);
    return probe?.code === 0 ? target : undefined;
  }

  /**
   * Boots the server into rescue unless it is already there (identify left it so), and waits until
   * rescue answers over SSH with the account's key.
   */
  async #rescueTarget(
    machine: ExternalMachine,
    context: CallContext,
  ): Promise<{ host: string; username: string; privateKey: string }> {
    const ssh = this.#ssh();
    const already = await this.#inRescue(machine);
    if (already) return already;
    const access = await this.rescue(machine.id, context);
    const target = {
      host: access.address,
      username: access.username,
      privateKey: await this.#context.secrets.resolve(this.#config.rescueKey),
    };
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const clock: Clock = this.#context.clock;
    const deadline = clock.now() + (this.#options.rescueTimeoutMs ?? 10 * 60_000);
    // Rescue is up when it answers; the hardware reset takes a minute or two.
    for (;;) {
      const probe = await ssh(target, rescueProbe).catch(() => undefined);
      if (probe?.code === 0) return target;
      if (clock.now() >= deadline || context.signal.aborted)
        throw new ComputeError(
          'PROVIDER_ERROR',
          `Rescue on Robot server ${machine.id} did not come up`,
          undefined,
          {
            provider: 'hetzner-robot',
          },
        );
      await sleep(this.#options.rescuePollMs ?? 15_000);
    }
  }

  /**
   * The server's SMBIOS UUID, read in rescue, so its bootstrap token can be bound to it (the
   * `provisioned` attestor refuses unbound tokens). Leaves the server in rescue for `bootstrap`.
   */
  async identify(machine: ExternalMachine, context: CallContext): Promise<{ productUuid: string }> {
    const target = await this.#rescueTarget(machine, context);
    const read = await this.#ssh()(target, 'cat /sys/class/dmi/id/product_uuid');
    const productUuid = read.stdout.trim().toLowerCase();
    if (
      read.code !== 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(productUuid)
    )
      throw new ComputeError(
        'PROVIDER_ERROR',
        `Could not read the SMBIOS UUID of Robot server ${machine.id}`,
        undefined,
        { provider: 'hetzner-robot' },
      );
    return { productUuid };
  }

  /**
   * Installs the OS from rescue and starts bcd with a single-use `provisioned` join token (§3.6).
   * The token travels only over SSH stdin into a root-only file; it never enters user data, argv or
   * logs. bcd's download is pinned by sha256.
   */
  async bootstrap(
    machine: ExternalMachine,
    bootstrap: { joinToken: string; bcdUrl: string; sha256: string },
    context: CallContext,
  ): Promise<void> {
    const ssh = this.#ssh();
    if (!/^[0-9a-f]{64}$/.test(bootstrap.sha256))
      throw new ComputeError('INVALID_INPUT', 'bootstrap.sha256 must be a hex sha256');
    if (!/^https:\/\//.test(bootstrap.bcdUrl))
      throw new ComputeError('INVALID_INPUT', 'bcdUrl must be https');
    const target = await this.#rescueTarget(machine, context);
    const written = await ssh(
      target,
      'umask 077 && cat > /root/bc-join-token',
      bootstrap.joinToken,
    );
    if (written.code !== 0)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'Could not deliver the join token to rescue',
        undefined,
        {
          provider: 'hetzner-robot',
        },
      );
    const script = bootstrapScript({
      hostname: machine.name && machine.name !== '' ? machine.name : `bc-${machine.id}`,
      image: this.#config.image,
      bcdUrl: bootstrap.bcdUrl,
      sha256: bootstrap.sha256,
    });
    const installed = await ssh(target, 'sh -s', script);
    // `reboot` may cut the session before it reports; anything else non-zero is a failure.
    if (installed.code !== 0 && installed.code !== 255)
      throw new ComputeError(
        'PROVIDER_ERROR',
        `installimage failed on Robot server ${machine.id}`,
        undefined,
        {
          provider: 'hetzner-robot',
          code: installed.code,
          stderr: installed.stderr.slice(-2000),
        },
      );
    await this.#request('DELETE', `/boot/${machine.id}/rescue`, undefined, context.signal);
  }
}

/** A Hetzner Robot provider definition; pass `ssh` for bootstrap and `fetch` to swap the transport. */
export function hetznerRobotProvider(
  options: HetznerRobotOptions = {},
): ProviderDefinition<HetznerRobotConfig> {
  return defineProvider<HetznerRobotConfig>({
    id: 'hetzner-robot',
    version: '0.1.0',
    provides: ['metal'],
    config: hetznerRobotConfig as unknown as ProviderDefinition<HetznerRobotConfig>['config'],
    capabilities: ['power', 'rescue', 'identify', 'bootstrap', 'list'],
    create: (config, context) => new HetznerRobotClient(config, context, options),
  });
}

/** Hetzner Robot without an SSH executor (offers, claims, power, rescue; not bootstrap). */
export const hetznerRobot: ProviderDefinition<HetznerRobotConfig> = hetznerRobotProvider();
