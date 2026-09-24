/**
 * bcx, better-compute's out-of-process driver protocol (PLAN.md §5.5): `bettercompute.driver.v1`
 * over gRPC/HTTP/2 with auto-mTLS and a go-plugin style handshake. Node.js only.
 *
 * - Plugin side: `serveDriver(def)` runs the same `defineDriver` object in its own process.
 * - Host side: `externalDriver({ command, sha256 })` pins, starts and supervises a plugin and
 *   exposes its drivers as `DriverDefinition`s; `connectPlugin` is the bare client.
 */
export {
  connectPlugin,
  type ConnectPluginOptions,
  type InvokeRequestInit,
  type PluginConnection,
  type ValidateRequestInit,
} from './client.js';
export { DRIVER_PLUGIN_SERVICE, GrpcCode, GrpcError } from './grpc.js';
export {
  BCX_CLIENT_CERT,
  BCX_MAGIC_COOKIE_KEY,
  BCX_MAGIC_COOKIE_VALUE,
  BCX_PROTOCOL_VERSION,
  BCX_SOCKET_DIR,
  createEphemeralIdentity,
  formatHandshake,
  parseHandshake,
  type BcxNetwork,
  type EphemeralIdentity,
  type Handshake,
} from './handshake.js';
export {
  externalDriver,
  pinnedFile,
  sha256File,
  startExternalDrivers,
  type ExternalDriverHost,
  type ExternalDriverOptions,
  type RemoteCall,
  type RemoteDriverDefinition,
  type RemoteKind,
} from './host.js';
export { remoteConfigSchema, type RemoteConfigSchema } from './schema.js';
export { serveDriver, type ServeDriverOptions, type ServedDriver } from './serve.js';
export {
  decodeArgs,
  driverError,
  encodeArgs,
  STREAM_CAPABILITY_PREFIX,
  type CallSite,
} from './wire.js';
