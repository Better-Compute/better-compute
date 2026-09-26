'use client';

import { useSyncExternalStore } from 'react';
import { moduleSwitches } from '@/lib/modules';

/**
 * Re-render when a module is shown or hidden (Settings → Installed modules, or another tab). Returns a version
 * to put in memo deps next to calls of navGroups/allWidgets/collectAttention… The server and the hydrating
 * render see every module; the browser's choice applies right after.
 */
export function useModuleVersion() {
  return useSyncExternalStore(moduleSwitches.subscribe, moduleSwitches.version, moduleSwitches.serverVersion);
}
