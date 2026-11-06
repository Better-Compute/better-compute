import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awsEventRulesCommand,
  eventRulesTemplate,
  iamPolicy,
  mapEventBridgeEnvelope,
  type AwsCommandContext,
} from '@better-compute/provider-aws';

// `aws event-rules` (A4): the CloudFormation stack that feeds an account's intake queue — the SQS
// queue (SSE-SQS, 14-day retention, a DLQ), the EventBridge rules, and a queue policy that lets only
// events.amazonaws.com send, only from those rules.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Resource = { Type: string; Properties: Record<string, any> };

describe('aws event-rules', () => {
  it('renders the queue, its DLQ, the rules and a queue policy pinned to the rule ARNs', () => {
    const template = eventRulesTemplate({ queueName: 'bc-events', account: '123456789012' });
    const resources = template.Resources as Record<string, Resource>;
    const queue = resources.IntakeQueue!;
    expect(queue.Type).toBe('AWS::SQS::Queue');
    expect(queue.Properties).toMatchObject({
      QueueName: 'bc-events',
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1_209_600,
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['IntakeDeadLetterQueue', 'Arn'] } },
    });
    expect(resources.IntakeDeadLetterQueue!.Properties).toMatchObject({
      QueueName: 'bc-events-dlq',
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1_209_600,
    });
    const rules = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::Events::Rule');
    expect(rules.map(([name]) => name).sort()).toEqual(['Ec2Events', 'HealthEvents']);
    for (const [, rule] of rules)
      expect(rule.Properties.Targets).toEqual([
        { Id: 'better-compute-intake', Arn: { 'Fn::GetAtt': ['IntakeQueue', 'Arn'] } },
      ]);
    const policy = resources.IntakeQueuePolicy!.Properties.PolicyDocument;
    const allow = policy.Statement.find((s: any) => s.Effect === 'Allow');
    expect(allow).toMatchObject({
      Principal: { Service: 'events.amazonaws.com' },
      Action: 'sqs:SendMessage',
      Condition: {
        ArnEquals: {
          'aws:SourceArn': [
            { 'Fn::GetAtt': ['Ec2Events', 'Arn'] },
            { 'Fn::GetAtt': ['HealthEvents', 'Arn'] },
          ],
        },
        StringEquals: { 'aws:SourceAccount': '123456789012' },
      },
    });
    expect(policy.Statement.find((s: any) => s.Effect === 'Deny')).toMatchObject({
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    });
    expect(template.Outputs).toMatchObject({ QueueUrl: { Value: { Ref: 'IntakeQueue' } } });
  });

  it('every detail type the rules send maps to an event', () => {
    const template = eventRulesTemplate({
      queueName: 'bc-events',
      account: '123456789012',
      apiCalls: true,
      guardDuty: true,
    });
    const resources = template.Resources as Record<string, Resource>;
    expect(Object.keys(resources).filter((name) => resources[name]!.Type === 'AWS::Events::Rule').sort()).toEqual([
      'ApiCalls',
      'Ec2Events',
      'GuardDutyFindings',
      'HealthEvents',
    ]);
    const filter = {
      account: '123456789012',
      region: 'us-east-1',
      sources: new Set(['aws.ec2', 'aws.health', 'aws.guardduty']),
    };
    const ec2Types = resources.Ec2Events!.Properties.EventPattern['detail-type'].filter(
      (type: unknown) => typeof type === 'string',
    );
    for (const type of ec2Types) {
      const mapped = mapEventBridgeEnvelope(
        {
          id: 'e',
          'detail-type': type,
          source: 'aws.ec2',
          account: '123456789012',
          region: 'us-east-1',
          time: '2026-10-01T12:00:00Z',
          detail: { 'instance-id': 'i-0abc12345678def01', 'capacity-reservation-id': 'cr-0123456789abcdef0' },
        },
        filter,
      );
      expect(mapped, type).toHaveProperty('events');
    }
    expect(resources.ApiCalls!.Properties.EventPattern).toMatchObject({
      source: ['aws.ec2'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { eventSource: ['ec2.amazonaws.com'] },
    });
  });

  it('refuses a bad queue name or account', () => {
    expect(() => eventRulesTemplate({ queueName: 'a b', account: '123456789012' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => eventRulesTemplate({ queueName: 'x'.repeat(80), account: '123456789012' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => eventRulesTemplate({ queueName: 'q', account: '1234' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('the command prints or writes the template', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-rules-'));
    dirs.push(dir);
    const out: string[] = [];
    const notes: string[] = [];
    const context = (flags: AwsCommandContext['flags']): AwsCommandContext => ({
      flags,
      io: { out: (message) => out.push(message) },
      note: (message) => notes.push(message),
      path: (value) => join(dir, value),
    });
    const command = awsEventRulesCommand();
    expect(command.name).toBe('aws event-rules');
    await command.run(context({ 'queue-name': 'bc-events', account: '123456789012' }));
    expect(JSON.parse(out[0]!).AWSTemplateFormatVersion).toBe('2010-09-09');
    await command.run(
      context({ 'queue-name': 'bc-events', account: '123456789012', 'api-calls': true, out: 'stack.json' }),
    );
    const written = JSON.parse(readFileSync(join(dir, 'stack.json'), 'utf8'));
    expect(written.Resources.ApiCalls.Type).toBe('AWS::Events::Rule');
    await expect(command.run(context({ account: '123456789012' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('the IAM policy allows the intake reads', () => {
    const plain = iamPolicy();
    const scheduled = plain.Statement.find((s) => s.Sid === 'ScheduledEvents')!;
    expect(scheduled).toMatchObject({ Action: 'ec2:DescribeInstanceStatus', Resource: '*' });
    expect(plain.Statement.find((s) => s.Sid === 'EventIntake')).toBeUndefined();
    const withQueue = iamPolicy({ region: 'us-east-1', account: '123456789012', eventQueue: 'bc-events' });
    expect(withQueue.Statement.find((s) => s.Sid === 'EventIntake')).toEqual({
      Sid: 'EventIntake',
      Effect: 'Allow',
      Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'],
      Resource: 'arn:aws:sqs:us-east-1:123456789012:bc-events',
    });
    expect(() => iamPolicy({ eventQueue: 'bad name' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});
