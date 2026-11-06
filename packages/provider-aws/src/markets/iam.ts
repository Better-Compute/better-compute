import type { AwsPartition } from '@better-compute/aws-core';
import type { IamStatement } from '../cli.js';
import { tags } from '../ids.js';

// The capacity-market statements of `aws iam-policy` (AWS A3). Always: the reservation, Capacity
// Block offering and Spot price reads (EC2 describes), the vCPU quota reads, and launching into a
// capacity reservation. With `spot`: Spot launches and EC2's Spot service-linked role. With
// `pricing`: the Price List. With `purchases`: buying Capacity Blocks and creating ODCRs, only when
// the request tags them better-compute:managed=true.

export interface MarketPolicyOptions {
  partition: AwsPartition;
  /** A region or `*`. */
  region: string;
  /** An account id or `*`. */
  account: string;
  spot?: boolean;
  pricing?: boolean;
  purchases?: boolean;
}

export function marketStatements(options: MarketPolicyOptions): IamStatement[] {
  const { partition, region, account } = options;
  const ec2 = (resource: string) => `arn:${partition}:ec2:${region}:${account}:${resource}`;
  const reservations = ec2('capacity-reservation/*');
  const statements: IamStatement[] = [
    {
      Sid: 'MarketReads',
      Effect: 'Allow',
      Action: [
        'ec2:DescribeCapacityReservations',
        'ec2:DescribeCapacityBlockOfferings',
        'ec2:DescribeSpotPriceHistory',
      ],
      Resource: '*',
    },
    {
      Sid: 'Quotas',
      Effect: 'Allow',
      Action: 'servicequotas:GetServiceQuota',
      Resource: `arn:${partition}:servicequotas:${region}:${account}:ec2/*`,
    },
    {
      // A launch that targets a reservation names it; the instance stays guarded by RunTagged.
      Sid: 'RunInReservations',
      Effect: 'Allow',
      Action: 'ec2:RunInstances',
      Resource: reservations,
    },
  ];
  if (options.spot)
    statements.push(
      {
        Sid: 'RunSpot',
        Effect: 'Allow',
        Action: 'ec2:RunInstances',
        Resource: ec2('spot-instances-request/*'),
      },
      {
        // EC2 creates AWSServiceRoleForEC2Spot on the first Spot launch of an account.
        Sid: 'SpotServiceRole',
        Effect: 'Allow',
        Action: 'iam:CreateServiceLinkedRole',
        Resource: `arn:${partition}:iam::${account}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot`,
        Condition: { StringEquals: { 'iam:AWSServiceName': 'spot.amazonaws.com' } },
      },
    );
  if (options.pricing)
    statements.push({
      // The Price List has no resource-level permissions.
      Sid: 'Prices',
      Effect: 'Allow',
      Action: 'pricing:GetProducts',
      Resource: '*',
    });
  if (options.purchases)
    statements.push(
      {
        // Spends money. (verify) the resource types PurchaseCapacityBlock authorizes against.
        Sid: 'BuyCapacity',
        Effect: 'Allow',
        Action: ['ec2:CreateCapacityReservation', 'ec2:PurchaseCapacityBlock'],
        Resource: [reservations, ec2('capacity-block-offering/*')],
        Condition: { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } },
      },
      {
        Sid: 'TagBoughtCapacity',
        Effect: 'Allow',
        Action: 'ec2:CreateTags',
        Resource: reservations,
        Condition: {
          StringEquals: {
            'ec2:CreateAction': ['CreateCapacityReservation', 'PurchaseCapacityBlock'],
          },
        },
      },
    );
  return statements;
}
