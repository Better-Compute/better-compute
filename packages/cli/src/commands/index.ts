import type { CommandSpec } from '../framework.js';
import { apiCommands } from './api.js';
import { auditCommands } from './audit.js';
import { capacityCommands } from './capacity.js';
import { daemonCommands } from './daemon.js';
import { iamSetupCommands } from './iam-setup.js';
import { pkiCommands } from './pki.js';
import { setupCommands } from './setup.js';

/** Every built-in command, in help order. */
export const builtinCommands: readonly CommandSpec<any>[] = [
  ...setupCommands,
  ...apiCommands,
  ...capacityCommands,
  ...pkiCommands,
  ...daemonCommands,
  ...iamSetupCommands,
  ...auditCommands,
];
