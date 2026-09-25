import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mermaid } from '@/components/mermaid';

/** The umbrella re-exports every package, so its edges would hide everything else. */
const umbrella = 'better-compute';

interface Manifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Every workspace package's manifest, read from `packages/*` at render time. The site runs from apps/docs, so the
 * repository root is two levels up; a deployment without the packages next to it gets an empty list.
 */
function readManifests(): Manifest[] {
  const root = join(process.cwd(), '..', '..', 'packages');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'package.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as Manifest)
    .filter((manifest) => typeof manifest.name === 'string')
    .sort((a, b) => a.name!.localeCompare(b.name!));
}

/**
 * The internal dependency graph of the workspace packages (runtime and peer dependencies, not dev dependencies),
 * built from their manifests. The umbrella package is left out to keep the graph readable.
 */
export function PackageGraph() {
  const manifests = readManifests().filter((manifest) => manifest.name !== umbrella);
  if (!manifests.length)
    return (
      <p className="text-text-secondary">
        The package graph is drawn from the repository&apos;s <code>packages/*</code> manifests,
        which this deployment does not include.
      </p>
    );
  const names = new Set(manifests.map((manifest) => manifest.name!));
  const id = (name: string) => name.replace('@better-compute/', '').replace(/[^a-z0-9]/gi, '_');
  const label = (name: string) => name.replace('@better-compute/', '');
  const lines = ['flowchart BT'];
  for (const manifest of manifests)
    lines.push(`  ${id(manifest.name!)}["${label(manifest.name!)}"]`);
  for (const manifest of manifests) {
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    for (const dependency of [...dependencies].sort())
      if (names.has(dependency)) lines.push(`  ${id(manifest.name!)} --> ${id(dependency)}`);
  }
  return <Mermaid chart={lines.join('\n')} />;
}
