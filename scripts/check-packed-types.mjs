// Runs Are the Types Wrong (`attw --profile esm-only`) on every tarball in artifacts/
// (`pnpm check:packed-types`, after `pnpm pack:all`).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root, runPnpm } from './tooling.mjs';

const archives = (await readdir(join(root, 'artifacts'))).filter((name) => name.endsWith('.tgz'));
if (archives.length === 0) throw new Error('No tarballs in artifacts/; run pnpm pack:all first');
for (const archive of archives)
  runPnpm(['exec', 'attw', join(root, 'artifacts', archive), '--profile', 'esm-only', '--quiet'], {
    cwd: root,
  });
console.log(`${archives.length} packed packages pass ESM and bundler type resolution checks.`);
