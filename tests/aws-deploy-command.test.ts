import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { awsDeployTemplatesCommand, deploymentTemplates, lintTemplate } from '@better-compute/aws';

// `better-compute aws deploy-templates --out <dir>`: writes the three A12 stacks as new
// CloudFormation JSON files and prints the order to deploy them in. It makes no AWS call.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function run(flags: Record<string, string | number | boolean | undefined>) {
  const dir = await mkdtemp(join(tmpdir(), 'bc-aws-deploy-'));
  dirs.push(dir);
  const out: string[] = [];
  const notes: string[] = [];
  await awsDeployTemplatesCommand().run({
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => join(dir, value),
  });
  return { dir, out, notes };
}

describe('deploymentTemplates', () => {
  it('renders network, data and control-plane in deploy order, each linting clean', () => {
    const templates = deploymentTemplates({ name: 'bc-prod' });
    expect(templates.map((entry) => [entry.stack, entry.file])).toEqual([
      ['network', 'network.json'],
      ['data', 'data.json'],
      ['control-plane', 'control-plane.json'],
    ]);
    for (const entry of templates) expect(lintTemplate(entry.template)).toEqual([]);
  });

  it('every import names an export of an earlier stack', () => {
    const templates = deploymentTemplates();
    const exported = new Map<string, Set<string>>();
    const parameterFor: Record<string, string> = { NetworkStack: 'network', DataStack: 'data' };
    for (const entry of templates) {
      const text = JSON.stringify(entry.template);
      for (const match of text.matchAll(/"Fn::ImportValue":\{"Fn::Sub":"\$\{(\w+)\}-(\w+)"\}/g)) {
        const stack = parameterFor[match[1]!]!;
        expect(exported.get(stack)?.has(match[2]!), `${entry.stack} imports ${stack}-${match[2]}`).toBe(true);
      }
      exported.set(entry.stack, new Set(Object.entries(entry.template.Outputs ?? {}).filter(([, output]) => output.Export).map(([name]) => name)));
    }
  });
});

describe('aws deploy-templates', () => {
  it('writes the three templates and prints the deploy commands', async () => {
    const { dir, notes } = await run({ out: 'cfn', name: 'bc-prod', zones: 2, nat: 'single', readers: 0 });
    expect((await readdir(join(dir, 'cfn'))).sort()).toEqual(['control-plane.json', 'data.json', 'network.json']);
    const network = JSON.parse(await readFile(join(dir, 'cfn', 'network.json'), 'utf8'));
    expect(network.Description).toContain('bc-prod');
    expect(Object.values(network.Resources as Record<string, { Type: string }>).filter((entry) => entry.Type === 'AWS::EC2::NatGateway')).toHaveLength(1);
    const data = JSON.parse(await readFile(join(dir, 'cfn', 'data.json'), 'utf8'));
    expect(Object.keys(data.Resources)).not.toContain('ReaderInstance0');
    const text = notes.join('\n');
    expect(text).toContain('aws cloudformation deploy --stack-name bc-prod-network --template-file');
    expect(text).toContain('NetworkStack=bc-prod-network DataStack=bc-prod-data');
    expect(text).toContain('--capabilities CAPABILITY_IAM');
  });

  it('says when a template is over the inline body limit and --compact keeps it under', async () => {
    const pretty = await run({ out: 'cfn' });
    expect(pretty.notes.join('\n')).toMatch(/control-plane\.json is over 51200 bytes.*--s3-bucket/);
    const compact = await run({ out: 'cfn', compact: true });
    expect(compact.notes.join('\n')).not.toMatch(/over 51200 bytes/);
    const size = (await readFile(join(compact.dir, 'cfn', 'control-plane.json'))).byteLength;
    expect(size).toBeLessThanOrEqual(51_200);
  });

  it('never overwrites an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-aws-deploy-'));
    dirs.push(dir);
    await writeFile(join(dir, 'data.json'), 'keep');
    await expect(
      awsDeployTemplatesCommand().run({ flags: { out: '.' }, io: { out: () => {} }, note: () => {}, path: (value) => join(dir, value) }),
    ).rejects.toThrow(/data\.json exists/);
    expect(await readFile(join(dir, 'data.json'), 'utf8')).toBe('keep');
    // Nothing is half-written: the check runs before any file is created.
    expect((await readdir(dir)).sort()).toEqual(['data.json']);
  });

  it('refuses a bad name, zone count or NAT mode before writing', async () => {
    await expect(run({ out: 'x', name: 'Bad Name' })).rejects.toThrow(/deployment name/);
    await expect(run({ out: 'x', zones: 5 })).rejects.toThrow(/zones/);
    await expect(run({ out: 'x', nat: 'none' })).rejects.toThrow(/natGateways|--nat/);
    await expect(run({})).rejects.toThrow(/--out/);
  });
});
