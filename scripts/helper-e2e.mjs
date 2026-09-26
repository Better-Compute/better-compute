// The bcd helper-as-root e2e (daemon/internal/helper/roote2e): builds bcd and the test with
// -tags nonvml,helpere2e (bcd gains the e2e-only `helper-call`), renders the install script with
// --unprivileged --instance-bridges bcbr0 and a placeholder command-root pin (the test pins its own
// root in its place), then runs the test as root under `unshare --mount --net`: the script and the
// helper see overlays of /etc, /usr/local and /var and a network namespace of their own, so the host
// is never changed. On Windows it runs in WSL (`wsl -u root`); on Linux it needs root. Without
// either it prints why and exits 0.
//
//   node scripts/helper-e2e.mjs [--distro <name>] [-v]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { root } from './tooling.mjs';

const args = process.argv.slice(2);
const distroAt = args.indexOf('--distro');
const distro = distroAt >= 0 ? args[distroAt + 1] : (process.env.BCD_WSL_DISTRO ?? 'Ubuntu');
const verbose = args.includes('-v');
const windows = process.platform === 'win32';

const skip = (why) => {
  console.log(`helper e2e: skipped (${why})`);
  process.exit(0);
};

// Where the test runs, as root: a command line prefix.
let asRoot;
if (windows) {
  const probe = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sh', '-c', 'command -v unshare && command -v useradd'], {
    stdio: 'ignore',
  });
  if (probe.error || probe.status !== 0) skip(`no WSL distro ${distro} with unshare and useradd`);
  asRoot = (argv) => ['wsl.exe', ['-d', distro, '-u', 'root', '-e', ...argv]];
} else if (process.platform === 'linux') {
  if (process.getuid?.() !== 0) skip('run it as root');
  asRoot = (argv) => [argv[0], argv.slice(1)];
} else skip(`${process.platform} has no Linux to run bcd helper on`);

const daemonDir = join(root, 'daemon');
const goEnv = {
  ...process.env,
  GOOS: 'linux',
  GOARCH: 'amd64',
  CGO_ENABLED: '0',
  PATH: [
    windows ? 'C:\\Program Files\\Go\\bin' : '/usr/local/go/bin',
    join(process.env.GOPATH ?? join(homedir(), 'go'), 'bin'),
    process.env.PATH ?? process.env.Path ?? '',
  ].join(delimiter),
};
if (windows) goEnv.Path = goEnv.PATH;
const go = (goArgs) => {
  const result = spawnSync('go', goArgs, { cwd: daemonDir, env: goEnv, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const tags = 'nonvml,helpere2e';
const bcd = join(daemonDir, 'bin', 'bcd-helpere2e');
const test = join(daemonDir, 'bin', 'tests', 'roote2e.test');
mkdirSync(join(daemonDir, 'bin', 'tests'), { recursive: true });
go(['build', '-tags', tags, '-ldflags', '-X main.version=0.0.0-e2e', '-o', bcd, './cmd/bcd']);
go(['test', '-c', '-tags', tags, '-o', test, './internal/helper/roote2e']);

// The install script exactly as the CLI renders it; only the command-root pin is filled in by the test.
await import('../tests/fixtures/bcx-loader.mjs');
const { renderInstallScript } = await import('@better-compute/cli/install-script');
const pin = (fill) => `sha256/${Buffer.alloc(32, fill).toString('base64')}`;
const placeholder = 'ee'.repeat(32);
const script = renderInstallScript({
  poolId: 'pool-e2e',
  siteId: 'site-e2e',
  gatewayUrl: 'https://gateway.e2e.invalid',
  downloadsBase: 'https://downloads.e2e.invalid',
  version: '0.0.0-e2e',
  sha256: { amd64: createHash('sha256').update(readFileSync(bcd)).digest('hex') },
  servingCaSpkiPin: pin(1),
  joinSigningKeyPin: pin(2),
  joinEncryptionKeyPin: pin(3),
  joinEncryptionJwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) },
  commandRootSha256: [placeholder],
  unprivileged: true,
  instanceBridges: ['bcbr0'],
  generator: 'scripts/helper-e2e.mjs',
});
const scriptFile = join(daemonDir, 'bin', 'tests', 'install-bcd-e2e.sh');
writeFileSync(scriptFile, script);

const linuxPath = (path) => (windows ? `/mnt/${path[0].toLowerCase()}${path.slice(2).split('\\').join('/')}` : path);
const [cmd, cmdArgs] = asRoot([
  'unshare',
  '--mount',
  '--net',
  '--propagation',
  'private',
  '--',
  'env',
  `BCD_ROOTE2E_SCRIPT=${linuxPath(scriptFile)}`,
  `BCD_ROOTE2E_BCD=${linuxPath(bcd)}`,
  `BCD_ROOTE2E_PLACEHOLDER=${placeholder}`,
  linuxPath(test),
  ...(verbose ? ['-test.v'] : []),
  '-test.run',
  'TestHelperAsRoot',
]);
const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root });
if (result.error) throw result.error;
console.log(result.status === 0 ? 'ok  \thelper e2e (root, WSL)' : 'FAIL\thelper e2e');
process.exit(result.status ?? 1);
