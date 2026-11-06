import { createHash } from 'node:crypto';
import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type ExternalMachine,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderImpl,
  type SecretRef,
} from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';

// DigitalOcean Bare Metal GPUs as metal hosts (P3, DO-D17). DigitalOcean's public API has no Bare
// Metal resource (research S4, checked again 2026-11-05), so this is DO-D17's fallback: the
// operator lists the machines DigitalOcean delivered (code-level `machines`, never tenant config),
// and the provider reaches them over SSH only.
//
// - A claim is a file on the machine (`/var/lib/better-compute/claim`), created with O_EXCL (the
//   shell's noclobber), so two claims of one machine can't both win: unlike DO's tags or Robot's
//   server names, this is a compare-and-set. Its content names the deployment (a hash) and the
//   idempotency key; a retried create finds its own claim.
// - `delete` stops bcd and removes the claim when it is this deployment's; the machine itself stays
//   (it is rented from DigitalOcean, not created). Anything else is refused.
// - `bootstrap` delivers the single-use `provisioned` join token over SSH stdin into a root-only
//   file (never user data, argv or a log), installs bcd pinned by sha256 and starts it. DO installs
//   the OS, so there is no reinstall.
// - Power: only `graceful-restart` (a reboot over SSH). Without a BMC or an API, a machine that is
//   powered off can't be powered on again, so every other action is UNSUPPORTED.
//
// Accounts are the platform's only: the machines are the operator's.

/** One Bare Metal GPU machine, as the operator lists it. */
export interface DoBareMetalMachine {
  /** The machine's id in better-compute: `[a-z0-9-]`, at most 63 characters. */
  id: string;
  /** DO region slug (`nyc3`, `ams3`, …). */
  region: string;
  /** The public (or reachable private) IPv4 address SSH connects to. */
  address: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB?: number;
  gpus?: { model: string; count: number };
  /**
   * SHA-256 of the machine's SSH host key (`SHA256:<base64>`, as `ssh-keygen -lf` prints it).
   * Required: the executor must refuse any other key. Bootstrap writes a single-use join token over
   * this connection, so an unpinned host (TOFU, an empty known_hosts) would hand it to whoever is on
   * the path.
   */
  hostKeySha256: string;
}

/**
 * Runs one command over SSH; `stdin` carries secrets so they never appear in argv. The executor
 * must refuse a host whose key is not `hostKeySha256` (never trust on first use).
 */
export type DoSshExecutor = (
  target: { host: string; username: string; privateKey: string; hostKeySha256: string },
  command: string,
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DoBareMetalOptions {
  /** The machines this provider may claim. */
  machines?: readonly DoBareMetalMachine[];
  /** Required for every call that reaches a machine. */
  ssh?: DoSshExecutor;
  /** Trust-domain string, hashed into each claim. Default `default` (as the Droplet provider's). */
  deployment?: string;
}

export const doBareMetalConfig = manifest({
  sshKey: field
    .secret()
    .describe('The SSH private key authorized on the machines, as a secret reference'),
  sshUser: field
    .string({ pattern: '^[a-z_][a-z0-9_-]{0,31}$' })
    .default('root')
    .describe(
      'The user SSH logs in as: root, or one with passwordless sudo (every command then runs through sudo -n)',
    ),
  regions: field
    .list(field.string({ pattern: '^[a-z][a-z0-9]*$' }), { min: 1 })
    .describe('Region slugs this account offers machines in'),
});

export interface DoBareMetalConfig {
  sshKey: SecretRef;
  sshUser: string;
  regions: string[];
}

/** Where a machine's claim lives. */
export const bareMetalClaimPath = '/var/lib/better-compute/claim';
/** Where the installed bcd reads its join token until `bcd join` spends it. */
export const bareMetalJoinTokenPath = '/etc/bcd/join-token';

const idPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const regionPattern = /^[a-z][a-z0-9]*$/;
const ipv4Pattern =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const hostKeyPattern = /^SHA256:[A-Za-z0-9+/]{43}$/;
const claimPattern = /^bc-[0-9a-f]{12}-[a-z0-9-]{1,80}$/;
const pinPattern = /^sha256\/[A-Za-z0-9+/]{43}=$/;
/** A URL safe in a systemd ExecStart= and a quoted heredoc. */
const unitSafeUrl = /^https:\/\/[^\s'"%$`\\]+$/;

function fail(
  code:
    | 'INVALID_CONFIG'
    | 'INVALID_INPUT'
    | 'INVALID_STATE'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'UNSUPPORTED'
    | 'UNAVAILABLE'
    | 'PROVIDER_ERROR',
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean-metal',
    reason,
    ...extra,
  });
}

/** The claim this deployment writes for an idempotency key. */
export function bareMetalClaim(deployment: string, idempotencyKey: string): string {
  const hash = createHash('sha256').update(deployment).digest('hex').slice(0, 12);
  const key = idempotencyKey
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 64);
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12);
  return `bc-${hash}-${key}-${keyHash}`;
}

/** Reads the claim; prints nothing when there is none. */
export const readClaimCommand = `cat ${bareMetalClaimPath} 2>/dev/null || true`;
/**
 * Claims the machine for the claim on stdin, atomically: noclobber (`set -C`) creates the file
 * with O_EXCL. Prints the claim the machine holds afterwards (ours, or the winner's).
 */
export const claimCommand = [
  'set -eu',
  'IFS= read -r CLAIM',
  'mkdir -p /var/lib/better-compute',
  `( set -C; printf '%s\\n' "$CLAIM" > ${bareMetalClaimPath} ) 2>/dev/null || true`,
  `cat ${bareMetalClaimPath}`,
].join('; ');
/**
 * What a release removes besides the claim: bcd's binary, units, configuration and state (its node
 * identity among them), so the next claim's bcd joins as a new node and inherits nothing. The OS
 * and anything outside these stays: DigitalOcean has no API to reinstall a Bare Metal machine.
 */
export const bareMetalBcdPaths = [
  '/usr/local/bin/bcd',
  '/usr/local/bin/bcd.new',
  '/etc/systemd/system/bcd.service',
  '/etc/systemd/system/bcd-join.service',
  '/etc/bcd',
  '/var/lib/bcd',
] as const;
/** Stops bcd, removes its install and the claim, if the claim still is the one on stdin. */
export const releaseCommand = [
  'set -eu',
  'IFS= read -r CLAIM',
  `[ "$(cat ${bareMetalClaimPath} 2>/dev/null || true)" = "$CLAIM" ] || exit 3`,
  'systemctl disable --now bcd.service bcd-join.service 2>/dev/null || true',
  `rm -rf ${bareMetalJoinTokenPath} ${bareMetalBcdPaths.join(' ')}`,
  'systemctl daemon-reload 2>/dev/null || true',
  `rm -f ${bareMetalClaimPath}`,
].join('; ');
export const productUuidCommand = 'cat /sys/class/dmi/id/product_uuid';
export const writeTokenCommand = `umask 077 && mkdir -p /etc/bcd && cat > ${bareMetalJoinTokenPath}`;
export const rebootCommand = 'systemctl reboot';
/** The command bootstrap's install script runs in (the script is its stdin). */
export const installCommand = 'sh -s';

/**
 * A command as `user` runs it: as is for root, else through passwordless sudo (`sudo -n`, which
 * fails rather than prompts). stdin passes through to the elevated shell.
 */
export function asRoot(command: string, user: string): string {
  if (user === 'root') return command;
  return `sudo -n sh -c '${command.replaceAll("'", "'\\''")}'`;
}

/**
 * The `bcd join` the machine runs once (the Go contract, as provider-hetzner's robot provider
 * has it): bcd reads the gateway and pins from the control plane's well-known document, joins with
 * the `provisioned` token and removes the token file.
 */
export function bareMetalJoinArgv(
  controlPlaneUrl: string,
  pins: { servingCa: string; joinSigning: string; joinEncryption: string },
): string[] {
  return [
    '/usr/local/bin/bcd',
    'join',
    '--server',
    controlPlaneUrl,
    '--token-file',
    bareMetalJoinTokenPath,
    '--attestor',
    'provisioned',
    '--serving-ca-pin',
    pins.servingCa,
    '--join-signing-pin',
    pins.joinSigning,
    '--join-encryption-pin',
    pins.joinEncryption,
  ];
}

/** The install script bootstrap sends over SSH stdin, after the token file is written. */
export function bareMetalInstallScript(input: {
  bcdUrl: string;
  sha256: string;
  controlPlaneUrl: string;
  pins: { servingCa: string; joinSigning: string; joinEncryption: string };
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    'set -eu',
    'umask 022',
    `test -s ${bareMetalJoinTokenPath}`,
    `curl -fsSL --retry 5 -o /usr/local/bin/bcd.new ${quote(input.bcdUrl)}`,
    `echo ${quote(`${input.sha256}  /usr/local/bin/bcd.new`)} | sha256sum -c -`,
    'chmod 0755 /usr/local/bin/bcd.new',
    'mv /usr/local/bin/bcd.new /usr/local/bin/bcd',
    `cat > /etc/systemd/system/bcd-join.service <<'UNIT'`,
    '[Unit]',
    'Description=Join better-compute',
    'After=network-online.target',
    'Wants=network-online.target',
    `ConditionPathExists=${bareMetalJoinTokenPath}`,
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${bareMetalJoinArgv(input.controlPlaneUrl, input.pins).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=15',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    `cat > /etc/systemd/system/bcd.service <<'UNIT'`,
    '[Unit]',
    'Description=better-compute node agent',
    'After=network-online.target bcd-join.service',
    'Wants=network-online.target',
    '[Service]',
    'ExecStart=/usr/local/bin/bcd node',
    'Restart=always',
    'RestartSec=5',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'systemctl daemon-reload',
    'systemctl enable --now bcd-join.service bcd.service',
  ].join('\n');
}

function checkMachines(machines: readonly DoBareMetalMachine[]): Map<string, DoBareMetalMachine> {
  const byId = new Map<string, DoBareMetalMachine>();
  for (const machine of machines) {
    const where = `Bare Metal machine ${JSON.stringify(machine.id)}`;
    if (!idPattern.test(machine.id))
      throw fail('INVALID_CONFIG', `${where}: the id must be [a-z0-9-], at most 63`, 'machines');
    if (byId.has(machine.id)) throw fail('INVALID_CONFIG', `${where} is listed twice`, 'machines');
    if (!regionPattern.test(machine.region))
      throw fail('INVALID_CONFIG', `${where}: the region is not a region slug`, 'machines');
    if (!ipv4Pattern.test(machine.address))
      throw fail('INVALID_CONFIG', `${where}: the address is not an IPv4 address`, 'machines');
    // Fail closed: the join token goes over this connection (bootstrap), so the host is pinned.
    if (machine.hostKeySha256 === undefined)
      throw fail('INVALID_CONFIG', `${where}: hostKeySha256 is required`, 'hostKey');
    if (!hostKeyPattern.test(machine.hostKeySha256))
      throw fail('INVALID_CONFIG', `${where}: hostKeySha256 is not SHA256:<base64>`, 'machines');
    if (!(machine.vcpu > 0 && machine.memoryGiB > 0))
      throw fail('INVALID_CONFIG', `${where}: vcpu and memoryGiB must be positive`, 'machines');
    byId.set(machine.id, machine);
  }
  return byId;
}

class DoBareMetal implements ProviderImpl {
  readonly #config: DoBareMetalConfig;
  readonly #context: ProviderContext;
  readonly #machines: Map<string, DoBareMetalMachine>;
  readonly #ssh: DoSshExecutor | undefined;
  readonly #deployment: string;
  readonly #claimPrefix: string;

  constructor(
    config: DoBareMetalConfig,
    context: ProviderContext,
    machines: Map<string, DoBareMetalMachine>,
    options: DoBareMetalOptions,
  ) {
    this.#config = config;
    this.#context = context;
    this.#machines = machines;
    this.#ssh = options.ssh;
    this.#deployment = options.deployment ?? 'default';
    this.#claimPrefix = bareMetalClaim(this.#deployment, 'x').slice(0, 'bc-'.length + 13);
  }

  /** The listed machine `id` in one of the account's regions. */
  #machine(id: string): DoBareMetalMachine | undefined {
    const machine = this.#machines.get(id);
    return machine && this.#config.regions.includes(machine.region) ? machine : undefined;
  }

  /** Runs a command on a machine. An SSH failure is UNAVAILABLE (retried); the key never leaves. */
  async #run(
    machine: DoBareMetalMachine,
    command: string,
    stdin?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.#ssh)
      throw fail(
        'INVALID_CONFIG',
        'digitaloceanMetal needs an ssh executor (digitaloceanMetalProvider({ ssh }))',
        'ssh',
      );
    if (!machine.hostKeySha256 || !hostKeyPattern.test(machine.hostKeySha256))
      throw fail('INVALID_CONFIG', `Bare Metal machine ${machine.id} pins no host key`, 'hostKey');
    const privateKey = await this.#context.secrets.resolve(this.#config.sshKey);
    try {
      return await this.#ssh(
        {
          host: machine.address,
          username: this.#config.sshUser,
          privateKey,
          hostKeySha256: machine.hostKeySha256,
        },
        asRoot(command, this.#config.sshUser),
        stdin,
      );
    } catch {
      // The executor's error may quote the target or the key's path: it is not passed on.
      this.#context.log.warn('digitalocean.metalUnreachable', { machine: machine.id });
      throw fail('UNAVAILABLE', `Bare Metal machine ${machine.id} is unreachable over SSH`, 'ssh', {
        retryAfterMs: 30_000,
      });
    }
  }

  async #claimOf(machine: DoBareMetalMachine): Promise<string | undefined> {
    const read = await this.#run(machine, readClaimCommand);
    if (read.code !== 0)
      throw fail('PROVIDER_ERROR', `could not read the claim of ${machine.id}`, 'claimRead');
    const claim = read.stdout.trim();
    return claim === '' ? undefined : claim;
  }

  /** Whether the claim is this deployment's (any of its instances'): what `list` shows. */
  #ours(claim: string | undefined): boolean {
    return claim !== undefined && claimPattern.test(claim) && claim.startsWith(this.#claimPrefix);
  }

  /** The exact claim the caller (its idempotency key: the instance or bootstrap id) writes. */
  #claimFor(context: CallContext): string {
    return bareMetalClaim(this.#deployment, context.idempotencyKey);
  }

  #toMachine(machine: DoBareMetalMachine): ExternalMachine {
    return {
      id: machine.id,
      name: machine.id,
      state: 'running',
      offerId: machine.id,
      region: machine.region,
      addresses: [machine.address],
      vcpu: machine.vcpu,
      memoryGiB: machine.memoryGiB,
      ...(machine.gpus ? { gpus: { ...machine.gpus } } : {}),
      labels: { 'better-compute-provider': 'digitalocean-metal' },
    };
  }

  #offer(machine: DoBareMetalMachine, available: boolean): Offer {
    return {
      id: machine.id,
      kind: 'metal',
      region: machine.region,
      vcpu: machine.vcpu,
      memoryGiB: machine.memoryGiB,
      ...(machine.diskGiB !== undefined ? { diskGiB: machine.diskGiB } : {}),
      ...(machine.gpus ? { gpus: { ...machine.gpus } } : {}),
      available,
    };
  }

  /** Unclaimed machines (one SSH read each); one that can't be reached is offered unavailable. */
  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.kind === 'vps') return [];
    const wanted = [...this.#machines.values()].filter(
      (m) =>
        this.#config.regions.includes(m.region) &&
        (query.region === undefined || m.region === query.region) &&
        (query.minVcpu ?? 0) <= m.vcpu &&
        (query.minMemoryGiB ?? 0) <= m.memoryGiB &&
        (query.minGpus ?? 0) <= (m.gpus?.count ?? 0) &&
        (query.gpuModel === undefined ||
          m.gpus?.model.toUpperCase() === query.gpuModel.toUpperCase()),
    );
    const offers: Offer[] = [];
    for (const machine of wanted) {
      let claim: string | undefined;
      try {
        claim = await this.#claimOf(machine);
      } catch {
        offers.push(this.#offer(machine, false));
        continue;
      }
      if (claim === undefined) offers.push(this.#offer(machine, true));
    }
    return offers;
  }

  /** Claims the machine `offerId` for the idempotency key; a retried claim returns it again. */
  async create(
    request: Parameters<ProviderImpl['create']>[0],
    context: CallContext,
  ): Promise<ExternalMachine> {
    const machine = this.#machine(request.offerId);
    if (!machine)
      throw fail(
        'NOT_FOUND',
        `Bare Metal machine ${request.offerId} is not listed for this account`,
        'machine',
      );
    const claim = bareMetalClaim(this.#deployment, context.idempotencyKey);
    const result = await this.#run(machine, claimCommand, `${claim}\n`);
    if (result.code !== 0)
      throw fail('PROVIDER_ERROR', `could not claim ${machine.id}`, 'claimWrite');
    const holder = result.stdout.trim();
    if (holder !== claim)
      throw fail('CONFLICT', `Bare Metal machine ${machine.id} is claimed by another`, 'claimed');
    this.#context.log.info('digitalocean.metalClaimed', { machine: machine.id });
    return this.#toMachine(machine);
  }

  /**
   * The machine if the caller holds its claim; any other claim, another instance's of this
   * deployment included, reads as absent (the caller's machine is gone).
   */
  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    const machine = this.#machine(id);
    if (!machine) return undefined;
    const claim = await this.#claimOf(machine);
    return claim === this.#claimFor(context) ? this.#toMachine(machine) : undefined;
  }

  /**
   * Releases the caller's claim and stops bcd; the machine stays. Another instance's claim of this
   * deployment means the caller's is already gone (a release that won on the machine but was not
   * recorded): done, and that claim is left alone. A claim outside this deployment is refused.
   */
  async delete(id: string, context: CallContext): Promise<void> {
    const machine = this.#machine(id);
    if (!machine) return;
    const claim = await this.#claimOf(machine);
    if (claim === undefined) return;
    const expected = this.#claimFor(context);
    if (claim !== expected && this.#ours(claim)) return;
    if (claim !== expected)
      throw fail(
        'INVALID_STATE',
        `Bare Metal machine ${id} is not claimed by this better-compute deployment`,
        'notManaged',
      );
    const released = await this.#run(machine, releaseCommand, `${expected}\n`);
    // 3: the claim changed between the read and the release; the next delete looks again.
    if (released.code === 3)
      throw fail('CONFLICT', `the claim on ${id} changed while it was released`, 'claimChanged');
    if (released.code !== 0)
      throw fail('PROVIDER_ERROR', `could not release ${id}`, 'claimRelease');
  }

  /** The machine `id` if the caller holds its claim, else refused (another instance's included). */
  async #claimed(id: string, context: CallContext): Promise<DoBareMetalMachine> {
    const machine = this.#machine(id);
    if (!machine) throw fail('NOT_FOUND', `Bare Metal machine ${id} is not listed`, 'machine');
    if ((await this.#claimOf(machine)) !== this.#claimFor(context))
      throw fail(
        'INVALID_STATE',
        `Bare Metal machine ${id} is not claimed by this instance of this better-compute deployment`,
        'notManaged',
      );
    return machine;
  }

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    if (action !== 'graceful-restart')
      throw fail(
        'UNSUPPORTED',
        `DigitalOcean Bare Metal has no API or BMC for ${action}: only a reboot over SSH`,
        'noBmc',
      );
    const machine = await this.#claimed(id, context);
    await this.#run(machine, rebootCommand);
  }

  async *list(): AsyncIterable<ExternalMachine> {
    for (const machine of this.#machines.values()) {
      if (!this.#config.regions.includes(machine.region)) continue;
      const claim = await this.#claimOf(machine);
      if (this.#ours(claim)) yield this.#toMachine(machine);
    }
  }

  async identify(
    machine: ExternalMachine,
    context: CallContext,
  ): Promise<{ productUuid: string }> {
    const target = await this.#claimed(machine.id, context);
    const read = await this.#run(target, productUuidCommand);
    const productUuid = read.stdout.trim().toLowerCase();
    if (
      read.code !== 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(productUuid)
    )
      throw fail('PROVIDER_ERROR', `could not read the SMBIOS UUID of ${machine.id}`, 'identify');
    return { productUuid };
  }

  /**
   * Installs and starts bcd with a single-use `provisioned` join token. The token travels only
   * over SSH stdin into a root-only file; bcd's download is pinned by sha256.
   */
  async bootstrap(
    machine: ExternalMachine,
    bootstrap: Parameters<NonNullable<ProviderImpl['bootstrap']>>[1],
    context: CallContext,
  ): Promise<void> {
    if (!bootstrap.controlPlaneUrl || !unitSafeUrl.test(bootstrap.controlPlaneUrl))
      throw fail(
        'INVALID_CONFIG',
        'bootstrap needs the https control plane URL the installed bcd joins through',
        'controlPlaneUrl',
      );
    const pins = bootstrap.pins;
    if (
      !pins ||
      ![pins.servingCa, pins.joinSigning, pins.joinEncryption].every((p) => pinPattern.test(p))
    )
      throw fail('INVALID_CONFIG', 'bootstrap needs sha256/<base64> join pins', 'pins');
    if (!/^[0-9a-f]{64}$/.test(bootstrap.sha256))
      throw fail('INVALID_INPUT', 'bootstrap.sha256 must be a hex sha256', 'sha256');
    if (!unitSafeUrl.test(bootstrap.bcdUrl))
      throw fail('INVALID_INPUT', 'bcdUrl must be an https URL', 'bcdUrl');
    const target = await this.#claimed(machine.id, context);
    const written = await this.#run(target, writeTokenCommand, bootstrap.joinToken);
    if (written.code !== 0)
      throw fail('PROVIDER_ERROR', `could not deliver the join token to ${machine.id}`, 'token');
    const script = bareMetalInstallScript({
      bcdUrl: bootstrap.bcdUrl,
      sha256: bootstrap.sha256,
      controlPlaneUrl: bootstrap.controlPlaneUrl,
      pins,
    });
    const installed = await this.#run(target, installCommand, script);
    if (installed.code !== 0)
      throw fail('PROVIDER_ERROR', `installing bcd failed on ${machine.id}`, 'install', {
        code: installed.code,
        stderr: installed.stderr.slice(-2000),
      });
  }
}

/**
 * DigitalOcean Bare Metal GPUs as a metal provider. Pass the operator's `machines` and an `ssh`
 * executor; accounts belong to the platform (root) tenant only.
 */
export function digitaloceanMetalProvider(
  options: DoBareMetalOptions = {},
): ProviderDefinition<DoBareMetalConfig> {
  const machines = checkMachines(options.machines ?? []);
  return defineProvider<DoBareMetalConfig>({
    id: 'digitalocean-metal',
    version: '0.1.0',
    provides: ['metal'],
    config: doBareMetalConfig as unknown as ProviderDefinition<DoBareMetalConfig>['config'],
    capabilities: ['power', 'identify', 'bootstrap', 'list'],
    create: (config, context) => {
      // Fail closed: an unknown account is not the platform's.
      if (context.account?.platform !== true)
        throw fail(
          'INVALID_CONFIG',
          "DigitalOcean Bare Metal accounts belong to the platform: the machines are the operator's",
          'platformOnly',
        );
      return new DoBareMetal(config, context, machines, options);
    },
  });
}

/** `digitaloceanMetalProvider()` with no machines and no SSH executor. */
export const digitaloceanMetal: ProviderDefinition<DoBareMetalConfig> = digitaloceanMetalProvider();
