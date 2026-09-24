// Fails on a bare now() in SQL outside the migration that defines compute_now() (PLAN.md P9, §8.4).
// `pnpm lint:repo` runs it.
//
//   node scripts/check-sql-now.mjs
//
// All compute SQL reads the clock through compute_now(), so production time and the sim clock
// (compute_sim_clock) are one source. The script reads the text of every string literal and template
// chunk in packages/*/src/**/*.{ts,mts,cts,tsx}; comments and template substitutions are code, not
// SQL. It reports now(), CURRENT_TIMESTAMP, LOCALTIMESTAMP and transaction_timestamp(),
// statement_timestamp() and clock_timestamp(), in any case; compute_now(), Date.now() and
// clock.now() are not matches.
//
// Exemptions:
// - The migration that defines compute_now(): a file named packages/postgres/src/migrations/0001_*.ts
//   that contains the marker `-- defines compute_now()` (put it in the SQL beside
//   CREATE FUNCTION compute_now()). The whole file is exempt. The marker exempts nothing elsewhere.
// - A source line containing `check-sql-now: allow` (in a TS or SQL comment on that line), for a
//   deliberate clock read such as doctor comparing compute_now() with now().
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineColumn, sourceFiles, stringChunks } from './source-scan.mjs';

/** The marker that identifies the one migration allowed to call now(). */
export const definitionMarker = '-- defines compute_now()';
/** A line carrying this text is not checked. */
export const allowMarker = 'check-sql-now: allow';

const migrationPath = /^packages\/postgres\/src\/migrations\/0001_[^/]+\.[mc]?ts$/;
const clockReads =
  /(?<![\w$.])(?:now\s*\(\s*\)|current_timestamp\b|localtimestamp\b|(?:transaction|statement|clock)_timestamp\s*\()/gi;

/** Whether a repo-relative file is the migration that defines compute_now(). */
export function definesComputeNow(path, source) {
  return migrationPath.test(path) && source.includes(definitionMarker);
}

/**
 * Clock reads in a file's string and template text.
 * @param {string} source
 * @returns {{ line: number, column: number, text: string }[]}
 */
export function findClockReads(source) {
  const lines = source.split('\n');
  const found = [];
  for (const chunk of stringChunks(source))
    for (const match of chunk.text.matchAll(clockReads)) {
      const position = lineColumn(source, chunk.start + match.index);
      if (!lines[position.line - 1].includes(allowMarker))
        found.push({ ...position, text: match[0] });
    }
  return found;
}

/**
 * Checks files given as repo-relative POSIX paths with their source. Pure: tests pass in-memory files.
 * @param {{ path: string, source: string }[]} files
 * @returns {string[]}  One message per clock read.
 */
export function checkSqlNow(files) {
  return files.flatMap(({ path, source }) =>
    definesComputeNow(path, source)
      ? []
      : findClockReads(source).map(
          ({ line, column, text }) =>
            `${path}:${line}:${column}: ${text} reads the database clock directly; use compute_now()`,
        ),
  );
}

/** True when run as `node scripts/check-sql-now.mjs`, false when a test imports it. */
function invokedDirectly() {
  const normal = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return normal(realpathSync(process.argv[1] ?? '')) === normal(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(root, 'packages', entry.name, 'src');
    for (const file of await sourceFiles(src))
      files.push({
        path: `packages/${entry.name}/src/${file}`,
        source: await readFile(join(src, file), 'utf8'),
      });
  }
  const problems = checkSqlNow(files);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`${problems.length} direct clock read(s) in SQL; see PLAN.md P9 and §8.4.`);
    process.exitCode = 1;
  } else console.log(`No bare now() in SQL across ${files.length} source files.`);
}
