import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Module augmentation is global to a TypeScript program, so "`implements: { power }` type-checks
// only with @better-compute/metal imported" cannot be asserted inside one test file. This compiles
// small in-memory programs against the package sources and reads their diagnostics.
//
// While no package augments DriverKinds at all, `implements` is `{}` and TypeScript skips excess
// property checks against `{}`: the definition is accepted, but the kind is absent from its type,
// so using it fails. The fixture therefore both defines and uses each driver.

const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/');
const source = (name: string) => [`${root}packages/${name}/src/index.ts`];
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  paths: {
    '@better-compute/core': source('core'),
    '@better-compute/protocol': source('protocol'),
    '@better-compute/inventory': source('inventory'),
    '@better-compute/provision': source('provision'),
    '@better-compute/metal': source('metal'),
    '@better-compute/vps': source('vps'),
  },
};

const drivers = `
import { defineDriver, manifest } from '@better-compute/core';
export const redfish = defineDriver({
  id: 'redfish', version: '1.0.0', runsOn: 'site', config: manifest({}),
  implements: { power: () => ({ getPower: async () => 'on' as const, setPower: async () => {} }) },
});
export const kvm = defineDriver({
  id: 'libvirt-kvm', version: '1.0.0', runsOn: 'node', config: manifest({}),
  implements: {
    runtime: () => ({
      traits: { isolation: 'vm' as const, multiTenant: true, gpuPassthrough: false, imageFormats: [] },
      list: async () => [], apply: async () => ({ id: 'i', state: 'running' as const, addresses: [] }),
      reboot: async () => {}, remove: async () => {},
    }),
  },
});
export const power = redfish.implements.power;
export const runtime = kvm.implements.runtime;
`;
// A third party's kind, so DriverKinds is not empty even without metal or vps.
const probeKind = `
declare module '@better-compute/core' { interface DriverKinds { 'stubs-probe': { ping(): void } } }
`;

const cache = new Map<string, ts.SourceFile>();
const host = ts.createCompilerHost(options, true);
const readFile = host.readFile.bind(host);
let fixture = { name: '', text: '' };
host.readFile = (name) => (name === fixture.name ? fixture.text : readFile(name));
host.fileExists = (name) => name === fixture.name || ts.sys.fileExists(name);
host.getSourceFile = (name, language) => {
  if (name === fixture.name) return ts.createSourceFile(name, fixture.text, language, true);
  let file = cache.get(name);
  if (!file) {
    const text = readFile(name);
    if (text === undefined) return undefined;
    file = ts.createSourceFile(name, text, language, true);
    cache.set(name, file);
  }
  return file;
};

let counter = 0;
/** The diagnostics of one fixture file (under tests/, so it resolves like a test would). */
function check(imports: string[], extra = ''): string[] {
  fixture = {
    name: `${root}tests/__driver-kinds-${counter++}.ts`,
    text: imports.map((specifier) => `import '${specifier}';\n`).join('') + drivers + extra,
  };
  const program = ts.createProgram([fixture.name], options, host);
  const file = program.getSourceFile(fixture.name)!;
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
}
const about = (errors: string[], kind: string) =>
  errors.filter((error) => error.includes(`'${kind}'`));

describe('DriverKinds augmentation', () => {
  it('leaves power and runtime unusable when only core is imported', () => {
    const errors = check([]);
    expect(about(errors, 'power')).toEqual(["Property 'power' does not exist on type '{}'."]);
    expect(about(errors, 'runtime')).toEqual(["Property 'runtime' does not exist on type '{}'."]);
    expect(errors).toHaveLength(2);
  });

  it('rejects power and runtime drivers when another package declares kinds', () => {
    const errors = check([], probeKind);
    expect(
      about(errors, 'power').some((error) => /'power' does not exist in type/.test(error)),
    ).toBe(true);
    expect(about(errors, 'runtime').length).toBeGreaterThan(0);
  });

  it('accepts power drivers once @better-compute/metal is imported', () => {
    const errors = check(['@better-compute/metal']);
    expect(about(errors, 'power')).toEqual([]);
    expect(about(errors, 'runtime').length).toBeGreaterThan(0);
  });

  it('accepts runtime drivers once @better-compute/vps is imported', () => {
    const errors = check(['@better-compute/vps']);
    expect(about(errors, 'runtime')).toEqual([]);
    expect(about(errors, 'power').length).toBeGreaterThan(0);
    expect(check(['@better-compute/metal', '@better-compute/vps'])).toEqual([]);
  });
});
