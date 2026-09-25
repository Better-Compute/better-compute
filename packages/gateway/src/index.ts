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
  HandshakeOutcome,
  GatewayLoopHealth,
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
export { AGENT_GATEWAY_SERVICE, serveGateway, unsafeSanOnlyAuthenticate } from './http2.js';
export { attachFrameConn, closeReason } from './frames.js';
export type { FrameEndpoint } from './frames.js';
export { certificateAuthenticate, peerChain } from './identity.js';
export { xidStatusHandler } from './health.js';
export { attachGatewayWs, serveGatewayWs, servingFromPem, WS_PATH, WS_SUBPROTOCOL } from './ws.js';
export { swapSecureContext, watchTlsFiles } from './tls-reload.js';
export type { TlsFiles, TlsFileWatch, TlsMaterial } from './tls-reload.js';
export { connectGatewayWs } from './ws-client.js';
export type { GatewayWsClient, GatewayWsClientOptions } from './ws-client.js';
export type { GatewayWsOptions, ServedGatewayWs } from './ws.js';
export { gatewayRenewHandler, RENEW_PATH } from './renew-http.js';
export type { RenewHttpOptions } from './renew-http.js';
export {
  agentProofType,
  gatewayProofType,
  signAgentProof,
  signGatewayProof,
  verifyAgentProof,
  verifyGatewayProof,
  wsNonce,
} from './ws-auth.js';
export type { VerifyAgentProofOptions } from './ws-auth.js';
export {
  encodeWsFrame,
  WsConnection,
  WsFrameDecoder,
  WsOpcode,
  WsProtocolError,
  wsAcceptKey,
  wsClientKey,
} from './websocket.js';
export type { WsConnectionOptions, WsFrame } from './websocket.js';
export { gatewayControlClient, gatewayNotifier, gatewayTunnelRelay, internalHandler, serveInternal } from './internal.js';
export type {
  ClientTunnel,
  ControlClientOptions,
  GatewayControlClient,
  GatewayNotifierOptions,
  GatewayTunnelRelay,
  GatewayTunnelRelayOptions,
  RelayedTunnel,
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
  CommandOwner,
  GatewayStoreOptions,
  HelloInput,
  HelloResult,
  InventoryIngest,
  LeaseToken,
  LivenessEntry,
  ReportContext,
  ReportHandlers,
  SettledCommand,
  StatusHandler,
  SpecSource,
  StoredCommand,
  UpdatesResult,
} from './store.js';
export { TokenBucket } from './token-bucket.js';
export { createTunnelRegistry, narrowsTunnels } from './tunnels.js';
export type {
  TunnelEndpoint,
  TunnelFilter,
  TunnelHandle,
  TunnelInfo,
  TunnelOptions,
  TunnelRegistry,
  TunnelStreamHandle,
} from './tunnels.js';
