import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { awsDeployTemplatesCommand, deploymentTemplates, lintTemplate } from '@better-compute/aws';
import { createCli } from '@better-compute/cli';

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

  it('says when a template is over the inline body limit, and offers --compact only when that would fit', async () => {
    // The control-plane body grows with the deployment name; at the longest name even the minified body is over.
    for (const name of ['better-compute', 'x'.repeat(28)]) {
      const compactBytes = Buffer.byteLength(JSON.stringify(deploymentTemplates({ name }).find((entry) => entry.stack === 'control-plane')!.template));
      const pretty = (await run({ out: 'cfn', name })).notes.join('\n');
      expect(pretty, name).toMatch(/control-plane\.json is over 51200 bytes.*pass --s3-bucket <bucket> to aws cloudformation deploy/);
      if (compactBytes > 51_200) expect(pretty, name).not.toContain('--compact');
      const compact = await run({ out: 'cfn', name, compact: true });
      const size = (await readFile(join(compact.dir, 'cfn', 'control-plane.json'))).byteLength;
      expect(size, name).toBe(compactBytes);
      const notes = compact.notes.join('\n');
      if (size > 51_200) {
        expect(notes, name).toMatch(/control-plane\.json is over 51200 bytes.*pass --s3-bucket/);
        expect(notes, name).not.toMatch(/or render with --compact/);
      } else expect(notes, name).not.toMatch(/over 51200 bytes/);
    }
    // A 28-character name is over the limit even minified: --compact is never promised to fit.
    expect(awsDeployTemplatesCommand().flags.compact.description).not.toMatch(/fits/);
  });

  it('prints a control-plane deploy line that uploads the template through an S3 bucket', async () => {
    const text = (await run({ out: 'cfn', name: 'bc-prod' })).notes.join('\n');
    const line = text.split('\n').find((entry) => entry.includes('--stack-name bc-prod-control-plane'))!;
    expect(line).toContain('--s3-bucket <bucket>');
    expect(line).toContain('--capabilities CAPABILITY_IAM');
  });

  it('runs as a CLI command a configuration module exports (export const commands = [awsDeployTemplatesCommand()])', async () => {
    // The CLI does not build the aws commands in; a configuration module's `commands` export adds them, which
    // is the same as passing them to createCli. The flags parse with the CLI's own rules.
    const dir = await mkdtemp(join(tmpdir(), 'bc-aws-deploy-'));
    dirs.push(dir);
    const out: string[] = [];
    const err: string[] = [];
    const cli = createCli({ commands: [awsDeployTemplatesCommand()] });
    await cli.run(['aws', 'deploy-templates', '--out', 'cfn', '--name', 'bc-cli', '--zones', '2', '--nat', 'single', '--compact'], {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
      cwd: dir,
    });
    expect((await readdir(join(dir, 'cfn'))).sort()).toEqual(['control-plane.json', 'data.json', 'network.json']);
    expect(JSON.parse(await readFile(join(dir, 'cfn', 'network.json'), 'utf8')).Description).toContain('bc-cli');
    expect(cli.help('aws deploy-templates')).toContain('--out');
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

describe('apps/docs operations/deploy-aws.mdx', () => {
  // The page's configuration example is never run; this keeps it to what the task definitions actually set.
  const page = async () => {
    const text = await readFile(join(import.meta.dirname, '..', 'apps', 'docs', 'content', 'docs', 'operations', 'deploy-aws.mdx'), 'utf8');
    const section = text.slice(text.indexOf('## The configuration in the image'), text.indexOf('## Alarms'));
    const example = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    return { prose: section.slice(0, section.indexOf('```ts')), example };
  };
  const taskEnvironment = () => {
    const template = deploymentTemplates().find((entry) => entry.stack === 'control-plane')!.template;
    const names = new Set<string>();
    for (const resource of Object.values(template.Resources)) {
      if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
      for (const container of (resource.Properties as { ContainerDefinitions: { Environment?: { Name: string }[]; Secrets?: { Name: string }[] }[] }).ContainerDefinitions)
        for (const entry of [...(container.Environment ?? []), ...(container.Secrets ?? [])]) names.add(entry.Name);
    }
    return names;
  };

  it('lists every variable the tasks set, and the example reads only those', async () => {
    const { prose, example } = await page();
    const names = taskEnvironment();
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(prose, name).toContain(`\`${name}\``);
    expect(example.length).toBeGreaterThan(0);
    for (const [, name] of example.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) expect(names.has(name!), `env.${name}`).toBe(true);
  });

  it('the example serves only once the snapshot store can sign download URLs', async () => {
    const { example } = await page();
    // Built before the options, warmed under `serve`, and refusing to start when warm() is false.
    expect(example).toMatch(/const snapshots = s3SnapshotStore\(/);
    expect(example).toMatch(/if \(command === 'serve' && !\(await snapshots\.warm\(\)\)\) throw /);
    expect(example).toContain('vps({ snapshots })');
    expect(example).toMatch(/defineConfig\(async \(\{ command, env = process\.env \} = \{\}\) =>/);
  });
});

describe('deploy/aws/README.md', () => {
  // The runbook's commands are never run by the suite; this keeps their options to what the AWS CLI accepts.
  const commands = async () => {
    const text = await readFile(join(import.meta.dirname, '..', 'deploy', 'aws', 'README.md'), 'utf8');
    const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!);
    return blocks.flatMap((block) => block.replace(/\\\n\s*/g, ' ').split('\n')).map((line) => line.replace(/#.*$/, '').trim());
  };
  const deployOptions = new Set([
    '--template-file', '--stack-name', '--s3-bucket', '--s3-prefix', '--force-upload', '--kms-key-id', '--parameter-overrides',
    '--capabilities', '--no-execute-changeset', '--disable-rollback', '--role-arn', '--notification-arns', '--tags',
    '--fail-on-empty-changeset', '--no-fail-on-empty-changeset', '--region', '--profile',
  ]);

  it('passes aws cloudformation deploy only options it has (no --use-previous-template)', async () => {
    const deploys = (await commands()).filter((line) => line.startsWith('aws cloudformation deploy'));
    expect(deploys.length).toBeGreaterThanOrEqual(4);
    for (const line of deploys)
      for (const option of line.match(/(?<=\s)--[a-z0-9-]+/g) ?? []) expect(deployOptions.has(option), `${option} in: ${line}`).toBe(true);
  });

  it('restores under the same name, adopting every retained resource the template can adopt', async () => {
    const text = await readFile(join(import.meta.dirname, '..', 'deploy', 'aws', 'README.md'), 'utf8');
    const template = deploymentTemplates().find((entry) => entry.stack === 'control-plane')!.template;
    const adoptable = Object.keys(template.Parameters!).filter((name) => name.startsWith('Existing') || name.startsWith('Adopt'));
    expect(adoptable.length).toBeGreaterThanOrEqual(7);
    const restore = (await commands()).find((line) => line.includes('ExistingDeploymentSecretArn='))!;
    for (const name of adoptable) expect(restore, name).toContain(`${name}=`);
    // A new NAME moves the tenant-secret prefix (better-compute/<name>/) away from every stored SecretRef.
    expect(text).not.toMatch(/deploy under a new `NAME`/);
    // Deleting a secret only schedules it: the runbook never asks for that before a redeploy.
    expect(text).not.toMatch(/delete that secret/);
  });

  it('never prints the deployment secret: it goes straight into an environment variable', async () => {
    const reads = (await commands()).filter((line) => line.includes('get-secret-value'));
    expect(reads.length).toBeGreaterThan(0);
    for (const line of reads) {
      expect(line, line).toMatch(/^export BETTER_COMPUTE_SECRET="\$\(aws secretsmanager get-secret-value /);
      expect(line, line).toContain('--query SecretString --output text)"');
    }
  });
});
