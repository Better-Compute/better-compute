// Runs the Go daemon's tests (daemon/, tags nonvml,fakehw). On Linux: `go test ./...`. On Windows,
// where bcd targets Linux and locally built executables may be refused by Application Control, it
// cross-compiles each package's test binary for linux/amd64 and runs it inside WSL (`wsl -d <distro>`,
// default Ubuntu), from the package directory so testdata paths resolve.
//
//   node scripts/daemon-test.mjs [--run <regexp>] [--distro <name>] [-v] [packages...]
//   node scripts/daemon-test.mjs --build-bcd     also writes daemon/bin/bcd-linux-amd64 (fakehw)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { root } from './tooling.mjs';

const daemonDir = join(root, 'daemon');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const runPattern = flag('--run');
const distro = flag('--distro') ?? process.env.BCD_WSL_DISTRO ?? 'Ubuntu';
const verbose = args.includes('-v') ? (args.splice(args.indexOf('-v'), 1), true) : false;
const buildBcd = args.includes('--build-bcd')
  ? (args.splice(args.indexOf('--build-bcd'), 1), true)
  : false;
const packages = args.length ? args : ['./...'];
const tags = 'nonvml,fakehw';

const goEnv = {
  ...process.env,
  PATH: [
    process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin' : '/usr/local/go/bin',
    join(process.env.GOPATH ?? join(homedir(), 'go'), 'bin'),
    process.env.PATH ?? process.env.Path ?? '',
  ].join(delimiter),
};
if (process.platform === 'win32') goEnv.Path = goEnv.PATH;

function go(goArgs, extraEnv = {}, capture = false) {
  const result = spawnSync('go', goArgs, {
    cwd: daemonDir,
    env: { ...goEnv, ...extraEnv },
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

const linux = { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' };

if (buildBcd) {
  mkdirSync(join(daemonDir, 'bin'), { recursive: true });
  const built = go(['build', '-tags', tags, '-o', 'bin/bcd-linux-amd64', './cmd/bcd'], linux);
  if (built.status !== 0) process.exit(built.status ?? 1);
  console.log('built daemon/bin/bcd-linux-amd64');
}

if (process.platform !== 'win32') {
  const testArgs = ['test', '-tags', tags, ...(verbose ? ['-v'] : [])];
  if (runPattern) testArgs.push('-run', runPattern);
  process.exit(go([...testArgs, ...packages]).status ?? 1);
}

// Windows: cross-compile each test binary, run it in WSL.
const listed = go(
  ['list', '-tags', tags, '-f', '{{if or .TestGoFiles .XTestGoFiles}}{{.ImportPath}}|{{.Dir}}{{end}}', ...packages],
  linux,
  true,
);
if (listed.status !== 0) process.exit(listed.status ?? 1);
const targets = listed.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [importPath, dir] = line.split('|');
    return { importPath, dir };
  });
const outDir = join(daemonDir, 'bin', 'tests');
mkdirSync(outDir, { recursive: true });
const toWsl = (path) =>
  `/mnt/${path[0].toLowerCase()}${path.slice(2).split('\\').join('/')}`;

let failed = 0;
for (const { importPath, dir } of targets) {
  const name = importPath.split('/').slice(-2).join('-');
  const binary = join(outDir, `${name}.test`);
  const built = go(['test', '-c', '-tags', tags, '-o', binary, importPath], linux);
  if (built.status !== 0) {
    failed++;
    continue;
  }
  if (!existsSync(binary)) continue;
  const testFlags = [verbose ? '-test.v' : '', runPattern ? `-test.run '${runPattern}'` : '']
    .filter(Boolean)
    .join(' ');
  const script = `cd '${toWsl(dir)}' && '${toWsl(binary)}' ${testFlags}`;
  const run = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const ok = run.status === 0;
  if (!ok) failed++;
  if (verbose || !ok) process.stdout.write(output);
  console.log(`${ok ? 'ok  ' : 'FAIL'}\t${importPath}\t(${relative(root, dir)})`);
}
process.exit(failed ? 1 : 0);
