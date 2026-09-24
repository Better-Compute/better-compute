import { afterEach, describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { gpuModelFamilies } from '@better-compute/inventory';
import { closeIamFixtures, iamFixture, ORIGIN } from './support/iam.js';

// `better-compute iam setup` (PLAN.md §12.6, §12.7): the example policies, and the root meters
// created through @better-iam/client against a real embedded better-iam.

afterEach(closeIamFixtures);

async function run(argv: string[], env: NodeJS.ProcessEnv = {}, fetch?: typeof globalThis.fetch) {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), env, ...(fetch ? { fetch } : {}) };
  try {
    await createCli().run(argv, io);
    return { ok: true as const, value: JSON.parse(out.join('\n')) };
  } catch (error) {
    return {
      ok: false as const,
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
}

describe('iam setup', () => {
  it('prints the two example policies for the compute audience', async () => {
    const result = await run([
      'iam',
      'setup',
      '--audience',
      'https://compute.test/api/compute',
      '--max-gpus',
      '4',
    ]);
    expect(result.ok).toBe(true);
    const policies = result.ok ? result.value.policies : [];
    expect(policies.map((policy: { name: string }) => policy.name)).toEqual([
      'gpu-user',
      'agent-guardrails',
    ]);
    const statements = policies[0].document.statements;
    expect(statements.find((s: { sid: string }) => s.sid === 'AssertToCompute').resources).toEqual([
      'iam/https://compute.test',
    ]);
    expect(
      statements.find((s: { sid: string }) => s.sid === 'ReserveBoundedH100').conditions
        .NumericLessThanEquals['resource.gpuCount'],
    ).toBe(4);
    expect(result.ok && result.value.meters).toBeUndefined();
  });

  it('asks for what --meters needs', async () => {
    expect(await run(['iam', 'setup'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await run(['iam', 'setup', '--audience', 'https://c.test', '--meters'])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
    expect(
      await run([
        'iam',
        'setup',
        '--audience',
        'https://c.test',
        '--meters',
        '--iam-url',
        ORIGIN,
        '--root-tenant',
        't',
      ]),
    ).toMatchObject({ ok: false, code: 'MISSING_ENV' });
  });

  it('creates the root meters once through better-iam’s API, as a root credential', async () => {
    const f = await iamFixture();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      f.iam.handler(new Request(input, init));
    const argv = [
      'iam',
      'setup',
      '--audience',
      'https://compute.test',
      '--meters',
      '--iam-url',
      ORIGIN,
      '--root-tenant',
      f.rootTenantId,
      '--gpu-models',
      'H100,B200',
    ];
    const env = { BETTER_IAM_TOKEN: f.rootCredential.token };
    const first = await run(argv, env, fetch);
    expect(first).toMatchObject({
      ok: true,
      value: {
        meters: {
          created: [
            'gpu.h100.hours',
            'gpu.b200.hours',
            'node.metal.hours',
            'vps.vcpu.hours',
            'vps.memory.gib.hours',
          ],
          existing: [],
        },
      },
    });
    const second = await run(argv, env, fetch);
    expect(second.ok && second.value.meters.created).toEqual([]);
    const keys = (
      await f.iam.api.billing.listMeters(f.rootCredential, { tenantId: f.rootTenantId })
    ).map((meter) => meter.key);
    expect(keys).toEqual(expect.arrayContaining(['gpu.h100.hours', 'vps.memory.gib.hours']));

    // Without --gpu-models every known family gets a meter.
    const all = await run(argv.slice(0, -2), env, fetch);
    expect(all.ok && all.value.meters.created.length + all.value.meters.existing.length).toBe(
      gpuModelFamilies.filter((model) => model !== 'other').length + 3,
    );

    // A tenant owner is not root: better-iam refuses.
    const refused = await run(argv, { BETTER_IAM_TOKEN: f.ownerCredential.token }, fetch);
    expect(refused.ok).toBe(false);
  });
});
