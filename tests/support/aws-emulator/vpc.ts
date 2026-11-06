import type { Ec2Emulator } from './ec2.js';
import type { AwsEmulator, EmulatorRequest, ServiceHandler } from './index.js';
import { ec2Error, ec2Response, el, items } from './xml.js';

// Amazon VPC as provider-aws networks use it (AWS A2): VPCs with secondary CIDR blocks, internet
// gateways, route tables, subnets, security groups and their tagged rules, network ACLs and their
// entries, gateway endpoints, and the security groups and tags of an instance's primary network
// interface (DescribeNetworkInterfaces, ModifyNetworkInterfaceAttribute; ModifyInstanceAttribute
// refuses groups on a multi-interface instance, as EC2 does). It wraps the EC2 emulator on
// the same host: every other action (and the instance half of CreateTags/DeleteTags) goes to it, and
// RunInstances is patched with the VPC and security groups of its subnet. Like EC2, deletes refuse
// a resource still in use with DependencyViolation. Knobs: associating (CIDR associations stay
// `associating` for that many reads), pendingVpcReads (a new VPC reads `pending`), ruleLimit (rules
// per security group), naclEntryLimit (entries per direction), groupsPerInterface and tagLagReads
// (a new VPC is missing from tag-filtered DescribeVpcs for that many reads, as AWS tag reads lag).

type Tags = Map<string, string>;

export interface EmuVpc {
  id: string;
  state: 'pending' | 'available';
  pendingReads: number;
  /** Tag-filtered reads that do not show this VPC yet. */
  tagHiddenReads: number;
  cidrs: {
    associationId: string;
    cidr: string;
    state: 'associating' | 'associated';
    reads: number;
  }[];
  tags: Tags;
  dnsSupport: boolean;
  dnsHostnames: boolean;
}

export interface EmuSubnet {
  id: string;
  vpcId: string;
  cidr: string;
  zone: string;
  mapPublicIp: boolean;
  tags: Tags;
}

export interface EmuSecurityGroup {
  id: string;
  vpcId: string;
  name: string;
  description: string;
  tags: Tags;
}

export interface EmuRule {
  id: string;
  groupId: string;
  egress: boolean;
  protocol: string;
  from: number;
  to: number;
  cidrIpv4?: string;
  cidrIpv6?: string;
  /** A rule that matches a security group (UserIdGroupPairs) instead of a range. */
  referencedGroupId?: string;
  tags: Tags;
}

export interface EmuNaclEntry {
  number: number;
  egress: boolean;
  protocol: string;
  action: 'allow' | 'deny';
  cidr?: string;
  ipv6Cidr?: string;
  from?: number;
  to?: number;
}

export interface EmuNacl {
  id: string;
  vpcId: string;
  isDefault: boolean;
  entries: EmuNaclEntry[];
  tags: Tags;
}

export interface EmuRouteTable {
  id: string;
  vpcId: string;
  main: boolean;
  routes: { destination: string; gatewayId: string }[];
  tags: Tags;
}

export interface EmuEndpoint {
  id: string;
  vpcId: string;
  service: string;
  routeTableIds: string[];
  tags: Tags;
}

function range(cidr: string): [number, number] {
  const [address = '', prefix = '32'] = cidr.split('/');
  const octets = address.split('.').map(Number);
  const start = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return [start, start + 2 ** (32 - Number(prefix)) - 1];
}
const prefixOf = (cidr: string) => Number(cidr.split('/')[1]);
const overlaps = (a: string, b: string) => {
  const [as, ae] = range(a);
  const [bs, be] = range(b);
  return as <= be && bs <= ae;
};
const contains = (outer: string, inner: string) => {
  const [os, oe] = range(outer);
  const [is, ie] = range(inner);
  return os <= is && ie <= oe;
};
const validCidr = (cidr: string) =>
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.test(cidr) &&
  range(cidr)[0] % 2 ** (32 - prefixOf(cidr)) === 0;

function listOf(params: URLSearchParams, prefix: string): string[] {
  const out: string[] = [];
  for (let n = 1; params.has(`${prefix}.${n}`); n++) out.push(params.get(`${prefix}.${n}`)!);
  return out;
}

function filtersOf(params: URLSearchParams): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  for (let n = 1; params.has(`Filter.${n}.Name`); n++)
    filters.set(params.get(`Filter.${n}.Name`)!, listOf(params, `Filter.${n}.Value`));
  return filters;
}

/** TagSpecification.N for `type` → tags. */
function tagsOf(params: URLSearchParams, type: string): Tags {
  const tags: Tags = new Map();
  for (let n = 1; params.has(`TagSpecification.${n}.ResourceType`); n++) {
    if (params.get(`TagSpecification.${n}.ResourceType`) !== type) continue;
    for (let m = 1; params.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
      tags.set(
        params.get(`TagSpecification.${n}.Tag.${m}.Key`)!,
        params.get(`TagSpecification.${n}.Tag.${m}.Value`) ?? '',
      );
  }
  return tags;
}

const tagSet = (tags: Tags) =>
  items(
    'tagSet',
    [...tags]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${el('key', key)}${el('value', value)}`),
  );

/** Whether a resource passes `filters`: `fields(name)` gives its values for a filter name. */
function matches(
  tags: Tags,
  filters: Map<string, string[]>,
  fields: (name: string) => readonly string[] | undefined,
): boolean {
  for (const [name, values] of filters) {
    if (name === 'tag-key') {
      if (!values.some((key) => tags.has(key))) return false;
    } else if (name.startsWith('tag:')) {
      const value = tags.get(name.slice(4));
      if (value === undefined || !values.includes(value)) return false;
    } else {
      const have = fields(name);
      if (have === undefined) throw new Error(`emulator: unsupported filter ${name}`);
      if (!have.some((value) => values.includes(value))) return false;
    }
  }
  return true;
}

const protocols: Record<string, string> = { tcp: '6', udp: '17', icmp: '1', '-1': '-1' };
/** The protocol as EC2 stores a rule's (`tcp`, `udp`, `icmp`, `-1`), from a name or number. */
function ruleProtocol(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'all') return '-1';
  if (lower in protocols) return lower;
  const byNumber = Object.entries(protocols).find(([, number]) => number === lower);
  return byNumber ? byNumber[0] : lower;
}

export class VpcEmulator {
  readonly vpcs = new Map<string, EmuVpc>();
  readonly subnets = new Map<string, EmuSubnet>();
  readonly igws = new Map<string, { id: string; vpcId?: string; tags: Tags }>();
  readonly routeTables = new Map<string, EmuRouteTable>();
  readonly groups = new Map<string, EmuSecurityGroup>();
  readonly rules = new Map<string, EmuRule>();
  readonly nacls = new Map<string, EmuNacl>();
  readonly endpoints = new Map<string, EmuEndpoint>();
  /** Reads a new CIDR association stays `associating`. */
  associating = 0;
  /** Reads a new VPC stays `pending`. */
  pendingVpcReads = 0;
  /** Tag-filtered DescribeVpcs reads a new VPC is missing from. */
  tagLagReads = 0;
  ruleLimit = 60;
  /**
   * Network interfaces other services keep in the account's subnets (EFS mount targets, FSx file
   * servers): their subnets and groups cannot be deleted while these report them.
   */
  readonly serviceInterfaces: (() => readonly { subnetId: string; groupIds: readonly string[] }[])[] =
    [];
  naclEntryLimit = 20;
  groupsPerInterface = 5;
  /** Page size of DescribeSecurityGroupRules (small, so tests page). */
  pageSize = 1000;
  readonly #inner: ServiceHandler;
  #next = 0x1000;

  constructor(
    private readonly emu: AwsEmulator,
    private readonly ec2: Ec2Emulator,
  ) {
    const inner = emu.handlerFor('ec2.us-east-1.amazonaws.com');
    if (!inner) throw new Error('VpcEmulator wraps an Ec2Emulator: construct that first');
    this.#inner = inner;
    emu.register(/^ec2\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'ec2',
      protocol: 'ec2',
      handle: (request) => this.#handle(request),
    });
  }

  #id(prefix: string): string {
    return `${prefix}-${(++this.#next).toString(16).padStart(17, '0')}`;
  }

  /** The tag map of any VPC resource by id. */
  #taggable(id: string): Tags | undefined {
    return (
      this.vpcs.get(id)?.tags ??
      this.subnets.get(id)?.tags ??
      this.igws.get(id)?.tags ??
      this.routeTables.get(id)?.tags ??
      this.groups.get(id)?.tags ??
      this.rules.get(id)?.tags ??
      this.nacls.get(id)?.tags ??
      this.endpoints.get(id)?.tags ??
      this.#enis().find((eni) => eni.id === id)?.instance.eniTags
    );
  }

  /** The primary network interface of every live instance (the only ones the emulator models). */
  #enis() {
    return this.#liveInstances().map((instance) => ({
      id: `eni-${instance.id.slice(2)}`,
      instance,
    }));
  }

  /** The VPC by tag value (test helper). */
  vpcByName(name: string): EmuVpc | undefined {
    return [...this.vpcs.values()].find((vpc) => vpc.tags.get('better-compute:network') === name);
  }

  defaultNacl(vpcId: string): EmuNacl {
    return [...this.nacls.values()].find((acl) => acl.vpcId === vpcId && acl.isDefault)!;
  }

  mainRouteTable(vpcId: string): EmuRouteTable {
    return [...this.routeTables.values()].find((table) => table.vpcId === vpcId && table.main)!;
  }

  /** A VPC better-compute did not make (an adopted one), with a subnet. */
  addForeignVpc(cidr = '172.31.0.0/16'): { vpc: EmuVpc; subnet: EmuSubnet } {
    const vpc = this.#createVpc(cidr, new Map());
    vpc.state = 'available';
    vpc.pendingReads = 0;
    const subnet: EmuSubnet = {
      id: this.#id('subnet'),
      vpcId: vpc.id,
      cidr: cidr.replace(/\/\d+$/, '/20'),
      zone: 'us-east-1a',
      mapPublicIp: true,
      tags: new Map(),
    };
    this.subnets.set(subnet.id, subnet);
    return { vpc, subnet };
  }

  #createVpc(cidr: string, tags: Tags): EmuVpc {
    const vpc: EmuVpc = {
      id: this.#id('vpc'),
      state: 'pending',
      pendingReads: this.pendingVpcReads,
      tagHiddenReads: this.tagLagReads,
      cidrs: [{ associationId: this.#id('vpc-cidr-assoc'), cidr, state: 'associated', reads: 0 }],
      tags,
      dnsSupport: true,
      dnsHostnames: false,
    };
    this.vpcs.set(vpc.id, vpc);
    const table: EmuRouteTable = {
      id: this.#id('rtb'),
      vpcId: vpc.id,
      main: true,
      routes: [{ destination: cidr, gatewayId: 'local' }],
      tags: new Map(),
    };
    this.routeTables.set(table.id, table);
    const all = { protocol: '-1', action: 'allow' as const, cidr: '0.0.0.0/0' };
    const aclId = this.#id('acl');
    this.nacls.set(aclId, {
      id: aclId,
      vpcId: vpc.id,
      isDefault: true,
      entries: [
        { number: 100, egress: false, ...all },
        { number: 100, egress: true, ...all },
      ],
      tags: new Map(),
    });
    const group: EmuSecurityGroup = {
      id: this.#id('sg'),
      vpcId: vpc.id,
      name: 'default',
      description: 'default VPC security group',
      tags: new Map(),
    };
    this.groups.set(group.id, group);
    this.#defaultEgress(group.id);
    return vpc;
  }

  #defaultEgress(groupId: string): void {
    const id = this.#id('sgr');
    this.rules.set(id, {
      id,
      groupId,
      egress: true,
      protocol: '-1',
      from: -1,
      to: -1,
      cidrIpv4: '0.0.0.0/0',
      tags: new Map(),
    });
  }

  #vpcXml(vpc: EmuVpc): string {
    return [
      el('vpcId', vpc.id),
      el('state', vpc.state),
      el('cidrBlock', vpc.cidrs[0]!.cidr),
      items(
        'cidrBlockAssociationSet',
        vpc.cidrs.map(
          (block) =>
            `${el('associationId', block.associationId)}${el('cidrBlock', block.cidr)}<cidrBlockState>${el('state', block.state)}</cidrBlockState>`,
        ),
      ),
      el('isDefault', false),
      tagSet(vpc.tags),
    ].join('');
  }

  #subnetXml(subnet: EmuSubnet): string {
    return [
      el('subnetId', subnet.id),
      el('state', 'available'),
      el('vpcId', subnet.vpcId),
      el('cidrBlock', subnet.cidr),
      el('availabilityZone', subnet.zone),
      el('availabilityZoneId', this.ec2.zones.get(subnet.zone)),
      el('mapPublicIpOnLaunch', subnet.mapPublicIp),
      tagSet(subnet.tags),
    ].join('');
  }

  #ruleXml(rule: EmuRule): string {
    return [
      el('securityGroupRuleId', rule.id),
      el('groupId', rule.groupId),
      el('isEgress', rule.egress),
      el('ipProtocol', rule.protocol),
      el('fromPort', rule.from),
      el('toPort', rule.to),
      el('cidrIpv4', rule.cidrIpv4),
      el('cidrIpv6', rule.cidrIpv6),
      rule.referencedGroupId
        ? `<referencedGroupInfo>${el('groupId', rule.referencedGroupId)}${el('userId', '222222222222')}</referencedGroupInfo>`
        : '',
      tagSet(rule.tags),
    ].join('');
  }

  #naclXml(acl: EmuNacl): string {
    // The implicit `*` deny entries read as rule 32767.
    const implicit = (egress: boolean): EmuNaclEntry => ({
      number: 32767,
      egress,
      protocol: '-1',
      action: 'deny',
      cidr: '0.0.0.0/0',
    });
    const entries = [...acl.entries, implicit(false), implicit(true)].map(
      (entry) =>
        `${el('ruleNumber', entry.number)}${el('protocol', entry.protocol)}${el('ruleAction', entry.action)}${el('egress', entry.egress)}${el('cidrBlock', entry.cidr)}${el('ipv6CidrBlock', entry.ipv6Cidr)}${entry.from !== undefined ? `<portRange>${el('from', entry.from)}${el('to', entry.to)}</portRange>` : ''}`,
    );
    const associations = [...this.subnets.values()]
      .filter((subnet) => subnet.vpcId === acl.vpcId && acl.isDefault)
      .map(
        (subnet) =>
          `${el('networkAclAssociationId', `aclassoc-${subnet.id.slice(7)}`)}${el('networkAclId', acl.id)}${el('subnetId', subnet.id)}`,
      );
    return [
      el('networkAclId', acl.id),
      el('vpcId', acl.vpcId),
      el('default', acl.isDefault),
      items('entrySet', entries),
      items('associationSet', associations),
      tagSet(acl.tags),
    ].join('');
  }

  /** Instances (not terminated) using a subnet or security group. */
  #liveInstances() {
    return [...this.ec2.instances.values()].filter((instance) => instance.state !== 'terminated');
  }

  #handle(request: EmulatorRequest): Response | Promise<Response> {
    const p = request.params;
    const action = request.operation;
    const filters = filtersOf(p);
    switch (action) {
      // --- VPCs --------------------------------------------------------------------------------
      case 'CreateVpc': {
        const cidr = p.get('CidrBlock') ?? (p.get('Ipv4IpamPoolId') ? '10.200.0.0/16' : '');
        if (!validCidr(cidr) || prefixOf(cidr) < 16 || prefixOf(cidr) > 28)
          return ec2Error('InvalidVpc.Range', `The CIDR '${cidr}' is invalid.`);
        const vpc = this.#createVpc(cidr, tagsOf(p, 'vpc'));
        return ec2Response(action, `<vpc>${this.#vpcXml(vpc)}</vpc>`);
      }
      case 'DescribeVpcs': {
        const ids = listOf(p, 'VpcId');
        for (const id of ids)
          if (!this.vpcs.has(id))
            return ec2Error('InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`);
        const byTag = [...filters.keys()].some((name) => name.startsWith('tag'));
        const found = [...this.vpcs.values()].filter(
          (vpc) =>
            (ids.length === 0 || ids.includes(vpc.id)) &&
            matches(vpc.tags, filters, (name) =>
              name === 'vpc-id'
                ? [vpc.id]
                : name === 'state'
                  ? [vpc.state]
                  : name === 'cidr-block-association.cidr-block'
                    ? vpc.cidrs.map((block) => block.cidr)
                    : undefined,
            ) &&
            !(byTag && vpc.tagHiddenReads-- > 0),
        );
        for (const vpc of found) {
          if (vpc.state === 'pending' && vpc.pendingReads-- <= 0) vpc.state = 'available';
          for (const block of vpc.cidrs)
            if (block.state === 'associating' && block.reads-- <= 0) block.state = 'associated';
        }
        return ec2Response(
          action,
          items(
            'vpcSet',
            found.map((vpc) => this.#vpcXml(vpc)),
          ),
        );
      }
      case 'ModifyVpcAttribute': {
        const vpc = this.vpcs.get(p.get('VpcId') ?? '');
        if (!vpc) return ec2Error('InvalidVpcID.NotFound', 'The vpc ID does not exist');
        const support = p.get('EnableDnsSupport.Value');
        const hostnames = p.get('EnableDnsHostnames.Value');
        if ((support === null) === (hostnames === null))
          return ec2Error('InvalidParameterCombination', 'exactly one attribute per call');
        if (support !== null) vpc.dnsSupport = support === 'true';
        if (hostnames !== null) vpc.dnsHostnames = hostnames === 'true';
        return ec2Response(action, el('return', true));
      }
      case 'AssociateVpcCidrBlock': {
        const vpc = this.vpcs.get(p.get('VpcId') ?? '');
        if (!vpc) return ec2Error('InvalidVpcID.NotFound', 'The vpc ID does not exist');
        const cidr = p.get('CidrBlock') ?? '';
        if (!validCidr(cidr) || prefixOf(cidr) < 16 || prefixOf(cidr) > 28)
          return ec2Error('InvalidVpc.Range', `The CIDR '${cidr}' is invalid.`);
        if (vpc.cidrs.some((block) => overlaps(block.cidr, cidr)))
          return ec2Error('InvalidVpc.Range', `The CIDR '${cidr}' conflicts with another subnet`);
        if (vpc.cidrs.length >= 5)
          return ec2Error('CidrLimitExceeded', 'This network has reached its CIDR block limit');
        const block = {
          associationId: this.#id('vpc-cidr-assoc'),
          cidr,
          state: this.associating > 0 ? ('associating' as const) : ('associated' as const),
          reads: this.associating - 1,
        };
        vpc.cidrs.push(block);
        return ec2Response(
          action,
          `${el('vpcId', vpc.id)}<cidrBlockAssociation>${el('associationId', block.associationId)}${el('cidrBlock', cidr)}<cidrBlockState>${el('state', block.state)}</cidrBlockState></cidrBlockAssociation>`,
        );
      }
      case 'DeleteVpc': {
        const id = p.get('VpcId') ?? '';
        if (!this.vpcs.has(id))
          return ec2Error('InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`);
        const blocking =
          [...this.subnets.values()].some((subnet) => subnet.vpcId === id) ||
          [...this.igws.values()].some((igw) => igw.vpcId === id) ||
          [...this.endpoints.values()].some((endpoint) => endpoint.vpcId === id) ||
          [...this.groups.values()].some((group) => group.vpcId === id && group.name !== 'default');
        if (blocking)
          return ec2Error(
            'DependencyViolation',
            `The vpc '${id}' has dependencies and cannot be deleted.`,
          );
        this.vpcs.delete(id);
        for (const [key, table] of this.routeTables)
          if (table.vpcId === id) this.routeTables.delete(key);
        for (const [key, acl] of this.nacls) if (acl.vpcId === id) this.nacls.delete(key);
        for (const [key, group] of this.groups)
          if (group.vpcId === id) {
            this.groups.delete(key);
            for (const [ruleId, rule] of this.rules)
              if (rule.groupId === key) this.rules.delete(ruleId);
          }
        return ec2Response(action, el('return', true));
      }

      // --- Internet gateways and routes ------------------------------------------------------------
      case 'CreateInternetGateway': {
        const igw = { id: this.#id('igw'), tags: tagsOf(p, 'internet-gateway') };
        this.igws.set(igw.id, igw);
        return ec2Response(
          action,
          `<internetGateway>${el('internetGatewayId', igw.id)}<attachmentSet/>${tagSet(igw.tags)}</internetGateway>`,
        );
      }
      case 'DescribeInternetGateways': {
        const found = [...this.igws.values()].filter((igw) =>
          matches(igw.tags, filters, (name) =>
            name === 'attachment.vpc-id'
              ? igw.vpcId
                ? [igw.vpcId]
                : []
              : name === 'internet-gateway-id'
                ? [igw.id]
                : undefined,
          ),
        );
        return ec2Response(
          action,
          items(
            'internetGatewaySet',
            found.map(
              (igw) =>
                `${el('internetGatewayId', igw.id)}${items('attachmentSet', igw.vpcId ? [`${el('vpcId', igw.vpcId)}${el('state', 'available')}`] : [])}${tagSet(igw.tags)}`,
            ),
          ),
        );
      }
      case 'AttachInternetGateway': {
        const igw = this.igws.get(p.get('InternetGatewayId') ?? '');
        if (!igw) return ec2Error('InvalidInternetGatewayID.NotFound', 'no such gateway');
        const vpcId = p.get('VpcId') ?? '';
        if (!this.vpcs.has(vpcId)) return ec2Error('InvalidVpcID.NotFound', 'no such vpc');
        if (igw.vpcId === vpcId)
          return ec2Error('Resource.AlreadyAssociated', `resource ${igw.id} is already attached`);
        if (igw.vpcId) return ec2Error('Resource.AlreadyAssociated', 'attached elsewhere');
        if ([...this.igws.values()].some((other) => other.vpcId === vpcId))
          return ec2Error('InvalidParameterValue', 'the network already has an internet gateway');
        igw.vpcId = vpcId;
        return ec2Response(action, el('return', true));
      }
      case 'DetachInternetGateway': {
        const igw = this.igws.get(p.get('InternetGatewayId') ?? '');
        if (!igw) return ec2Error('InvalidInternetGatewayID.NotFound', 'no such gateway');
        if (igw.vpcId !== p.get('VpcId')) return ec2Error('Gateway.NotAttached', 'not attached');
        delete igw.vpcId;
        return ec2Response(action, el('return', true));
      }
      case 'DeleteInternetGateway': {
        const id = p.get('InternetGatewayId') ?? '';
        const igw = this.igws.get(id);
        if (!igw) return ec2Error('InvalidInternetGatewayID.NotFound', 'no such gateway');
        if (igw.vpcId) return ec2Error('DependencyViolation', `${id} is attached`);
        this.igws.delete(id);
        return ec2Response(action, el('return', true));
      }
      case 'DescribeRouteTables': {
        const found = [...this.routeTables.values()].filter((table) =>
          matches(table.tags, filters, (name) =>
            name === 'vpc-id'
              ? [table.vpcId]
              : name === 'association.main'
                ? [String(table.main)]
                : name === 'route-table-id'
                  ? [table.id]
                  : undefined,
          ),
        );
        return ec2Response(
          action,
          items(
            'routeTableSet',
            found.map(
              (table) =>
                `${el('routeTableId', table.id)}${el('vpcId', table.vpcId)}${items(
                  'routeSet',
                  table.routes.map(
                    (route) =>
                      `${el('destinationCidrBlock', route.destination)}${el('gatewayId', route.gatewayId)}${el('state', 'active')}`,
                  ),
                )}${items('associationSet', table.main ? [`${el('routeTableAssociationId', `rtbassoc-${table.id.slice(4)}`)}${el('routeTableId', table.id)}${el('main', true)}`] : [])}${tagSet(table.tags)}`,
            ),
          ),
        );
      }
      case 'CreateRoute':
      case 'ReplaceRoute': {
        const table = this.routeTables.get(p.get('RouteTableId') ?? '');
        if (!table) return ec2Error('InvalidRouteTableID.NotFound', 'no such route table');
        const destination = p.get('DestinationCidrBlock') ?? '';
        const gatewayId = p.get('GatewayId') ?? '';
        if (!this.igws.has(gatewayId) && !this.endpoints.has(gatewayId))
          return ec2Error(
            'InvalidGatewayID.NotFound',
            `The gateway ID '${gatewayId}' does not exist`,
          );
        const existing = table.routes.find((route) => route.destination === destination);
        if (action === 'CreateRoute') {
          if (existing)
            return ec2Error(
              'RouteAlreadyExists',
              `The route identified by ${destination} already exists.`,
            );
          table.routes.push({ destination, gatewayId });
        } else {
          if (!existing) return ec2Error('InvalidRoute.NotFound', 'no such route');
          existing.gatewayId = gatewayId;
        }
        return ec2Response(action, el('return', true));
      }

      // --- Subnets -------------------------------------------------------------------------------
      case 'CreateSubnet': {
        const vpc = this.vpcs.get(p.get('VpcId') ?? '');
        if (!vpc) return ec2Error('InvalidVpcID.NotFound', 'no such vpc');
        const cidr = p.get('CidrBlock') ?? '';
        const zone = p.get('AvailabilityZone') ?? 'us-east-1a';
        if (!this.ec2.zones.has(zone))
          return ec2Error(
            'InvalidParameterValue',
            `Value (${zone}) for parameter availabilityZone is invalid.`,
          );
        if (
          !validCidr(cidr) ||
          prefixOf(cidr) < 16 ||
          prefixOf(cidr) > 28 ||
          !vpc.cidrs.some((block) => block.state === 'associated' && contains(block.cidr, cidr))
        )
          return ec2Error('InvalidSubnet.Range', `The CIDR '${cidr}' is invalid.`);
        if ([...this.subnets.values()].some((s) => s.vpcId === vpc.id && overlaps(s.cidr, cidr)))
          return ec2Error(
            'InvalidSubnet.Conflict',
            `The CIDR '${cidr}' conflicts with another subnet`,
          );
        const subnet: EmuSubnet = {
          id: this.#id('subnet'),
          vpcId: vpc.id,
          cidr,
          zone,
          mapPublicIp: false,
          tags: tagsOf(p, 'subnet'),
        };
        this.subnets.set(subnet.id, subnet);
        return ec2Response(action, `<subnet>${this.#subnetXml(subnet)}</subnet>`);
      }
      case 'DescribeSubnets': {
        const ids = listOf(p, 'SubnetId');
        for (const id of ids)
          if (!this.subnets.has(id))
            return ec2Error('InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`);
        const found = [...this.subnets.values()].filter(
          (subnet) =>
            (ids.length === 0 || ids.includes(subnet.id)) &&
            matches(subnet.tags, filters, (name) =>
              name === 'vpc-id'
                ? [subnet.vpcId]
                : name === 'cidr-block'
                  ? [subnet.cidr]
                  : name === 'availability-zone'
                    ? [subnet.zone]
                    : name === 'subnet-id'
                      ? [subnet.id]
                      : undefined,
            ),
        );
        return ec2Response(
          action,
          items(
            'subnetSet',
            found.map((s) => this.#subnetXml(s)),
          ),
        );
      }
      case 'ModifySubnetAttribute': {
        const subnet = this.subnets.get(p.get('SubnetId') ?? '');
        if (!subnet) return ec2Error('InvalidSubnetID.NotFound', 'no such subnet');
        const value = p.get('MapPublicIpOnLaunch.Value');
        if (value !== null) subnet.mapPublicIp = value === 'true';
        return ec2Response(action, el('return', true));
      }
      case 'DeleteSubnet': {
        const id = p.get('SubnetId') ?? '';
        if (!this.subnets.has(id))
          return ec2Error('InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`);
        if (
          this.#liveInstances().some((instance) => instance.subnetId === id) ||
          this.serviceInterfaces.some((list) => list().some((eni) => eni.subnetId === id))
        )
          return ec2Error(
            'DependencyViolation',
            `The subnet '${id}' has dependencies and cannot be deleted.`,
          );
        this.subnets.delete(id);
        return ec2Response(action, el('return', true));
      }

      // --- Security groups ---------------------------------------------------------------------
      case 'CreateSecurityGroup': {
        const vpcId = p.get('VpcId') ?? '';
        if (!this.vpcs.has(vpcId)) return ec2Error('InvalidVpcID.NotFound', 'no such vpc');
        const name = p.get('GroupName') ?? '';
        if ([...this.groups.values()].some((group) => group.vpcId === vpcId && group.name === name))
          return ec2Error(
            'InvalidGroup.Duplicate',
            `The security group '${name}' already exists for VPC '${vpcId}'`,
          );
        const group: EmuSecurityGroup = {
          id: this.#id('sg'),
          vpcId,
          name,
          description: p.get('GroupDescription') ?? '',
          tags: tagsOf(p, 'security-group'),
        };
        this.groups.set(group.id, group);
        this.#defaultEgress(group.id);
        return ec2Response(
          action,
          `${el('return', true)}${el('groupId', group.id)}${tagSet(group.tags)}`,
        );
      }
      case 'DescribeSecurityGroups': {
        const ids = listOf(p, 'GroupId');
        for (const id of ids)
          if (!this.groups.has(id))
            return ec2Error('InvalidGroup.NotFound', `The security group '${id}' does not exist`);
        const found = [...this.groups.values()].filter(
          (group) =>
            (ids.length === 0 || ids.includes(group.id)) &&
            matches(group.tags, filters, (name) =>
              name === 'vpc-id'
                ? [group.vpcId]
                : name === 'group-name'
                  ? [group.name]
                  : name === 'group-id'
                    ? [group.id]
                    : undefined,
            ),
        );
        return ec2Response(
          action,
          items(
            'securityGroupInfo',
            found.map(
              (group) =>
                `${el('ownerId', '222222222222')}${el('groupId', group.id)}${el('groupName', group.name)}${el('groupDescription', group.description)}${el('vpcId', group.vpcId)}${tagSet(group.tags)}`,
            ),
          ),
        );
      }
      case 'DeleteSecurityGroup': {
        const id = p.get('GroupId') ?? '';
        const group = this.groups.get(id);
        if (!group)
          return ec2Error('InvalidGroup.NotFound', `The security group '${id}' does not exist`);
        if (group.name === 'default')
          return ec2Error('CannotDelete', 'the default security group cannot be deleted');
        if (
          this.#liveInstances().some((instance) => instance.groups.some((g) => g.id === id)) ||
          this.serviceInterfaces.some((list) => list().some((eni) => eni.groupIds.includes(id)))
        )
          return ec2Error('DependencyViolation', `resource ${id} has a dependent object`);
        // Another group's rule naming this one blocks the delete; a rule naming its own group does not.
        if ([...this.rules.values()].some((r) => r.referencedGroupId === id && r.groupId !== id))
          return ec2Error('DependencyViolation', `resource ${id} has a dependent object`);
        this.groups.delete(id);
        for (const [ruleId, rule] of this.rules) if (rule.groupId === id) this.rules.delete(ruleId);
        return ec2Response(action, el('return', true));
      }
      case 'AuthorizeSecurityGroupIngress':
      case 'AuthorizeSecurityGroupEgress': {
        const groupId = p.get('GroupId') ?? '';
        if (!this.groups.has(groupId))
          return ec2Error(
            'InvalidGroup.NotFound',
            `The security group '${groupId}' does not exist`,
          );
        const egress = action === 'AuthorizeSecurityGroupEgress';
        const tags = tagsOf(p, 'security-group-rule');
        const wanted: Omit<EmuRule, 'id' | 'tags'>[] = [];
        for (let n = 1; p.has(`IpPermissions.${n}.IpProtocol`); n++) {
          const protocol = ruleProtocol(p.get(`IpPermissions.${n}.IpProtocol`)!);
          const from = Number(p.get(`IpPermissions.${n}.FromPort`) ?? -1);
          const to = Number(p.get(`IpPermissions.${n}.ToPort`) ?? -1);
          if ((protocol === 'tcp' || protocol === 'udp') && (from < 0 || to > 65535 || from > to))
            return ec2Error('InvalidParameterValue', 'Invalid port range');
          const base = {
            groupId,
            egress,
            protocol,
            from: protocol === '-1' ? -1 : from,
            to: protocol === '-1' ? -1 : to,
          };
          for (let m = 1; p.has(`IpPermissions.${n}.IpRanges.${m}.CidrIp`); m++)
            wanted.push({ ...base, cidrIpv4: p.get(`IpPermissions.${n}.IpRanges.${m}.CidrIp`)! });
          for (let m = 1; p.has(`IpPermissions.${n}.Ipv6Ranges.${m}.CidrIpv6`); m++)
            wanted.push({
              ...base,
              cidrIpv6: p.get(`IpPermissions.${n}.Ipv6Ranges.${m}.CidrIpv6`)!,
            });
          for (let m = 1; p.has(`IpPermissions.${n}.Groups.${m}.GroupId`); m++) {
            const referenced = p.get(`IpPermissions.${n}.Groups.${m}.GroupId`)!;
            if (!this.groups.has(referenced))
              return ec2Error(
                'InvalidGroup.NotFound',
                `The security group '${referenced}' does not exist`,
              );
            wanted.push({ ...base, referencedGroupId: referenced });
          }
        }
        const same = (a: Omit<EmuRule, 'id' | 'tags'>, b: Omit<EmuRule, 'id' | 'tags'>) =>
          a.groupId === b.groupId &&
          a.egress === b.egress &&
          a.protocol === b.protocol &&
          a.from === b.from &&
          a.to === b.to &&
          a.cidrIpv4 === b.cidrIpv4 &&
          a.cidrIpv6 === b.cidrIpv6 &&
          a.referencedGroupId === b.referencedGroupId;
        if (wanted.some((rule) => [...this.rules.values()].some((have) => same(have, rule))))
          return ec2Error('InvalidPermission.Duplicate', 'the specified rule already exists');
        const count = [...this.rules.values()].filter(
          (rule) => rule.groupId === groupId && rule.egress === egress,
        ).length;
        if (count + wanted.length > this.ruleLimit)
          return ec2Error(
            'RulesPerSecurityGroupLimitExceeded',
            'The maximum number of rules per security group has been reached.',
          );
        const created = wanted.map((rule) => {
          const full: EmuRule = { ...rule, id: this.#id('sgr'), tags: new Map(tags) };
          this.rules.set(full.id, full);
          return full;
        });
        return ec2Response(
          action,
          `${el('return', true)}${items(
            'securityGroupRuleSet',
            created.map((rule) => this.#ruleXml(rule)),
          )}`,
        );
      }
      case 'RevokeSecurityGroupIngress':
      case 'RevokeSecurityGroupEgress': {
        const groupId = p.get('GroupId') ?? '';
        if (!this.groups.has(groupId))
          return ec2Error(
            'InvalidGroup.NotFound',
            `The security group '${groupId}' does not exist`,
          );
        const ids = listOf(p, 'SecurityGroupRuleId');
        const egress = action === 'RevokeSecurityGroupEgress';
        for (const id of ids) {
          const rule = this.rules.get(id);
          if (!rule || rule.groupId !== groupId || rule.egress !== egress)
            return ec2Error(
              'InvalidSecurityGroupRuleId.NotFound',
              `The security group rule ID '${id}' does not exist`,
            );
        }
        for (const id of ids) this.rules.delete(id);
        return ec2Response(action, el('return', true));
      }
      case 'DescribeSecurityGroupRules': {
        const ids = listOf(p, 'SecurityGroupRuleId');
        const all = [...this.rules.values()].filter(
          (rule) =>
            (ids.length === 0 || ids.includes(rule.id)) &&
            matches(rule.tags, filters, (name) =>
              name === 'group-id'
                ? [rule.groupId]
                : name === 'security-group-rule-id'
                  ? [rule.id]
                  : undefined,
            ),
        );
        const start = Number(p.get('NextToken')?.replace(/^tok-/, '') ?? '0');
        const max = Math.min(Number(p.get('MaxResults') ?? 1000), this.pageSize);
        const page = all.slice(start, start + max);
        const next = start + max < all.length ? `tok-${start + max}` : undefined;
        return ec2Response(
          action,
          items(
            'securityGroupRuleSet',
            page.map((rule) => this.#ruleXml(rule)),
          ) + el('nextToken', next),
        );
      }

      // --- Network ACLs --------------------------------------------------------------------------
      case 'DescribeNetworkAcls': {
        const ids = listOf(p, 'NetworkAclId');
        const found = [...this.nacls.values()].filter(
          (acl) =>
            (ids.length === 0 || ids.includes(acl.id)) &&
            matches(acl.tags, filters, (name) =>
              name === 'vpc-id'
                ? [acl.vpcId]
                : name === 'default'
                  ? [String(acl.isDefault)]
                  : name === 'network-acl-id'
                    ? [acl.id]
                    : undefined,
            ),
        );
        return ec2Response(
          action,
          items(
            'networkAclSet',
            found.map((acl) => this.#naclXml(acl)),
          ),
        );
      }
      case 'CreateNetworkAclEntry':
      case 'ReplaceNetworkAclEntry': {
        const acl = this.nacls.get(p.get('NetworkAclId') ?? '');
        if (!acl) return ec2Error('InvalidNetworkAclID.NotFound', 'no such network ACL');
        const number = Number(p.get('RuleNumber'));
        const egress = p.get('Egress') === 'true';
        if (!Number.isInteger(number) || number < 1 || number > 32766)
          return ec2Error('InvalidParameterValue', 'rule number must be 1-32766');
        const protocol = p.get('Protocol') ?? '';
        const action_ = p.get('RuleAction');
        if (action_ !== 'allow' && action_ !== 'deny')
          return ec2Error('InvalidParameterValue', 'RuleAction is allow or deny');
        const cidr = p.get('CidrBlock') ?? undefined;
        const ipv6Cidr = p.get('Ipv6CidrBlock') ?? undefined;
        if ((cidr === undefined) === (ipv6Cidr === undefined))
          return ec2Error('InvalidParameterCombination', 'one of CidrBlock and Ipv6CidrBlock');
        const ported = protocol === '6' || protocol === '17';
        if (ported && !p.has('PortRange.From'))
          return ec2Error('MissingParameter', 'TCP and UDP entries need a PortRange');
        const entry: EmuNaclEntry = {
          number,
          egress,
          protocol,
          action: action_,
          ...(cidr !== undefined ? { cidr } : {}),
          ...(ipv6Cidr !== undefined ? { ipv6Cidr } : {}),
          ...(ported
            ? { from: Number(p.get('PortRange.From')), to: Number(p.get('PortRange.To')) }
            : {}),
        };
        const index = acl.entries.findIndex((e) => e.number === number && e.egress === egress);
        if (action === 'CreateNetworkAclEntry') {
          if (index !== -1)
            return ec2Error(
              'NetworkAclEntryAlreadyExists',
              `The network acl entry identified by ${number} already exists.`,
            );
          if (acl.entries.filter((e) => e.egress === egress).length >= this.naclEntryLimit)
            return ec2Error(
              'NetworkAclEntryLimitExceeded',
              'The maximum number of network acl entries has been reached.',
            );
          acl.entries.push(entry);
        } else {
          if (index === -1) return ec2Error('InvalidNetworkAclEntry.NotFound', 'no such entry');
          acl.entries[index] = entry;
        }
        acl.entries.sort((a, b) => a.number - b.number);
        return ec2Response(action, el('return', true));
      }
      case 'DeleteNetworkAclEntry': {
        const acl = this.nacls.get(p.get('NetworkAclId') ?? '');
        if (!acl) return ec2Error('InvalidNetworkAclID.NotFound', 'no such network ACL');
        const number = Number(p.get('RuleNumber'));
        const egress = p.get('Egress') === 'true';
        const index = acl.entries.findIndex((e) => e.number === number && e.egress === egress);
        if (index === -1)
          return ec2Error(
            'InvalidNetworkAclEntry.NotFound',
            `The network acl entry identified by ${number} does not exist.`,
          );
        acl.entries.splice(index, 1);
        return ec2Response(action, el('return', true));
      }

      // --- Gateway endpoints -------------------------------------------------------------------
      case 'CreateVpcEndpoint': {
        const vpcId = p.get('VpcId') ?? '';
        if (!this.vpcs.has(vpcId)) return ec2Error('InvalidVpcID.NotFound', 'no such vpc');
        if (p.get('VpcEndpointType') !== 'Gateway')
          return ec2Error('InvalidParameterValue', 'the emulator knows gateway endpoints only');
        const service = p.get('ServiceName') ?? '';
        if (!/^com\.amazonaws\.[a-z0-9-]+\.(s3|dynamodb)$/.test(service))
          return ec2Error(
            'InvalidServiceName',
            `The Vpc Endpoint Service '${service}' does not exist`,
          );
        if ([...this.endpoints.values()].some((e) => e.vpcId === vpcId && e.service === service))
          return ec2Error(
            'RouteAlreadyExists',
            'an endpoint for the service already routes this table',
          );
        const endpoint: EmuEndpoint = {
          id: this.#id('vpce'),
          vpcId,
          service,
          routeTableIds: listOf(p, 'RouteTableId'),
          tags: tagsOf(p, 'vpc-endpoint'),
        };
        this.endpoints.set(endpoint.id, endpoint);
        return ec2Response(action, `<vpcEndpoint>${this.#endpointXml(endpoint)}</vpcEndpoint>`);
      }
      case 'DescribeVpcEndpoints': {
        const found = [...this.endpoints.values()].filter((endpoint) =>
          matches(endpoint.tags, filters, (name) =>
            name === 'vpc-id'
              ? [endpoint.vpcId]
              : name === 'service-name'
                ? [endpoint.service]
                : name === 'vpc-endpoint-type'
                  ? ['Gateway']
                  : undefined,
          ),
        );
        return ec2Response(
          action,
          items(
            'vpcEndpointSet',
            found.map((e) => this.#endpointXml(e)),
          ),
        );
      }
      case 'DeleteVpcEndpoints': {
        const unsuccessful: string[] = [];
        for (const id of listOf(p, 'VpcEndpointId')) {
          if (!this.endpoints.delete(id))
            unsuccessful.push(
              `${el('resourceId', id)}<error>${el('code', 'InvalidVpcEndpoint.NotFound')}${el('message', 'not found')}</error>`,
            );
        }
        return ec2Response(action, items('unsuccessful', unsuccessful));
      }

      // --- Instances -----------------------------------------------------------------------------
      case 'DescribeNetworkInterfaces': {
        const ids = listOf(p, 'NetworkInterfaceId');
        const found = this.#enis().filter(
          ({ id, instance }) =>
            (ids.length === 0 || ids.includes(id)) &&
            matches(instance.eniTags, filters, (name) =>
              name === 'network-interface-id'
                ? [id]
                : name === 'group-id'
                  ? instance.groups.map((g) => g.id)
                  : name === 'vpc-id'
                    ? [instance.vpcId]
                    : name === 'attachment.instance-id'
                      ? [instance.id]
                      : undefined,
            ),
        );
        for (const id of ids)
          if (!found.some((eni) => eni.id === id))
            return ec2Error(
              'InvalidNetworkInterfaceID.NotFound',
              `The networkInterface ID '${id}' does not exist`,
            );
        return ec2Response(
          action,
          items(
            'networkInterfaceSet',
            found.map(
              ({ id, instance }) =>
                `${el('networkInterfaceId', id)}${el('vpcId', instance.vpcId)}${el('subnetId', instance.subnetId)}<attachment>${el('instanceId', instance.id)}${el('deviceIndex', 0)}</attachment>${items(
                  'groupSet',
                  instance.groups.map((g) => `${el('groupId', g.id)}${el('groupName', g.name)}`),
                )}${tagSet(instance.eniTags)}`,
            ),
          ),
        );
      }
      case 'ModifyNetworkInterfaceAttribute': {
        const eni = this.#enis().find(({ id }) => id === p.get('NetworkInterfaceId'));
        if (!eni) return ec2Error('InvalidNetworkInterfaceID.NotFound', 'no such interface');
        return this.#setGroups(eni.instance, listOf(p, 'SecurityGroupId'), action);
      }
      case 'ModifyInstanceAttribute': {
        const instance = this.ec2.instances.get(p.get('InstanceId') ?? '');
        if (!instance) return ec2Error('InvalidInstanceID.NotFound', 'no such instance');
        const ids = listOf(p, 'GroupId');
        if (ids.length === 0) return this.#inner.handle(request);
        if ((instance.interfaces ?? 1) > 1)
          return ec2Error(
            'InvalidInstanceID',
            `There are multiple interfaces attached to instance '${instance.id}'. Please specify an interface ID for the operation instead.`,
          );
        return this.#setGroups(instance, ids, action);
      }
      case 'RunInstances':
        return this.#run(request);
      case 'CreateTags':
      case 'DeleteTags': {
        const ids = listOf(p, 'ResourceId');
        if (ids.every((id) => id.startsWith('i-'))) return this.#inner.handle(request);
        for (const id of ids)
          if (!this.#taggable(id)) return ec2Error('InvalidID', `The ID '${id}' is not valid`);
        for (const id of ids) {
          const tags = this.#taggable(id)!;
          for (let n = 1; p.has(`Tag.${n}.Key`); n++) {
            const key = p.get(`Tag.${n}.Key`)!;
            if (action === 'CreateTags') tags.set(key, p.get(`Tag.${n}.Value`) ?? '');
            else {
              const value = p.get(`Tag.${n}.Value`);
              if (value === null || tags.get(key) === value) tags.delete(key);
            }
          }
        }
        return ec2Response(action, el('return', true));
      }
      default:
        return this.#inner.handle(request);
    }
  }

  /** The security groups of an instance's primary interface (ModifyInstanceAttribute or the ENI's). */
  #setGroups(
    instance: { vpcId: string; groups: { id: string; name: string }[] },
    ids: string[],
    action: string,
  ): Response {
    if (ids.length > this.groupsPerInterface)
      return ec2Error(
        'SecurityGroupsPerInstanceLimitExceeded',
        'The maximum number of security groups per interface has been reached.',
      );
    const groups = [];
    for (const id of ids) {
      const group = this.groups.get(id);
      if (!group)
        return ec2Error('InvalidGroup.NotFound', `The security group '${id}' does not exist`);
      if (group.vpcId !== instance.vpcId)
        return ec2Error(
          'InvalidGroup.NotFound',
          `The security group '${id}' does not exist in VPC '${instance.vpcId}'`,
        );
      groups.push({ id: group.id, name: group.name });
    }
    instance.groups = groups;
    return ec2Response(action, el('return', true));
  }

  #endpointXml(endpoint: EmuEndpoint): string {
    return [
      el('vpcEndpointId', endpoint.id),
      el('vpcEndpointType', 'Gateway'),
      el('vpcId', endpoint.vpcId),
      el('serviceName', endpoint.service),
      el('state', 'available'),
      items(
        'routeTableIdSet',
        endpoint.routeTableIds.map((id) => id),
      ),
      tagSet(endpoint.tags),
    ].join('');
  }

  async #run(request: EmulatorRequest): Promise<Response> {
    const p = request.params;
    const subnetId = p.get('NetworkInterface.1.SubnetId');
    const subnet = subnetId ? this.subnets.get(subnetId) : undefined;
    const groupIds = listOf(p, 'NetworkInterface.1.SecurityGroupId');
    if (subnet) {
      const zone = p.get('Placement.AvailabilityZone');
      if (zone && zone !== subnet.zone)
        return ec2Error(
          'InvalidParameterValue',
          `subnet ${subnet.id} is in ${subnet.zone}, not ${zone}`,
        );
      for (const id of groupIds) {
        const group = this.groups.get(id);
        if (!group || group.vpcId !== subnet.vpcId)
          return ec2Error(
            'InvalidGroup.NotFound',
            `The security group '${id}' does not exist in VPC '${subnet.vpcId}'`,
          );
      }
    }
    const response = await this.#inner.handle(request);
    if (!subnet || response.status !== 200) return response;
    const token = p.get('ClientToken');
    const instances = [...this.ec2.instances.values()];
    const instance = token
      ? instances.find((candidate) => candidate.clientToken === token)
      : instances[instances.length - 1];
    if (instance) {
      instance.vpcId = subnet.vpcId;
      const groups = groupIds.length
        ? groupIds.map((id) => this.groups.get(id)!)
        : [
            [...this.groups.values()].find(
              (g) => g.vpcId === subnet.vpcId && g.name === 'default',
            )!,
          ];
      instance.groups = groups.map((group) => ({ id: group.id, name: group.name }));
    }
    // The response was rendered before the patch; later reads show the VPC and groups.
    return response;
  }
}
