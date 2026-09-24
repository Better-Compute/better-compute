// Packs every packages/* package into artifacts/ with the pinned pnpm (`pnpm pack:all`). Run after
// `pnpm build`. pnpm rewrites `workspace:*` to the exact version inside each tarball. Tarballs left
// from an earlier pack are removed first, so check-packed-types only sees this build.
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, runPnpm } from './tooling.mjs';

const destination = join(root, 'artifacts');
await mkdir(destination, { recursive: true });
for (const file of await readdir(destination))
  if (file.endsWith('.tgz')) await rm(join(destination, file));
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  const directory = join(root, 'packages', entry.name);
  if (entry.isDirectory() && existsSync(join(directory, 'package.json')))
    runPnpm(['pack', '--pack-destination', destination], { cwd: directory });
}
console.log(`Packed packages into ${destination}. No packages were published.`);
