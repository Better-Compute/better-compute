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
