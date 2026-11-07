import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '@better-compute/cli';
import {
  awsIamPolicyCommand,
  awsTrustPolicyCommand,
  iamPolicy,
  trustPolicy,
  type AwsCommandContext,
  type IamStatement,
} from '@better-compute/provider-aws';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const actionsOf = (statement: IamStatement) =>
  typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action];

function harness(flags: AwsCommandContext['flags']) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-policy-'));
  dirs.push(dir);
  const out: string[] = [];
  const notes: string[] = [];
  const context: AwsCommandContext = {
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => join(dir, value),
  };
  return { dir, out, notes, context };
}

describe('provider-aws CLI policies', () => {
  it('iam policy scopes destructive actions to managed tags', () => {
    const policy = iamPolicy();
    const terminating = policy.Statement.filter((s) =>
      actionsOf(s).includes('ec2:TerminateInstances'),
    );
    expect(terminating).toHaveLength(1);
    expect(
      terminating[0]!.Condition?.StringEquals?.['ec2:ResourceTag/better-compute:managed'],
    ).toBe('true');
    const run = policy.Statement.find((s) => s.Sid === 'RunTagged')!;
    expect(run.Condition?.StringEquals?.['aws:RequestTag/better-compute:managed']).toBe('true');
    const power = policy.Statement.find((s) => actionsOf(s).includes('ec2:StopInstances'))!;
    expect(power.Condition?.Null?.['ec2:ResourceTag/better-compute:instance']).toBe('false');
    expect(actionsOf(power)).not.toContain('ec2:TerminateInstances');
    for (const statement of policy.Statement)
      if (statement.Resource === '*')
        expect(
          actionsOf(statement).every(
            (a) => a.startsWith('ec2:Describe') || a === 'sts:GetCallerIdentity',
          ),
        ).toBe(true);
  });

  it('tag edits are limited to better-compute keys', () => {
    const policy = iamPolicy();
    const tagging = policy.Statement.filter((s) =>
      actionsOf(s).some((a) => a === 'ec2:CreateTags' || a === 'ec2:DeleteTags'),
    );
    expect(tagging.length).toBe(2);
    for (const statement of tagging) {
      const onCreate = statement.Condition?.StringEquals?.['ec2:CreateAction'];
      const keys = statement.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys'];
      expect(
        onCreate === 'RunInstances' ||
          JSON.stringify(keys) ===
            JSON.stringify(['better-compute:instance', 'better-compute:managed']),
      ).toBe(true);
    }
  });

  it('tag edits outside launch need tag keys in the request', () => {
    // ForAllValues is vacuously true without aws:TagKeys: a DeleteTags with no Tag parameter (all
    // tags) would pass it. The Null condition refuses a request that names no keys.
    const attach = iamPolicy().Statement.find((s) => s.Sid === 'Attach')!;
    expect(attach.Condition?.Null?.['aws:TagKeys']).toBe('false');
    expect(attach.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']).toEqual([
      'better-compute:instance',
      'better-compute:managed',
    ]);
    expect(attach.Condition?.StringEquals).toBeUndefined();
  });

  it('--discover-tag limits attach tag edits to instances carrying the discovery tag', async () => {
    const attach = iamPolicy({ discoverTag: 'team=ml' }).Statement.find((s) => s.Sid === 'Attach')!;
    expect(attach.Condition?.StringEquals?.['ec2:ResourceTag/team']).toBe('ml');
    expect(attach.Condition?.Null?.['aws:TagKeys']).toBe('false');
    expect(() => iamPolicy({ discoverTag: 'novalue' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    const { out, context } = harness({ 'discover-tag': 'team=ml' });
    await awsIamPolicyCommand().run(context);
    const printed = JSON.parse(out.join('\n')) as { Statement: IamStatement[] };
    expect(
      printed.Statement.find((s) => s.Sid === 'Attach')!.Condition?.StringEquals?.[
        'ec2:ResourceTag/team'
      ],
    ).toBe('ml');
  });

  it('reinstall can name its new task, volume, snapshot and image; the instance stays tag-guarded', () => {
    const policy = iamPolicy({ region: 'us-east-1', account: '222222222222' });
    const replace = policy.Statement.filter((s) =>
      actionsOf(s).includes('ec2:CreateReplaceRootVolumeTask'),
    );
    const guarded = replace.find((s) => s.Sid === 'PowerClaimed')!;
    expect(guarded.Resource).toBe('arn:aws:ec2:us-east-1:222222222222:instance/*');
    const extra = replace.find((s) => s.Sid === 'ReinstallResources')!;
    expect(actionsOf(extra)).toEqual(['ec2:CreateReplaceRootVolumeTask']);
    expect(extra.Resource).toEqual([
      'arn:aws:ec2:us-east-1:222222222222:replace-root-volume-task/*',
      'arn:aws:ec2:us-east-1:222222222222:volume/*',
      'arn:aws:ec2:us-east-1::snapshot/*',
      'arn:aws:ec2:us-east-1::image/*',
    ]);
    expect(JSON.stringify(extra.Resource)).not.toContain('instance/');
  });

  it('--kms-key adds the EBS grants for that key only, through EC2', () => {
    expect(iamPolicy().Statement.some((s) => actionsOf(s).some((a) => a.startsWith('kms:')))).toBe(
      false,
    );
    const key = 'arn:aws:kms:us-east-1:222222222222:key/1234abcd-12ab-34cd-56ef-1234567890ab';
    const policy = iamPolicy({ region: 'us-east-1', kmsKeyArn: key });
    const kms = policy.Statement.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
    expect(kms.map((s) => s.Sid).sort()).toEqual(['EbsKey', 'EbsKeyGrant']);
    for (const statement of kms) {
      expect(statement.Resource).toBe(key);
      expect(statement.Condition?.StringEquals?.['kms:ViaService']).toBe(
        'ec2.us-east-1.amazonaws.com',
      );
    }
    const grant = kms.find((s) => s.Sid === 'EbsKeyGrant')!;
    expect(actionsOf(grant)).toEqual(['kms:CreateGrant']);
    expect(grant.Condition?.Bool?.['kms:GrantIsForAWSResource']).toBe('true');
    expect(
      iamPolicy({ kmsKeyArn: key }).Statement.find((s) => s.Sid === 'EbsKey')!.Condition
        ?.StringLike?.['kms:ViaService'],
    ).toBe('ec2.*.amazonaws.com');
    for (const bad of ['alias/x', 'arn:aws:s3:::b', 'arn:aws-cn:kms:cn-north-1:222222222222:key/x'])
      expect(() => iamPolicy({ kmsKeyArn: bad })).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
  });

  it('--ssm-prefix adds GetParameters on the host ssmImagePrefixes', async () => {
    const plain = iamPolicy();
    expect(plain.Statement.some((s) => s.Sid === 'PrivateImages')).toBe(false);
    const policy = iamPolicy({
      region: 'us-east-1',
      account: '222222222222',
      ssmPrefixes: ['/my/team/', '/golden/'],
    });
    const statement = policy.Statement.find((s) => s.Sid === 'PrivateImages')!;
    expect(statement.Action).toBe('ssm:GetParameters');
    expect(statement.Resource).toEqual([
      'arn:aws:ssm:us-east-1:222222222222:parameter/my/team/*',
      'arn:aws:ssm:us-east-1:222222222222:parameter/golden/*',
    ]);
    for (const bad of [['/my/team'], ['my/team/'], ['/a/../b/'], ['/*/']])
      expect(() => iamPolicy({ ssmPrefixes: bad })).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    const printed = harness({ 'ssm-prefix': '/my/team/,/golden/', region: 'us-east-1' });
    await awsIamPolicyCommand().run(printed.context);
    expect(JSON.parse(printed.out.join('\n'))).toEqual(
      iamPolicy({ region: 'us-east-1', ssmPrefixes: ['/my/team/', '/golden/'] }),
    );
  });

  it('partition flows into ARNs', () => {
    const policy = iamPolicy({
      partition: 'aws-us-gov',
      region: 'us-gov-west-1',
      account: '222222222222',
      instanceProfileArn: 'arn:aws-us-gov:iam::222222222222:instance-profile/bc-nodes',
    });
    const resources = policy.Statement.flatMap((s) =>
      s.Resource === undefined
        ? []
        : typeof s.Resource === 'string'
          ? [s.Resource]
          : [...s.Resource],
    ).filter((r) => r !== '*');
    expect(resources.length).toBeGreaterThan(5);
    for (const resource of resources) expect(resource.startsWith('arn:aws-us-gov:')).toBe(true);
    expect(resources).toContain('arn:aws-us-gov:ec2:us-gov-west-1:222222222222:instance/*');
    expect(resources).toContain('arn:aws-us-gov:iam::222222222222:role/bc-nodes');
    expect(() => iamPolicy({ region: 'us-east-1.evil.com' })).toThrow();
    expect(() => iamPolicy({ account: '12' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() =>
      iamPolicy({ instanceProfileArn: 'arn:aws-cn:iam::222222222222:instance-profile/x' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('trust policy requires the external id', () => {
    const policy = trustPolicy({
      platformPrincipalArn: 'arn:aws:iam::111111111111:role/bc-control-plane',
      externalId: 'better-compute:pa_tenantA',
    });
    const [statement] = policy.Statement;
    expect(statement!.Condition?.StringEquals?.['sts:ExternalId']).toBe(
      'better-compute:pa_tenantA',
    );
    expect(statement!.Principal).toEqual({
      AWS: 'arn:aws:iam::111111111111:role/bc-control-plane',
    });
    expect(statement!.Action).toBe('sts:AssumeRole');
    expect(statement!.Resource).toBeUndefined();
    for (const bad of [
      { platformPrincipalArn: '*', externalId: 'x1' },
      { platformPrincipalArn: 'arn:aws:s3:::bucket', externalId: 'x1' },
      { platformPrincipalArn: 'arn:aws:iam::111111111111:role/x', externalId: '' },
      { platformPrincipalArn: 'arn:aws:iam::111111111111:role/x', externalId: 'a b' },
    ])
      expect(() => trustPolicy(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('commands print JSON and honor --out', async () => {
    const printed = harness({});
    await awsIamPolicyCommand().run(printed.context);
    expect(JSON.parse(printed.out.join('\n'))).toEqual(iamPolicy());

    const written = harness({
      'platform-principal': 'arn:aws:iam::111111111111:role/bc',
      'external-id': 'better-compute:pa_1',
      out: 'trust.json',
    });
    await awsTrustPolicyCommand().run(written.context);
    expect(written.out).toEqual([]);
    expect(JSON.parse(readFileSync(join(written.dir, 'trust.json'), 'utf8'))).toEqual(
      trustPolicy({
        platformPrincipalArn: 'arn:aws:iam::111111111111:role/bc',
        externalId: 'better-compute:pa_1',
      }),
    );
    expect(written.notes[0]).toContain('trust.json');
    // Never overwrites.
    await expect(awsTrustPolicyCommand().run(written.context)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(awsTrustPolicyCommand().run(harness({}).context)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('commands have the CLI shape', () => {
    for (const command of [awsIamPolicyCommand(), awsTrustPolicyCommand()]) {
      const spec = command as unknown as CommandSpec<any>;
      expect(spec.name).toMatch(/^aws [a-z-]+$/);
      expect(spec.group).toBe('Providers');
      expect(spec.summary).toMatch(/^[A-Z][a-z]+ /);
      expect(typeof spec.run).toBe('function');
      for (const [name, flag] of Object.entries(spec.flags ?? {})) {
        expect(['url', 'format', 'config', 'query']).not.toContain(name);
        expect(flag.type).toBe('string');
        expect(typeof flag.description).toBe('string');
      }
    }
    expect(Object.keys(awsTrustPolicyCommand().flags).sort()).toEqual([
      'external-id',
      'out',
      'platform-principal',
    ]);
    expect(awsTrustPolicyCommand().flags['external-id'].required).toBe(true);
  });
});
