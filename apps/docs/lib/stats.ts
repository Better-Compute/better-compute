import api from '@/generated/api.json';
import cli from '@/generated/cli.json';
import commandKinds from '@/generated/command-kinds.json';
import errors from '@/generated/errors.json';
import modules from '@/generated/modules.json';
import packages from '@/generated/packages.json';

/**
 * Counts quoted on the landing page, the sidebar, and social cards. They are derived from the reference data
 * `scripts/generate.mjs` extracts from the live registry, so every number matches the code the site was built from.
 */
export const stats = {
  /** The released version, as the CLI reports it (every package shares one version). */
  version: cli.version,
  /** API groups (`POST /api/compute/{group}/{method}`). */
  groups: api.length,
  /** Every method in PLAN.md §9.2 plus registered methods outside it. */
  methods: api.reduce((sum, group) => sum + group.methods.length, 0),
  /** Methods a full deployment serves today; the rest are planned for a later phase. */
  servedMethods: api.reduce(
    (sum, group) => sum + group.methods.filter((method) => method.status === 'registered').length,
    0,
  ),
  errorCodes: errors.length,
  cliCommands: cli.commands.length,
  commandKinds: commandKinds.length,
  modules: modules.modules.length,
  jobs: modules.jobs.length,
  /** Publishable packages (the umbrella and every `@better-compute/*` package that is not private). */
  packages: packages.filter((pkg) => !pkg.private).length,
} as const;
