import { PROTOCOL_VERSION } from '@better-compute/protocol';

/** This release of `@better-compute/server`; equal to its package.json version (a test checks). */
export const serverVersion = '0.1.0';

/** What `system.version` and `GET {basePath}/.well-known/better-compute` report. */
export interface ServerInfo {
  name: 'better-compute';
  version: string;
  /** Where the API is mounted, e.g. `/api/compute`. */
  basePath: string;
  /** The agent protocol versions this control plane speaks (`Hello.proto_min`/`proto_max`). */
  protocol: { min: number; max: number };
}

export function serverInfo(basePath: string): ServerInfo {
  return {
    name: 'better-compute',
    version: serverVersion,
    basePath,
    protocol: { min: PROTOCOL_VERSION.min, max: PROTOCOL_VERSION.max },
  };
}
