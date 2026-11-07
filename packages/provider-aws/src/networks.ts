import {
  ComputeError,
  isComputeError,
  type CallContext,
  type NetworkRef,
  type ProviderContext,
  type ProviderFirewallSpec,
  type ProviderNetworks,
  type ProviderNetworkSpec,
  type ProviderNetworkState,
  type ProviderSubnetSpec,
} from '@better-compute/core';
import { partitionOf, type QueryParams, type XmlElement } from '@better-compute/aws-core';
import type { IamStatement } from './cli.js';
import type { AwsConfig } from './config.js';
import { clientToken, parseInstanceId, tags, tagValue } from './ids.js';

// Tenant networking on Amazon VPC (AWS A2). A better-compute network is a VPC with an internet
// gateway, its own route table (the default route) and its own network ACL, which every subnet it
// makes is associated with (AWS's main table and default ACL are never edited); its subnets are
// zone-scoped; firewall rules are security group rules (allows) and entries of the network's ACL
// (network-wide denies); a machine's network tags are security groups on its primary interface.
//
// Everything better-compute makes is found again by tag, never by remembered id, so a restart
// re-reads the account: VPCs, gateways, route tables, ACLs and subnets carry
// `better-compute:network` (and
// `better-compute:subnet`), security group rules carry one `better-compute:firewall:<name>` key per
// firewall that wants them, and a network ACL entry's owner is the ACL tag
// `better-compute:deny:<ingress|egress>:<rule number>`. Every ensure*/delete* call is idempotent and
// answers `pending` while AWS settles or something still uses a resource (DependencyViolation).

/** Tag keys of networking resources. */
export const networkTags = {
  network: 'better-compute:network',
  subnet: 'better-compute:subnet',
  /** On a subnet that asked for private service access (`true`): it keeps the gateway endpoints. */
  privateAccess: 'better-compute:private-access',
  /** On a per-tag security group: the network tag it stands for. */
  tag: 'better-compute:tag',
  /** `better-compute:firewall:<name>` on a security group rule: that firewall wants it. */
  firewallPrefix: 'better-compute:firewall:',
  /** `better-compute:deny:<ingress|egress>:<n>` on a network ACL: entry n belongs to the firewall named by the value. */
  denyPrefix: 'better-compute:deny:',
  /**
   * On a security group rule: EFA's self-referencing all-traffic rule of a network's group (config
   * `efa: 'auto'`). It carries no firewall key, so firewall diffing never sees or revokes it.
   */
  efa: 'better-compute:efa',
  /** (A10) On a filesystem's group and its rules: the filesystem (`ProviderFilesystemSpec.name`) they serve. */
  filesystem: 'better-compute:filesystem',
} as const;

/** (A10) A filesystem's way into its network: the VPC, its own group, and one subnet per zone. */
export interface FilesystemAccess {
  state: 'ready';
  vpcId: string;
  groupId: string;
  subnets: readonly { id: string; zone: string }[];
}

/** (A10) The tcp ports a filesystem's group opens: NFS, or Lustre's 988 and 1018-1023. */
const filesystemPorts: Readonly<Record<'nfs' | 'lustre', readonly [number, number][]>> = {
  nfs: [[2049, 2049]],
  lustre: [
    [988, 988],
    [1018, 1023],
  ],
};

/** The VPC CIDR a network gets when its spec names none. */
export const defaultNetworkCidr = '10.64.0.0/16';
/** The rule number the allow-all entries of a network's ACL move to, after every deny. */
export const naclAllowAllRule = 32766;
/** The security groups a network interface may have unless the account config says otherwise. */
export const defaultGroupsPerInterface = 5;
/** How often a VPC's unused tag groups are looked for (at most; by ensureNetwork, ensureFirewall, setTags). */
export const tagGroupSweepMs = 10 * 60_000;

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The network name vps gives the project's shared default network: here, the account's default VPC. */
const defaultNetwork = 'default';
const vpcIdPattern = /^vpc-[0-9a-f]{8,17}$/;
const subnetIdPattern = /^subnet-[0-9a-f]{8,17}$/;
// A tag's group is named after the tag, so a tag never takes the name of a network's group.
const tagPattern = /^bc-(?!net-)[a-z0-9-]{1,60}$/;

const state = (id: string, value: ProviderNetworkState['state'], message?: string) =>
  ({ id, state: value, ...(message !== undefined ? { message } : {}) }) as ProviderNetworkState;

const invalidInput = (message: string, reason: string) =>
  new ComputeError('INVALID_INPUT', message, undefined, { provider: 'aws', reason });

const awsCode = (error: unknown): string | undefined =>
  isComputeError(error) && typeof error.details?.code === 'string' ? error.details.code : undefined;

// --- CIDRs ---------------------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
  prefix: number;
}

function parseCidr(cidr: string): Range | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return undefined;
  const start = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const size = 2 ** (32 - prefix);
  if (start % size !== 0) return undefined;
  return { start, end: start + size - 1, prefix };
}

const within = (outer: Range, inner: Range) => outer.start <= inner.start && inner.end <= outer.end;
const overlap = (a: Range, b: Range) => a.start <= b.end && b.start <= a.end;
const formatCidr = (start: number, prefix: number) =>
  `${[24, 16, 8, 0].map((shift) => (start >>> shift) & 255).join('.')}/${prefix}`;

/** The ranges a VPC may use: RFC 1918 and the shared address space (100.64.0.0/10). */
const privateRanges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].map(
  (cidr) => parseCidr(cidr)!,
);

/** A private IPv4 CIDR of /16 to /28 (what AWS takes for a VPC block or a subnet); INVALID_INPUT otherwise. */
function vpcRange(cidr: string, what: string): Range {
  const range = parseCidr(cidr);
  if (!range)
    throw invalidInput(`${what} ${JSON.stringify(cidr.slice(0, 64))} is not an IPv4 CIDR`, 'cidr');
  if (range.prefix < 16 || range.prefix > 28)
    throw invalidInput(`${what} ${cidr} is not /16 to /28, the sizes AWS takes`, 'cidr-size');
  if (!privateRanges.some((allowed) => within(allowed, range)))
    throw invalidInput(`${what} ${cidr} is not in RFC 1918 or 100.64.0.0/10`, 'cidr-range');
  return range;
}

// --- Firewall compilation --------------------------------------------------------------------------

/** One security group rule as better-compute compares them. */
interface Permission {
  groupId: string;
  egress: boolean;
  /** `tcp`, `udp`, `icmp` or `-1`. */
  protocol: string;
  from: number;
  to: number;
  cidr: string;
}

const permissionKey = (p: Permission) =>
  `${p.groupId}|${p.egress}|${p.protocol}|${p.from}|${p.to}|${p.cidr}`;

/** `22` or `8000-8080` → [from, to]; INVALID_INPUT otherwise. */
function portRange(text: string): [number, number] {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text);
  const from = Number(match?.[1]);
  const to = match?.[2] !== undefined ? Number(match[2]) : from;
  if (!match || from > to || to > 65535)
    throw invalidInput(
      `port ${JSON.stringify(text.slice(0, 16))} is not a port or a range`,
      'port',
    );
  return [from, to];
}

/** The protocol/port tuples of a firewall's rules. */
function tuples(spec: ProviderFirewallSpec): { protocol: string; from: number; to: number }[] {
  const out: { protocol: string; from: number; to: number }[] = [];
  for (const rule of spec.rules) {
    if (rule.protocol === 'all') out.push({ protocol: '-1', from: -1, to: -1 });
    else if (rule.protocol === 'icmp') out.push({ protocol: 'icmp', from: -1, to: -1 });
    else if (!rule.ports?.length) out.push({ protocol: rule.protocol, from: 0, to: 65535 });
    else
      for (const port of rule.ports) {
        const [from, to] = portRange(port);
        out.push({ protocol: rule.protocol, from, to });
      }
  }
  return out;
}

/** The far side of a rule: ingress sources or egress destinations (anywhere when absent). */
function peers(spec: ProviderFirewallSpec): string[] {
  const list = spec.direction === 'ingress' ? spec.sources : spec.destinations;
  const values = list?.length ? [...new Set(list)] : ['0.0.0.0/0'];
  for (const value of values)
    if (!parseCidr(value) && !/^[0-9a-f:]+\/\d{1,3}$/i.test(value))
      throw invalidInput(`${JSON.stringify(value.slice(0, 64))} is not a CIDR`, 'cidr');
  return values;
}

const naclProtocols: Record<string, string> = { tcp: '6', udp: '17', icmp: '1', '-1': '-1' };

interface NaclEntry {
  number: number;
  egress: boolean;
  protocol: string;
  cidr: string;
  from?: number;
  to?: number;
}

const naclKey = (e: Omit<NaclEntry, 'number'>) =>
  `${e.egress}|${e.protocol}|${e.cidr}|${e.from ?? ''}|${e.to ?? ''}`;

// --- Parsed resources -------------------------------------------------------------------------------

interface Vpc {
  id: string;
  state: string;
  blocks: { cidr: string; state: string }[];
  tags: Map<string, string>;
  /** Made by better-compute (it carries the network tag). */
  ours: boolean;
}

const tagMap = (element: XmlElement) =>
  new Map(
    element.items('tagSet').map((item) => [item.textOf('key') ?? '', item.textOf('value') ?? '']),
  );

/** Made by better-compute for `network`: it carries the network tag and `better-compute:managed`. */
const madeFor = (item: XmlElement, network: string) => {
  const tagged = tagMap(item);
  return tagged.get(networkTags.network) === network && tagged.get(tags.managed) === 'true';
};

function parseVpc(item: XmlElement): Vpc {
  const tagged = tagMap(item);
  return {
    id: item.textOf('vpcId') ?? '',
    state: item.textOf('state') ?? '',
    blocks: item.items('cidrBlockAssociationSet').map((block) => ({
      cidr: block.textOf('cidrBlock') ?? '',
      state: block.child('cidrBlockState')?.textOf('state') ?? '',
    })),
    tags: tagged,
    ours: tagged.has(networkTags.network),
  };
}

interface Subnet {
  id: string;
  vpcId: string;
  cidr: string;
  zone: string;
  state: string;
  mapPublicIp: boolean;
  tags: Map<string, string>;
}

function parseSubnet(item: XmlElement): Subnet {
  return {
    id: item.textOf('subnetId') ?? '',
    vpcId: item.textOf('vpcId') ?? '',
    cidr: item.textOf('cidrBlock') ?? '',
    zone: item.textOf('availabilityZone') ?? '',
    state: item.textOf('state') ?? '',
    mapPublicIp: item.textOf('mapPublicIpOnLaunch') === 'true',
    tags: tagMap(item),
  };
}

interface Group {
  id: string;
  name: string;
  vpcId: string;
  tags: Map<string, string>;
}

interface Rule extends Permission {
  id: string;
  tags: Map<string, string>;
}

export interface AwsNetworksHost {
  config: AwsConfig;
  context: ProviderContext;
  /** An EC2 call after the account's identity checks. */
  call(action: string, params: QueryParams, signal: AbortSignal): Promise<XmlElement>;
  /** How long AWS may not yet show what this client just created (tag reads lag writes). */
  consistencyWindowMs(): number;
}

/** Where a machine on a network launches: the subnet and the security groups of its tags. */
export interface AwsPlacement {
  subnetId: string;
  zone: string;
  groupIds: string[];
}

/** One AWS account's VPC networking (`ProviderNetworks`). */
export class AwsNetworks implements ProviderNetworks {
  readonly subnetScope = 'zone' as const;
  readonly denyRules = 'network-wide' as const;
  /** A VPC range and a subnet are /16 to /28 (vps refuses others at the API). */
  readonly cidrPrefix = {
    network: [16, 28] as const,
    subnet: [16, 28] as const,
  };
  /** Network name → the VPC this client just created and when (DescribeVpcs by tag lags). */
  readonly #created = new Map<string, { id: string; at: number }>();
  /** VPCs whose DNS attributes this client has set. */
  readonly #dns = new Set<string>();
  /** VPC id → when its tag groups were last swept. */
  readonly #swept = new Map<string, number>();
  /** Tag group id → when a sweep first saw it unused (it is deleted at a later sweep, if still unused). */
  readonly #unused = new Map<string, { vpcId: string; at: number }>();

  constructor(readonly host: AwsNetworksHost) {}

  get #config(): AwsConfig {
    return this.host.config;
  }

  #call(action: string, params: QueryParams, signal: AbortSignal): Promise<XmlElement> {
    return this.host.call(action, params, signal);
  }

  /** Tolerates the AWS error codes listed: the call's outcome is already true. */
  async #tolerate(codes: readonly string[], action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (
        !codes.includes(awsCode(error) ?? '') &&
        !(codes.includes('*NotFound') && isComputeError(error, 'NOT_FOUND'))
      )
        throw error;
    }
  }

  /** The tags of a networking resource better-compute makes; `extra` wins (a subnet's own Name). */
  #ownTags(resourceType: string, network: string, extra: Record<string, string> = {}) {
    const entries = new Map<string, string>([
      [networkTags.network, network],
      [tags.managed, 'true'],
      [tags.name, tagValue(network)],
    ]);
    for (const [key, value] of Object.entries(extra)) entries.set(key, value);
    return [
      { ResourceType: resourceType, Tag: [...entries].map(([Key, Value]) => ({ Key, Value })) },
    ];
  }

  // --- VPC ---------------------------------------------------------------------------------------

  /**
   * The VPC a network name stands for: ours by tag, or an adopted one: a VPC id, or `default`
   * (the account's default VPC in the region, which vps adopts as the shared default network).
   */
  async #vpc(name: string, signal: AbortSignal): Promise<Vpc | undefined> {
    if (name === defaultNetwork) {
      const doc = await this.#call(
        'DescribeVpcs',
        { Filter: [{ Name: 'isDefault', Value: ['true'] }] },
        signal,
      );
      const item = doc.items('vpcSet')[0];
      // Adopted, whatever its tags say: never changed, never deleted.
      return item ? { ...parseVpc(item), ours: false } : undefined;
    }
    if (vpcIdPattern.test(name)) {
      try {
        const doc = await this.#call('DescribeVpcs', { VpcId: [name] }, signal);
        const item = doc.items('vpcSet')[0];
        return item ? parseVpc(item) : undefined;
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND')) return undefined;
        throw error;
      }
    }
    if (!namePattern.test(name))
      throw invalidInput(
        `network ${JSON.stringify(name.slice(0, 64))} is not a better-compute network name or a VPC id`,
        'network-name',
      );
    const doc = await this.#call(
      'DescribeVpcs',
      { Filter: [{ Name: `tag:${networkTags.network}`, Value: [name] }] },
      signal,
    );
    const found = doc
      .items('vpcSet')
      .map(parseVpc)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (found.length > 1) {
      // A duplicate (a CreateVpc retried inside the tag lag): the one in use, with the gateway,
      // wins over an empty one, whatever the ids; deleteNetwork deletes them all.
      const gateways = await this.#call(
        'DescribeInternetGateways',
        { Filter: [{ Name: 'attachment.vpc-id', Value: found.map((vpc) => vpc.id) }] },
        signal,
      );
      const attached = new Set(
        gateways
          .items('internetGatewaySet')
          .flatMap((igw) => igw.items('attachmentSet').map((a) => a.textOf('vpcId'))),
      );
      found.sort((a, b) => Number(attached.has(b.id)) - Number(attached.has(a.id)));
      this.host.context.log.warn('aws: more than one VPC carries a network tag', {
        provider: 'aws',
        network: name,
        vpcs: found.map((vpc) => vpc.id),
        used: found[0]!.id,
      });
    }
    if (found[0]) return found[0];
    const created = this.#created.get(name);
    if (created && this.host.context.clock.now() - created.at < this.host.consistencyWindowMs())
      return {
        id: created.id,
        state: 'pending',
        blocks: [],
        tags: new Map([[networkTags.network, name]]),
        ours: true,
      };
    return undefined;
  }

  /**
   * CreateVpc takes no idempotency token: before making one, a VPC of the range read without a tag
   * filter (which lags) whose tags name the network, as a lost CreateVpc answer leaves. With an
   * IPAM pool the range is not known up front, so every VPC of the region is read (a page at a time).
   */
  async #byRange(name: string, cidr: string, signal: AbortSignal): Promise<Vpc | undefined> {
    const vpcs: Vpc[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.#call(
        'DescribeVpcs',
        this.#config.ipamPoolId
          ? { MaxResults: 1000, NextToken: token }
          : { Filter: [{ Name: 'cidr-block-association.cidr-block', Value: [cidr] }] },
        signal,
      );
      vpcs.push(...doc.items('vpcSet').map(parseVpc));
      token = this.#config.ipamPoolId ? doc.textOf('nextToken') || undefined : undefined;
      if (token && seen.has(token)) break;
      if (token) seen.add(token);
    } while (token);
    const mine = vpcs
      .filter((vpc) => vpc.tags.get(networkTags.network) === name)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (mine) this.#created.set(name, { id: mine.id, at: this.host.context.clock.now() });
    return mine;
  }

  /** No VPC for the network: wait for it, or (`default`) say the account has none. */
  #missing(id: string, network: string): ProviderNetworkState {
    return network === defaultNetwork
      ? state(id, 'error', `This account has no default VPC in ${this.#config.region}`)
      : state(id, 'pending', `Waiting for network ${network}`);
  }

  /** Every VPC that carries the network's tag (duplicates included). */
  async #vpcsOf(name: string, signal: AbortSignal): Promise<Vpc[]> {
    if (name === defaultNetwork || !namePattern.test(name)) return [];
    const doc = await this.#call(
      'DescribeVpcs',
      { Filter: [{ Name: `tag:${networkTags.network}`, Value: [name] }] },
      signal,
    );
    return doc.items('vpcSet').map(parseVpc);
  }

  async ensureNetwork(
    spec: ProviderNetworkSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    if (
      vpcIdPattern.test(spec.name) ||
      spec.name === defaultNetwork ||
      !namePattern.test(spec.name)
    )
      throw invalidInput(
        `network ${JSON.stringify(spec.name.slice(0, 64))} is not a better-compute network name`,
        'network-name',
      );
    const cidr = spec.cidr ?? defaultNetworkCidr;
    vpcRange(cidr, 'network cidr');
    const vpc =
      (await this.#vpc(spec.name, signal)) ?? (await this.#byRange(spec.name, cidr, signal));
    if (!vpc) {
      const doc = await this.#call(
        'CreateVpc',
        {
          ...(this.#config.ipamPoolId
            ? {
                Ipv4IpamPoolId: this.#config.ipamPoolId,
                Ipv4NetmaskLength: Number(cidr.split('/')[1]),
              }
            : { CidrBlock: cidr }),
          TagSpecification: this.#ownTags('vpc', spec.name),
        },
        signal,
      );
      const id = doc.child('vpc')?.textOf('vpcId') ?? '';
      if (!id)
        throw new ComputeError('PROVIDER_ERROR', 'CreateVpc returned no VPC', undefined, {
          provider: 'aws',
        });
      this.#created.set(spec.name, { id, at: this.host.context.clock.now() });
      return state(id, 'pending');
    }
    if (vpc.state !== 'available') return state(vpc.id, 'pending');

    if (!this.#dns.has(vpc.id)) {
      // One attribute per call, as EC2 requires; hostnames need support first.
      await this.#call(
        'ModifyVpcAttribute',
        { VpcId: vpc.id, EnableDnsSupport: { Value: true } },
        signal,
      );
      await this.#call(
        'ModifyVpcAttribute',
        { VpcId: vpc.id, EnableDnsHostnames: { Value: true } },
        signal,
      );
      this.#dns.add(vpc.id);
    }

    const igw = await this.#ensureGateway(spec.name, vpc.id, signal);
    const table = await this.#ensureRouteTable(spec.name, vpc.id, signal);
    await this.#ensureDefaultRoute(table, igw, signal);
    await this.#ensureAcl(spec.name, vpc.id, signal);
    await this.#reconcileEfaRule(spec.name, vpc.id, signal);
    await this.#sweepTagGroups(vpc.id, signal);
    return state(vpc.id, 'ready');
  }

  /** The VPC's internet gateway: attached already, ours detached, or a new one. */
  async #ensureGateway(network: string, vpcId: string, signal: AbortSignal): Promise<string> {
    const attached = await this.#call(
      'DescribeInternetGateways',
      { Filter: [{ Name: 'attachment.vpc-id', Value: [vpcId] }] },
      signal,
    );
    const current = attached.items('internetGatewaySet')[0]?.textOf('internetGatewayId');
    if (current) return current;
    const own = await this.#call(
      'DescribeInternetGateways',
      { Filter: [{ Name: `tag:${networkTags.network}`, Value: [network] }] },
      signal,
    );
    let id = own
      .items('internetGatewaySet')
      .find((item) => item.items('attachmentSet').length === 0)
      ?.textOf('internetGatewayId');
    if (!id) {
      const doc = await this.#call(
        'CreateInternetGateway',
        { TagSpecification: this.#ownTags('internet-gateway', network) },
        signal,
      );
      id = doc.child('internetGateway')?.textOf('internetGatewayId') ?? '';
      if (!id)
        throw new ComputeError(
          'PROVIDER_ERROR',
          'CreateInternetGateway returned no gateway',
          undefined,
          { provider: 'aws' },
        );
    }
    const gateway = id;
    await this.#tolerate(['Resource.AlreadyAssociated'], () =>
      this.#call('AttachInternetGateway', { InternetGatewayId: gateway, VpcId: vpcId }, signal),
    );
    return gateway;
  }

  /** The route table better-compute made for `network` in a VPC (never the VPC's main table). */
  async #networkRouteTable(
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<XmlElement | undefined> {
    const doc = await this.#call(
      'DescribeRouteTables',
      { Filter: [{ Name: 'vpc-id', Value: [vpcId] }] },
      signal,
    );
    return doc
      .items('routeTableSet')
      .filter(
        (table) =>
          madeFor(table, network) &&
          !table.items('associationSet').some((a) => a.textOf('main') === 'true'),
      )
      .sort((a, b) =>
        (a.textOf('routeTableId') ?? '') < (b.textOf('routeTableId') ?? '') ? -1 : 1,
      )[0];
  }

  /**
   * The network's own route table, created tagged when missing. AWS's main table (untagged, made
   * by AWS) is never edited: the IAM policy lets routes change only on tables created with
   * `better-compute:managed`, which no statement may write on an existing table.
   */
  async #ensureRouteTable(
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<XmlElement> {
    const found = await this.#networkRouteTable(network, vpcId, signal);
    if (found) return found;
    // The token makes a retry (a lost answer, a read that does not show the table yet) return
    // the same table.
    const doc = await this.#call(
      'CreateRouteTable',
      {
        VpcId: vpcId,
        ClientToken: clientToken(`rtb:${vpcId}`),
        TagSpecification: this.#ownTags('route-table', network),
      },
      signal,
    );
    const table = doc.child('routeTable');
    if (!table?.textOf('routeTableId'))
      throw new ComputeError('PROVIDER_ERROR', 'CreateRouteTable returned no table', undefined, {
        provider: 'aws',
      });
    return table;
  }

  async #ensureDefaultRoute(table: XmlElement, igw: string, signal: AbortSignal): Promise<void> {
    const tableId = table.textOf('routeTableId')!;
    const route = table
      .items('routeSet')
      .find((item) => item.textOf('destinationCidrBlock') === '0.0.0.0/0');
    if (route?.textOf('gatewayId') === igw) return;
    const params = { RouteTableId: tableId, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw };
    if (route) await this.#call('ReplaceRoute', params, signal);
    else
      await this.#tolerate(['RouteAlreadyExists'], () => this.#call('CreateRoute', params, signal));
  }

  /** The network ACL better-compute made for `network` in a VPC (never the VPC's default ACL). */
  async #networkAcl(
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<XmlElement | undefined> {
    const doc = await this.#call(
      'DescribeNetworkAcls',
      {
        Filter: [
          { Name: 'vpc-id', Value: [vpcId] },
          { Name: 'default', Value: ['false'] },
        ],
      },
      signal,
    );
    return doc
      .items('networkAclSet')
      .filter((acl) => madeFor(acl, network))
      .sort((a, b) =>
        (a.textOf('networkAclId') ?? '') < (b.textOf('networkAclId') ?? '') ? -1 : 1,
      )[0];
  }

  /**
   * The network's own ACL, created tagged when missing, with allow-all entries at rule 32766 so a
   * deny entry (100 and up) is evaluated first. The VPC's default ACL is never edited.
   */
  async #ensureAcl(network: string, vpcId: string, signal: AbortSignal): Promise<XmlElement> {
    let acl = await this.#networkAcl(network, vpcId, signal);
    if (!acl) {
      const doc = await this.#call(
        'CreateNetworkAcl',
        {
          VpcId: vpcId,
          ClientToken: clientToken(`acl:${vpcId}`),
          TagSpecification: this.#ownTags('network-acl', network),
        },
        signal,
      );
      acl = doc.child('networkAcl');
      if (!acl?.textOf('networkAclId'))
        throw new ComputeError('PROVIDER_ERROR', 'CreateNetworkAcl returned no ACL', undefined, {
          provider: 'aws',
        });
    }
    const aclId = acl.textOf('networkAclId')!;
    const entries = parseAclEntries(acl);
    for (const egress of [false, true])
      if (!entries.some((entry) => entry.number === naclAllowAllRule && entry.egress === egress))
        await this.#tolerate(['NetworkAclEntryAlreadyExists'], () =>
          this.#call(
            'CreateNetworkAclEntry',
            {
              NetworkAclId: aclId,
              RuleNumber: naclAllowAllRule,
              Protocol: '-1',
              RuleAction: 'allow',
              Egress: egress,
              CidrBlock: '0.0.0.0/0',
            },
            signal,
          ),
        );
    return acl;
  }

  /**
   * Puts a subnet of a network better-compute made on the network's route table and ACL; the
   * state to answer while that cannot be done yet, or undefined once it is.
   */
  async #associate(
    network: string,
    vpcId: string,
    subnetId: string,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState | undefined> {
    const table = await this.#networkRouteTable(network, vpcId, signal);
    const acl = await this.#networkAcl(network, vpcId, signal);
    if (!table || !acl)
      return state(
        subnetId,
        'pending',
        `Waiting for the route table and network ACL of network ${network}`,
      );
    const tableId = table.textOf('routeTableId')!;
    if (!table.items('associationSet').some((a) => a.textOf('subnetId') === subnetId))
      try {
        await this.#call(
          'AssociateRouteTable',
          { RouteTableId: tableId, SubnetId: subnetId },
          signal,
        );
      } catch (error) {
        if (awsCode(error) !== 'Resource.AlreadyAssociated') throw error;
        const doc = await this.#call(
          'DescribeRouteTables',
          { Filter: [{ Name: 'association.subnet-id', Value: [subnetId] }] },
          signal,
        );
        const other = doc.items('routeTableSet')[0]?.textOf('routeTableId');
        if (other !== tableId)
          return state(
            subnetId,
            'error',
            `Subnet ${subnetId} uses route table ${other ?? 'unknown'}, not network ${network}'s ${tableId}`,
          );
      }
    const aclId = acl.textOf('networkAclId')!;
    if (!acl.items('associationSet').some((a) => a.textOf('subnetId') === subnetId)) {
      const doc = await this.#call(
        'DescribeNetworkAcls',
        { Filter: [{ Name: 'association.subnet-id', Value: [subnetId] }] },
        signal,
      );
      const association = doc
        .items('networkAclSet')
        .flatMap((item) => item.items('associationSet'))
        .find((a) => a.textOf('subnetId') === subnetId)
        ?.textOf('networkAclAssociationId');
      if (!association)
        return state(subnetId, 'pending', `Waiting for the network ACL association of ${subnetId}`);
      await this.#call(
        'ReplaceNetworkAclAssociation',
        { AssociationId: association, NetworkAclId: aclId },
        signal,
      );
    }
    return undefined;
  }

  async deleteNetwork(name: string, context: CallContext): Promise<ProviderNetworkState> {
    const { signal } = context;
    // Only VPCs better-compute made are deleted: an adopted VPC id never is.
    const vpcs = await this.#vpcsOf(name, signal);
    // A VPC this client just created may not show in tag reads yet: never take that for "gone".
    const created = this.#created.get(name);
    if (
      created &&
      !vpcs.some((vpc) => vpc.id === created.id) &&
      this.host.context.clock.now() - created.at < this.host.consistencyWindowMs()
    ) {
      const fresh = await this.#vpc(created.id, signal);
      // Not even a read by id shows it yet: wait, rather than leave a VPC nobody deletes.
      if (!fresh) return state(created.id, 'pending', `Waiting for VPC ${created.id} to show`);
      vpcs.push(fresh);
    }
    if (vpcs.length === 0) {
      this.#created.delete(name);
      return state(name, 'deleted');
    }
    const waiting: string[] = [];
    for (const vpc of vpcs) {
      const blocked = await this.#deleteVpc(name, vpc.id, signal);
      if (blocked) waiting.push(blocked);
    }
    if (waiting.length) return state(vpcs[0]!.id, 'pending', waiting.join('; ').slice(0, 500));
    this.#created.delete(name);
    return state(vpcs[0]!.id, 'deleted');
  }

  /** Deletes one VPC and what better-compute made in it; the reason it must wait, or undefined. */
  async #deleteVpc(
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const inUse = (error: unknown) => isComputeError(error, 'INVALID_STATE');
    const reasons: string[] = [];
    const attempt = async (what: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND')) return;
        if (inUse(error)) {
          reasons.push(`${what} is in use (DependencyViolation)`);
          return;
        }
        throw error;
      }
    };
    const byVpc = { Filter: [{ Name: 'vpc-id', Value: [vpcId] }] };

    const endpoints = await this.#call('DescribeVpcEndpoints', byVpc, signal);
    const endpointIds = endpoints
      .items('vpcEndpointSet')
      .filter((item) => tagMap(item).get(networkTags.network) === network)
      .map((item) => item.textOf('vpcEndpointId') ?? '')
      .filter(Boolean);
    if (endpointIds.length)
      await attempt('a gateway endpoint', async () => {
        // A 200 answer lists the endpoints it could not delete.
        const doc = await this.#call('DeleteVpcEndpoints', { VpcEndpointId: endpointIds }, signal);
        for (const item of doc.items('unsuccessful')) {
          const code = item.child('error')?.textOf('code') ?? 'unknown';
          if (code.endsWith('.NotFound')) continue;
          reasons.push(
            `gateway endpoint ${item.textOf('resourceId') ?? ''} was not deleted (${code})`,
          );
        }
      });

    const subnets = await this.#call('DescribeSubnets', byVpc, signal);
    for (const subnet of subnets.items('subnetSet').map(parseSubnet))
      if (subnet.tags.get(networkTags.network) === network)
        await attempt(`subnet ${subnet.id}`, () =>
          this.#call('DeleteSubnet', { SubnetId: subnet.id }, signal),
        );
    // A subnet still in use has machines on it: they keep their groups, gateway and route until
    // they are gone, so the delete goes no further than the subnets.
    if (reasons.length) return `VPC ${vpcId}: ${reasons.join(', ')}`;

    const groups = await this.#call('DescribeSecurityGroups', byVpc, signal);
    for (const item of groups.items('securityGroupInfo')) {
      const id = item.textOf('groupId') ?? '';
      if (
        item.textOf('groupName') === 'default' ||
        tagMap(item).get(networkTags.network) !== network
      )
        continue;
      await attempt(`security group ${id}`, () =>
        this.#call('DeleteSecurityGroup', { GroupId: id }, signal),
      );
    }

    const gateways = await this.#call(
      'DescribeInternetGateways',
      { Filter: [{ Name: 'attachment.vpc-id', Value: [vpcId] }] },
      signal,
    );
    for (const item of gateways.items('internetGatewaySet')) {
      const id = item.textOf('internetGatewayId') ?? '';
      await attempt(`internet gateway ${id}`, async () => {
        await this.#tolerate(['Gateway.NotAttached'], () =>
          this.#call('DetachInternetGateway', { InternetGatewayId: id, VpcId: vpcId }, signal),
        );
        if (tagMap(item).get(networkTags.network) === network)
          await this.#call('DeleteInternetGateway', { InternetGatewayId: id }, signal);
      });
    }
    // Our gateways a crash left detached.
    const detached = await this.#call(
      'DescribeInternetGateways',
      { Filter: [{ Name: `tag:${networkTags.network}`, Value: [network] }] },
      signal,
    );
    for (const item of detached.items('internetGatewaySet'))
      if (item.items('attachmentSet').length === 0) {
        const id = item.textOf('internetGatewayId') ?? '';
        await attempt(`internet gateway ${id}`, () =>
          this.#call('DeleteInternetGateway', { InternetGatewayId: id }, signal),
        );
      }

    // The network's own route table and ACL (its subnets, and so their associations, are gone).
    const tables = await this.#call('DescribeRouteTables', byVpc, signal);
    for (const item of tables.items('routeTableSet'))
      if (
        madeFor(item, network) &&
        !item.items('associationSet').some((a) => a.textOf('main') === 'true')
      ) {
        const id = item.textOf('routeTableId') ?? '';
        await attempt(`route table ${id}`, () =>
          this.#call('DeleteRouteTable', { RouteTableId: id }, signal),
        );
      }
    const acls = await this.#call('DescribeNetworkAcls', byVpc, signal);
    for (const item of acls.items('networkAclSet'))
      if (madeFor(item, network) && item.textOf('default') !== 'true') {
        const id = item.textOf('networkAclId') ?? '';
        await attempt(`network ACL ${id}`, () =>
          this.#call('DeleteNetworkAcl', { NetworkAclId: id }, signal),
        );
      }

    if (reasons.length) return `VPC ${vpcId}: ${reasons.join(', ')}`;
    let blocked: string | undefined;
    await attempt(`VPC ${vpcId}`, () => this.#call('DeleteVpc', { VpcId: vpcId }, signal));
    if (reasons.length) blocked = `VPC ${vpcId}: ${reasons.join(', ')}`;
    if (!blocked) this.#dns.delete(vpcId);
    return blocked;
  }

  // --- Subnets -------------------------------------------------------------------------------------

  async #subnetsBy(
    filters: { Name: string; Value: string[] }[],
    signal: AbortSignal,
  ): Promise<Subnet[]> {
    const doc = await this.#call('DescribeSubnets', { Filter: filters }, signal);
    return doc.items('subnetSet').map(parseSubnet);
  }

  async ensureSubnet(
    spec: ProviderSubnetSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    const id = `${spec.region}/${spec.name}`;
    if (spec.region !== this.#config.region)
      throw invalidInput(
        `region ${spec.region} is not this account's region ${this.#config.region}`,
        'region',
      );
    if (!namePattern.test(spec.name))
      throw invalidInput(
        `subnet ${JSON.stringify(spec.name.slice(0, 64))} is not a better-compute subnet name`,
        'subnet-name',
      );
    if (spec.zone === undefined)
      throw invalidInput(
        'an AWS subnet lives in one Availability Zone: the subnet needs a zone',
        'zone-required',
      );
    if (!this.#config.zones.includes(spec.zone))
      throw invalidInput(`zone ${spec.zone} is not one of this account's zones`, 'zone');
    const range = vpcRange(spec.cidr, 'subnet cidr');

    const vpc = await this.#vpc(spec.network, signal);
    if (!vpc) return this.#missing(id, spec.network);
    if (vpc.state !== 'available') return state(id, 'pending', `Waiting for VPC ${vpc.id}`);
    // An adopted VPC stays as it is: gateway endpoints would reroute S3 and DynamoDB for every
    // subnet of it (they go on a route table every subnet shares), so they need a network
    // better-compute made.
    if (!vpc.ours && spec.privateGoogleAccess === true)
      return state(
        id,
        'error',
        `private service access needs a network better-compute made; ${vpc.id} is adopted`,
      );

    const [existing] = await this.#subnetsBy(
      [
        { Name: 'vpc-id', Value: [vpc.id] },
        { Name: `tag:${networkTags.subnet}`, Value: [spec.name] },
      ],
      signal,
    );
    if (existing) {
      if (existing.cidr !== spec.cidr || existing.zone !== spec.zone)
        return state(
          existing.id,
          'error',
          `Subnet ${spec.name} exists as ${existing.cidr} in ${existing.zone}, not ${spec.cidr} in ${spec.zone}`,
        );
      return this.#finishSubnet(spec, vpc, existing, signal);
    }

    // Subnets of a VPC never overlap, so the range finds a subnet whose tag a read does not show yet.
    const [sameRange] = await this.#subnetsBy(
      [
        { Name: 'vpc-id', Value: [vpc.id] },
        { Name: 'cidr-block', Value: [spec.cidr] },
      ],
      signal,
    );
    if (sameRange)
      return sameRange.tags.get(networkTags.subnet) === undefined
        ? state(
            sameRange.id,
            'error',
            `Range ${spec.cidr} is taken by subnet ${sameRange.id}, which better-compute did not make`,
          )
        : state(
            sameRange.id,
            'pending',
            `Range ${spec.cidr} belongs to subnet ${sameRange.tags.get(networkTags.subnet)}`,
          );

    const blocks = vpc.blocks.map((block) => ({ ...block, range: parseCidr(block.cidr) }));
    const covering = blocks.find((block) => block.range && within(block.range, range));
    if (!covering) {
      if (blocks.some((block) => block.range && overlap(block.range, range)))
        return state(id, 'error', `Range ${spec.cidr} straddles a range of VPC ${vpc.id}`);
      // Only a network better-compute made gets a new range: an adopted VPC is never changed.
      if (!vpc.ours)
        return state(
          id,
          'error',
          `Range ${spec.cidr} is outside the ranges of adopted VPC ${vpc.id} (${vpc.blocks.map((block) => block.cidr).join(', ')}), which better-compute does not change`,
        );
      return this.#associateBlock(id, vpc, range, signal);
    }
    if (covering.state !== 'associated')
      return state(id, 'pending', `Waiting for range ${covering.cidr} of VPC ${vpc.id}`);

    let created: Subnet | undefined;
    try {
      const doc = await this.#call(
        'CreateSubnet',
        {
          VpcId: vpc.id,
          CidrBlock: spec.cidr,
          AvailabilityZone: spec.zone,
          TagSpecification: this.#ownTags('subnet', spec.network, {
            [networkTags.subnet]: spec.name,
            [tags.name]: spec.name,
            // What keeps the gateway endpoints: the last such subnet's delete removes them.
            ...(spec.privateGoogleAccess === true ? { [networkTags.privateAccess]: 'true' } : {}),
          }),
        },
        signal,
      );
      const item = doc.child('subnet');
      created = item ? parseSubnet(item) : undefined;
    } catch (error) {
      const code = awsCode(error);
      if (code === 'InvalidSubnet.Conflict' || code === 'InvalidSubnet.Range')
        return state(id, 'error', `AWS refused subnet ${spec.cidr} in VPC ${vpc.id} (${code})`);
      throw error;
    }
    if (!created?.id)
      throw new ComputeError('PROVIDER_ERROR', 'CreateSubnet returned no subnet', undefined, {
        provider: 'aws',
      });
    return this.#finishSubnet(spec, vpc, created, signal);
  }

  /**
   * A secondary VPC range for a subnet outside the VPC's ranges: the subnet's /16 when that
   * overlaps nothing, else the subnet's own range.
   */
  async #associateBlock(
    id: string,
    vpc: Vpc,
    range: Range,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    const wide = { start: range.start - (range.start % 2 ** 16), end: 0, prefix: 16 };
    wide.end = wide.start + 2 ** 16 - 1;
    const taken = vpc.blocks
      .map((block) => parseCidr(block.cidr))
      .filter((r): r is Range => r !== undefined);
    const block =
      range.prefix > 16 &&
      !taken.some((other) => overlap(other, wide)) &&
      privateRanges.some((p) => within(p, wide))
        ? formatCidr(wide.start, 16)
        : formatCidr(range.start, range.prefix);
    try {
      const doc = await this.#call(
        'AssociateVpcCidrBlock',
        { VpcId: vpc.id, CidrBlock: block },
        signal,
      );
      const associated = doc
        .child('cidrBlockAssociation')
        ?.child('cidrBlockState')
        ?.textOf('state');
      return state(
        id,
        'pending',
        associated === 'associated' ? undefined : `Adding range ${block} to VPC ${vpc.id}`,
      );
    } catch (error) {
      const code = awsCode(error);
      if (
        code === 'CidrLimitExceeded' ||
        code === 'InvalidVpc.Range' ||
        isComputeError(error, 'INVALID_INPUT')
      )
        return state(
          id,
          'error',
          `AWS refused range ${block} for VPC ${vpc.id} (${code ?? error})`,
        );
      throw error;
    }
  }

  /**
   * Public IPs on launch from config, the network's route table and ACL (a network better-compute
   * made), and private service access (gateway endpoints).
   */
  async #finishSubnet(
    spec: ProviderSubnetSpec,
    vpc: Vpc,
    subnet: Subnet,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    if (subnet.state !== '' && subnet.state !== 'available') return state(subnet.id, 'pending');
    if (vpc.ours) {
      const waiting = await this.#associate(
        vpc.tags.get(networkTags.network) ?? spec.network,
        vpc.id,
        subnet.id,
        signal,
      );
      if (waiting) return waiting;
    }
    if (subnet.mapPublicIp !== this.#config.associatePublicIp)
      await this.#call(
        'ModifySubnetAttribute',
        { SubnetId: subnet.id, MapPublicIpOnLaunch: { Value: this.#config.associatePublicIp } },
        signal,
      );
    if (spec.privateGoogleAccess === true && vpc.ours) {
      const network = vpc.tags.get(networkTags.network) ?? spec.network;
      const table = await this.#networkRouteTable(network, vpc.id, signal);
      if (!table)
        return state(subnet.id, 'pending', `Waiting for the route table of network ${network}`);
      await this.#ensureServiceAccess(network, vpc.id, table.textOf('routeTableId')!, signal);
    }
    return state(subnet.id, 'ready');
  }

  /**
   * "Private service access": S3 and DynamoDB gateway endpoints on the network's route table. No
   * ClientToken: a token would hand back an endpoint deleted by hand instead of a new one; a
   * second endpoint for a service on the same table is refused by AWS (RouteAlreadyExists).
   */
  async #ensureServiceAccess(
    network: string,
    vpcId: string,
    tableId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const doc = await this.#call(
      'DescribeVpcEndpoints',
      { Filter: [{ Name: 'vpc-id', Value: [vpcId] }] },
      signal,
    );
    const have = new Set(
      doc
        .items('vpcEndpointSet')
        .filter((item) => item.items('routeTableIdSet').some((id) => id.text === tableId))
        .map((item) => item.textOf('serviceName')),
    );
    for (const name of this.#endpointServices()) {
      if (have.has(name)) continue;
      await this.#tolerate(['RouteAlreadyExists'], () =>
        this.#call(
          'CreateVpcEndpoint',
          {
            VpcId: vpcId,
            ServiceName: name,
            VpcEndpointType: 'Gateway',
            RouteTableId: [tableId],
            TagSpecification: this.#ownTags('vpc-endpoint', network),
          },
          signal,
        ),
      );
    }
  }

  /** The gateway endpoint services of private service access in this region. */
  #endpointServices(): string[] {
    const prefix =
      partitionOf(this.#config.region).partition === 'aws-cn'
        ? 'cn.com.amazonaws'
        : 'com.amazonaws';
    return ['s3', 'dynamodb'].map((service) => `${prefix}.${this.#config.region}.${service}`);
  }

  async deleteSubnet(
    region: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const id = `${region}/${name}`;
    if (region !== this.#config.region || !namePattern.test(name)) return state(id, 'deleted');
    // Only subnets better-compute made: managed, of one of its networks.
    const found = (
      await this.#subnetsBy(
        [
          { Name: `tag:${networkTags.subnet}`, Value: [name] },
          { Name: `tag:${tags.managed}`, Value: ['true'] },
        ],
        context.signal,
      )
    ).filter((subnet) => subnet.tags.has(networkTags.network));
    for (const subnet of found) {
      try {
        await this.#call('DeleteSubnet', { SubnetId: subnet.id }, context.signal);
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND')) continue;
        if (isComputeError(error, 'INVALID_STATE'))
          return state(subnet.id, 'pending', `Subnet ${subnet.id} is in use (DependencyViolation)`);
        throw error;
      }
    }
    const deleted = new Set(found.map((subnet) => subnet.id));
    for (const subnet of found)
      if (subnet.tags.get(networkTags.privateAccess) === 'true') {
        const waiting = await this.#pruneServiceAccess(
          subnet.tags.get(networkTags.network)!,
          subnet.vpcId,
          deleted,
          context.signal,
        );
        if (waiting) return state(subnet.id, 'pending', waiting);
      }
    return state(found[0]?.id ?? id, 'deleted');
  }

  /**
   * Removes the network's gateway endpoints once no subnet of the VPC asks for private service
   * access any more (`deleted` are gone already); the reason to wait, or undefined.
   */
  async #pruneServiceAccess(
    network: string,
    vpcId: string,
    deleted: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const subnets = await this.#subnetsBy([{ Name: 'vpc-id', Value: [vpcId] }], signal);
    if (
      subnets.some(
        (subnet) =>
          !deleted.has(subnet.id) && subnet.tags.get(networkTags.privateAccess) === 'true',
      )
    )
      return undefined;
    const services = new Set(this.#endpointServices());
    const doc = await this.#call(
      'DescribeVpcEndpoints',
      { Filter: [{ Name: 'vpc-id', Value: [vpcId] }] },
      signal,
    );
    const ids = doc
      .items('vpcEndpointSet')
      .filter((item) => madeFor(item, network) && services.has(item.textOf('serviceName') ?? ''))
      .map((item) => item.textOf('vpcEndpointId') ?? '')
      .filter(Boolean);
    if (ids.length === 0) return undefined;
    const result = await this.#call('DeleteVpcEndpoints', { VpcEndpointId: ids }, signal);
    const failed = result
      .items('unsuccessful')
      .filter((item) => !(item.child('error')?.textOf('code') ?? '').endsWith('.NotFound'))
      .map((item) => item.textOf('resourceId') ?? '');
    return failed.length
      ? `Gateway endpoints ${failed.join(', ')} were not deleted`.slice(0, 500)
      : undefined;
  }

  // --- Security groups ---------------------------------------------------------------------------------

  async #groupsByName(
    vpcId: string,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<Group[]> {
    if (names.length === 0) return [];
    const doc = await this.#call(
      'DescribeSecurityGroups',
      {
        Filter: [
          { Name: 'vpc-id', Value: [vpcId] },
          { Name: 'group-name', Value: [...names] },
        ],
      },
      signal,
    );
    return doc.items('securityGroupInfo').map((item) => ({
      id: item.textOf('groupId') ?? '',
      name: item.textOf('groupName') ?? '',
      vpcId: item.textOf('vpcId') ?? '',
      tags: tagMap(item),
    }));
  }

  /** The security group of a network (`bc-net-<name>`, untargeted rules) or of one network tag. */
  static groupName(kind: 'network' | 'tag', name: string): string {
    return kind === 'network' ? `bc-net-${name}` : name;
  }

  /**
   * The security groups named, created when missing (a lost race finds the winner's). `network`
   * is the better-compute network the VPC belongs to, when it is one of ours.
   */
  async #ensureGroups(
    vpcId: string,
    wanted: readonly {
      name: string;
      tag?: string;
      /** Extra tags and the description of a group that is no tag group (a filesystem's). */
      extra?: Readonly<Record<string, string>>;
      description?: string;
    }[],
    network: string | undefined,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const group of await this.#groupsByName(
      vpcId,
      wanted.map((w) => w.name),
      signal,
    ))
      ids.set(group.name, group.id);
    for (const want of wanted) {
      if (ids.has(want.name)) continue;
      const extra: Record<string, string> = want.tag
        ? { [networkTags.tag]: want.tag }
        : { ...want.extra };
      try {
        const doc = await this.#call(
          'CreateSecurityGroup',
          {
            GroupName: want.name,
            GroupDescription:
              want.description ??
              (want.tag
                ? `better-compute network tag ${want.tag}`
                : `better-compute network ${network ?? vpcId}`),
            VpcId: vpcId,
            TagSpecification: [
              {
                ResourceType: 'security-group',
                Tag: [
                  ...(network ? [{ Key: networkTags.network, Value: network }] : []),
                  { Key: tags.managed, Value: 'true' },
                  { Key: tags.name, Value: want.name },
                  ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value })),
                ],
              },
            ],
          },
          signal,
        );
        const id = doc.textOf('groupId');
        if (!id)
          throw new ComputeError(
            'PROVIDER_ERROR',
            'CreateSecurityGroup returned no group',
            undefined,
            { provider: 'aws' },
          );
        ids.set(want.name, id);
      } catch (error) {
        if (!isComputeError(error, 'CONFLICT')) throw error;
        const [winner] = await this.#groupsByName(vpcId, [want.name], signal);
        if (!winner) throw error;
        ids.set(want.name, winner.id);
      }
    }
    return ids;
  }

  // --- Filesystems (A10) ----------------------------------------------------------------------------

  /** A filesystem's group: a colon never appears in a network or tag name, so it collides with neither. */
  static filesystemGroupName(name: string): string {
    return `bc-fs:${name}`;
  }

  /**
   * The way a filesystem reaches its network (AWS A10): the network's VPC (one better-compute
   * made; an adopted VPC is `error`), the filesystem's own group `bc-fs:<name>` that allows the
   * filesystem's ports from the network's group only (Lustre also from itself), and the network's
   * subnets, one per zone of the account (the first by subnet name). The group's rules carry
   * `better-compute:filesystem` and no firewall key, so firewall diffing never touches them.
   */
  async filesystemAccess(
    network: string,
    name: string,
    kind: 'nfs' | 'lustre',
    signal: AbortSignal,
  ): Promise<FilesystemAccess | ProviderNetworkState> {
    const vpc = await this.#vpc(network, signal);
    if (!vpc || vpc.state !== 'available')
      return state(name, 'pending', `Waiting for network ${network}`);
    const own = vpc.ours ? vpc.tags.get(networkTags.network) : undefined;
    if (!own)
      return state(
        name,
        'error',
        `A filesystem needs a network better-compute made; ${vpc.id} is adopted`,
      );
    const netName = AwsNetworks.groupName('network', own);
    const fsName = AwsNetworks.filesystemGroupName(name);
    const ids = await this.#ensureGroups(
      vpc.id,
      [
        { name: netName },
        {
          name: fsName,
          extra: { [networkTags.filesystem]: name },
          description: `better-compute filesystem ${name}`,
        },
      ],
      own,
      signal,
    );
    const netGroup = ids.get(netName)!;
    const fsGroup = ids.get(fsName)!;
    const peers = kind === 'lustre' ? [netGroup, fsGroup] : [netGroup];
    const desired: Permission[] = filesystemPorts[kind].flatMap(([from, to]) =>
      peers.map((peer) => ({
        groupId: fsGroup,
        egress: false,
        protocol: 'tcp',
        from,
        to,
        cidr: `sg:${peer}`,
      })),
    );
    const wanted = new Set(desired.map(permissionKey));
    const have = await this.#rules(
      [{ Name: `tag:${networkTags.filesystem}`, Value: [name] }],
      signal,
    );
    const present = new Set<string>();
    for (const rule of have) {
      const key = permissionKey(rule);
      if (wanted.has(key) && !present.has(key)) present.add(key);
      else
        await this.#tolerate(['*NotFound'], () =>
          this.#call(
            rule.egress ? 'RevokeSecurityGroupEgress' : 'RevokeSecurityGroupIngress',
            { GroupId: rule.groupId, SecurityGroupRuleId: [rule.id] },
            signal,
          ),
        );
    }
    for (const p of desired) {
      if (present.has(permissionKey(p))) continue;
      await this.#tolerate(['InvalidPermission.Duplicate'], () =>
        this.#call(
          'AuthorizeSecurityGroupIngress',
          {
            GroupId: fsGroup,
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: p.from,
                ToPort: p.to,
                Groups: [{ GroupId: p.cidr.slice('sg:'.length) }],
              },
            ],
            TagSpecification: [
              {
                ResourceType: 'security-group-rule',
                Tag: [
                  { Key: networkTags.filesystem, Value: name },
                  { Key: networkTags.network, Value: own },
                ],
              },
            ],
          },
          signal,
        ),
      );
    }
    const byZone = new Map<string, Subnet>();
    const subnets = (await this.#subnetsBy([{ Name: 'vpc-id', Value: [vpc.id] }], signal))
      .filter(
        (s) =>
          s.tags.get(networkTags.network) === own &&
          s.tags.has(networkTags.subnet) &&
          this.#config.zones.includes(s.zone),
      )
      .sort((a, b) => (a.tags.get(networkTags.subnet)! < b.tags.get(networkTags.subnet)! ? -1 : 1));
    for (const subnet of subnets) if (!byZone.has(subnet.zone)) byZone.set(subnet.zone, subnet);
    return {
      state: 'ready',
      vpcId: vpc.id,
      groupId: fsGroup,
      subnets: [...byZone.values()].map((s) => ({ id: s.id, zone: s.zone })),
    };
  }

  /**
   * Deletes a filesystem's group once nothing uses it: `deleted`, or `deleting` while the
   * filesystem's interfaces still hold it. A group better-compute did not make is never touched.
   */
  async releaseFilesystemAccess(name: string, signal: AbortSignal): Promise<ProviderNetworkState> {
    const doc = await this.#call(
      'DescribeSecurityGroups',
      {
        Filter: [
          { Name: 'group-name', Value: [AwsNetworks.filesystemGroupName(name)] },
          { Name: `tag:${networkTags.filesystem}`, Value: [name] },
          { Name: `tag:${tags.managed}`, Value: ['true'] },
        ],
      },
      signal,
    );
    for (const item of doc.items('securityGroupInfo')) {
      const id = item.textOf('groupId') ?? '';
      try {
        await this.#tolerate(['*NotFound'], () =>
          this.#call('DeleteSecurityGroup', { GroupId: id }, signal),
        );
      } catch (error) {
        if (awsCode(error) === 'DependencyViolation' || isComputeError(error, 'INVALID_STATE'))
          return state(name, 'deleting', `security group ${id} is still in use`);
        throw error;
      }
    }
    return state(name, 'deleted');
  }

  // --- Firewalls -------------------------------------------------------------------------------------

  async #rulesOf(firewall: string, signal: AbortSignal): Promise<Rule[]> {
    return this.#rules(
      [{ Name: `tag:${networkTags.firewallPrefix}${firewall}`, Value: ['true'] }],
      signal,
    );
  }

  /** Every security group rule matching `filters`, a page at a time. */
  async #rules(filters: { Name: string; Value: string[] }[], signal: AbortSignal): Promise<Rule[]> {
    const out: Rule[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.#call(
        'DescribeSecurityGroupRules',
        { Filter: filters, MaxResults: 1000, NextToken: token },
        signal,
      );
      out.push(...doc.items('securityGroupRuleSet').map(parseRule));
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS returned a pagination token twice',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      if (token) seen.add(token);
    } while (token);
    return out;
  }

  /**
   * EFA's self-referencing rule (AWS A10): with config `efa: 'auto'`, the network's group
   * (`bc-net-<network>`, on every machine of the network and on each of its EFA interfaces) allows
   * all traffic from and to itself, as EFA's OS-bypass traffic needs. The two rules carry
   * `better-compute:efa` and no firewall key, so firewall diffing never revokes them; with `efa: 'off'`
   * the rules better-compute made are revoked again, and a rule of the same content that someone
   * else made is left alone.
   */
  async #reconcileEfaRule(network: string, vpcId: string, signal: AbortSignal): Promise<void> {
    const have = await this.#rules(
      [
        { Name: `tag:${networkTags.efa}`, Value: ['true'] },
        { Name: `tag:${networkTags.network}`, Value: [network] },
      ],
      signal,
    );
    const keep = new Set<string>();
    if (this.#config.efa === 'auto') {
      const name = AwsNetworks.groupName('network', network);
      const groupId = (await this.#ensureGroups(vpcId, [{ name }], network, signal)).get(name)!;
      const self = `sg:${groupId}`;
      for (const egress of [false, true]) {
        const found = have.find(
          (rule) =>
            rule.groupId === groupId &&
            rule.egress === egress &&
            rule.protocol === '-1' &&
            rule.cidr === self,
        );
        if (found) {
          keep.add(found.id);
          continue;
        }
        // A rule of the same content (someone else's) already allows it: Duplicate, and nothing to do.
        await this.#tolerate(['InvalidPermission.Duplicate'], () =>
          this.#call(
            egress ? 'AuthorizeSecurityGroupEgress' : 'AuthorizeSecurityGroupIngress',
            {
              GroupId: groupId,
              IpPermissions: [{ IpProtocol: '-1', Groups: [{ GroupId: groupId }] }],
              TagSpecification: [
                {
                  ResourceType: 'security-group-rule',
                  Tag: [
                    { Key: networkTags.efa, Value: 'true' },
                    { Key: networkTags.network, Value: network },
                  ],
                },
              ],
            },
            signal,
          ),
        );
      }
    }
    for (const rule of have)
      if (!keep.has(rule.id))
        await this.#tolerate(['*NotFound'], () =>
          this.#call(
            rule.egress ? 'RevokeSecurityGroupEgress' : 'RevokeSecurityGroupIngress',
            { GroupId: rule.groupId, SecurityGroupRuleId: [rule.id] },
            signal,
          ),
        );
  }

  async ensureFirewall(
    spec: ProviderFirewallSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    if (!namePattern.test(spec.name))
      throw invalidInput(
        `firewall ${JSON.stringify(spec.name.slice(0, 64))} is not a better-compute name`,
        'firewall-name',
      );
    const targeted = (spec.targetTags?.length ?? 0) > 0;
    for (const tag of spec.targetTags ?? [])
      if (!tagPattern.test(tag))
        throw invalidInput(
          `${JSON.stringify(tag.slice(0, 64))} is not a managed network tag`,
          'tag',
        );
    if (spec.action === 'deny' && targeted)
      return state(
        spec.name,
        'error',
        'AWS security groups only allow: a deny rule applies network-wide (network ACL) and cannot target instances',
      );
    const other = spec.direction === 'ingress' ? spec.destinations : spec.sources;
    if (other?.length)
      return state(
        spec.name,
        'error',
        `AWS rules match only the ${spec.direction === 'ingress' ? 'source' : 'destination'} range; ${spec.direction} ${spec.direction === 'ingress' ? 'destinations' : 'sources'} are not supported`,
      );
    const vpc = await this.#vpc(spec.network, signal);
    if (!vpc) return this.#missing(spec.name, spec.network);
    // A VPC this client just made that tag reads do not show yet: neither ready nor adopted.
    if (vpc.state !== 'available') return state(spec.name, 'pending', `Waiting for VPC ${vpc.id}`);
    const network = vpc.ours ? vpc.tags.get(networkTags.network) : undefined;
    if (spec.action === 'deny') {
      if (!network)
        return state(
          spec.name,
          'error',
          `A deny rule needs a network better-compute made; ${vpc.id} is adopted`,
        );
      // A rule that was an allow before keeps no security group rules.
      await this.#applyRules(spec.name, network, [], signal);
      return this.#ensureDeny(spec, network, vpc.id, signal);
    }
    // A rule that was a deny before keeps no ACL entries.
    if (network) await this.#releaseDenyEntries(spec.name, network, vpc.id, signal);
    if (!targeted && !network)
      return state(
        spec.name,
        'error',
        `Rule ${spec.name} names no instances and ${vpc.id} is adopted`,
      );

    const groups = await this.#ensureGroups(
      vpc.id,
      targeted
        ? spec.targetTags!.map((tag) => ({ name: AwsNetworks.groupName('tag', tag), tag }))
        : [{ name: AwsNetworks.groupName('network', network!) }],
      network,
      signal,
    );
    const desired: Permission[] = [];
    if (spec.disabled !== true)
      for (const groupId of groups.values())
        for (const tuple of tuples(spec))
          for (const cidr of peers(spec))
            desired.push({ groupId, egress: spec.direction === 'egress', ...tuple, cidr });
    await this.#applyRules(spec.name, network ?? vpc.id, desired, signal);
    await this.#sweepTagGroups(vpc.id, signal);
    return state(spec.name, 'ready');
  }

  /** Makes the rules tagged for `firewall` exactly `desired`: revokes or untags the rest, authorizes or tags what is missing. */
  async #applyRules(
    firewall: string,
    network: string,
    desired: Permission[],
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${networkTags.firewallPrefix}${firewall}`;
    const wanted = new Map(desired.map((p) => [permissionKey(p), p]));
    const current = await this.#rulesOf(firewall, signal);
    const have = new Set<string>();
    for (const rule of current) {
      const k = permissionKey(rule);
      if (wanted.has(k) && !have.has(k)) {
        have.add(k);
        continue;
      }
      await this.#releaseRule(rule, key, signal);
    }
    const missing = [...wanted].filter(([k]) => !have.has(k)).map(([, p]) => p);
    const byGroup = new Map<string, Permission[]>();
    for (const p of missing) {
      const group = `${p.groupId}|${p.egress}`;
      byGroup.set(group, [...(byGroup.get(group) ?? []), p]);
    }
    for (const list of byGroup.values()) {
      const { groupId, egress } = list[0]!;
      try {
        await this.#authorize(groupId, egress, list, firewall, network, signal);
      } catch (error) {
        if (!isComputeError(error, 'CONFLICT')) throw error;
        // A rule of the same content exists (another firewall's, or not better-compute's): one at a
        // time, and an existing equal rule gets this firewall's key instead.
        for (const p of list) {
          try {
            await this.#authorize(groupId, egress, [p], firewall, network, signal);
          } catch (inner) {
            if (!isComputeError(inner, 'CONFLICT')) throw inner;
            // Every page: a busy group has more rules than one answer holds.
            const same = (await this.#rules([{ Name: 'group-id', Value: [groupId] }], signal)).find(
              (rule) => permissionKey(rule) === permissionKey(p),
            );
            if (!same) throw inner;
            await this.#call(
              'CreateTags',
              { ResourceId: [same.id], Tag: [{ Key: key, Value: 'true' }] },
              signal,
            );
          }
        }
      }
    }
  }

  async #authorize(
    groupId: string,
    egress: boolean,
    list: Permission[],
    firewall: string,
    network: string,
    signal: AbortSignal,
  ): Promise<void> {
    const v6 = (cidr: string) => cidr.includes(':');
    await this.#call(
      egress ? 'AuthorizeSecurityGroupEgress' : 'AuthorizeSecurityGroupIngress',
      {
        GroupId: groupId,
        IpPermissions: list.map((p) => ({
          IpProtocol: p.protocol,
          FromPort: p.protocol === '-1' ? undefined : p.from,
          ToPort: p.protocol === '-1' ? undefined : p.to,
          IpRanges: v6(p.cidr) ? undefined : [{ CidrIp: p.cidr }],
          Ipv6Ranges: v6(p.cidr) ? [{ CidrIpv6: p.cidr }] : undefined,
        })),
        TagSpecification: [
          {
            ResourceType: 'security-group-rule',
            Tag: [
              { Key: `${networkTags.firewallPrefix}${firewall}`, Value: 'true' },
              { Key: networkTags.network, Value: network },
            ],
          },
        ],
      },
      signal,
    );
  }

  /**
   * Drops a firewall's claim on a rule: revoked when no other firewall wants it and better-compute
   * made it (it carries the network tag), else only the firewall's key is removed.
   */
  async #releaseRule(rule: Rule, key: string, signal: AbortSignal): Promise<void> {
    const others = [...rule.tags.keys()].some(
      (k) => k !== key && k.startsWith(networkTags.firewallPrefix),
    );
    if (others || !rule.tags.has(networkTags.network)) {
      await this.#tolerate(['*NotFound'], () =>
        this.#call('DeleteTags', { ResourceId: [rule.id], Tag: [{ Key: key }] }, signal),
      );
      return;
    }
    await this.#tolerate(['*NotFound'], () =>
      this.#call(
        rule.egress ? 'RevokeSecurityGroupEgress' : 'RevokeSecurityGroupIngress',
        { GroupId: rule.groupId, SecurityGroupRuleId: [rule.id] },
        signal,
      ),
    );
  }

  async deleteFirewall(name: string, context: CallContext): Promise<ProviderNetworkState> {
    const { signal } = context;
    if (!namePattern.test(name)) return state(name, 'deleted');
    const key = `${networkTags.firewallPrefix}${name}`;
    for (const rule of await this.#rulesOf(name, signal))
      await this.#releaseRule(rule, key, signal);
    const acls = await this.#call(
      'DescribeNetworkAcls',
      {
        Filter: [
          { Name: 'tag-key', Value: [networkTags.network] },
          { Name: `tag:${tags.managed}`, Value: ['true'] },
        ],
      },
      signal,
    );
    for (const acl of acls.items('networkAclSet')) {
      const aclId = acl.textOf('networkAclId') ?? '';
      for (const owned of ownedEntries(acl).filter((entry) => entry.firewall === name))
        await this.#removeDenyEntry(aclId, owned.number, owned.egress, signal);
    }
    return state(name, 'deleted');
  }

  // --- Network-wide deny: network ACL entries ---------------------------------------------------

  async #ensureDeny(
    spec: ProviderFirewallSpec,
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    const acl = await this.#networkAcl(network, vpcId, signal);
    const aclId = acl?.textOf('networkAclId');
    if (!acl || !aclId)
      return state(spec.name, 'pending', `Waiting for the network ACL of ${vpcId}`);
    const egress = spec.direction === 'egress';
    const desired: Omit<NaclEntry, 'number'>[] = [];
    if (spec.disabled !== true)
      for (const tuple of tuples(spec))
        for (const cidr of peers(spec))
          desired.push({
            egress,
            protocol: naclProtocols[tuple.protocol]!,
            cidr,
            ...(tuple.protocol === 'tcp' || tuple.protocol === 'udp'
              ? { from: tuple.from, to: tuple.to }
              : {}),
          });
    const entries = parseAclEntries(acl);
    const owned = ownedEntries(acl);
    const mine = owned.filter((entry) => entry.firewall === spec.name);
    const wanted = new Map(desired.map((entry) => [naclKey(entry), entry]));
    const slot = (egressSide: boolean, number: number) => `${egressSide}|${number}`;
    const kept = new Set<string>();
    const freed = new Set<string>();
    for (const entry of mine) {
      const actual = entries.find((e) => e.number === entry.number && e.egress === entry.egress);
      const k = actual?.action === 'deny' ? naclKey(actual) : undefined;
      if (k !== undefined && wanted.has(k) && !kept.has(k)) {
        kept.add(k);
        continue;
      }
      await this.#removeDenyEntry(aclId, entry.number, entry.egress, signal, actual !== undefined);
      freed.add(slot(entry.egress, entry.number));
    }
    // Every number in use stays taken: entries (ours, others' and ones nobody owns) and owner tags.
    const taken = new Set(
      [...entries, ...owned].map((e) => slot(e.egress, e.number)).filter((key) => !freed.has(key)),
    );
    for (const [k, entry] of wanted) {
      if (kept.has(k)) continue;
      let number = 100 + Math.floor(spec.priority / 10);
      while (taken.has(slot(entry.egress, number))) number++;
      if (number >= naclAllowAllRule)
        throw invalidInput(
          `deny rule ${spec.name} needs an ACL rule number past ${naclAllowAllRule - 1}`,
          'nacl-rule-number',
        );
      taken.add(slot(entry.egress, number));
      // The owner tag first: a crash between the two leaves a tag without an entry, which the next
      // ensure repairs, never an entry nobody owns.
      try {
        await this.#call(
          'CreateTags',
          { ResourceId: [aclId], Tag: [{ Key: denyTag(entry.egress, number), Value: spec.name }] },
          signal,
        );
      } catch (error) {
        if (awsCode(error) !== 'TagLimitExceeded') throw error;
        return state(
          spec.name,
          'error',
          `Network ACL ${aclId} has no room for the owner tag of deny rule ${spec.name} (TagLimitExceeded: EC2 allows 50 tags per resource, one per deny entry)`,
        );
      }
      const untag = () =>
        this.#tolerate(['*NotFound'], () =>
          this.#call(
            'DeleteTags',
            { ResourceId: [aclId], Tag: [{ Key: denyTag(entry.egress, number) }] },
            signal,
          ),
        );
      try {
        await this.#call(
          'CreateNetworkAclEntry',
          {
            NetworkAclId: aclId,
            RuleNumber: number,
            Protocol: entry.protocol,
            RuleAction: 'deny',
            Egress: entry.egress,
            ...(entry.cidr.includes(':')
              ? { Ipv6CidrBlock: entry.cidr }
              : { CidrBlock: entry.cidr }),
            ...(entry.from !== undefined ? { PortRange: { From: entry.from, To: entry.to } } : {}),
            ...(entry.protocol === '1' ? { IcmpTypeCode: { Type: -1, Code: -1 } } : {}),
          },
          signal,
        );
      } catch (error) {
        const code = awsCode(error);
        if (code === 'NetworkAclEntryAlreadyExists') {
          // Not this firewall's entry: an owner tag left on it would have the next ensure delete it.
          await untag();
          return state(spec.name, 'pending', `ACL rule ${number} was taken meanwhile`);
        }
        if (code === 'NetworkAclEntryLimitExceeded') {
          await untag();
          return state(
            spec.name,
            'error',
            `Network ACL ${aclId} has no room for deny rule ${spec.name} (NetworkAclEntryLimitExceeded)`,
          );
        }
        throw error;
      }
    }
    return state(spec.name, 'ready');
  }

  /** Removes every ACL entry of the VPC's network ACL that `firewall` owns. */
  async #releaseDenyEntries(
    firewall: string,
    network: string,
    vpcId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const acl = await this.#networkAcl(network, vpcId, signal);
    const aclId = acl?.textOf('networkAclId');
    if (!acl || !aclId) return;
    const entries = parseAclEntries(acl);
    for (const owned of ownedEntries(acl).filter((entry) => entry.firewall === firewall))
      await this.#removeDenyEntry(
        aclId,
        owned.number,
        owned.egress,
        signal,
        entries.some((e) => e.number === owned.number && e.egress === owned.egress),
      );
  }

  /** Deletes an owned entry, then its owner tag. */
  async #removeDenyEntry(
    aclId: string,
    number: number,
    egress: boolean,
    signal: AbortSignal,
    exists = true,
  ): Promise<void> {
    if (exists)
      await this.#tolerate(['*NotFound'], () =>
        this.#call(
          'DeleteNetworkAclEntry',
          { NetworkAclId: aclId, RuleNumber: number, Egress: egress },
          signal,
        ),
      );
    await this.#tolerate(['*NotFound'], () =>
      this.#call(
        'DeleteTags',
        { ResourceId: [aclId], Tag: [{ Key: denyTag(egress, number) }] },
        signal,
      ),
    );
  }

  // --- Machines --------------------------------------------------------------------------------------

  /**
   * Where a machine on a network launches (create): the network's subnet in the offer's zone, and
   * the security groups of the network and of the machine's tags (created when missing), so the
   * firewall applies from the first boot.
   */
  async placement(ref: NetworkRef, zone: string, signal: AbortSignal): Promise<AwsPlacement> {
    const vpc = await this.#vpc(ref.network, signal);
    if (!vpc || vpc.state !== 'available')
      throw new ComputeError('INVALID_STATE', `network ${ref.network} is not ready`, undefined, {
        provider: 'aws',
        reason: 'network',
      });
    let subnet: Subnet | undefined;
    if (ref.subnet === undefined) {
      subnet = (await this.#subnetsBy([{ Name: 'vpc-id', Value: [vpc.id] }], signal))
        .filter((s) => s.zone === zone && (!vpc.ours || s.tags.has(networkTags.subnet)))
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    } else if (subnetIdPattern.test(ref.subnet)) {
      [subnet] = await this.#subnetsBy(
        [
          { Name: 'vpc-id', Value: [vpc.id] },
          { Name: 'subnet-id', Value: [ref.subnet] },
        ],
        signal,
      );
    } else {
      [subnet] = await this.#subnetsBy(
        [
          { Name: 'vpc-id', Value: [vpc.id] },
          { Name: `tag:${networkTags.subnet}`, Value: [ref.subnet] },
        ],
        signal,
      );
    }
    if (!subnet)
      throw new ComputeError(
        'INVALID_STATE',
        `network ${ref.network} has no subnet ${ref.subnet ?? `in ${zone}`}`,
        undefined,
        {
          provider: 'aws',
          reason: 'subnet',
        },
      );
    if (subnet.zone !== zone)
      throw invalidInput(
        `subnet ${ref.subnet ?? subnet.id} is in ${subnet.zone}, but the offer is in ${zone}`,
        'subnet-zone',
      );
    const network = vpc.ours ? vpc.tags.get(networkTags.network) : undefined;
    const groupIds = await this.#groupIdsFor(vpc.id, network, ref.tags ?? [], 0, signal);
    return { subnetId: subnet.id, zone: subnet.zone, groupIds };
  }

  /**
   * The better-compute security groups of a machine with `machineTags` in a VPC, created when
   * missing. `others` is how many other groups the interface keeps: what would not fit is refused
   * before any group is made.
   */
  async #groupIdsFor(
    vpcId: string,
    network: string | undefined,
    machineTags: readonly string[],
    others: number,
    signal: AbortSignal,
  ): Promise<string[]> {
    for (const tag of machineTags)
      if (!tagPattern.test(tag))
        throw invalidInput(
          `${JSON.stringify(tag.slice(0, 64))} is not a managed network tag (bc-…)`,
          'tag',
        );
    const wanted = [
      ...(network ? [{ name: AwsNetworks.groupName('network', network) }] : []),
      ...[...new Set(machineTags)].map((tag) => ({ name: AwsNetworks.groupName('tag', tag), tag })),
    ];
    const limit = this.#config.securityGroupsPerInterface ?? defaultGroupsPerInterface;
    if (others + wanted.length > limit)
      throw new ComputeError(
        'QUOTA_EXCEEDED',
        `the machine would have ${others + wanted.length} security groups; an interface takes ${limit}`,
        undefined,
        { provider: 'aws', reason: 'security-groups-per-interface', limit },
      );
    const ids = await this.#ensureGroups(vpcId, wanted, network, signal);
    return wanted.map((w) => ids.get(w.name)!);
  }

  async setTags(
    machineId: string,
    machineTags: readonly string[],
    context: CallContext,
    instanceId?: string,
  ): Promise<void> {
    const { signal } = context;
    parseInstanceId(machineId);
    for (const tag of machineTags)
      if (!tagPattern.test(tag))
        throw invalidInput(
          `${JSON.stringify(tag.slice(0, 64))} is not a managed network tag (bc-…)`,
          'tag',
        );
    const doc = await this.#call('DescribeInstances', { InstanceId: [machineId] }, signal);
    const instance = doc
      .items('reservationSet')
      .flatMap((reservation) => reservation.items('instancesSet'))
      .find((item) => item.textOf('instanceId') === machineId);
    if (!instance)
      throw new ComputeError('NOT_FOUND', `instance ${machineId} not found`, undefined, {
        provider: 'aws',
      });
    const claimedBy = tagMap(instance).get(tags.instance);
    if (!claimedBy)
      throw new ComputeError(
        'INVALID_STATE',
        `${machineId} is not an instance of better-compute; its groups are not touched`,
        undefined,
        {
          provider: 'aws',
          reason: 'notAttached',
        },
      );
    if (instanceId !== undefined && claimedBy !== tagValue(instanceId))
      throw new ComputeError(
        'INVALID_STATE',
        `${machineId} belongs to instance ${claimedBy}, not ${instanceId}; its groups are not touched`,
        undefined,
        {
          provider: 'aws',
          reason: 'notOwned',
          claimedBy,
        },
      );
    const vpcId = instance.textOf('vpcId');
    const interfaces = instance.items('networkInterfaceSet');
    const primary =
      interfaces.find((eni) => eni.child('attachment')?.textOf('deviceIndex') === '0') ??
      interfaces[0];
    if (!vpcId || !primary)
      throw new ComputeError(
        'INVALID_STATE',
        `${machineId} has no network interface yet`,
        undefined,
        { provider: 'aws', reason: 'no-interface' },
      );
    const groupsOf = (eni: (typeof interfaces)[number]): string[] =>
      eni
        .items('groupSet')
        .map((item) => item.textOf('groupId') ?? '')
        .filter(Boolean);
    const allIds = [...new Set(interfaces.flatMap(groupsOf))];

    const vpcDoc = await this.#call('DescribeVpcs', { VpcId: [vpcId] }, signal);
    const vpcItem = vpcDoc.items('vpcSet')[0];
    const network = vpcItem ? parseVpc(vpcItem).tags.get(networkTags.network) : undefined;

    // Which current groups are better-compute's (by tag, never by name): those are replaced.
    const managed = new Set<string>();
    if (allIds.length) {
      const groups = await this.#call('DescribeSecurityGroups', { GroupId: allIds }, signal);
      for (const item of groups.items('securityGroupInfo')) {
        const t = tagMap(item);
        if (
          t.has(networkTags.tag) ||
          (t.get(tags.managed) === 'true' && t.has(networkTags.network))
        )
          managed.add(item.textOf('groupId') ?? '');
      }
    }
    // Every interface the machine's groups are on changes: the primary, and each other interface
    // carrying one of ours (an EFA interface per network card launches with the same groups), so
    // a tag the machine no longer carries admits nothing on any of its addresses. An interface
    // with none of ours (a claimed machine's own extra interface) is left as it is.
    const touched = interfaces.filter(
      (eni) => eni === primary || groupsOf(eni).some((id) => managed.has(id)),
    );
    const foreignOf = (eni: (typeof interfaces)[number]) =>
      groupsOf(eni).filter((id) => !managed.has(id));
    // The limit is checked before any group is made, so a machine over it leaves none behind.
    const others = Math.max(...touched.map((eni) => foreignOf(eni).length));
    const ours = await this.#groupIdsFor(vpcId, network, machineTags, others, signal);
    const changes = touched
      .map((eni) => {
        const current = groupsOf(eni);
        const next = [...new Set([...foreignOf(eni), ...ours])];
        return {
          eniId: eni.textOf('networkInterfaceId') ?? '',
          next,
          changed: next.length !== current.length || !next.every((id) => current.includes(id)),
        };
      })
      .filter((change) => change.changed);
    if (changes.length) {
      if (interfaces.length > 1) {
        const eniIds = changes.map((change) => change.eniId);
        // The IAM policy changes an interface's groups only when it carries the ownership tag:
        // RunInstances puts it on every interface it makes; a claimed machine's get it now.
        const eni = await this.#call(
          'DescribeNetworkInterfaces',
          { NetworkInterfaceId: eniIds },
          signal,
        );
        const tagged = new Set(
          eni
            .items('networkInterfaceSet')
            .filter((item) => tagMap(item).get(tags.instance) === claimedBy)
            .map((item) => item.textOf('networkInterfaceId')),
        );
        const untagged = eniIds.filter((id) => !tagged.has(id));
        if (untagged.length)
          await this.#call(
            'CreateTags',
            { ResourceId: untagged, Tag: [{ Key: tags.instance, Value: claimedBy }] },
            signal,
          );
        for (const change of changes)
          await this.#call(
            'ModifyNetworkInterfaceAttribute',
            { NetworkInterfaceId: change.eniId, SecurityGroupId: change.next },
            signal,
          );
      } else
        await this.#call(
          'ModifyInstanceAttribute',
          { InstanceId: machineId, GroupId: changes[0]!.next },
          signal,
        );
    }
    await this.#sweepTagGroups(vpcId, signal);
  }

  // --- Tag group garbage collection ------------------------------------------------------------

  /**
   * Deletes the VPC's tag groups nothing uses any more: a managed group carrying
   * `better-compute:tag` that no network interface has and no firewall rule targets (its machine
   * is gone, or carries other tags now). A group is deleted only when two sweeps, at least the
   * consistency window apart, both saw it unused, so a machine being launched with it right now
   * (whose interface a read may not show yet) keeps it; EC2 refuses to delete a group still in
   * use (DependencyViolation) anyway, which leaves it for a later sweep. At most one sweep per VPC
   * every `tagGroupSweepMs`; a sweep that fails is logged, never the caller's error.
   */
  async #sweepTagGroups(vpcId: string, signal: AbortSignal): Promise<void> {
    const now = this.host.context.clock.now();
    const last = this.#swept.get(vpcId);
    if (last !== undefined && now - last < tagGroupSweepMs) return;
    this.#swept.set(vpcId, now);
    try {
      const doc = await this.#call(
        'DescribeSecurityGroups',
        {
          Filter: [
            { Name: 'vpc-id', Value: [vpcId] },
            { Name: 'tag-key', Value: [networkTags.tag] },
            { Name: `tag:${tags.managed}`, Value: ['true'] },
          ],
        },
        signal,
      );
      const candidates = doc
        .items('securityGroupInfo')
        .map((item) => item.textOf('groupId') ?? '')
        .filter(Boolean);
      const keep = new Set<string>();
      for (let start = 0; start < candidates.length; start += 200) {
        const chunk = candidates.slice(start, start + 200);
        const enis = await this.#call(
          'DescribeNetworkInterfaces',
          { Filter: [{ Name: 'group-id', Value: chunk }] },
          signal,
        );
        for (const eni of enis.items('networkInterfaceSet'))
          for (const group of eni.items('groupSet')) keep.add(group.textOf('groupId') ?? '');
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const rules = await this.#call(
            'DescribeSecurityGroupRules',
            { Filter: [{ Name: 'group-id', Value: chunk }], MaxResults: 1000, NextToken: token },
            signal,
          );
          for (const rule of rules.items('securityGroupRuleSet').map(parseRule))
            if ([...rule.tags.keys()].some((key) => key.startsWith(networkTags.firewallPrefix)))
              keep.add(rule.groupId);
          token = rules.textOf('nextToken') || undefined;
          if (token && seen.has(token)) break;
          if (token) seen.add(token);
        } while (token);
      }
      for (const id of candidates) {
        if (keep.has(id)) {
          this.#unused.delete(id);
          continue;
        }
        const since = this.#unused.get(id)?.at;
        if (since === undefined) {
          this.#unused.set(id, { vpcId, at: now });
          continue;
        }
        if (now - since < this.host.consistencyWindowMs()) continue;
        try {
          await this.#call('DeleteSecurityGroup', { GroupId: id }, signal);
          this.#unused.delete(id);
        } catch (error) {
          if (isComputeError(error, 'NOT_FOUND')) this.#unused.delete(id);
          // In use after all (DependencyViolation): looked at again by a later sweep.
          else if (isComputeError(error, 'INVALID_STATE')) this.#unused.delete(id);
          else throw error;
        }
      }
      // This VPC's groups gone some other way are forgotten.
      for (const [id, entry] of [...this.#unused])
        if (entry.vpcId === vpcId && !candidates.includes(id)) this.#unused.delete(id);
    } catch (error) {
      if (signal.aborted) throw error;
      this.host.context.log.warn('aws: sweeping unused tag security groups failed', {
        provider: 'aws',
        vpc: vpcId,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      });
    }
  }
}

function parseRule(item: XmlElement): Rule {
  return {
    id: item.textOf('securityGroupRuleId') ?? '',
    groupId: item.textOf('groupId') ?? '',
    egress: item.textOf('isEgress') === 'true',
    protocol: item.textOf('ipProtocol') ?? '',
    from: Number(item.textOf('fromPort') ?? -1),
    to: Number(item.textOf('toPort') ?? -1),
    // A rule matching a security group (EFA's self rule) has no range: its peer is the group.
    cidr:
      item.textOf('cidrIpv4') ??
      item.textOf('cidrIpv6') ??
      (item.child('referencedGroupInfo')?.textOf('groupId')
        ? `sg:${item.child('referencedGroupInfo')!.textOf('groupId')}`
        : ''),
    tags: tagMap(item),
  };
}

const denyTag = (egress: boolean, number: number) =>
  `${networkTags.denyPrefix}${egress ? 'egress' : 'ingress'}:${number}`;

function parseAclEntries(acl: XmlElement): (NaclEntry & { action: string })[] {
  return acl.items('entrySet').map((item) => {
    const range = item.child('portRange');
    const protocol = item.textOf('protocol') ?? '';
    return {
      number: Number(item.textOf('ruleNumber')),
      egress: item.textOf('egress') === 'true',
      protocol,
      action: item.textOf('ruleAction') ?? '',
      cidr: item.textOf('cidrBlock') ?? item.textOf('ipv6CidrBlock') ?? '',
      ...(range && (protocol === '6' || protocol === '17')
        ? { from: Number(range.textOf('from')), to: Number(range.textOf('to')) }
        : {}),
    };
  });
}

/** The ACL's owner tags: which entry numbers belong to which firewall. */
function ownedEntries(acl: XmlElement): { number: number; egress: boolean; firewall: string }[] {
  const out: { number: number; egress: boolean; firewall: string }[] = [];
  for (const [key, value] of tagMap(acl)) {
    const match = /^better-compute:deny:(ingress|egress):(\d{1,5})$/.exec(key);
    if (match)
      out.push({ egress: match[1] === 'egress', number: Number(match[2]), firewall: value });
  }
  return out;
}

// --- IAM -------------------------------------------------------------------------------------------

/**
 * The IAM statements tenant networks need (program Appendix B, phase A2), for `iamPolicy({ networks:
 * true })`. `ec2(resource)` is an EC2 resource ARN in the policy's partition, region and account;
 * `discover` is the account's discoverTag as [key, value].
 *
 * - Creates must tag what they create `better-compute:managed=true` (every VPC, gateway, subnet,
 *   security group, route table, network ACL and endpoint better-compute makes carries it), and
 *   that tag may only be written by those creates: no statement grants it (or the network tag) on
 *   an existing resource, so a resource-tag condition below cannot be met by tagging.
 * - Changes and deletes of VPCs, gateways, subnets, security groups, route tables, network ACLs and
 *   endpoints need that tag on the resource. A network has its own route table and network ACL,
 *   created tagged; AWS's untagged main table and default ACL are never edited. Routes, ACL entries
 *   and subnet associations change only on managed tables, ACLs and subnets, and a route may only
 *   point at a managed internet gateway.
 * - Route tables, network ACLs and gateway endpoints go only into a managed VPC, and an endpoint
 *   only onto a managed route table (an adopted VPC is never changed).
 * - The deny-owner tags (`better-compute:deny:*`) may be written only on a managed network ACL.
 * - A machine's groups change only on instances carrying `better-compute:instance` (claimed ones),
 *   and on network interfaces carrying it (RunInstances tags the interface of a machine on a tenant
 *   network; setTags tags a claimed multi-interface machine's primary interface). That interface
 *   tag is the one self-grant left, like A1's attach: the role may put `better-compute:instance` on
 *   any interface it may tag, which `discover` narrows to interfaces carrying the discovery tag.
 */
export function networksIamStatements(
  ec2: (resource: string) => string,
  options: { discover?: readonly [string, string] } = {},
): IamStatement[] {
  const managed = { StringEquals: { [`ec2:ResourceTag/${tags.managed}`]: 'true' } };
  const requestTagged = { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } };
  const made = [
    ec2('vpc/*'),
    ec2('internet-gateway/*'),
    ec2('subnet/*'),
    ec2('security-group/*'),
    ec2('vpc-endpoint/*'),
    ec2('route-table/*'),
    ec2('network-acl/*'),
  ];
  return [
    {
      Sid: 'NetworkDescribe',
      Effect: 'Allow',
      Action: [
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeRouteTables',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSecurityGroupRules',
        'ec2:DescribeNetworkAcls',
        'ec2:DescribeVpcEndpoints',
        'ec2:DescribeNetworkInterfaces',
      ],
      Resource: '*',
    },
    {
      Sid: 'NetworkCreateTagged',
      Effect: 'Allow',
      Action: ['ec2:CreateVpc', 'ec2:CreateInternetGateway'],
      Resource: [ec2('vpc/*'), ec2('internet-gateway/*'), ec2('ipam-pool/*')],
      Condition: requestTagged,
    },
    {
      // Subnets and security groups also go into adopted VPCs (a subnet inside its ranges, the
      // groups of network tags): the VPC is a resource of the call under the same condition.
      Sid: 'NetworkCreateInVpc',
      Effect: 'Allow',
      Action: ['ec2:CreateSubnet', 'ec2:CreateSecurityGroup'],
      Resource: [ec2('subnet/*'), ec2('security-group/*'), ec2('vpc/*')],
      Condition: requestTagged,
    },
    {
      Sid: 'NetworkCreateOwnedParts',
      Effect: 'Allow',
      Action: ['ec2:CreateRouteTable', 'ec2:CreateNetworkAcl'],
      Resource: [ec2('route-table/*'), ec2('network-acl/*')],
      Condition: requestTagged,
    },
    {
      // Only the endpoint itself under the request tag: on route-table/* that condition would let
      // an endpoint onto any table.
      Sid: 'NetworkCreateEndpoint',
      Effect: 'Allow',
      Action: 'ec2:CreateVpcEndpoint',
      Resource: ec2('vpc-endpoint/*'),
      Condition: requestTagged,
    },
    {
      // The existing resources those creates name: a managed VPC, and for an endpoint a managed
      // route table.
      Sid: 'NetworkOwnedPartsParents',
      Effect: 'Allow',
      Action: ['ec2:CreateRouteTable', 'ec2:CreateNetworkAcl', 'ec2:CreateVpcEndpoint'],
      Resource: ec2('vpc/*'),
      Condition: managed,
    },
    {
      Sid: 'NetworkEndpointRouteTables',
      Effect: 'Allow',
      Action: 'ec2:CreateVpcEndpoint',
      Resource: ec2('route-table/*'),
      Condition: managed,
    },
    {
      Sid: 'NetworkTagOnCreate',
      Effect: 'Allow',
      Action: 'ec2:CreateTags',
      Resource: [...made, ec2('security-group-rule/*')],
      Condition: {
        StringEquals: {
          'ec2:CreateAction': [
            'CreateVpc',
            'CreateInternetGateway',
            'CreateSubnet',
            'CreateSecurityGroup',
            'CreateVpcEndpoint',
            'CreateRouteTable',
            'CreateNetworkAcl',
            'AuthorizeSecurityGroupIngress',
            'AuthorizeSecurityGroupEgress',
          ],
        },
      },
    },
    {
      Sid: 'NetworkManageOwned',
      Effect: 'Allow',
      Action: [
        'ec2:DeleteVpc',
        'ec2:ModifyVpcAttribute',
        'ec2:AssociateVpcCidrBlock',
        'ec2:AttachInternetGateway',
        'ec2:DetachInternetGateway',
        'ec2:DeleteInternetGateway',
        'ec2:DeleteSubnet',
        'ec2:ModifySubnetAttribute',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:DeleteVpcEndpoints',
        'ec2:DeleteRouteTable',
        'ec2:DeleteNetworkAcl',
      ],
      Resource: made,
      Condition: managed,
    },
    {
      // The other resources of a rule change: each must be allowed, so the group itself stays
      // guarded by NetworkManageOwned.
      Sid: 'NetworkRuleResources',
      Effect: 'Allow',
      Action: [
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
      ],
      Resource: ec2('security-group-rule/*'),
    },
    {
      Sid: 'NetworkRuleTags',
      Effect: 'Allow',
      Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: ec2('security-group-rule/*'),
      Condition: {
        'ForAllValues:StringLike': { 'aws:TagKeys': [`${networkTags.firewallPrefix}*`] },
        Null: { 'aws:TagKeys': 'false' },
      },
    },
    {
      Sid: 'NetworkRoutes',
      Effect: 'Allow',
      Action: ['ec2:CreateRoute', 'ec2:ReplaceRoute'],
      Resource: ec2('route-table/*'),
      Condition: managed,
    },
    {
      // The gateway a route names is a resource of the call too: only a managed one.
      Sid: 'NetworkRouteGateways',
      Effect: 'Allow',
      Action: ['ec2:CreateRoute', 'ec2:ReplaceRoute'],
      Resource: ec2('internet-gateway/*'),
      Condition: managed,
    },
    {
      Sid: 'NetworkAclEntries',
      Effect: 'Allow',
      Action: ['ec2:CreateNetworkAclEntry', 'ec2:DeleteNetworkAclEntry'],
      Resource: ec2('network-acl/*'),
      Condition: managed,
    },
    {
      // A managed subnet onto the network's managed route table and ACL.
      Sid: 'NetworkSubnetAssociations',
      Effect: 'Allow',
      Action: ['ec2:AssociateRouteTable', 'ec2:ReplaceNetworkAclAssociation'],
      Resource: [ec2('subnet/*'), ec2('route-table/*'), ec2('network-acl/*')],
      Condition: managed,
    },
    {
      // The deny-owner keys only, and only on a network ACL better-compute created.
      Sid: 'NetworkAclTags',
      Effect: 'Allow',
      Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: ec2('network-acl/*'),
      Condition: {
        'ForAllValues:StringLike': { 'aws:TagKeys': [`${networkTags.denyPrefix}*`] },
        Null: { 'aws:TagKeys': 'false' },
        ...managed,
      },
    },
    {
      Sid: 'NetworkMachineGroups',
      Effect: 'Allow',
      Action: ['ec2:ModifyInstanceAttribute'],
      Resource: ec2('instance/*'),
      Condition: { Null: { [`ec2:ResourceTag/${tags.instance}`]: 'false' } },
    },
    {
      // A multi-interface machine changes groups on its primary interface, which must carry the
      // ownership tag too.
      Sid: 'NetworkInterfaceGroups',
      Effect: 'Allow',
      Action: 'ec2:ModifyNetworkInterfaceAttribute',
      Resource: ec2('network-interface/*'),
      Condition: { Null: { [`ec2:ResourceTag/${tags.instance}`]: 'false' } },
    },
    {
      // A claimed multi-interface machine's primary interface gets the ownership tag (only that
      // key). The documented self-grant: narrowed by the account's discoverTag when it has one.
      Sid: 'NetworkInterfaceOwnerTag',
      Effect: 'Allow',
      Action: 'ec2:CreateTags',
      Resource: ec2('network-interface/*'),
      Condition: {
        'ForAllValues:StringEquals': { 'aws:TagKeys': [tags.instance] },
        Null: { 'aws:TagKeys': 'false' },
        ...(options.discover
          ? {
              StringEquals: {
                [`ec2:ResourceTag/${options.discover[0]}`]: options.discover[1],
              },
            }
          : {}),
      },
    },
    {
      Sid: 'NetworkMachineGroupResources',
      Effect: 'Allow',
      Action: ['ec2:ModifyInstanceAttribute', 'ec2:ModifyNetworkInterfaceAttribute'],
      Resource: ec2('security-group/*'),
    },
  ];
}
