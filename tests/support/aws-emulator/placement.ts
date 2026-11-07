import type { AwsEmulator, EmulatorRequest } from './index.js';
import type { Ec2Emulator, EmuInstance } from './ec2.js';
import { ec2Error, ec2Response, el, items } from './xml.js';

// EC2's ML fabric as provider-aws uses it (AWS A10): placement groups (CreatePlacementGroup,
// DescribePlacementGroups, launches with Placement.GroupName / PartitionNumber) and the instance
// topology (DescribeInstanceTopology). It plugs into Ec2Emulator through its `extra` operations
// and `runHooks`, as capacity.ts does.

export interface EmuPlacementGroup {
  name: string;
  id: string;
  strategy: 'cluster' | 'spread' | 'partition';
  partitionCount?: number;
  state: 'pending' | 'available' | 'deleting' | 'deleted';
  tags: Map<string, string>;
  /** DescribePlacementGroups calls that do not show it yet (eventual consistency). */
  hiddenReads?: number;
}

/** TagSpecification.N with ResourceType `type` → its tags. */
function tagsOf(params: URLSearchParams, type: string): Map<string, string> {
  const tags = new Map<string, string>();
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

function filterValues(params: URLSearchParams, name: string): string[] | undefined {
  for (let n = 1; params.has(`Filter.${n}.Name`); n++) {
    if (params.get(`Filter.${n}.Name`) !== name) continue;
    const values: string[] = [];
    for (let m = 1; params.has(`Filter.${n}.Value.${m}`); m++)
      values.push(params.get(`Filter.${n}.Value.${m}`)!);
    return values;
  }
  return undefined;
}

export class PlacementEmulator {
  readonly groups = new Map<string, EmuPlacementGroup>();
  /** instance id → the group (and partition) it launched into. */
  readonly members = new Map<string, { group: string; partition?: number }>();
  /** instance id → its network nodes, top (1) to bottom (3), as DescribeInstanceTopology reports. */
  readonly topology = new Map<string, string[]>();
  /** Instance types DescribeInstanceTopology covers (others are left out of its answer). */
  readonly topologyTypes = new Set(['p5.48xlarge', 'trn1.32xlarge']);
  /** Fail the next calls of an operation with an error code. */
  readonly failNext = new Map<string, string>();
  readonly calls: { action: string; params: URLSearchParams }[] = [];
  #next = 0;

  constructor(
    private readonly emu: AwsEmulator,
    private readonly ec2: Ec2Emulator,
  ) {
    for (const action of [
      'CreatePlacementGroup',
      'DescribePlacementGroups',
      'DescribeInstanceTopology',
    ] as const)
      ec2.extra.set(action, (request) => {
        this.calls.push({ action, params: request.params });
        const failure = this.failNext.get(action);
        if (failure) {
          this.failNext.delete(action);
          return ec2Error(failure, `injected ${failure}`);
        }
        if (action === 'CreatePlacementGroup') return this.#create(request);
        if (action === 'DescribePlacementGroups') return this.#describe(request);
        return this.#topology(request);
      });
    ec2.runHooks.push({
      check: (params) => {
        // EFA (A10): EC2 takes a public address only with one interface, and EFA only on EFA types.
        let interfaces = 0;
        for (let n = 1; params.has(`NetworkInterface.${n}.DeviceIndex`); n++) {
          interfaces = n;
          if (
            params.get(`NetworkInterface.${n}.InterfaceType`) === 'efa' &&
            this.ec2.types.get(params.get('InstanceType') ?? '')?.efa === undefined
          )
            return ec2Error('InvalidParameterCombination', 'EFA is not supported on this type');
        }
        if (
          interfaces > 1 &&
          [...params].some(
            ([key, value]) => key.endsWith('.AssociatePublicIpAddress') && value === 'true',
          )
        )
          return ec2Error(
            'InvalidParameterCombination',
            'The associatePublicIPAddress parameter cannot be specified when launching with multiple network interfaces.',
          );
        const name = params.get('Placement.GroupName');
        if (name === null) return undefined;
        const group = this.groups.get(name);
        if (!group || group.state !== 'available')
          return ec2Error(
            'InvalidPlacementGroup.Unknown',
            `The Placement Group '${name}' is unknown.`,
          );
        const partition = params.get('Placement.PartitionNumber');
        if (partition !== null) {
          if (group.strategy !== 'partition')
            return ec2Error(
              'InvalidParameterCombination',
              'PartitionNumber is only valid for partition placement groups',
            );
          const number = Number(partition);
          if (!Number.isInteger(number) || number < 1 || number > (group.partitionCount ?? 0))
            return ec2Error('InvalidParameterValue', `Invalid partition number ${partition}`);
        }
        if (
          params.has(
            'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId',
          )
        )
          return ec2Error(
            'InvalidParameterCombination',
            'A placement group cannot be combined with a capacity reservation target here',
          );
        return undefined;
      },
      launched: (instance, params) => {
        const name = params.get('Placement.GroupName');
        if (name === null) return;
        const partition = params.get('Placement.PartitionNumber');
        this.members.set(instance.id, {
          group: name,
          ...(partition !== null ? { partition: Number(partition) } : {}),
        });
      },
    });
  }

  /** A group that exists in the account already (made by someone else unless `tags` say so). */
  add(group: Partial<EmuPlacementGroup> & { name: string }): EmuPlacementGroup {
    const made: EmuPlacementGroup = {
      id: `pg-${(++this.#next).toString(16).padStart(17, '0')}`,
      strategy: 'cluster',
      state: 'available',
      tags: new Map(),
      ...group,
    };
    this.groups.set(made.name, made);
    return made;
  }

  #xml(group: EmuPlacementGroup): string {
    return [
      el('groupName', group.name),
      el('groupId', group.id),
      el('state', group.state),
      el('strategy', group.strategy),
      el('partitionCount', group.partitionCount),
      items(
        'tagSet',
        [...group.tags].map(([key, value]) => `${el('key', key)}${el('value', value)}`),
      ),
    ].join('');
  }

  #create(request: EmulatorRequest): Response {
    const p = request.params;
    const name = p.get('GroupName') ?? '';
    const strategy = p.get('Strategy') ?? '';
    if (!/^[\x20-\x7e]{1,255}$/.test(name))
      return ec2Error('InvalidParameterValue', 'Invalid placement group name');
    if (strategy !== 'cluster' && strategy !== 'spread' && strategy !== 'partition')
      return ec2Error('InvalidParameterValue', `Invalid strategy ${strategy}`);
    const count = p.get('PartitionCount');
    if (count !== null && strategy !== 'partition')
      return ec2Error('InvalidParameterCombination', 'PartitionCount needs strategy partition');
    if (this.groups.has(name))
      return ec2Error(
        'InvalidPlacementGroup.Duplicate',
        `The placement group '${name}' already exists.`,
      );
    const group = this.add({
      name,
      strategy,
      ...(strategy === 'partition' ? { partitionCount: count === null ? 2 : Number(count) } : {}),
      tags: tagsOf(p, 'placement-group'),
    });
    return ec2Response(
      'CreatePlacementGroup',
      `<placementGroup>${this.#xml(group)}</placementGroup>`,
    );
  }

  #describe(request: EmulatorRequest): Response {
    const names = filterValues(request.params, 'group-name');
    const shown = [...this.groups.values()].filter((group) => {
      if (names && !names.includes(group.name)) return false;
      if (group.hiddenReads && group.hiddenReads > 0) {
        group.hiddenReads -= 1;
        return false;
      }
      return true;
    });
    return ec2Response(
      'DescribePlacementGroups',
      items(
        'placementGroupSet',
        shown.map((group) => this.#xml(group)),
      ),
    );
  }

  #topology(request: EmulatorRequest): Response {
    const p = request.params;
    const ids: string[] = [];
    for (let n = 1; p.has(`InstanceId.${n}`); n++) ids.push(p.get(`InstanceId.${n}`)!);
    if (ids.length > 100) return ec2Error('InvalidParameterValue', 'at most 100 instance ids');
    const found = ids
      .map((id) => this.ec2.instances.get(id))
      .filter(
        (instance): instance is EmuInstance =>
          instance !== undefined &&
          instance.state === 'running' &&
          this.topologyTypes.has(instance.type) &&
          this.topology.has(instance.id),
      );
    return ec2Response(
      'DescribeInstanceTopology',
      items(
        'instanceSet',
        found.map(
          (instance) =>
            `${el('instanceId', instance.id)}${el('instanceType', instance.type)}${el('groupName', this.members.get(instance.id)?.group)}${items(
              'networkNodeSet',
              this.topology.get(instance.id)!.map((node) => node.replace(/[<&>]/g, '')),
            )}${el('availabilityZone', instance.zone)}${el('zoneId', this.ec2.zones.get(instance.zone))}`,
        ),
      ),
    );
  }

  get now(): number {
    return this.emu.now();
  }
}
