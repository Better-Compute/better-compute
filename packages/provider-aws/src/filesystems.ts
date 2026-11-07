import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ProviderContext,
  type ProviderFilesystems,
  type ProviderFilesystemSpec,
  type ProviderFilesystemState,
  type ProviderMount,
} from '@better-compute/core';
import { partitionOf, type JsonClient, type RestClient } from '@better-compute/aws-core';
import type { IamStatement } from './cli.js';
import type { AwsConfig } from './config.js';
import { tags, tagValue } from './ids.js';
import { AwsNetworks, networkTags } from './networks.js';

// Shared filesystems (AWS A10, sub-plan 2026-11-05): `nfs` is Amazon EFS (elastic throughput,
// general purpose, encrypted) with one mount target per zone of the network; `lustre` is Amazon
// FSx for Lustre in one zone (SCRATCH_2, or PERSISTENT_2 at 125 MB/s/TiB). Both sit behind the
// filesystem's own group `bc-fs:<name>` (AwsNetworks.filesystemAccess), so only the network's
// machines reach them. A filesystem is found again by name (EFS CreationToken; FSx tag
// `better-compute:filesystem`), and one without `better-compute:managed=true` is never adopted or
// deleted.

/** The mount options machines use: EFS's recommended NFS options, and Lustre's. */
export const efsMountOptions =
  'nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev';
export const lustreMountOptions = 'relatime,flock,_netdev';

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const invalid = (message: string, reason: string) =>
  new ComputeError('INVALID_INPUT', message, undefined, { provider: 'aws', reason });

const state = (
  id: string,
  value: ProviderFilesystemState['state'],
  extra: Partial<ProviderFilesystemState> = {},
): ProviderFilesystemState => ({ id, state: value, ...extra });

const bytesPerGiB = 2 ** 30;

/** `{ sizeGiB }` of a size AWS reported in `unit`s (GiB = 1, bytes = 2^30), or nothing when it is no size. */
const sizeOf = (value: unknown, perGiB: number): { sizeGiB?: number } =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { sizeGiB: Math.round((value / perGiB) * 1e6) / 1e6 }
    : {};

const awsCode = (error: unknown): string | undefined =>
  isComputeError(error) ? (error.details?.code as string | undefined) : undefined;

interface EfsFileSystem {
  FileSystemId: string;
  CreationToken: string;
  LifeCycleState: string;
  /** The metered size; `Value` is bytes. */
  SizeInBytes?: { Value?: number };
  Tags?: { Key: string; Value: string }[];
}
interface EfsMountTarget {
  MountTargetId: string;
  SubnetId: string;
  AvailabilityZoneName?: string;
  LifeCycleState: string;
}
interface FsxFileSystem {
  FileSystemId: string;
  FileSystemType: string;
  Lifecycle: string;
  StorageCapacity?: number;
  DNSName?: string;
  Tags?: { Key: string; Value: string }[];
  LustreConfiguration?: { DeploymentType?: string; MountName?: string };
}

const tagsOf = (list: { Key: string; Value: string }[] | undefined) =>
  new Map((list ?? []).map((tag) => [tag.Key, tag.Value]));

export interface AwsFilesystemsHost {
  config: AwsConfig;
  context: ProviderContext;
  efs: RestClient;
  fsx: JsonClient;
  networks: AwsNetworks;
}

/** Validates a spec before any call: `INVALID_INPUT` with a reason. */
export function validateFilesystemSpec(spec: ProviderFilesystemSpec, config: AwsConfig): void {
  if (typeof spec.name !== 'string' || !namePattern.test(spec.name))
    throw invalid(
      `filesystem ${JSON.stringify(String(spec.name).slice(0, 64))} is not a better-compute name`,
      'filesystem-name',
    );
  if (spec.kind !== 'nfs' && spec.kind !== 'lustre')
    throw invalid('a filesystem is nfs or lustre', 'filesystem-kind');
  if (spec.kind === 'lustre') {
    const size = spec.sizeGiB ?? 1200;
    if (!Number.isInteger(size) || !(size === 1200 || (size > 0 && size % 2400 === 0)))
      throw invalid(
        'a Lustre filesystem is 1200 GiB or a multiple of 2400 GiB',
        'filesystem-size',
      );
    if (spec.deployment !== undefined && spec.deployment !== 'scratch' && spec.deployment !== 'persistent')
      throw invalid('deployment is scratch or persistent', 'filesystem-deployment');
    if (spec.zone !== undefined && !config.zones.includes(spec.zone))
      throw invalid(`${spec.zone} is not one of the account's zones`, 'filesystem-zone');
  } else if (spec.sizeGiB !== undefined || spec.deployment !== undefined || spec.zone !== undefined)
    throw invalid(
      'an nfs filesystem is elastic and spans every zone: no size, deployment or zone',
      'filesystem-options',
    );
}

/** One account's EFS and FSx for Lustre filesystems (`ProviderFilesystems`). */
export class AwsFilesystems implements ProviderFilesystems {
  readonly kinds = ['nfs', 'lustre'] as const;

  constructor(readonly host: AwsFilesystemsHost) {}

  get #config(): AwsConfig {
    return this.host.config;
  }

  #ownTags(spec: Pick<ProviderFilesystemSpec, 'name' | 'network'>) {
    return [
      { Key: tags.managed, Value: 'true' },
      { Key: tags.name, Value: tagValue(spec.name) },
      { Key: networkTags.filesystem, Value: spec.name },
      { Key: networkTags.network, Value: tagValue(spec.network) },
    ];
  }

  validate(spec: ProviderFilesystemSpec): void {
    validateFilesystemSpec(spec, this.#config);
  }

  async ensureFilesystem(
    spec: ProviderFilesystemSpec,
    context: CallContext,
  ): Promise<ProviderFilesystemState> {
    validateFilesystemSpec(spec, this.#config);
    const { signal } = context;
    const access = await this.host.networks.filesystemAccess(spec.network, spec.name, spec.kind, signal);
    if (!('groupId' in access))
      return state(spec.name, access.state === 'error' ? 'error' : 'pending', {
        ...(access.message !== undefined ? { message: access.message } : {}),
      });
    if (access.subnets.length === 0)
      return state(spec.name, 'pending', {
        message: `Waiting for a subnet of network ${spec.network}`,
      });
    return spec.kind === 'nfs'
      ? this.#ensureEfs(spec, access.groupId, access.subnets, signal)
      : this.#ensureLustre(spec, access.groupId, access.subnets, signal);
  }

  async deleteFilesystem(name: string, context: CallContext): Promise<ProviderFilesystemState> {
    const { signal } = context;
    if (typeof name !== 'string' || !namePattern.test(name)) return state(String(name), 'deleted');
    const efs = await this.#findEfs(name, signal);
    if (efs) {
      this.#refuseForeign(name, efs.Tags);
      const gone = await this.#deleteEfs(efs, signal);
      if (!gone) return state(efs.FileSystemId, 'deleting');
    }
    const lustre = await this.#findLustre(name, signal);
    if (lustre) {
      this.#refuseForeign(name, lustre.Tags);
      if (lustre.Lifecycle !== 'DELETING') {
        if (lustre.Lifecycle === 'CREATING')
          return state(lustre.FileSystemId, 'deleting', {
            message: 'Waiting for the file system to finish creating',
          });
        await this.host.fsx.call(
          'DeleteFileSystem',
          {
            FileSystemId: lustre.FileSystemId,
            ...(lustre.LustreConfiguration?.DeploymentType?.startsWith('PERSISTENT')
              ? { LustreConfiguration: { SkipFinalBackup: true } }
              : {}),
          },
          { signal },
        );
      }
      return state(lustre.FileSystemId, 'deleting');
    }
    const released = await this.host.networks.releaseFilesystemAccess(name, signal);
    return released.state === 'deleted'
      ? state(name, 'deleted')
      : state(name, 'deleting', { ...(released.message ? { message: released.message } : {}) });
  }

  #refuseForeign(name: string, list: { Key: string; Value: string }[] | undefined): void {
    if (tagsOf(list).get(tags.managed) !== 'true')
      throw new ComputeError(
        'INVALID_STATE',
        `filesystem ${name} was not made by better-compute; it is never adopted or deleted`,
        undefined,
        { provider: 'aws', reason: 'filesystem-foreign' },
      );
  }

  // --- EFS -------------------------------------------------------------------------------------------

  async #efs<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    signal: AbortSignal,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.host.efs.request(method, `/2015-02-01${path}`, {
      signal,
      protocol: 'rest-json',
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined
        ? {
            body: JSON.stringify(options.body),
            headers: { 'content-type': 'application/json' },
          }
        : {}),
    });
    const text = new TextDecoder().decode(response.body);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async #findEfs(name: string, signal: AbortSignal): Promise<EfsFileSystem | undefined> {
    const doc = await this.#efs<{ FileSystems?: EfsFileSystem[] }>('GET', '/file-systems', signal, {
      query: { CreationToken: name },
    });
    return (doc.FileSystems ?? []).find((fs) => fs.CreationToken === name);
  }

  #efsMount(id: string): Omit<ProviderMount, 'path'> {
    const { dnsSuffix } = partitionOf(this.#config.region);
    return {
      fstype: 'nfs4',
      source: `${id}.efs.${this.#config.region}.${dnsSuffix}:/`,
      options: efsMountOptions,
    };
  }

  async #ensureEfs(
    spec: ProviderFilesystemSpec,
    groupId: string,
    subnets: readonly { id: string; zone: string }[],
    signal: AbortSignal,
  ): Promise<ProviderFilesystemState> {
    let fs = await this.#findEfs(spec.name, signal);
    if (!fs) {
      try {
        fs = await this.#efs<EfsFileSystem>('POST', '/file-systems', signal, {
          body: {
            CreationToken: spec.name,
            PerformanceMode: 'generalPurpose',
            ThroughputMode: 'elastic',
            Encrypted: true,
            ...(this.#config.kmsKeyId ? { KmsKeyId: this.#config.kmsKeyId } : {}),
            Tags: this.#ownTags(spec),
          },
        });
      } catch (error) {
        // The token is taken (a lost answer of our own create, or a race): found again next time.
        if (awsCode(error) !== 'FileSystemAlreadyExists') throw error;
        return state(spec.name, 'pending', { message: 'Waiting for the file system' });
      }
      return state(fs.FileSystemId, 'pending', { message: 'Creating the file system' });
    }
    this.#refuseForeign(spec.name, fs.Tags);
    const outputs = { fileSystemId: fs.FileSystemId };
    if (fs.LifeCycleState === 'error')
      return state(fs.FileSystemId, 'error', { outputs, message: 'EFS reports the file system failed' });
    if (fs.LifeCycleState === 'deleting' || fs.LifeCycleState === 'deleted')
      return state(fs.FileSystemId, 'pending', { outputs, message: 'The file system is being deleted' });
    if (fs.LifeCycleState !== 'available')
      return state(fs.FileSystemId, 'pending', { outputs, message: 'Creating the file system' });

    const targets = (
      await this.#efs<{ MountTargets?: EfsMountTarget[] }>('GET', '/mount-targets', signal, {
        query: { FileSystemId: fs.FileSystemId },
      })
    ).MountTargets ?? [];
    const live = targets.filter((t) => t.LifeCycleState !== 'deleting' && t.LifeCycleState !== 'deleted');
    const zones = new Set(live.map((t) => t.AvailabilityZoneName));
    let made = false;
    for (const subnet of subnets) {
      if (zones.has(subnet.zone)) continue;
      try {
        await this.#efs('POST', '/mount-targets', signal, {
          body: { FileSystemId: fs.FileSystemId, SubnetId: subnet.id, SecurityGroups: [groupId] },
        });
        made = true;
      } catch (error) {
        // A mount target in that zone already (a lost answer, or a race): seen next time.
        if (awsCode(error) !== 'MountTargetConflict') throw error;
        made = true;
      }
    }
    if (made || live.some((t) => t.LifeCycleState !== 'available'))
      return state(fs.FileSystemId, 'pending', { outputs, message: 'Creating mount targets' });
    return state(fs.FileSystemId, 'ready', {
      outputs,
      mount: this.#efsMount(fs.FileSystemId),
      ...sizeOf(fs.SizeInBytes?.Value, bytesPerGiB),
    });
  }

  /** Deletes the mount targets, then the file system; true once EFS no longer shows it. */
  async #deleteEfs(fs: EfsFileSystem, signal: AbortSignal): Promise<boolean> {
    if (fs.LifeCycleState === 'deleting' || fs.LifeCycleState === 'deleted') return false;
    const targets = (
      await this.#efs<{ MountTargets?: EfsMountTarget[] }>('GET', '/mount-targets', signal, {
        query: { FileSystemId: fs.FileSystemId },
      })
    ).MountTargets ?? [];
    for (const target of targets)
      if (target.LifeCycleState !== 'deleting' && target.LifeCycleState !== 'deleted')
        await this.#tolerate(['MountTargetNotFound'], () =>
          this.#efs('DELETE', `/mount-targets/${encodeURIComponent(target.MountTargetId)}`, signal),
        );
    if (targets.length > 0 || fs.LifeCycleState === 'creating') return false;
    await this.#tolerate(['FileSystemNotFound', 'FileSystemInUse', 'IncorrectFileSystemLifeCycleState'], () =>
      this.#efs('DELETE', `/file-systems/${encodeURIComponent(fs.FileSystemId)}`, signal),
    );
    return false;
  }

  async #tolerate(codes: readonly string[], action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!codes.includes(awsCode(error) ?? '')) throw error;
    }
  }

  // --- FSx for Lustre --------------------------------------------------------------------------------

  async #findLustre(name: string, signal: AbortSignal): Promise<FsxFileSystem | undefined> {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const doc = await this.host.fsx.call<{ FileSystems?: FsxFileSystem[]; NextToken?: string }>(
        'DescribeFileSystems',
        { MaxResults: 100, ...(token ? { NextToken: token } : {}) },
        { signal },
      );
      const found = (doc.FileSystems ?? []).find(
        (fs) => fs.FileSystemType === 'LUSTRE' && tagsOf(fs.Tags).get(networkTags.filesystem) === name,
      );
      if (found) return found;
      token = doc.NextToken || undefined;
      if (token && seen.has(token))
        throw new ComputeError('PROVIDER_ERROR', 'AWS returned a pagination token twice', undefined, {
          provider: 'aws',
          reason: 'pagination-loop',
        });
      if (token) seen.add(token);
    } while (token);
    return undefined;
  }

  async #ensureLustre(
    spec: ProviderFilesystemSpec,
    groupId: string,
    subnets: readonly { id: string; zone: string }[],
    signal: AbortSignal,
  ): Promise<ProviderFilesystemState> {
    let fs = await this.#findLustre(spec.name, signal);
    if (!fs) {
      const zone = spec.zone ?? this.#config.zones[0]!;
      const subnet = subnets.find((s) => s.zone === zone);
      if (!subnet)
        return state(spec.name, 'pending', {
          message: `Waiting for a subnet of network ${spec.network} in ${zone}`,
        });
      const persistent = spec.deployment === 'persistent';
      // ClientRequestToken makes a retried create (a lost answer) return the same file system.
      const doc = await this.host.fsx.call<{ FileSystem: FsxFileSystem }>(
        'CreateFileSystem',
        {
          ClientRequestToken: spec.name,
          FileSystemType: 'LUSTRE',
          StorageCapacity: spec.sizeGiB ?? 1200,
          StorageType: 'SSD',
          SubnetIds: [subnet.id],
          SecurityGroupIds: [groupId],
          Tags: this.#ownTags(spec),
          ...(persistent && this.#config.kmsKeyId ? { KmsKeyId: this.#config.kmsKeyId } : {}),
          LustreConfiguration: persistent
            ? { DeploymentType: 'PERSISTENT_2', PerUnitStorageThroughput: 125 }
            : { DeploymentType: 'SCRATCH_2' },
        },
        { signal },
      );
      fs = doc.FileSystem;
      return state(fs.FileSystemId, 'pending', { message: 'Creating the file system' });
    }
    this.#refuseForeign(spec.name, fs.Tags);
    const outputs = { fileSystemId: fs.FileSystemId };
    switch (fs.Lifecycle) {
      case 'AVAILABLE': {
        const mountName = fs.LustreConfiguration?.MountName;
        if (!fs.DNSName || !mountName)
          return state(fs.FileSystemId, 'pending', { outputs, message: 'Waiting for the mount name' });
        return state(fs.FileSystemId, 'ready', {
          outputs,
          mount: { fstype: 'lustre', source: `${fs.DNSName}@tcp:/${mountName}`, options: lustreMountOptions },
          ...sizeOf(fs.StorageCapacity, 1),
        });
      }
      case 'FAILED':
      case 'MISCONFIGURED':
        return state(fs.FileSystemId, 'error', {
          outputs,
          message: `FSx reports the file system ${fs.Lifecycle === 'FAILED' ? 'failed' : 'misconfigured'}`,
        });
      case 'DELETING':
        return state(fs.FileSystemId, 'pending', { outputs, message: 'The file system is being deleted' });
      default:
        return state(fs.FileSystemId, 'pending', { outputs, message: 'Creating the file system' });
    }
  }
}

/**
 * (A10) The IAM statements shared filesystems need (`aws iam-policy --phases A10`; their groups and
 * rules come from the A2 network statements). Creates must carry `better-compute:managed=true`,
 * tags go on only as part of a create, and mount targets, deletes and FSx deletes need the tag on
 * the file system. EFS creates a mount target's interface with the caller's EC2 permissions, so
 * those are granted only when EFS makes the call (`aws:CalledVia`). FSx makes its interfaces
 * through its service-linked role. (verify) against the live suite: the `fsx:CreateAction`
 * condition key on tag-on-create.
 */
export function filesystemsIamStatements(arn: {
  partition: string;
  region: string;
  account: string;
}): IamStatement[] {
  const efs = `arn:${arn.partition}:elasticfilesystem:${arn.region}:${arn.account}:file-system/*`;
  const fsx = `arn:${arn.partition}:fsx:${arn.region}:${arn.account}:file-system/*`;
  const ec2 = (resource: string) => `arn:${arn.partition}:ec2:${arn.region}:${arn.account}:${resource}`;
  return [
    {
      Sid: 'FilesystemRead',
      Effect: 'Allow',
      Action: [
        'elasticfilesystem:DescribeFileSystems',
        'elasticfilesystem:DescribeMountTargets',
        'fsx:DescribeFileSystems',
      ],
      Resource: '*',
    },
    {
      Sid: 'FilesystemCreate',
      Effect: 'Allow',
      Action: ['elasticfilesystem:CreateFileSystem', 'fsx:CreateFileSystem'],
      Resource: [efs, fsx],
      Condition: { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } },
    },
    {
      Sid: 'FilesystemTagOnCreate',
      Effect: 'Allow',
      Action: 'elasticfilesystem:TagResource',
      Resource: efs,
      Condition: { StringEquals: { 'elasticfilesystem:CreateAction': 'CreateFileSystem' } },
    },
    {
      Sid: 'FsxTagOnCreate',
      Effect: 'Allow',
      Action: 'fsx:TagResource',
      Resource: fsx,
      Condition: { StringEquals: { 'fsx:CreateAction': 'CreateFileSystem' } },
    },
    {
      Sid: 'FilesystemManageOwned',
      Effect: 'Allow',
      Action: [
        'elasticfilesystem:CreateMountTarget',
        'elasticfilesystem:DeleteMountTarget',
        'elasticfilesystem:DeleteFileSystem',
        'fsx:DeleteFileSystem',
      ],
      Resource: [efs, fsx],
      Condition: { StringEquals: { [`aws:ResourceTag/${tags.managed}`]: 'true' } },
    },
    {
      Sid: 'FilesystemMountTargetInterfaces',
      Effect: 'Allow',
      Action: [
        'ec2:CreateNetworkInterface',
        'ec2:DeleteNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
      ],
      Resource: [ec2('network-interface/*'), ec2('subnet/*'), ec2('security-group/*')],
      Condition: {
        'ForAnyValue:StringEquals': { 'aws:CalledVia': ['elasticfilesystem.amazonaws.com'] },
      },
    },
  ];
}
