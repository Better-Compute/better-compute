// IAM document helpers for the deployment templates.
import { cfnRef, cfnSub } from './cfn.js';

export interface PolicyStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Principal?: unknown;
  Action: string | readonly string[];
  Resource?: unknown;
  Condition?: Record<string, unknown>;
}

export const policyDocument = (statements: readonly PolicyStatement[]) => ({ Version: '2012-10-17', Statement: statements });

/** A trust policy for one AWS service, confined to this account (the confused-deputy guard). */
export function serviceTrust(service: string) {
  return policyDocument([
    {
      Effect: 'Allow',
      Principal: { Service: service },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'aws:SourceAccount': cfnRef('AWS::AccountId') } },
    },
  ]);
}

/** `arn:${AWS::Partition}:<rest>` (Sub syntax in `rest`). */
export const arn = (rest: string) => cfnSub(`arn:\${AWS::Partition}:${rest}`);

/** A bucket policy statement that refuses every request not made over TLS. */
export function denyInsecureTransport(bucket: string): PolicyStatement {
  return {
    Sid: 'DenyInsecureTransport',
    Effect: 'Deny',
    Principal: '*',
    Action: 's3:*',
    Resource: [cfnSub(`\${${bucket}.Arn}`), cfnSub(`\${${bucket}.Arn}/*`)],
    Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  };
}

/**
 * A KMS key policy that delegates to this account's IAM (the AWS default key policy), plus any
 * service statements the key needs (CloudWatch Logs, SNS publishers).
 */
export function accountKeyPolicy(extra: readonly PolicyStatement[] = []) {
  return policyDocument([
    {
      Sid: 'AccountIam',
      Effect: 'Allow',
      Principal: { AWS: arn('iam::${AWS::AccountId}:root') },
      Action: 'kms:*',
      Resource: '*',
    },
    ...extra,
  ]);
}
