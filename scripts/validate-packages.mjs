// Checks that every packages/* manifest is publishable. Run after `pnpm build` (`pnpm check` does).
//
//   node scripts/validate-packages.mjs
//
// Per package: license Apache-2.0, not private, publishConfig.access "public", repository.directory
// equal to its folder, engines.node equal to the root's, a LICENSE file, export conditions exactly
// `{ types, import }` (string targets are allowed), every export and bin target present, and no
// publint errors. Across packages: one synchronized version.
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publint } from 'publint';
import { root } from './tooling.mjs';

const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const problems = [];
const versions = new Map();
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
/** Every file path an `exports` value points at. */
const targets = (value) =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(targets)
      : [];

for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  const directory = join(root, 'packages', entry.name);
  if (!entry.isDirectory() || !(await exists(join(directory, 'package.json')))) continue;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const fail = (message) => problems.push(`${manifest.name ?? entry.name}: ${message}`);
  versions.set(manifest.name, manifest.version);

  if (manifest.license !== 'Apache-2.0' || manifest.private)
    fail('expected a publishable (not private) Apache-2.0 package');
  if (manifest.publishConfig?.access !== 'public') fail('expected publishConfig.access "public"');
  if (manifest.repository?.directory !== `packages/${entry.name}`)
    fail(`expected repository.directory "packages/${entry.name}"`);
  if (manifest.engines?.node !== rootManifest.engines.node)
    fail(`expected engines.node "${rootManifest.engines.node}" like the workspace root`);
  if (!(await exists(join(directory, 'LICENSE')))) fail('missing LICENSE');

  const exportsMap =
    typeof manifest.exports === 'string' ? { '.': manifest.exports } : (manifest.exports ?? {});
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (value && typeof value === 'object' && Object.keys(value).join() !== 'types,import')
      fail(`exports["${subpath}"] must have exactly the conditions types, import (in that order)`);
    for (const target of targets(value))
      if (!(await exists(join(directory, target))))
        fail(`exports["${subpath}"] target ${target} does not exist (build first)`);
  }
  const bins =
    typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {});
  for (const [command, target] of Object.entries(bins))
    if (!(await exists(join(directory, target))))
      fail(`bin ${command} target ${target} does not exist`);

  const result = await publint({ pkgDir: directory });
  for (const message of result.messages) {
    if (message.type === 'error') fail(`publint ${message.code}`);
    else console.log(manifest.name, message.type, message.code);
  }
}

const byVersion = Map.groupBy(versions.keys(), (name) => versions.get(name));
if (byVersion.size > 1)
  problems.push(
    `package versions are not synchronized: ${[...byVersion].map(([version, names]) => `${version} (${names.join(', ')})`).join('; ')}`,
  );
for (const problem of problems) console.error(problem);
if (problems.length > 0) throw new Error(`${problems.length} package validation errors`);
console.log(
  `All ${versions.size} packages have valid exports, synchronized versions, and publishable metadata.`,
);
