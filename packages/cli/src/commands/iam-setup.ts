import {
  computeMeters,
  examplePolicies,
  setupIamMeters,
  type IamSetupApi,
} from '@better-compute/iam';
import { gpuModelFamilies } from '@better-compute/inventory';
import { importOptional } from '../config.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';

interface IamClientModule {
  createIamClient(options: {
    baseURL: string;
    basePath?: string;
    token?: string;
    fetch?: typeof globalThis.fetch;
  }): {
    billing: {
      listMeters(input: { tenantId: string }): Promise<{ key: string }[]>;
      createMeter(input: {
        tenantId: string;
        key: string;
        name: string;
        unit: string;
      }): Promise<unknown>;
    };
  };
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const iamSetupCommands = [
  defineCommand({
    name: 'iam setup',
    group: 'IAM',
    summary: 'Print the example compute policies and create the root billing meters in better-iam',
    description:
      "iam setup prints the PLAN.md §12.6 example policies, gpu-user and agent-guardrails, for an organization administrator to apply: compute cannot write organization policies. The policies are parameterized by the session JWT audience (the compute API's URL), the GPU model, regions and limits of the bounded-reservation statement. With --meters it also creates the §12.7 root meters in better-iam: one gpu.<model>.hours per GPU model family, plus node.metal.hours, vps.vcpu.hours and vps.memory.gib.hours. Meters that already exist are left alone, so re-running is safe. Creating meters calls better-iam at --iam-url as BETTER_IAM_TOKEN, which must be a root credential, through the optional peer @better-iam/client. It sets no prices: pricing is an operator decision (billing.setPrice).",
    flags: {
      audience: {
        type: 'string',
        value: 'URL',
        env: 'BETTER_COMPUTE_BASE_URL',
        required: true,
        description: 'The compute API URL, used as the session JWT audience',
      },
      'gpu-model': {
        type: 'string',
        value: 'MODEL',
        default: 'H100',
        description: 'GPU model family the bounded-reservation statement allows',
      },
      regions: {
        type: 'string',
        value: 'LIST',
        description: 'Regions the bounded-reservation statement allows, comma-separated',
      },
      'max-gpus': {
        type: 'integer',
        value: 'N',
        min: 1,
        default: 8,
        description: 'GPUs per reservation',
      },
      'max-hours': {
        type: 'integer',
        value: 'N',
        min: 1,
        default: 72,
        description: 'Hours per reservation, extensions included',
      },
      feature: {
        type: 'string',
        value: 'FLAG',
        description: 'Tenant feature the reservation statement requires (default compute.<model>)',
      },
      meters: { type: 'boolean', description: 'Also create the root billing meters in better-iam' },
      'iam-url': {
        type: 'string',
        value: 'URL',
        env: 'BETTER_IAM_URL',
        description: 'better-iam base URL for --meters',
      },
      'iam-base-path': {
        type: 'string',
        value: 'PATH',
        default: '/api/iam',
        description: "better-iam's API base path",
      },
      'root-tenant': {
        type: 'string',
        value: 'ID',
        env: 'BETTER_COMPUTE_ROOT_TENANT',
        description: 'The root tenant that owns the meters (required with --meters)',
      },
      'gpu-models': {
        type: 'string',
        value: 'LIST',
        description: 'GPU model families to meter, comma-separated (default: every known family)',
      },
    },
    examples: [
      'better-compute iam setup --audience https://compute.example.com --query "[0]"',
      'BETTER_IAM_TOKEN=... better-compute iam setup --audience https://compute.example.com --meters --iam-url https://iam.example.com --root-tenant ten_root',
    ],
    validate(flags) {
      if (!flags.meters) return;
      if (!flags['iam-url']) throw usageError('--meters needs --iam-url (or BETTER_IAM_URL)');
      if (!flags['root-tenant'])
        throw usageError('--meters needs --root-tenant (or BETTER_COMPUTE_ROOT_TENANT)');
    },
    async run({ flags, env, io }) {
      let audience: string;
      try {
        audience = new URL(flags.audience!).origin;
      } catch {
        throw usageError('--audience must be a URL');
      }
      const regions = list(flags.regions);
      const policies = examplePolicies({
        audience,
        gpuModel: flags['gpu-model'] ?? 'H100',
        maxGpus: flags['max-gpus'] ?? 8,
        maxHours: flags['max-hours'] ?? 72,
        ...(regions.length ? { regions } : {}),
        ...(flags.feature ? { feature: flags.feature } : {}),
      });
      if (!flags.meters) return { policies };

      const token = env.BETTER_IAM_TOKEN;
      if (!token)
        throw new CliError(
          'MISSING_ENV',
          'Set BETTER_IAM_TOKEN to a root session token or API key to create meters',
        );
      const models = list(flags['gpu-models']);
      const meters = computeMeters(models.length ? models : [...gpuModelFamilies]);
      const { createIamClient } = await importOptional<IamClientModule>(
        '@better-iam/client',
        'iam setup --meters',
      );
      const client = createIamClient({
        baseURL: flags['iam-url']!,
        basePath: flags['iam-base-path'] ?? '/api/iam',
        token,
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
      // The client binds the credential; setupIamMeters passes it per call the server-side way.
      const api: IamSetupApi = {
        billing: {
          listMeters: (_credential, input) => client.billing.listMeters(input),
          createMeter: (_credential, input) => client.billing.createMeter(input),
        },
      };
      const result = await setupIamMeters(
        api,
        { credential: { token }, tenantId: flags['root-tenant']! },
        meters,
      );
      return { policies, meters: result };
    },
  }),
];
