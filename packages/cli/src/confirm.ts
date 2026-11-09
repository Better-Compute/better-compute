import { CliError, usageError } from './errors.js';
import type { CliIO } from './framework.js';

// The gate of commands that destroy something that does not come back: a machine's disks, a node's
// identity, the power under a running system. One rule for all of them, checked before anything is
// called: `--yes` on the command line, or a "yes" from the person at an interactive terminal.

/** The `--yes` flag of a destructive command; `what` completes "Confirm: …". */
export const yesFlag = (what: string) => ({ type: 'boolean', description: `Confirm: ${what}` }) as const;

/**
 * Passes with `--yes`. Without it, asks on an interactive terminal (`io.confirm`) and passes on yes
 * (`CANCELLED` otherwise); where nobody can be asked (a pipe, CI, an embedding program), it is a usage
 * error that says to re-run with `--yes`. `what` is the whole sentence of what will happen, naming
 * the target: "metal retire erases node_…'s disks and retires it for good".
 */
export async function confirmDestructive(context: { flags: { yes?: boolean | undefined }; io: Pick<CliIO, 'confirm'> }, what: string): Promise<void> {
  if (context.flags.yes) return;
  if (!context.io.confirm) throw usageError(`${what}; re-run with --yes`, 'Nothing was done. --yes confirms it without a prompt.');
  if (!(await context.io.confirm(`${what}. Continue?`))) throw new CliError('CANCELLED', 'Not confirmed: nothing was done');
}
