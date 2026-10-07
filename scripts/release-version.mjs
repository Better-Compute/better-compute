// Sets one version on every packages/* manifest (the versions stay synchronized).
//
//   node scripts/release-version.mjs 0.2.0
//
// Apps, examples and the daemon (versioned by its git tag through goreleaser) are left alone.
// The whole release checklist is RELEASING.md.
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
const date = new Date().toISOString().slice(0, 10);
console.log(
  `Updated package metadata to ${version}. Next (RELEASING.md): move CHANGELOG.md's Unreleased notes under "## ${version} (${date})" and leave "## Unreleased" empty above it (\`node scripts/release-notes.mjs ${version}\` prints the release notes), then run pnpm install, pnpm check, pnpm pack:all, pnpm check:packed-types and pnpm test:packed.`,
);
