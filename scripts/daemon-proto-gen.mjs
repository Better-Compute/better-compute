// Generates the committed Go code in daemon/gen from proto/ with the pinned buf from node_modules
// and the daemon's template (daemon/buf.gen.yaml): protoc-gen-go and protoc-gen-connect-go, which
// must be installed locally (see the template). The TypeScript side is scripts/proto-gen.mjs.
//
//   node scripts/daemon-proto-gen.mjs           buf generate into daemon/gen
//   node scripts/daemon-proto-gen.mjs --check   regenerate into a temp dir; fails when daemon/gen differs
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './tooling.mjs';

const generatedDir = 'daemon/gen';
const template = 'daemon/buf.gen.yaml';

/** PATH with the Go install and GOPATH/bin, where `go install` puts the plugins. */
function pathWithGo() {
  const extra = [
    process.env.GOBIN,
    join(process.env.GOPATH ?? join(homedir(), 'go'), 'bin'),
    process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin' : '/usr/local/go/bin',
  ].filter(Boolean);
  return [...extra, process.env.PATH ?? process.env.Path ?? ''].join(delimiter);
}

function buf(args) {
  const manifestPath = resolve(root, 'node_modules', '@bufbuild', 'buf', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = resolve(dirname(manifestPath), manifest.bin.buf);
  const env = { ...process.env, PATH: pathWithGo() };
  if (process.platform === 'win32') env.Path = env.PATH;
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`buf ${args[0]} failed (${result.status})`);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.go')) files.push(relative(dir, path).split('\\').join('/'));
    }
  };
  walk(dir);
  return files.sort();
}

if (process.argv.includes('--check')) {
  const temp = mkdtempSync(join(tmpdir(), 'bc-daemon-gen-'));
  try {
    buf(['generate', '--template', template, '--output', temp]);
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
      throw new Error('daemon/gen is stale; run: node scripts/daemon-proto-gen.mjs');
    }
    console.log(`daemon/gen matches the protos (${expected.length} files).`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  buf(['generate', '--template', template]);
  console.log(`Generated ${listFiles(join(root, generatedDir)).length} Go files in ${generatedDir}.`);
}
