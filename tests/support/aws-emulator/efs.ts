import type { AwsEmulator } from './index.js';
import type { VpcEmulator } from './vpc.js';
import { requestId } from './xml.js';

// Amazon EFS as AWS A10 uses it (rest-json, `/2015-02-01/…`): file systems found by CreationToken
// (a second create with the same token is `FileSystemAlreadyExists`), one mount target per zone
// (`MountTargetConflict`), and deletes that refuse while mount targets remain (`FileSystemInUse`).
// New file systems and mount targets stay `creating`, and deleted ones `deleting`, for
// `settleReads` describes.

export interface EmuFileSystem {
  id: string;
  creationToken: string;
  lifeCycleState: 'creating' | 'available' | 'deleting' | 'deleted' | 'error';
  encrypted: boolean;
  kmsKeyId?: string;
  performanceMode: string;
  throughputMode: string;
  tags: Map<string, string>;
  /** Describes left before the state moves on. */
  reads: number;
  /** The metered size EFS reports (default 6144 bytes, an empty file system). */
  sizeBytes?: number;
}

export interface EmuMountTarget {
  id: string;
  fileSystemId: string;
  subnetId: string;
  zone: string;
  vpcId: string;
  groupIds: string[];
  ipAddress: string;
  lifeCycleState: 'creating' | 'available' | 'deleting' | 'deleted';
  reads: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': requestId() },
  });

const restError = (code: string, message: string, status: number) =>
  new Response(JSON.stringify({ ErrorCode: code, Message: message }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-amzn-errortype': code,
      'x-amzn-requestid': requestId(),
    },
  });

const prefix = '/2015-02-01';

export class EfsEmulator {
  readonly fileSystems = new Map<string, EmuFileSystem>();
  readonly mountTargets = new Map<string, EmuMountTarget>();
  /** Describes a new or deleted resource stays in its transitional state. */
  settleReads = 1;
  #next = 0;

  constructor(
    readonly emu: AwsEmulator,
    readonly vpc: VpcEmulator,
  ) {
    emu.register(/^elasticfilesystem\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'elasticfilesystem',
      protocol: 'rest',
      handle: (request) => {
        let body: Record<string, unknown> = {};
        try {
          if (request.body) body = JSON.parse(request.body) as Record<string, unknown>;
        } catch {
          return restError('BadRequest', 'body is not JSON', 400);
        }
        const path = request.url.pathname;
        const query = request.url.searchParams;
        if (request.method === 'POST' && path === `${prefix}/file-systems`)
          return this.#createFileSystem(body);
        if (request.method === 'GET' && path === `${prefix}/file-systems`)
          return this.#describeFileSystems(query);
        if (request.method === 'DELETE' && path.startsWith(`${prefix}/file-systems/`))
          return this.#deleteFileSystem(path.slice(`${prefix}/file-systems/`.length));
        if (request.method === 'POST' && path === `${prefix}/mount-targets`)
          return this.#createMountTarget(body);
        if (request.method === 'GET' && path === `${prefix}/mount-targets`)
          return this.#describeMountTargets(query);
        if (request.method === 'DELETE' && path.startsWith(`${prefix}/mount-targets/`))
          return this.#deleteMountTarget(path.slice(`${prefix}/mount-targets/`.length));
        return restError('BadRequest', `unsupported ${request.method} ${path}`, 400);
      },
    });
    vpc.serviceInterfaces.push(() =>
      [...this.mountTargets.values()]
        .filter((target) => target.lifeCycleState !== 'deleted')
        .map((target) => ({ subnetId: target.subnetId, groupIds: target.groupIds })),
    );
  }

  #id(kind: string): string {
    return `${kind}-${(++this.#next).toString(16).padStart(17, '0')}`;
  }

  #fsJson(fs: EmuFileSystem) {
    return {
      OwnerId: '222222222222',
      CreationToken: fs.creationToken,
      FileSystemId: fs.id,
      FileSystemArn: `arn:aws:elasticfilesystem:us-east-1:222222222222:file-system/${fs.id}`,
      LifeCycleState: fs.lifeCycleState,
      NumberOfMountTargets: [...this.mountTargets.values()].filter(
        (target) => target.fileSystemId === fs.id && target.lifeCycleState !== 'deleted',
      ).length,
      SizeInBytes: { Value: fs.sizeBytes ?? 6144 },
      PerformanceMode: fs.performanceMode,
      ThroughputMode: fs.throughputMode,
      Encrypted: fs.encrypted,
      ...(fs.kmsKeyId ? { KmsKeyId: fs.kmsKeyId } : {}),
      Tags: [...fs.tags].map(([Key, Value]) => ({ Key, Value })),
    };
  }

  #createFileSystem(body: Record<string, unknown>): Response {
    const token = String(body.CreationToken ?? '');
    if (!token || token.length > 64) return restError('BadRequest', 'CreationToken', 400);
    const existing = [...this.fileSystems.values()].find((fs) => fs.creationToken === token);
    if (existing)
      return new Response(
        JSON.stringify({
          ErrorCode: 'FileSystemAlreadyExists',
          Message: 'File system already exists',
          FileSystemId: existing.id,
        }),
        {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'x-amzn-errortype': 'FileSystemAlreadyExists',
            'x-amzn-requestid': requestId(),
          },
        },
      );
    const fs: EmuFileSystem = {
      id: this.#id('fs'),
      creationToken: token,
      lifeCycleState: 'creating',
      encrypted: body.Encrypted === true,
      ...(typeof body.KmsKeyId === 'string' ? { kmsKeyId: body.KmsKeyId } : {}),
      performanceMode: String(body.PerformanceMode ?? 'generalPurpose'),
      throughputMode: String(body.ThroughputMode ?? 'bursting'),
      tags: new Map(
        ((body.Tags as { Key: string; Value: string }[] | undefined) ?? []).map((tag) => [
          tag.Key,
          tag.Value,
        ]),
      ),
      reads: this.settleReads,
    };
    this.fileSystems.set(fs.id, fs);
    return json(this.#fsJson(fs), 201);
  }

  #describeFileSystems(query: URLSearchParams): Response {
    const token = query.get('CreationToken');
    const id = query.get('FileSystemId');
    if (id && !this.fileSystems.has(id))
      return restError('FileSystemNotFound', `File system '${id}' does not exist.`, 404);
    const found = [...this.fileSystems.values()].filter(
      (fs) => (token === null || fs.creationToken === token) && (id === null || fs.id === id),
    );
    for (const fs of found) this.#advanceFs(fs);
    return json({
      FileSystems: found
        .filter((fs) => this.fileSystems.has(fs.id))
        .map((fs) => this.#fsJson(fs)),
    });
  }

  #advanceFs(fs: EmuFileSystem): void {
    if (fs.reads > 0) {
      fs.reads -= 1;
      return;
    }
    if (fs.lifeCycleState === 'creating') fs.lifeCycleState = 'available';
    else if (fs.lifeCycleState === 'deleting') this.fileSystems.delete(fs.id);
  }

  #deleteFileSystem(id: string): Response {
    const fs = this.fileSystems.get(id);
    if (!fs) return restError('FileSystemNotFound', `File system '${id}' does not exist.`, 404);
    if (
      [...this.mountTargets.values()].some(
        (target) => target.fileSystemId === id && target.lifeCycleState !== 'deleted',
      )
    )
      return restError('FileSystemInUse', 'File system is in use by mount targets', 409);
    if (fs.lifeCycleState === 'creating')
      return restError(
        'IncorrectFileSystemLifeCycleState',
        'File system is still being created',
        409,
      );
    fs.lifeCycleState = 'deleting';
    fs.reads = this.settleReads;
    return new Response(null, { status: 204, headers: { 'x-amzn-requestid': requestId() } });
  }

  #mtJson(target: EmuMountTarget) {
    return {
      OwnerId: '222222222222',
      MountTargetId: target.id,
      FileSystemId: target.fileSystemId,
      SubnetId: target.subnetId,
      LifeCycleState: target.lifeCycleState,
      IpAddress: target.ipAddress,
      NetworkInterfaceId: `eni-${target.id.slice(5)}`,
      AvailabilityZoneName: target.zone,
      VpcId: target.vpcId,
    };
  }

  #createMountTarget(body: Record<string, unknown>): Response {
    const fs = this.fileSystems.get(String(body.FileSystemId ?? ''));
    if (!fs) return restError('FileSystemNotFound', 'File system does not exist.', 404);
    if (fs.lifeCycleState !== 'available')
      return restError('IncorrectFileSystemLifeCycleState', 'File system is not available', 409);
    const subnet = this.vpc.subnets.get(String(body.SubnetId ?? ''));
    if (!subnet) return restError('SubnetNotFound', 'Subnet does not exist', 400);
    const groupIds = (body.SecurityGroups as string[] | undefined) ?? [];
    if (groupIds.length > 5) return restError('SecurityGroupLimitExceeded', 'groups', 400);
    for (const groupId of groupIds) {
      const group = this.vpc.groups.get(groupId);
      if (!group) return restError('SecurityGroupNotFound', `${groupId} does not exist`, 400);
      if (group.vpcId !== subnet.vpcId)
        return restError('BadRequest', 'security group is in another VPC', 400);
    }
    const live = [...this.mountTargets.values()].filter(
      (target) => target.fileSystemId === fs.id && target.lifeCycleState !== 'deleted',
    );
    if (live.some((target) => target.vpcId !== subnet.vpcId))
      return restError('MountTargetConflict', 'mount targets of a file system share one VPC', 409);
    if (live.some((target) => target.zone === subnet.zone))
      return restError('MountTargetConflict', 'a mount target exists in this zone', 409);
    const target: EmuMountTarget = {
      id: this.#id('fsmt'),
      fileSystemId: fs.id,
      subnetId: subnet.id,
      zone: subnet.zone,
      vpcId: subnet.vpcId,
      groupIds: groupIds.length ? groupIds : [],
      ipAddress: `10.64.0.${10 + this.mountTargets.size}`,
      lifeCycleState: 'creating',
      reads: this.settleReads,
    };
    this.mountTargets.set(target.id, target);
    return json(this.#mtJson(target));
  }

  #describeMountTargets(query: URLSearchParams): Response {
    const id = query.get('FileSystemId');
    if (!id) return restError('BadRequest', 'FileSystemId', 400);
    if (!this.fileSystems.has(id))
      return restError('FileSystemNotFound', `File system '${id}' does not exist.`, 404);
    const found = [...this.mountTargets.values()].filter((target) => target.fileSystemId === id);
    for (const target of found) {
      if (target.reads > 0) target.reads -= 1;
      else if (target.lifeCycleState === 'creating') target.lifeCycleState = 'available';
      else if (target.lifeCycleState === 'deleting') this.mountTargets.delete(target.id);
    }
    return json({
      MountTargets: found
        .filter((target) => this.mountTargets.has(target.id))
        .map((target) => this.#mtJson(target)),
    });
  }

  #deleteMountTarget(id: string): Response {
    const target = this.mountTargets.get(id);
    if (!target) return restError('MountTargetNotFound', `Mount target '${id}' does not exist.`, 404);
    target.lifeCycleState = 'deleting';
    target.reads = this.settleReads;
    return new Response(null, { status: 204, headers: { 'x-amzn-requestid': requestId() } });
  }
}
