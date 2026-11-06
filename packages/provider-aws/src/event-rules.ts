import { writeFile } from 'node:fs/promises';
import { ComputeError, type Json } from '@better-compute/core';
import type { AwsCommandContext } from './cli.js';

// `aws event-rules` (A4, AD12): the CloudFormation stack a customer deploys in the AWS account to
// feed that account's intake queue. The queue and its dead-letter queue are SSE-SQS encrypted and
// keep messages 14 days; EventBridge rules for EC2 (state changes, Spot interruption warnings,
// rebalance recommendations, Capacity Reservation events) and AWS Health EC2 events (plus, opted in,
// CloudTrail EC2 API calls and GuardDuty findings) target the queue; and the queue policy lets only
// events.amazonaws.com send, only from those rules in this account, only over TLS. The account
// config then names the queue URL (stack output QueueUrl) as eventQueueUrl.

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);

/** EC2 detail types the Ec2Events rule sends (Capacity Reservation types by prefix: unverified names). */
export const ec2EventDetailTypes = [
  'EC2 Instance State-change Notification',
  'EC2 Spot Instance Interruption Warning',
  'EC2 Instance Rebalance Recommendation',
] as const;

/** The EC2 API calls the opt-in ApiCalls rule sends (what changes an instance out of band). */
const apiCallNames = [
  'TerminateInstances',
  'StopInstances',
  'StartInstances',
  'RebootInstances',
  'ModifyInstanceAttribute',
  'ModifyInstanceMetadataOptions',
];

const fourteenDays = 14 * 86_400;

export interface EventRulesOptions {
  /** The intake queue's name (the DLQ is `<name>-dlq`). */
  queueName: string;
  /** The AWS account the stack is deployed in (the queue policy's aws:SourceAccount). */
  account: string;
  /** Also send CloudTrail EC2 instance API calls (needs a CloudTrail trail with management events). */
  apiCalls?: boolean;
  /** Also send GuardDuty findings (the account then lists aws.guardduty in eventSources). */
  guardDuty?: boolean;
}

/** The CloudFormation template (JSON) of an account's event intake. */
export function eventRulesTemplate(options: EventRulesOptions): Record<string, Json> {
  // 80 characters at most, the DLQ suffix included.
  if (!/^[A-Za-z0-9_-]{1,75}$/.test(String(options.queueName)))
    throw usage('--queue-name is 1 to 75 characters of [A-Za-z0-9_-]');
  if (!/^\d{12}$/.test(String(options.account)))
    throw usage('--account is a 12-digit AWS account id');
  const queueArn = { 'Fn::GetAtt': ['IntakeQueue', 'Arn'] };
  const target = [{ Id: 'better-compute-intake', Arn: queueArn }];
  const rule = (description: string, pattern: Record<string, Json>) => ({
    Type: 'AWS::Events::Rule',
    Properties: { Description: description, State: 'ENABLED', EventPattern: pattern, Targets: target },
  });
  const rules: Record<string, Json> = {
    Ec2Events: rule('better-compute: EC2 state changes, Spot interruptions, rebalance and Capacity Reservation events', {
      source: ['aws.ec2'],
      'detail-type': [
        ...ec2EventDetailTypes,
        { prefix: 'EC2 Capacity Reservation' },
        { prefix: 'EC2 ODCR' },
        { prefix: 'EC2 Capacity Block' },
      ],
    }),
    HealthEvents: rule('better-compute: AWS Health events for EC2 (scheduled maintenance)', {
      source: ['aws.health'],
      'detail-type': ['AWS Health Event'],
      detail: { service: ['EC2'] },
    }),
  };
  if (options.apiCalls)
    rules.ApiCalls = rule('better-compute: EC2 instance API calls (CloudTrail)', {
      source: ['aws.ec2'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { eventSource: ['ec2.amazonaws.com'], eventName: apiCallNames },
    });
  if (options.guardDuty)
    rules.GuardDutyFindings = rule('better-compute: GuardDuty findings', {
      source: ['aws.guardduty'],
      'detail-type': ['GuardDuty Finding'],
    });
  const ruleArns = Object.keys(rules).map((name) => ({ 'Fn::GetAtt': [name, 'Arn'] }));
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `better-compute event intake for AWS account ${options.account}: EventBridge rules feeding SQS queue ${options.queueName}`,
    Resources: {
      IntakeDeadLetterQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: `${options.queueName}-dlq`,
          SqsManagedSseEnabled: true,
          MessageRetentionPeriod: fourteenDays,
        },
      },
      IntakeQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: options.queueName,
          SqsManagedSseEnabled: true,
          MessageRetentionPeriod: fourteenDays,
          // better-compute long-polls 10 s and acks after its transaction: a minute covers a run.
          ReceiveMessageWaitTimeSeconds: 10,
          VisibilityTimeout: 60,
          RedrivePolicy: {
            deadLetterTargetArn: { 'Fn::GetAtt': ['IntakeDeadLetterQueue', 'Arn'] },
            maxReceiveCount: 5,
          },
        },
      },
      IntakeQueuePolicy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'IntakeQueue' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'EventBridgeRulesOnly',
                Effect: 'Allow',
                Principal: { Service: 'events.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: queueArn,
                Condition: {
                  ArnEquals: { 'aws:SourceArn': ruleArns },
                  StringEquals: { 'aws:SourceAccount': options.account },
                },
              },
              {
                Sid: 'TlsOnly',
                Effect: 'Deny',
                Principal: '*',
                Action: 'sqs:*',
                Resource: queueArn,
                Condition: { Bool: { 'aws:SecureTransport': 'false' } },
              },
            ],
          },
        },
      },
      ...rules,
    },
    Outputs: {
      QueueUrl: {
        Description: "The provider account's eventQueueUrl",
        Value: { Ref: 'IntakeQueue' },
      },
      QueueArn: { Value: queueArn },
    },
  };
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

/** `better-compute aws event-rules --queue-name <name> --account <id>`: the intake stack, as JSON. */
export function awsEventRulesCommand() {
  return {
    name: 'aws event-rules' as const,
    group: 'Providers' as const,
    summary: "Print the CloudFormation stack that feeds an AWS account's event intake queue",
    description:
      "aws event-rules prints a CloudFormation template (JSON) to deploy in the AWS account: the SQS intake queue --queue-name (SSE-SQS, 14-day retention, a dead-letter queue after 5 receives), EventBridge rules for EC2 state changes, Spot interruption warnings, rebalance recommendations, Capacity Reservation events and AWS Health EC2 events, and a queue policy that lets only events.amazonaws.com send, only from those rules in --account, only over TLS. --api-calls adds CloudTrail EC2 instance API calls, --guardduty GuardDuty findings (list aws.guardduty in the account's eventSources). Set the stack's QueueUrl output as the provider account's eventQueueUrl, and grant the account's role sqs:ReceiveMessage and sqs:DeleteMessage on it (aws iam-policy --event-queue).",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      'queue-name': {
        type: 'string' as const,
        value: 'NAME',
        required: true,
        description: 'The intake queue name (its dead-letter queue is <name>-dlq)',
      },
      account: {
        type: 'string' as const,
        value: 'ID',
        required: true,
        description: 'The AWS account the stack is deployed in',
      },
      'api-calls': {
        type: 'boolean' as const,
        description: 'Also send CloudTrail EC2 instance API calls (needs a trail with management events)',
      },
      guardduty: { type: 'boolean' as const, description: 'Also send GuardDuty findings' },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the template to this new file instead of the output',
      },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const queueName = text(context.flags['queue-name']);
      const account = text(context.flags.account);
      if (!queueName) throw usage('--queue-name is required');
      if (!account) throw usage('--account is required');
      const json = `${JSON.stringify(
        eventRulesTemplate({
          queueName,
          account,
          apiCalls: context.flags['api-calls'] === true,
          guardDuty: context.flags.guardduty === true,
        }),
        null,
        2,
      )}\n`;
      const out = text(context.flags.out);
      if (!out) {
        context.io.out(json.trimEnd());
        return;
      }
      const file = context.path(out);
      try {
        await writeFile(file, json, { flag: 'wx', mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw usage(`--out ${out} exists; give a new file`);
        throw error;
      }
      context.note(`wrote ${file}`);
    },
  };
}
