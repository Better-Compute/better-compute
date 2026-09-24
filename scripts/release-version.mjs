// Sets one version on every packages/* manifest (the versions stay synchronized).
//
//   node scripts/release-version.mjs 0.2.0
//
// Apps, examples and the daemon (versioned by its git tag through goreleaser) are left alone.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './tooling.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw new Error('Usage: node scripts/release-version.mjs VERSION');
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  const path = join(root, 'packages', entry.name, 'package.json');
  if (!entry.isDirectory() || !existsSync(path)) continue;
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(
  `Updated package metadata to ${version}; review the changes, move CHANGELOG.md's Unreleased notes under ## ${version}, and run pnpm install and pnpm check before packing.`,
);
