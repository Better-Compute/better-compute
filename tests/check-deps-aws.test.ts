import { describe, expect, it } from 'vitest';
import { checkAwsDeps, checkDeps } from '../scripts/check-deps.mjs';

/** A package model whose tsconfig references mirror its workspace dependencies. */
function pkg(name: string, deps: string[] = [], sources: Record<string, string> = {}) {
  const folder = name.replace(/^@better-compute\//, '');
  return {
    dir: `packages/${folder}`,
    manifest: {
      name,
      dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])),
    },
    tsconfig: {
      references: deps.map((dep) => ({ path: `../${dep.replace(/^@better-compute\//, '')}` })),
    },
    sources,
  };
}

describe('dependency rule 5 (aws-core)', () => {
  it('rule 5 refuses a package that depends on aws-core', () => {
    const violations = checkAwsDeps([pkg('@better-compute/vps', ['@better-compute/aws-core'])]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('aws');
    expect(violations[0]?.message).toContain('@better-compute/aws-core');
  });

  it('lets provider-aws and aws depend on aws-core', () => {
    expect(
      checkAwsDeps([
        pkg('@better-compute/provider-aws', ['@better-compute/aws-core']),
        pkg('@better-compute/aws', ['@better-compute/aws-core']),
      ]),
    ).toEqual([]);
  });

  it('refuses a package that imports aws-core without being allowed to', () => {
    const violations = checkAwsDeps([
      pkg('@better-compute/vps', [], { 'src/a.ts': "import '@better-compute/aws-core';\n" }),
    ]);
    expect(violations).toHaveLength(1);
  });

  it('refuses any package under packages/ that depends on aws or provider-aws', () => {
    expect(
      checkAwsDeps([
        pkg('@better-compute/better-compute', ['@better-compute/provider-aws']),
        pkg('@better-compute/vps', ['@better-compute/aws']),
      ]),
    ).toHaveLength(2);
  });

  it('is part of checkDeps', () => {
    const rules = checkDeps([
      pkg('@better-compute/core'),
      pkg('@better-compute/vps', ['@better-compute/aws-core']),
    ]).map((violation) => violation.rule);
    expect(rules).toContain('aws');
  });
});
