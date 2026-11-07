import type { AwsEmulator } from './index.js';
import type { VpcEmulator } from './vpc.js';
import { jsonError, requestId } from './xml.js';

// Amazon FSx for Lustre as AWS A10 uses it (JSON 1.1, `AWSSimbaAPIService_v20180301.<Operation>`):
// CreateFileSystem with ClientRequestToken idempotency (the same token with other parameters is
// `IdempotentParameterMismatch`), the Lustre capacity rule (1200 GiB or a multiple of 2400 GiB),
// DescribeFileSystems (paged), and DeleteFileSystem. New file systems stay CREATING, and deleted
// ones DELETING, for `settleReads` describes.

export interface EmuLustre {
  id: string;
  token: string;
  /** The create request as it came, for idempotency. */
  request: string;
  lifecycle: 'CREATING' | 'AVAILABLE' | 'DELETING' | 'FAILED';
  capacity: number;
  deploymentType: string;
  perUnitStorageThroughput?: number;
  subnetIds: string[];
  groupIds: string[];
  vpcId: string;
  kmsKeyId?: string;
  mountName: string;
  tags: Map<string, string>;
  reads: number;
  /** The DeleteFileSystem request, as it came. */
  deleteRequest?: Record<string, unknown>;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': requestId() },
  });

const lustreTypes = new Set(['SCRATCH_1', 'SCRATCH_2', 'PERSISTENT_1', 'PERSISTENT_2']);

export class FsxEmulator {
  readonly fileSystems = new Map<string, EmuLustre>();
  settleReads = 1;
  /** DescribeFileSystems page size (small, so tests page). */
  pageSize = 2;
  #next = 0;

  constructor(
    readonly emu: AwsEmulator,
    readonly vpc: VpcEmulator,
  ) {
    emu.register(/^fsx\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'fsx',
      protocol: 'json',
      handle: (request) => {
        if (request.headers.get('x-amz-target')?.split('.')[0] !== 'AWSSimbaAPIService_v20180301')
          return jsonError('BadRequest', 'unknown target prefix');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(request.body || '{}') as Record<string, unknown>;
        } catch {
          return jsonError('BadRequest', 'body is not JSON');
        }
        switch (request.operation) {
          case 'CreateFileSystem':
            return this.#create(body);
          case 'DescribeFileSystems':
            return this.#describe(body);
          case 'DeleteFileSystem':
            return this.#delete(body);
          default:
            return jsonError('BadRequest', `unsupported ${request.operation}`);
        }
      },
    });
    vpc.serviceInterfaces.push(() =>
      [...this.fileSystems.values()].flatMap((fs) =>
        fs.subnetIds.map((subnetId) => ({ subnetId, groupIds: fs.groupIds })),
      ),
    );
  }

  #json(fs: EmuLustre) {
    return {
      OwnerId: '222222222222',
      FileSystemId: fs.id,
      FileSystemType: 'LUSTRE',
      Lifecycle: fs.lifecycle,
      StorageCapacity: fs.capacity,
      StorageType: 'SSD',
      VpcId: fs.vpcId,
      SubnetIds: fs.subnetIds,
      DNSName: `${fs.id}.fsx.us-east-1.amazonaws.com`,
      ...(fs.kmsKeyId ? { KmsKeyId: fs.kmsKeyId } : {}),
      ResourceARN: `arn:aws:fsx:us-east-1:222222222222:file-system/${fs.id}`,
      Tags: [...fs.tags].map(([Key, Value]) => ({ Key, Value })),
      LustreConfiguration: {
        DeploymentType: fs.deploymentType,
        MountName: fs.mountName,
        ...(fs.perUnitStorageThroughput
          ? { PerUnitStorageThroughput: fs.perUnitStorageThroughput }
          : {}),
      },
    };
  }

  #create(body: Record<string, unknown>): Response {
    if (body.FileSystemType !== 'LUSTRE')
      return jsonError('InvalidParameterValue', 'only LUSTRE is emulated');
    const token = typeof body.ClientRequestToken === 'string' ? body.ClientRequestToken : '';
    const request = JSON.stringify(body);
    if (token) {
      const same = [...this.fileSystems.values()].find((fs) => fs.token === token);
      if (same) {
        if (same.request !== request)
          return jsonError('IdempotentParameterMismatch', 'the token was used with other parameters');
        return json({ FileSystem: this.#json(same) });
      }
    }
    const lustre = (body.LustreConfiguration as Record<string, unknown> | undefined) ?? {};
    const deploymentType = String(lustre.DeploymentType ?? 'SCRATCH_1');
    if (!lustreTypes.has(deploymentType))
      return jsonError('InvalidParameterValue', 'DeploymentType');
    const capacity = Number(body.StorageCapacity);
    if (!(capacity === 1200 || (capacity > 0 && capacity % 2400 === 0)))
      return jsonError('InvalidParameterValue', 'StorageCapacity must be 1200 or a multiple of 2400');
    const subnetIds = (body.SubnetIds as string[] | undefined) ?? [];
    if (subnetIds.length !== 1)
      return jsonError('InvalidParameterValue', 'Lustre takes exactly one subnet');
    const subnet = this.vpc.subnets.get(subnetIds[0]!);
    if (!subnet) return jsonError('InvalidNetworkSettings', 'subnet does not exist');
    const groupIds = (body.SecurityGroupIds as string[] | undefined) ?? [];
    for (const groupId of groupIds)
      if (this.vpc.groups.get(groupId)?.vpcId !== subnet.vpcId)
        return jsonError('InvalidNetworkSettings', `${groupId} is not in the subnet's VPC`);
    if (deploymentType.startsWith('PERSISTENT') && !lustre.PerUnitStorageThroughput)
      return jsonError('InvalidParameterValue', 'PerUnitStorageThroughput');
    const id = `fs-${(++this.#next).toString(16).padStart(17, '0')}`;
    const fs: EmuLustre = {
      id,
      token,
      request,
      lifecycle: 'CREATING',
      capacity,
      deploymentType,
      ...(lustre.PerUnitStorageThroughput
        ? { perUnitStorageThroughput: Number(lustre.PerUnitStorageThroughput) }
        : {}),
      subnetIds,
      groupIds,
      vpcId: subnet.vpcId,
      ...(typeof body.KmsKeyId === 'string' ? { kmsKeyId: body.KmsKeyId } : {}),
      mountName: `m${this.#next.toString(36).padStart(7, '0')}`,
      tags: new Map(
        ((body.Tags as { Key: string; Value: string }[] | undefined) ?? []).map((tag) => [
          tag.Key,
          tag.Value,
        ]),
      ),
      reads: this.settleReads,
    };
    this.fileSystems.set(id, fs);
    return json({ FileSystem: this.#json(fs) });
  }

  #describe(body: Record<string, unknown>): Response {
    const ids = (body.FileSystemIds as string[] | undefined) ?? [];
    for (const id of ids)
      if (!this.fileSystems.has(id))
        return jsonError('FileSystemNotFound', `File system ${id} does not exist`);
    const all = [...this.fileSystems.values()].filter(
      (fs) => ids.length === 0 || ids.includes(fs.id),
    );
    const start = Number(String(body.NextToken ?? '0').replace(/^t-/, '')) || 0;
    const page = all.slice(start, start + this.pageSize);
    for (const fs of page) {
      if (fs.reads > 0) fs.reads -= 1;
      else if (fs.lifecycle === 'CREATING') fs.lifecycle = 'AVAILABLE';
      else if (fs.lifecycle === 'DELETING') this.fileSystems.delete(fs.id);
    }
    const next = start + this.pageSize < all.length ? `t-${start + this.pageSize}` : undefined;
    return json({
      FileSystems: page.filter((fs) => this.fileSystems.has(fs.id)).map((fs) => this.#json(fs)),
      ...(next ? { NextToken: next } : {}),
    });
  }

  #delete(body: Record<string, unknown>): Response {
    const fs = this.fileSystems.get(String(body.FileSystemId ?? ''));
    if (!fs) return jsonError('FileSystemNotFound', 'File system does not exist');
    if (fs.lifecycle === 'CREATING')
      return jsonError('BadRequest', 'the file system is still being created');
    if (fs.lifecycle === 'DELETING')
      return jsonError('BadRequest', 'the file system is already being deleted');
    fs.lifecycle = 'DELETING';
    fs.reads = this.settleReads;
    fs.deleteRequest = body;
    return json({ FileSystemId: fs.id, Lifecycle: 'DELETING' });
  }
}
