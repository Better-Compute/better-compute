// The `network` stack: one VPC across the deployment's zones, a public and a private subnet per
// zone, NAT for the private side, the S3 gateway endpoint and interface endpoints for the AWS
// services every process calls, and VPC flow logs. Exports the ids the other stacks import.
import {
  assertTemplate,
  cfnAz,
  cfnExport,
  cfnGetAtt,
  cfnJoin,
  cfnRef,
  cfnSelect,
  cfnSub,
  deploymentTags,
  type CfnResource,
  type CfnTemplate,
} from './cfn.js';
import { policyDocument, serviceTrust } from './policy.js';
import { resolveDeploymentOptions, zoneIndexes, type AwsDeploymentOptions } from './options.js';

/** Interface endpoints (private DNS) for what the control plane calls on every request path. */
export const networkInterfaceEndpoints = ['secretsmanager', 'kms', 'ecr.api', 'ecr.dkr', 'logs', 'sts'] as const;

const endpointId = (service: string) =>
  `${service
    .split('.')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')}Endpoint`;

export function networkTemplate(options: AwsDeploymentOptions = {}): CfnTemplate {
  const resolved = resolveDeploymentOptions(options);
  const { name } = resolved;
  const zones = zoneIndexes(resolved);
  const tags = (part: string) => deploymentTags(name, part);
  const subnetCidr = (index: number) => cfnSelect(index, { 'Fn::Cidr': [cfnGetAtt('Vpc', 'CidrBlock'), 6, 12] });
  const natFor = (zone: number) => (resolved.natGateways === 'single' ? 0 : zone);
  const resources: Record<string, CfnResource> = {
    Vpc: {
      Type: 'AWS::EC2::VPC',
      Properties: { CidrBlock: cfnRef('VpcCidr'), EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags('vpc') },
    },
    InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags('igw') } },
    GatewayAttachment: {
      Type: 'AWS::EC2::VPCGatewayAttachment',
      Properties: { VpcId: cfnRef('Vpc'), InternetGatewayId: cfnRef('InternetGateway') },
    },
    PublicRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: cfnRef('Vpc'), Tags: tags('public') } },
    PublicDefaultRoute: {
      Type: 'AWS::EC2::Route',
      DependsOn: 'GatewayAttachment',
      Properties: { RouteTableId: cfnRef('PublicRouteTable'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: cfnRef('InternetGateway') },
    },
  };
  for (const zone of zones) {
    resources[`PublicSubnet${zone}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: cfnRef('Vpc'),
        AvailabilityZone: cfnAz(zone),
        CidrBlock: subnetCidr(zone),
        MapPublicIpOnLaunch: false,
        Tags: [...tags(`public-${zone}`), { Key: 'better-compute:subnet', Value: 'public' }],
      },
    };
    resources[`PublicSubnet${zone}Routes`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: { SubnetId: cfnRef(`PublicSubnet${zone}`), RouteTableId: cfnRef('PublicRouteTable') },
    };
    resources[`PrivateSubnet${zone}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: cfnRef('Vpc'),
        AvailabilityZone: cfnAz(zone),
        CidrBlock: subnetCidr(3 + zone),
        MapPublicIpOnLaunch: false,
        Tags: [...tags(`private-${zone}`), { Key: 'better-compute:subnet', Value: 'private' }],
      },
    };
    if (natFor(zone) === zone) {
      resources[`NatAddress${zone}`] = {
        Type: 'AWS::EC2::EIP',
        DependsOn: 'GatewayAttachment',
        Properties: { Domain: 'vpc', Tags: tags(`nat-${zone}`) },
      };
      resources[`NatGateway${zone}`] = {
        Type: 'AWS::EC2::NatGateway',
        Properties: {
          AllocationId: cfnGetAtt(`NatAddress${zone}`, 'AllocationId'),
          SubnetId: cfnRef(`PublicSubnet${zone}`),
          Tags: tags(`nat-${zone}`),
        },
      };
    }
    resources[`PrivateRouteTable${zone}`] = {
      Type: 'AWS::EC2::RouteTable',
      Properties: { VpcId: cfnRef('Vpc'), Tags: tags(`private-${zone}`) },
    };
    resources[`PrivateDefaultRoute${zone}`] = {
      Type: 'AWS::EC2::Route',
      Properties: {
        RouteTableId: cfnRef(`PrivateRouteTable${zone}`),
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: cfnRef(`NatGateway${natFor(zone)}`),
      },
    };
    resources[`PrivateSubnet${zone}Routes`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: { SubnetId: cfnRef(`PrivateSubnet${zone}`), RouteTableId: cfnRef(`PrivateRouteTable${zone}`) },
    };
  }
  const privateSubnets = zones.map((zone) => cfnRef(`PrivateSubnet${zone}`));
  const publicSubnets = zones.map((zone) => cfnRef(`PublicSubnet${zone}`));
  const privateRouteTables = zones.map((zone) => cfnRef(`PrivateRouteTable${zone}`));

  resources.S3Endpoint = {
    Type: 'AWS::EC2::VPCEndpoint',
    Properties: {
      VpcEndpointType: 'Gateway',
      VpcId: cfnRef('Vpc'),
      ServiceName: cfnSub('com.amazonaws.${AWS::Region}.s3'),
      RouteTableIds: privateRouteTables,
    },
  };
  resources.EndpointSecurityGroup = {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupDescription: `${name}: HTTPS from the VPC to the interface endpoints`,
      VpcId: cfnRef('Vpc'),
      SecurityGroupIngress: [
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: cfnGetAtt('Vpc', 'CidrBlock'), Description: 'HTTPS from inside the VPC' },
      ],
      Tags: tags('endpoints'),
    },
  };
  for (const service of networkInterfaceEndpoints)
    resources[endpointId(service)] = {
      Type: 'AWS::EC2::VPCEndpoint',
      Properties: {
        VpcEndpointType: 'Interface',
        VpcId: cfnRef('Vpc'),
        ServiceName: cfnSub(`com.amazonaws.\${AWS::Region}.${service}`),
        SubnetIds: privateSubnets,
        SecurityGroupIds: [cfnRef('EndpointSecurityGroup')],
        PrivateDnsEnabled: true,
      },
    };

  resources.FlowLogGroup = {
    Type: 'AWS::Logs::LogGroup',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: { LogGroupName: `/better-compute/${name}/vpc-flow-logs`, RetentionInDays: cfnRef('FlowLogRetentionDays'), Tags: tags('flow-logs') },
  };
  resources.FlowLogRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      Description: `${name}: VPC flow logs delivery`,
      AssumeRolePolicyDocument: serviceTrust('vpc-flow-logs.amazonaws.com'),
      Policies: [
        {
          PolicyName: 'deliver-flow-logs',
          PolicyDocument: policyDocument([
            {
              Effect: 'Allow',
              Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
              Resource: [cfnGetAtt('FlowLogGroup', 'Arn')],
            },
          ]),
        },
      ],
      Tags: tags('flow-logs'),
    },
  };
  resources.FlowLog = {
    Type: 'AWS::EC2::FlowLog',
    Properties: {
      ResourceId: cfnRef('Vpc'),
      ResourceType: 'VPC',
      TrafficType: 'ALL',
      LogDestinationType: 'cloud-watch-logs',
      LogGroupName: cfnRef('FlowLogGroup'),
      DeliverLogsPermissionArn: cfnGetAtt('FlowLogRole', 'Arn'),
      Tags: tags('flow-logs'),
    },
  };

  return assertTemplate('network', {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `better-compute ${name}: network (VPC across ${resolved.zones} zones, NAT, VPC endpoints, flow logs)`,
    Parameters: {
      VpcCidr: {
        Type: 'String',
        Description: 'The VPC CIDR block (a /16; six /20 subnets are carved from it)',
        Default: '10.40.0.0/16',
        AllowedPattern: '^(10|172|192)\\.(\\d{1,3})\\.0\\.0/16$',
        ConstraintDescription: 'a private /16 such as 10.40.0.0/16',
      },
      FlowLogRetentionDays: {
        Type: 'Number',
        Description: 'Days to keep VPC flow logs',
        Default: 90,
        AllowedValues: [30, 60, 90, 180, 365, 731],
      },
    },
    Resources: resources,
    Outputs: {
      ...cfnExport('VpcId', 'The VPC', cfnRef('Vpc')),
      ...cfnExport('VpcCidr', 'The VPC CIDR block', cfnGetAtt('Vpc', 'CidrBlock')),
      ...cfnExport('PublicSubnetIds', 'Public subnets (load balancers), comma-separated', cfnJoin(',', publicSubnets)),
      ...cfnExport('PrivateSubnetIds', 'Private subnets (tasks, database), comma-separated', cfnJoin(',', privateSubnets)),
      ...cfnExport('PrivateRouteTableIds', 'Private route tables, comma-separated', cfnJoin(',', privateRouteTables)),
      ...cfnExport('EndpointSecurityGroupId', 'The interface endpoints security group', cfnRef('EndpointSecurityGroup')),
    },
  });
}
