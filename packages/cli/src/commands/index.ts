import type { CommandSpec } from '../framework.js';
import { apiCommands } from './api.js';
import { setupCommands } from './setup.js';

/** Every built-in command, in help order. */
export const builtinCommands: readonly CommandSpec<any>[] = [...setupCommands, ...apiCommands];
