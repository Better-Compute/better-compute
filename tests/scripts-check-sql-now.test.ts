import { describe, expect, it } from 'vitest';
import {
  allowMarker,
  checkSqlNow,
  definesComputeNow,
  definitionMarker,
  findClockReads,
} from '../scripts/check-sql-now.mjs';

const migration = 'packages/postgres/src/migrations/0001_initial.ts';
const definition = `export const up = sql\`
  ${definitionMarker}
  CREATE FUNCTION compute_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT now() $$;
\`;
`;

describe('findClockReads', () => {
  it('finds now() and the other clock functions in strings and templates, in any case', () => {
    const source = `const a = 'SELECT now()';
const b = "UPDATE leases SET expires_at = NOW ( ) + interval '15 s'";
const c = \`INSERT INTO t (at) VALUES (current_timestamp)\`;
const d = sql\`SELECT clock_timestamp(), statement_timestamp(), transaction_timestamp(), LOCALTIMESTAMP\`;
`;
    expect(findClockReads(source).map(({ line, text }) => `${line}:${text}`)).toEqual([
      '1:now()',
      '2:NOW ( )',
      '3:current_timestamp',
      '4:clock_timestamp(',
      '4:statement_timestamp(',
      '4:transaction_timestamp(',
      '4:LOCALTIMESTAMP',
    ]);
  });

  it('reports the column of the read', () => {
    expect(findClockReads("const q = 'SELECT now()';\n")).toEqual([
      { line: 1, column: 19, text: 'now()' },
    ]);
  });

  it('ignores compute_now(), JS clocks, comments and template substitutions', () => {
    const source = `// Never call now() in SQL.
/** SQL reads compute_now(), not now(). */
const at = Date.now();
const t = clock.now();
const q = \`SELECT compute_now(), \${now()} AS js_time, 'x.now()' FROM t\`;
const r = 'WHERE not_before <= compute_now()';
const s = 'snow()';
`;
    expect(findClockReads(source)).toEqual([]);
  });

  it('skips a line that carries the allow marker', () => {
    const source = `const drift = 'SELECT compute_now() - now()'; // ${allowMarker}: doctor compares the clocks
const bad = 'SELECT now()';
`;
    expect(findClockReads(source).map(({ line }) => line)).toEqual([2]);
  });
});

describe('checkSqlNow', () => {
  it('exempts only the 0001 postgres migration that carries the marker', () => {
    expect(definesComputeNow(migration, definition)).toBe(true);
    expect(checkSqlNow([{ path: migration, source: definition }])).toEqual([]);
    expect(definesComputeNow('packages/postgres/src/migrations/0002_nodes.ts', definition)).toBe(
      false,
    );
    expect(definesComputeNow('packages/server/src/migrations/0001_x.ts', definition)).toBe(false);
    expect(definesComputeNow(migration, definition.replace(definitionMarker, '-- helpers'))).toBe(
      false,
    );
  });

  it('reports every other bare now() with its location', () => {
    const problems = checkSqlNow([
      { path: migration, source: definition },
      { path: 'packages/postgres/src/migrations/0002_nodes.ts', source: definition },
      {
        path: 'packages/server/src/leases.ts',
        source: "export const renew = 'UPDATE leases SET expires_at = now()';\n",
      },
      { path: 'packages/core/src/index.ts', source: 'export const now = () => Date.now();\n' },
    ]);
    expect(problems).toEqual([
      expect.stringMatching(
        /^packages\/postgres\/src\/migrations\/0002_nodes\.ts:3:\d+: now\(\) reads/,
      ),
      expect.stringMatching(
        /^packages\/server\/src\/leases\.ts:1:\d+: now\(\) reads the database clock directly/,
      ),
    ]);
  });
});
