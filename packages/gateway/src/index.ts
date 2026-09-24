/**
 * The better-compute gateway (PLAN.md §7, §8.1, §8.5): one long-lived mTLS gRPC session per
 * daemon, epoch-fenced routing, age-based liveness, dispatch by join with per-lane credits, result
 * and event ingestion, and forwarding of Join/Renew/SecretRequest to the api (dependency inversion:
 * the gateway holds no CA or signing key).
 *
 * ```ts
 * const gateway = createGateway({ region: 'eu-1', database, services: compute.gatewayServices });
 * await gateway.start();
 * await serveGateway(gateway, { port: 443, tls: { key, cert, ca: nodeCaRoots } });
 * ```
 */
export { createGateway } from './gateway.js';
export type {
  Gateway,
  GatewayJob,
  GatewayOptions,
  GatewaySessionInfo,
  GatewayStatus,
  LaneCreditLimits,
  PeerIdentity,
  RevocationFeed,
  SessionHandle,
  SessionSink,
} from './gateway.js';
export {
  decodeGrpcMessage,
  encodeGrpcMessage,
  frameMessage,
  GrpcCode,
  GrpcError,
  isGrpcContentType,
  MessageDecoder,
  statusTrailers,
  toGrpcError,
} from './grpc.js';
export { AGENT_GATEWAY_SERVICE, serveGateway, spiffeAuthenticate } from './http2.js';
export { attachFrameConn, closeReason } from './frames.js';
export type { FrameEndpoint } from './frames.js';
export { certificateAuthenticate, peerChain } from './identity.js';
export { gatewayControlClient, gatewayNotifier, internalHandler, serveInternal } from './internal.js';
export type {
  ControlClientOptions,
  GatewayControlClient,
  GatewayNotifierOptions,
  ServedInternal,
  ServeInternalOptions,
} from './internal.js';
export type { CertificateAuthenticateOptions } from './identity.js';
export type { Authenticate, PeerContext, ServedGateway, ServeGatewayOptions } from './http2.js';
export { sqlEventPublisher, sqlWorkQueue } from './ports.js';
export {
  createGatewayStore,
  FencedError,
  inventoryStore,
  isTerminalUpdate,
  nodeSpecColumn,
} from './store.js';
export type {
  GatewayStore,
  GatewayStoreOptions,
  HelloInput,
  HelloResult,
  InventoryIngest,
  LeaseToken,
  LivenessEntry,
  ReportContext,
  ReportHandlers,
  SettledCommand,
  SpecSource,
  StoredCommand,
  UpdatesResult,
} from './store.js';
export { TokenBucket } from './token-bucket.js';
