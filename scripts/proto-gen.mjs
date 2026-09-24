// Lints the protos (proto/bettercompute) and generates the committed TypeScript in
// packages/protocol/src/gen with the pinned buf from node_modules (@bufbuild/buf).
//
//   node scripts/proto-gen.mjs              buf lint + buf generate
//   node scripts/proto-gen.mjs --check      buf lint + buf format check + regenerate into a temp dir;
//                                           fails if the committed generated code differs
//   node scripts/proto-gen.mjs --baseline   writes proto/baseline.binpb (the frozen image buf breaking
//                                           compares against); run only when a release freezes protos
//   node scripts/proto-gen.mjs --breaking [--against <buf input>]
//                                           buf breaking against proto/baseline.binpb, or another input
//                                           such as '.git#branch=main' (needs git on PATH)
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './tooling.mjs';

const generatedDir = 'packages/protocol/src/gen';
const baseline = 'proto/baseline.binpb';

/** Run the buf CLI through its JS entry with the current node; no shell. */
function buf(args, { capture = false } = {}) {
  const manifestPath = resolve(root, 'node_modules', '@bufbuild', 'buf', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = resolve(dirname(manifestPath), manifest.bin.buf);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stdout) process.stderr.write(result.stdout);
    throw new Error(`buf ${args[0]} failed (${result.status})`);
  }
  return result.stdout ?? '';
}

/** Relative paths of every file below `dir`, sorted, with forward slashes. */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(dir, path).split('\\').join('/'));
    }
  };
  walk(dir);
  return files.sort();
}

function check() {
  buf(['lint']);
  const formatDiff = buf(['format', '--diff'], { capture: true });
  if (formatDiff.trim()) {
    process.stderr.write(formatDiff);
    throw new Error(
      'protos are not formatted; run: node node_modules/@bufbuild/buf/bin/buf format -w',
    );
  }
  const temp = mkdtempSync(join(tmpdir(), 'bc-proto-gen-'));
  try {
    buf(['generate', '--output', temp]);
    const expectedDir = join(temp, generatedDir);
    const actualDir = join(root, generatedDir);
    const expected = listFiles(expectedDir);
    const actual = listFiles(actualDir);
    const problems = [];
    for (const file of expected) {
      if (!actual.includes(file)) problems.push(`missing ${generatedDir}/${file}`);
      else if (!readFileSync(join(expectedDir, file)).equals(readFileSync(join(actualDir, file))))
        problems.push(`stale   ${generatedDir}/${file}`);
    }
    for (const file of actual)
      if (!expected.includes(file)) problems.push(`extra   ${generatedDir}/${file}`);
    if (problems.length) {
      for (const problem of problems) console.error(`  ${problem}`);
      throw new Error('generated code is out of date; run: node scripts/proto-gen.mjs');
    }
    console.log(`proto-gen: ${expected.length} generated files up to date`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  if (flag('--check')) check();
  else if (flag('--baseline')) {
    buf(['lint']);
    buf(['build', '--exclude-source-info', '-o', baseline]);
    console.log(`proto-gen: wrote ${baseline}`);
  } else if (flag('--breaking')) {
    const against = option('--against') ?? baseline;
    if (against === baseline && !existsSync(resolve(root, baseline)))
      throw new Error(`${baseline} is missing; run: node scripts/proto-gen.mjs --baseline`);
    buf(['breaking', '--against', against]);
    console.log(`proto-gen: no breaking changes against ${against}`);
  } else {
    buf(['lint']);
    buf(['generate']);
    const count = listFiles(resolve(root, generatedDir)).length;
    console.log(`proto-gen: generated ${count} files in ${generatedDir}`);
  }
} catch (error) {
  console.error(`proto-gen: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
