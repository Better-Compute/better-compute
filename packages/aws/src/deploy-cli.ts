import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ComputeError } from '@better-compute/core';
import { writeNewFile } from './cli.js';
import type { AwsCommandContext } from './common.js';
import { cfnLimits } from './deploy/cfn.js';
import { resolveDeploymentOptions, type AwsDeploymentOptions } from './deploy/options.js';
import { deploymentTemplates } from './deploy/templates.js';

function text(context: AwsCommandContext, name: string): string | undefined {
  const value = context.flags[name];
  return value === undefined || value === false ? undefined : String(value);
}

function integer(context: AwsCommandContext, name: string): number | undefined {
  const value = text(context, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new ComputeError('INVALID_INPUT', `--${name} must be an integer`);
  return parsed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `better-compute aws deploy-templates --out <dir>`: renders the network, data and control-plane
 * CloudFormation templates (A12) as new files and prints how to deploy them. No AWS call.
 */
export function awsDeployTemplatesCommand() {
  return {
    name: 'aws deploy-templates' as const,
    group: 'Operations' as const,
    summary: 'Write the CloudFormation templates that deploy the control plane on AWS',
    description:
      'aws deploy-templates renders three CloudFormation JSON templates into --out (new files only): network (a VPC across --zones zones, NAT, VPC endpoints, flow logs), data (Aurora PostgreSQL Serverless v2 with IAM auth, KMS-encrypted) and control-plane (ECS Fargate api, worker and gateway services, ALB with WAF, NLB passthrough for the gateway, S3, KMS, EventBridge, alarms). Deploy them in that order; each imports the stacks before it. Runtime values (image, domains, certificate, counts) are stack parameters. It makes no AWS call.',
    flags: {
      out: { type: 'string' as const, value: 'DIR', required: true, description: 'The directory to write network.json, data.json and control-plane.json into' },
      name: { type: 'string' as const, value: 'NAME', default: 'better-compute', description: 'The deployment name (tags, log groups, the ECS cluster, stack names in the hints)' },
      zones: { type: 'integer' as const, min: 2, max: 3, default: 3, description: 'Availability zones to span' },
      nat: { type: 'string' as const, choices: ['per-zone', 'single'], default: 'per-zone', description: 'One NAT gateway per zone, or a single shared one' },
      readers: { type: 'integer' as const, min: 0, max: 2, default: 1, description: 'Aurora reader instances beside the writer' },
      compact: { type: 'boolean' as const, description: 'Write minified JSON. It is smaller, but a body still over the 51200-byte inline limit (control-plane.json) needs --s3-bucket' },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const out = text(context, 'out');
      if (!out) throw new ComputeError('INVALID_INPUT', '--out is required');
      const nat = text(context, 'nat');
      if (nat !== undefined && nat !== 'per-zone' && nat !== 'single')
        throw new ComputeError('INVALID_INPUT', "--nat must be 'per-zone' or 'single'");
      const options: AwsDeploymentOptions = {
        ...(text(context, 'name') !== undefined ? { name: text(context, 'name')! } : {}),
        ...(integer(context, 'zones') !== undefined ? { zones: integer(context, 'zones') as 2 | 3 } : {}),
        ...(nat !== undefined ? { natGateways: nat } : {}),
        ...(integer(context, 'readers') !== undefined ? { readers: integer(context, 'readers') as 0 | 1 | 2 } : {}),
      };
      const { name } = resolveDeploymentOptions(options);
      const compact = context.flags.compact === true || context.flags.compact === 'true';
      const rendered = deploymentTemplates(options).map((entry) => ({
        ...entry,
        body: compact ? JSON.stringify(entry.template) : `${JSON.stringify(entry.template, null, 2)}\n`,
      }));
      const dir = context.path(out);
      // Refuse before writing anything, so a clash never leaves a half-written set.
      for (const entry of rendered)
        if (await exists(join(dir, entry.file)))
          throw new ComputeError('CONFLICT', `${join(out, entry.file)} exists; the command writes only new files`);
      await mkdir(dir, { recursive: true });
      for (const entry of rendered) await writeNewFile(join(dir, entry.file), entry.body);
      const file = (entry: (typeof rendered)[number]) => join(out, entry.file);
      context.note(`Wrote ${rendered.map(file).join(', ')}.`);
      for (const entry of rendered) {
        const bytes = Buffer.byteLength(entry.body, 'utf8');
        if (bytes <= cfnLimits.inlineTemplateBytes) continue;
        // Offer --compact only when the minified body would actually fit (it grows with the deployment name).
        const fitsCompact = !compact && Buffer.byteLength(JSON.stringify(entry.template), 'utf8') <= cfnLimits.inlineTemplateBytes;
        context.note(
          `${entry.file} is over ${cfnLimits.inlineTemplateBytes} bytes (${bytes}): pass --s3-bucket <bucket> to aws cloudformation deploy${fitsCompact ? ', or render with --compact' : ''}.`,
        );
      }
      const [network, data, controlPlane] = rendered as [(typeof rendered)[number], (typeof rendered)[number], (typeof rendered)[number]];
      context.note(
        [
          'Deploy in this order (the control plane starts with zero tasks until the first migrate):',
          `  aws cloudformation deploy --stack-name ${name}-network --template-file ${file(network)} --capabilities CAPABILITY_IAM`,
          `  aws cloudformation deploy --stack-name ${name}-data --template-file ${file(data)} --parameter-overrides NetworkStack=${name}-network`,
          `  aws cloudformation deploy --stack-name ${name}-control-plane --template-file ${file(controlPlane)} --s3-bucket <bucket> --capabilities CAPABILITY_IAM \\`,
          `    --parameter-overrides NetworkStack=${name}-network DataStack=${name}-data Image=<repository>@sha256:<digest> \\`,
          '    ApiDomainName=<api host> GatewayDomainName=<gateway host> CertificateArn=<acm arn> ApiCount=0 WorkerCount=0 GatewayCount=0',
          'Then create the database user, put the sealed PKI bundle, run the migrate task and raise the counts (see deploy/aws/README.md).',
        ].join('\n'),
      );
    },
  };
}
