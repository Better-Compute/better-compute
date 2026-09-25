import type { CliManifest } from './framework.js';

// Shell completion scripts (bash, zsh, fish) generated from the command manifest: command words, the flags of the
// command on the line and the values of flags with choices. Only names of a plain shape are emitted (every built-in
// is; a project command with another name is left out), and descriptions are single-quoted with control
// characters removed, so nothing a command defines can run in the user's shell.

const word = /^[a-z][a-z0-9-]*$/;
const flagName = /^--[a-z][a-z0-9-]*$/;
const choice = /^[A-Za-z0-9._:/@+=-]+$/;

interface Entry {
  words: string[];
  summary: string;
  flags: { flag: string; takesValue: boolean; choices: string[]; description: string }[];
}

function entries(manifest: CliManifest): Entry[] {
  return manifest.commands
    .map((command) => ({
      words: command.name.split(' '),
      summary: command.summary,
      flags: command.flags
        .filter((flag) => flagName.test(flag.flag))
        .map((flag) => ({
          flag: flag.flag,
          takesValue: flag.value !== undefined,
          choices: (flag.choices ?? []).filter((item) => choice.test(item)),
          description: flag.description,
        })),
    }))
    .filter((entry) => entry.words.length <= 2 && entry.words.every((part) => word.test(part)));
}

/**
 * Text safe inside single quotes in sh and fish: no control characters, quotes escaped for the target. Word lists
 * (commands, flags, choices) are kept whole; descriptions are cut to one short line.
 */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
const shQuote = (text: string) => `'${plain(text).replace(/'/g, `'\\''`)}'`;
const fishQuote = (text: string) => `'${plain(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const fishText = (text: string) => fishQuote(plain(text).slice(0, 120));

function bash(manifest: CliManifest): string {
  const all = entries(manifest);
  const top = [...new Set(all.map((entry) => entry.words[0]!))].sort();
  const groups = new Map<string, string[]>();
  for (const entry of all)
    if (entry.words.length === 2) groups.set(entry.words[0]!, [...(groups.get(entry.words[0]!) ?? []), entry.words[1]!]);
  const name = (entry: Entry) => entry.words.join(' ');
  const lines = [
    '# better-compute shell completion (bash). Load it with:',
    '#   source <(better-compute completion bash)',
    '_better_compute() {',
    '  local cur prev cmd',
    '  cur=${COMP_WORDS[COMP_CWORD]}',
    '  prev=${COMP_WORDS[COMP_CWORD-1]}',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    COMPREPLY=($(compgen -W ${shQuote(top.join(' '))} -- "$cur"))`,
    '    return',
    '  fi',
    '  cmd=',
    '  case "${COMP_WORDS[1]} ${COMP_WORDS[2]:-}" in',
    ...all.filter((entry) => entry.words.length === 2).map((entry) => `    ${shQuote(name(entry))}) cmd=${shQuote(name(entry))} ;;`),
    '  esac',
    '  if [ -z "$cmd" ]; then',
    '    case "${COMP_WORDS[1]}" in',
    ...all.filter((entry) => entry.words.length === 1).map((entry) => `      ${shQuote(name(entry))}) cmd=${shQuote(name(entry))} ;;`),
    '    esac',
    '  fi',
    '  if [ "$COMP_CWORD" -eq 2 ]; then',
    '    case "${COMP_WORDS[1]}" in',
    ...[...groups].map(
      ([group, subs]) => `      ${shQuote(group)}) COMPREPLY=($(compgen -W ${shQuote(subs.sort().join(' '))} -- "$cur")); return ;;`,
    ),
    '    esac',
    '  fi',
    '  case "$cmd|$prev" in',
    ...all.flatMap((entry) =>
      entry.flags
        .filter((flag) => flag.choices.length)
        .map(
          (flag) =>
            `    ${shQuote(`${name(entry)}|${flag.flag}`)}) COMPREPLY=($(compgen -W ${shQuote(flag.choices.join(' '))} -- "$cur")); return ;;`,
        ),
    ),
    '  esac',
    '  case "$cmd" in',
    ...all.map(
      (entry) =>
        `    ${shQuote(name(entry))}) COMPREPLY=($(compgen -W ${shQuote(entry.flags.map((flag) => flag.flag).join(' '))} -- "$cur")) ;;`,
    ),
    '  esac',
    '}',
    'complete -o default -F _better_compute better-compute',
    '',
  ];
  return lines.join('\n');
}

function zsh(manifest: CliManifest): string {
  return [
    '# better-compute shell completion (zsh), through bash completion. Load it with:',
    '#   source <(better-compute completion zsh)',
    'autoload -U +X bashcompinit && bashcompinit',
    bash(manifest).split('\n').slice(2).join('\n'),
  ].join('\n');
}

function fish(manifest: CliManifest): string {
  const all = entries(manifest);
  const groups = new Map<string, string[]>();
  for (const entry of all)
    if (entry.words.length === 2) groups.set(entry.words[0]!, [...(groups.get(entry.words[0]!) ?? []), entry.words[1]!]);
  const lines = [
    '# better-compute shell completion (fish). Load it with:',
    '#   better-compute completion fish | source',
    'complete -c better-compute -f',
  ];
  const tops = new Map<string, string>();
  for (const entry of all) if (!tops.has(entry.words[0]!)) tops.set(entry.words[0]!, entry.words.length === 1 ? entry.summary : `${entry.words[0]} commands`);
  for (const [top, summary] of [...tops].sort())
    lines.push(`complete -c better-compute -n __fish_use_subcommand -a ${fishQuote(top)} -d ${fishText(summary)}`);
  for (const [group, subs] of groups) {
    const none = `not __fish_seen_subcommand_from ${subs.join(' ')}`;
    for (const entry of all.filter((item) => item.words.length === 2 && item.words[0] === group))
      lines.push(
        `complete -c better-compute -n ${fishQuote(`__fish_seen_subcommand_from ${group}; and ${none}`)} -a ${fishQuote(entry.words[1]!)} -d ${fishText(entry.summary)}`,
      );
  }
  for (const entry of all) {
    const when =
      entry.words.length === 2
        ? `__fish_seen_subcommand_from ${entry.words[0]}; and __fish_seen_subcommand_from ${entry.words[1]}`
        : `__fish_seen_subcommand_from ${entry.words[0]}`;
    for (const flag of entry.flags)
      lines.push(
        `complete -c better-compute -n ${fishQuote(when)} -l ${flag.flag.slice(2)}${flag.takesValue ? ' -r' : ''}${
          flag.choices.length ? ` -a ${fishQuote(flag.choices.join(' '))}` : ''
        } -d ${fishText(flag.description)}`,
      );
  }
  lines.push('');
  return lines.join('\n');
}

/** The completion script for `shell`. */
export function completionScript(shell: 'bash' | 'zsh' | 'fish', manifest: CliManifest): string {
  return shell === 'bash' ? bash(manifest) : shell === 'zsh' ? zsh(manifest) : fish(manifest);
}
