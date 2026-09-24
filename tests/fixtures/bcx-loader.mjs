// Lets a plain `node` subprocess run the workspace's TypeScript sources, as vitest's aliases do for
// the tests themselves: `@better-compute/<name>[/<sub>]` resolves to packages/<name>/src/<sub|index>.ts,
// NodeNext `./x.js` specifiers inside those sources resolve to `./x.ts`, and `.ts` files are
// compiled in-process with Node's own `stripTypeScriptTypes` (transform mode: enums, parameter
// properties). Import it before any dynamic import of a workspace package.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const packages = new URL('../../packages/', import.meta.url);

// stripTypeScriptTypes is experimental; its warning is noise on the plugin's stderr.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning).includes('stripTypeScriptTypes')) return;
  return emitWarning.call(process, warning, ...rest);
};

registerHooks({
  resolve(specifier, context, next) {
    const scoped = /^@better-compute\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/.exec(specifier);
    if (scoped) {
      const file = new URL(`${scoped[1]}/src/${scoped[2] ?? 'index'}.ts`, packages);
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true };
    }
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.endsWith('.ts')
    ) {
      const file = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
