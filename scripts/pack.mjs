// Packs every packages/* package into artifacts/ with the pinned pnpm (`pnpm pack:all`).
//
//   node scripts/pack.mjs
//
// Each package's dist/ and tsconfig.tsbuildinfo are deleted first and every package is rebuilt from
// scratch (`tsc -b` from the root), so a tarball never carries output whose source is gone (a renamed
// migration, a moved module): `tsc -b --clean` alone would not do, since it only deletes the outputs
// of the current sources. pnpm rewrites `workspace:*` to the exact version inside each tarball.
// Tarballs left from an earlier pack are removed first, so check-packed-types only sees this build.
// The same clean build is what a manual `pnpm publish -r` should run from (RELEASING.md).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { root, runPnpm } from './tooling.mjs';

const packages = [];
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  const directory = join(root, 'packages', entry.name);
  if (entry.isDirectory() && existsSync(join(directory, 'package.json'))) packages.push(directory);
}

for (const directory of packages) {
  await rm(join(directory, 'dist'), { recursive: true, force: true });
  await rm(join(directory, 'tsconfig.tsbuildinfo'), { force: true });
}
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tsc, '-b'], { cwd: root, stdio: 'inherit', shell: false });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`tsc -b failed (${build.status})`);
console.log(`Rebuilt ${packages.length} packages from a clean dist/.`);

const destination = join(root, 'artifacts');
await mkdir(destination, { recursive: true });
for (const file of await readdir(destination))
  if (file.endsWith('.tgz')) await rm(join(destination, file));
for (const directory of packages)
  runPnpm(['pack', '--pack-destination', destination], { cwd: directory });
console.log(`Packed ${packages.length} packages into ${destination}. No packages were published.`);
