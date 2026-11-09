import {
  ComputeError,
  isComputeError,
  type Clock,
  type Logger,
  type ProviderPlacement,
} from '@better-compute/core';
import type { QueryParams, XmlElement } from '@better-compute/aws-core';
import type { IamStatement } from './cli.js';
import { ReadConsistency } from './consistency.js';
import { tags } from './ids.js';

// EC2 placement groups (AWS A10). A create that asks for a placement launches into the named group,
// which provider-aws makes on first use (tagged `better-compute:managed=true`). A group with that
// name that better-compute did not make is refused, never adopted: its machines are someone else's
// and its strategy is theirs to pick. Groups it made are deleted again once no instance uses them
// (`sweep`): an account holds a limited number of them, and nothing else ever removes one.

/** Partitions a partition group gets: EC2's maximum per Availability Zone. */
export const placementPartitions = 7;
/**
 * How long a group this client made or read stays trusted without another read. A group that went
 * away meanwhile (deleted by hand, or swept by another replica) is found out by the launch itself:
 * `InvalidPlacementGroup.Unknown` drops the entry (`forget`) and the group is ensured again.
 */
const knownTtlMs = 3_600_000;
/** At most one sweep of an account's placement groups in this long. */
export const placementSweepMs = 10 * 60_000;
/** After a sweep the account's policy does not allow: when it is tried again. */
const sweepDeniedBackoffMs = 3_600_000;
/** Instances in these states hold their placement group (a terminated one does not). */
const memberStates = ['pending', 'running', 'stopping', 'stopped', 'shutting-down'];
/** The EC2 code of a launch into (or a delete of) a placement group that does not exist. */
export const unknownPlacementGroup = 'InvalidPlacementGroup.Unknown';

const groupName = /^[A-Za-z0-9._-]{1,255}$/;
const strategies: ReadonlySet<string> = new Set(['cluster', 'spread', 'partition']);

function invalid(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, { provider: 'aws', reason });
}

/** Checks a placement's shape; `INVALID_INPUT` (reasons `placement-*`) before any call. */
export function checkPlacement(placement: ProviderPlacement): void {
  const { group, strategy, partition } = placement;
  if (typeof group !== 'string' || !groupName.test(group))
    throw invalid(
      'a placement group name is 1 to 255 characters of letters, digits, ".", "_" and "-"',
      'placement-group',
    );
  if (typeof strategy !== 'string' || !strategies.has(strategy))
    throw invalid('a placement strategy is cluster, spread or partition', 'placement-strategy');
  if (partition === undefined) return;
  if (strategy !== 'partition')
    throw invalid('only a partition placement names a partition', 'placement-partition');
  if (!Number.isInteger(partition) || partition < 1 || partition > placementPartitions)
    throw invalid(`a partition is 1 to ${placementPartitions}`, 'placement-partition');
}

/** The RunInstances `Placement` members a placement adds. */
export function placementParams(placement: ProviderPlacement): QueryParams {
  return {
    GroupName: placement.group,
    ...(placement.partition !== undefined ? { PartitionNumber: placement.partition } : {}),
  };
}

type Call = (action: string, params: QueryParams, signal: AbortSignal) => Promise<XmlElement>;

interface GroupInfo {
  strategy: string;
  state: string;
  managed: boolean;
}

function readGroup(item: XmlElement): GroupInfo {
  return {
    strategy: item.textOf('strategy') ?? '',
    state: item.textOf('state') ?? '',
    managed: item
      .items('tagSet')
      .some((tag) => tag.textOf('key') === tags.managed && tag.textOf('value') === 'true'),
  };
}

/**
 * Placement groups of one account: made on first use, checked, remembered for an hour, and deleted
 * once nothing uses them.
 */
export class PlacementGroups {
  readonly #known = new Map<string, { strategy: string; at: number }>();
  /** Group name → when a sweep first saw it without an instance. */
  readonly #unused = new Map<string, number>();
  readonly #lag: ReadConsistency;
  #sweptAt: number | undefined;
  #sweepRetryAt: number | undefined;
  readonly #warned = new Set<string>();

  constructor(
    private readonly call: Call,
    private readonly clock: Clock,
    /** How long EC2 may not show an instance that was just launched into a group. */
    consistencyWindowMs: number | (() => number) = 120_000,
  ) {
    this.#lag = new ReadConsistency(clock, consistencyWindowMs);
  }

  /** Drops what is remembered of `group`: the next `ensure` reads it (and makes it if it is gone). */
  forget(group: string): void {
    this.#known.delete(group);
  }

  /**
   * Deletes the placement groups better-compute made that no instance uses, and returns their
   * names. Only groups tagged `better-compute:managed=true` are ever looked at (the filter, and
   * the tag read again on each item): a group found by name alone is someone else's. A group is
   * deleted only when two sweeps, at least the consistency window apart, both saw it without an
   * instance, and this client did not make or read it inside the window: a launch into it that EC2
   * does not show yet keeps it. EC2 refuses to delete a group in use anyway, which leaves it for a
   * later sweep; a launch that loses the race to a delete gets `InvalidPlacementGroup.Unknown` and
   * makes the group again.
   */
  async sweep(signal: AbortSignal): Promise<string[]> {
    return this.#deleteUnused(await this.#managed(signal), signal);
  }

  /** The names of the available groups better-compute made. */
  async #managed(signal: AbortSignal): Promise<string[]> {
    const doc = await this.call(
      'DescribePlacementGroups',
      { Filter: [{ Name: `tag:${tags.managed}`, Value: ['true'] }] },
      signal,
    );
    return doc
      .items('placementGroupSet')
      .filter((item) => item.textOf('state') === 'available' && readGroup(item).managed)
      .map((item) => item.textOf('groupName') ?? '')
      .filter((name) => groupName.test(name));
  }

  async #deleteUnused(names: readonly string[], signal: AbortSignal): Promise<string[]> {
    const now = this.clock.now();
    const used = new Set<string>();
    for (let start = 0; start < names.length; start += 200) {
      let token: string | undefined;
      const seen = new Set<string>();
      do {
        const instances = await this.call(
          'DescribeInstances',
          {
            Filter: [
              { Name: 'placement-group-name', Value: names.slice(start, start + 200) },
              { Name: 'instance-state-name', Value: memberStates },
            ],
            MaxResults: 1000,
            NextToken: token,
          },
          signal,
        );
        for (const reservation of instances.items('reservationSet'))
          for (const instance of reservation.items('instancesSet')) {
            const group = instance.child('placement')?.textOf('groupName');
            if (group) used.add(group);
          }
        token = instances.textOf('nextToken') || undefined;
        if (token && seen.has(token)) break;
        if (token) seen.add(token);
      } while (token);
    }
    // Groups gone some other way are forgotten.
    for (const name of [...this.#unused.keys()])
      if (!names.includes(name)) this.#unused.delete(name);
    const deleted: string[] = [];
    for (const name of names) {
      if (used.has(name)) {
        this.#unused.delete(name);
        continue;
      }
      const since = this.#unused.get(name);
      if (since === undefined) {
        this.#unused.set(name, now);
        continue;
      }
      if (this.#lag.recent(since) || this.#lag.recent(this.#known.get(name)?.at)) continue;
      try {
        await this.call('DeletePlacementGroup', { GroupName: name }, signal);
        deleted.push(name);
      } catch (error) {
        const code = isComputeError(error) ? error.details?.code : undefined;
        // Gone already, or in use after all: a later sweep looks again.
        if (
          code !== unknownPlacementGroup &&
          code !== 'InvalidPlacementGroup.InUse' &&
          !isComputeError(error, 'NOT_FOUND') &&
          !isComputeError(error, 'INVALID_STATE')
        )
          throw error;
      }
      this.#unused.delete(name);
      this.#known.delete(name);
    }
    return deleted;
  }

  /**
   * `sweep`, at most once every `placementSweepMs`, for a periodic caller: a sweep that fails is
   * logged and never the caller's error (an account whose policy does not allow it is tried again
   * in an hour).
   */
  async sweepWhenDue(signal: AbortSignal, log: Logger): Promise<void> {
    const now = this.clock.now();
    if (this.#sweptAt !== undefined && now - this.#sweptAt < placementSweepMs) return;
    if (this.#sweepRetryAt !== undefined && now < this.#sweepRetryAt) return;
    this.#sweptAt = now;
    this.#sweepRetryAt = undefined;
    try {
      let names: string[];
      try {
        names = await this.#managed(signal);
      } catch (error) {
        if (!isComputeError(error, 'ACCESS_DENIED')) throw error;
        // An account without the A10 policy cannot have made a group either: nothing to sweep and
        // nothing to tell its operator, who may not use placement groups at all.
        this.#sweepRetryAt = now + sweepDeniedBackoffMs;
        log.debug('aws: placement groups are not readable (no A10 policy); none are swept', {
          provider: 'aws',
        });
        return;
      }
      const deleted = await this.#deleteUnused(names, signal);
      if (deleted.length)
        log.info('aws: deleted placement groups no instance uses', {
          provider: 'aws',
          groups: deleted.slice(0, 50),
        });
    } catch (error) {
      if (signal.aborted) return;
      const code = isComputeError(error) ? error.code : 'error';
      if (code === 'ACCESS_DENIED') this.#sweepRetryAt = now + sweepDeniedBackoffMs;
      if (this.#warned.has(code)) return;
      this.#warned.add(code);
      log.warn(
        code === 'ACCESS_DENIED'
          ? 'aws: the account may not delete its unused placement groups (ec2:DeletePlacementGroup, ec2:DescribeInstances); they stay until the policy of `aws iam-policy --phases A10` is applied again'
          : 'aws: sweeping unused placement groups failed',
        {
          provider: 'aws',
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        },
      );
    }
  }

  /**
   * The group exists, is better-compute's, is available and has the asked strategy; makes it when
   * absent. `CONFLICT` for a foreign group or another strategy, `UNAVAILABLE` while EC2 settles.
   */
  async ensure(placement: ProviderPlacement, signal: AbortSignal): Promise<void> {
    const now = this.clock.now();
    const known = this.#known.get(placement.group);
    if (known && now - known.at < knownTtlMs && known.strategy === placement.strategy) return;
    let found = await this.#read(placement.group, signal);
    if (!found) {
      try {
        await this.call(
          'CreatePlacementGroup',
          {
            GroupName: placement.group,
            Strategy: placement.strategy,
            ...(placement.strategy === 'partition' ? { PartitionCount: placementPartitions } : {}),
            TagSpecification: [
              {
                ResourceType: 'placement-group',
                Tag: [{ Key: tags.managed, Value: 'true' }],
              },
            ],
          },
          signal,
        );
        this.#known.set(placement.group, { strategy: placement.strategy, at: now });
        return;
      } catch (error) {
        if (!isComputeError(error, 'CONFLICT')) throw error;
        // Made since the read (a concurrent create, or one whose answer was lost): read it again
        // and check it like any other group. One EC2 does not show yet is never launched into.
        found = await this.#read(placement.group, signal);
        if (!found)
          throw new ComputeError(
            'UNAVAILABLE',
            `placement group ${placement.group} exists but EC2 does not show it yet`,
            undefined,
            { provider: 'aws', reason: 'placement-group-propagating' },
          );
      }
    }
    if (!found.managed)
      throw new ComputeError(
        'CONFLICT',
        `placement group ${placement.group} was not made by better-compute`,
        undefined,
        { provider: 'aws', reason: 'placement-group-foreign' },
      );
    if (found.strategy !== placement.strategy)
      throw new ComputeError(
        'CONFLICT',
        `placement group ${placement.group} is a ${found.strategy || 'unknown'} group, not ${placement.strategy}`,
        undefined,
        { provider: 'aws', reason: 'placement-strategy' },
      );
    if (found.state !== 'available' && found.state !== 'pending')
      throw new ComputeError(
        'UNAVAILABLE',
        `placement group ${placement.group} is ${found.state || 'in an unknown state'}`,
        undefined,
        { provider: 'aws', reason: 'placement-group-deleting' },
      );
    if (found.state === 'available')
      this.#known.set(placement.group, { strategy: found.strategy, at: now });
  }

  async #read(name: string, signal: AbortSignal): Promise<GroupInfo | undefined> {
    const doc = await this.call(
      'DescribePlacementGroups',
      { Filter: [{ Name: 'group-name', Value: [name] }] },
      signal,
    );
    const item = doc
      .items('placementGroupSet')
      .find((group) => group.textOf('groupName') === name && group.textOf('state') !== 'deleted');
    return item ? readGroup(item) : undefined;
  }
}

/**
 * (A10) The IAM statements placement groups and topology need (`aws iam-policy --phases A10`):
 * reads, creates only tagged `better-compute:managed=true` (the tag on create), and launches only
 * into groups so tagged.
 */
export function mlIamStatements(ec2: (resource: string) => string): IamStatement[] {
  const groups = ec2('placement-group/*');
  return [
    {
      Sid: 'MlFabricRead',
      Effect: 'Allow',
      Action: ['ec2:DescribePlacementGroups', 'ec2:DescribeInstanceTopology'],
      Resource: '*',
    },
    {
      Sid: 'PlacementGroupCreate',
      Effect: 'Allow',
      Action: 'ec2:CreatePlacementGroup',
      Resource: groups,
      Condition: { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } },
    },
    {
      Sid: 'PlacementGroupTagOnCreate',
      Effect: 'Allow',
      Action: 'ec2:CreateTags',
      Resource: groups,
      Condition: { StringEquals: { 'ec2:CreateAction': 'CreatePlacementGroup' } },
    },
    {
      // The sweep of groups no instance uses: only groups better-compute made.
      Sid: 'PlacementGroupDelete',
      Effect: 'Allow',
      Action: 'ec2:DeletePlacementGroup',
      Resource: groups,
      Condition: { StringEquals: { [`ec2:ResourceTag/${tags.managed}`]: 'true' } },
    },
    {
      Sid: 'RunInPlacementGroup',
      Effect: 'Allow',
      Action: 'ec2:RunInstances',
      Resource: groups,
      Condition: { StringEquals: { [`ec2:ResourceTag/${tags.managed}`]: 'true' } },
    },
  ];
}
