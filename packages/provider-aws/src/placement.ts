import {
  ComputeError,
  isComputeError,
  type Clock,
  type ProviderPlacement,
} from '@better-compute/core';
import type { QueryParams, XmlElement } from '@better-compute/aws-core';
import { tags } from './ids.js';

// EC2 placement groups (AWS A10). A create that asks for a placement launches into the named group,
// which provider-aws makes on first use (tagged `better-compute:managed=true`). A group with that
// name that better-compute did not make is refused, never adopted: its machines are someone else's
// and its strategy is theirs to pick.

/** Partitions a partition group gets: EC2's maximum per Availability Zone. */
export const placementPartitions = 7;
/** How long a group this client made or read stays trusted without another read. */
const knownTtlMs = 3_600_000;

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

/** Placement groups of one account: made on first use, checked, and remembered for an hour. */
export class PlacementGroups {
  readonly #known = new Map<string, { strategy: string; at: number }>();

  constructor(
    private readonly call: Call,
    private readonly clock: Clock,
  ) {}

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
