import type { CommandSpec } from '../framework.js';
import { apiCommands } from './api.js';
import { authCommands } from './auth.js';
import { auditCommands } from './audit.js';
import { capacityCommands } from './capacity.js';
import { daemonCommands } from './daemon.js';
import { fleetCommands } from './fleet.js';
import { iamSetupCommands } from './iam-setup.js';
import { pkiCommands } from './pki.js';
import { releaseCommands } from './release.js';
import { serveCommands } from './serve.js';
import { setupCommands } from './setup.js';
import { simCommands } from './sim.js';
import { sshCommands } from './ssh.js';
import { supportCommands } from './support.js';
import { tunnelCommands } from './tunnel.js';

/** Every built-in command, in help order. */
export const builtinCommands: readonly CommandSpec<any>[] = [
  ...setupCommands,
  ...serveCommands,
  ...simCommands,
  ...apiCommands,
  ...authCommands,
  ...sshCommands,
  ...tunnelCommands,
  ...capacityCommands,
  ...fleetCommands,
  ...pkiCommands,
  ...daemonCommands,
  ...iamSetupCommands,
  ...auditCommands,
  ...releaseCommands,
  ...supportCommands,
];
