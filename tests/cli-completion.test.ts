import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, defineCommand } from '@better-compute/cli';
import { completionScript } from '../packages/cli/src/completion.js';
import { manifestOf } from '../packages/cli/src/framework.js';

// `better-compute completion bash|zsh|fish` (the CLI's own words, flags and choices), and that nothing a command
// defines reaches the shell as code.

async function completion(shell: string) {
  const out: string[] = [];
  await createCli().run(['completion', shell], { out: (line) => out.push(line), env: {} });
  return out.join('\n');
}

const bashes = ['/bin/bash', '/usr/bin/bash', 'C:/Program Files/Git/bin/bash.exe'].filter((path) =>
  existsSync(path),
);

describe('completion', () => {
  it('completes words, flags and choices in bash (and zsh through bashcompinit)', async () => {
    const script = await completion('bash');
    expect(script).toContain('complete -o default -F _better_compute better-compute');
    expect(script).toMatch(/COMPREPLY=\(\$\(compgen -W '[^']*\bnodes\b[^']*' -- "\$cur"\)\)/);
    expect(script).toContain(`'nodes list|--state') COMPREPLY=($(compgen -W 'adopting adopted`);
    expect(await completion('zsh')).toContain('bashcompinit');
    const bash = bashes[0];
    if (!bash) return;
    // Drive the function the way bash's completion does.
    const dir = await mkdtemp(join(tmpdir(), 'bc-completion-'));
    const complete = async (words: string[]) => {
      await writeFile(
        join(dir, 'run.sh'),
        [
          script,
          `COMP_WORDS=(${words.map((w) => `'${w}'`).join(' ')})`,
          `COMP_CWORD=${words.length - 1}`,
          '_better_compute',
          'printf "%s\\n" "${COMPREPLY[@]}"',
        ].join('\n'),
      );
      const result = spawnSync(bash, [join(dir, 'run.sh')], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      return result.stdout.split('\n').filter(Boolean);
    };
    expect(await complete(['better-compute', 'nod'])).toEqual(['nodes']);
    expect(await complete(['better-compute', 'nodes', 'co'])).toEqual(['cordon']);
    expect(await complete(['better-compute', 'nodes', 'list', '--st'])).toEqual(['--state']);
    expect(await complete(['better-compute', 'nodes', 'list', '--state', 'dep'])).toEqual([
      'deploying',
      'deployed',
    ]);
    expect(await complete(['better-compute', 'reserve', '--po'])).toEqual(['--pool']);
  });

  it('completes in fish', async () => {
    const script = await completion('fish');
    expect(script).toContain("complete -c better-compute -n __fish_use_subcommand -a 'nodes'");
    expect(script).toMatch(
      /-n '__fish_seen_subcommand_from nodes; and __fish_seen_subcommand_from list' -l state -r -a 'adopting /,
    );
  });

  it('never lets a command’s name or text become shell code', () => {
    const evil = defineCommand({
      name: 'evil',
      summary: "it's $(rm -rf ~) `id`\u001b[2J",
      flags: {
        mode: {
          type: 'string',
          choices: ['ok', "x';reboot;'"],
          description: "a ' quote\nand a newline",
        },
        'bad;flag': { type: 'boolean', description: 'dropped' },
      },
      run: () => undefined,
    });
    const odd = defineCommand({ name: 'odd;name', summary: 'dropped', run: () => undefined });
    const manifest = manifestOf([evil, odd], '0.0.0');
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = completionScript(shell, manifest);
      expect(script).not.toContain('odd;name');
      expect(script).not.toContain('bad;flag');
      expect(script).not.toContain("x';reboot");
      expect(script).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    }
    // The summary is quoted: its $( ) and quote are inert text inside single quotes.
    expect(completionScript('fish', manifest)).toContain("-d 'it\\'s $(rm -rf ~) `id` [2J'");
  });

  it('refuses an unknown shell', async () => {
    await expect(completion('powershell')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
