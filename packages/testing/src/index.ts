/**
 * Testing kit for better-compute (PLAN.md §15):
 *
 * - `computeFixture()` (PGlite, migrated; the sim clock bound to `compute_now()`; a scripted IAM; an
 *   HTTP `request()` helper), `closeFixtures()` and `fakeIam()`;
 * - the daemon side of the agent protocol in TypeScript: `FakeDaemon` (journal rules mirrored from
 *   daemon/internal/journal), `createDaemonHarness()`, fake hardware (`fakeHardware()`, mirroring
 *   daemon/internal/fakehw);
 * - `FrameConn` links with seeded fault injection (`createAgentLink()`, `createFramePair()`);
 * - the deterministic fleet simulator (`createFleetSim()`) with a pluggable `GatewayPort`, the
 *   in-memory `GatewayStub`, and the invariant checkers I1, I2, I5 and I8;
 * - deterministic plumbing: `createSimScheduler()`, `createRng()`, `EventLog`.
 */
export { closeFixtures, computeFixture } from './fixture.js';
export type {
  ComputeFixture,
  ComputeFixtureOptions,
  FixtureClock,
  FixtureRequestOptions,
  FixtureResponse,
  FixtureTenant,
} from './fixture.js';
export { fakeIam, tokenOf } from './fake-iam.js';
export type {
  FakeIam,
  FakeIamCall,
  FakeIamMethod,
  FakeIamOptions,
  FakeIamRule,
} from './fake-iam.js';

export { createRng } from './rng.js';
export type { Rng } from './rng.js';
export { createRealtimeScheduler, createSimScheduler } from './scheduler.js';
export type {
  RealtimeSchedulerOptions,
  Scheduler,
  SimScheduler,
  SimSchedulerOptions,
  Task,
  Timer,
} from './scheduler.js';
export { EventLog, formatLogEntry } from './event-log.js';
export type { EventLogOptions, LogEntry, LogValue } from './event-log.js';
export {
  DOWN,
  UP,
  agentFrameCodec,
  createAgentLink,
  createFramePair,
  serverFrameCodec,
} from './frame-conn.js';
export type {
  AgentConn,
  AgentLink,
  AgentLinkOptions,
  CloseInfo,
  CloseInitiator,
  FrameCodec,
  FrameConn,
  FrameHandler,
  FramePair,
  FramePairOptions,
  FrameVerdict,
  LinkControl,
  LinkDirection,
  LinkEvent,
  LinkFaults,
  LinkStats,
  ServerConn,
} from './frame-conn.js';
export {
  H100_GPU_NAME,
  L40S_GPU_NAME,
  canonicalizeInventory,
  encodeInventorySections,
  fakeHardware,
  inventoryHashes,
} from './fake-hw.js';
export type {
  EncodedSection,
  FakeHardware,
  FakeHardwareOptions,
  FakeHardwareVariant,
} from './fake-hw.js';

export { FakeDaemon, cdiSpecPath, envFilePath, mergeSpec } from './daemon/fake-daemon.js';
export type { FakeDaemonOptions, FakeDaemonState, Verdict } from './daemon/fake-daemon.js';
export {
  DEFAULT_CREDITS,
  DEFAULT_WORKERS,
  defaultFakeKinds,
  fakeDiagNvml,
  fakeGpuReset,
  fakeInventoryRefresh,
  fakeLogsCollect,
  fakeNodeReboot,
} from './daemon/kinds.js';
export type {
  FakeDaemonKnobs,
  FakeKind,
  FakeKindContext,
  FakeKindOutcome,
} from './daemon/kinds.js';
export {
  COMMAND_TTL_MS,
  JOURNAL_DEFAULT_MAX_BYTES,
  JOURNAL_DEFAULT_MAX_EVENTS,
  JournalError,
  MemoryJournal,
  REASON_INTERRUPTED,
  accept,
  ackResult,
  complete,
  interrupted,
  markRunning,
  recordRejection,
  recover,
  resolve,
  sweep,
} from './daemon/journal.js';
export type {
  Action,
  Decision,
  Delivery,
  EntryState,
  EventClass,
  EventStats,
  JournalCerts,
  JournalCommand,
  JournalErrorCode,
  JournalEvent,
  JournalMeta,
  JournalResult,
  JournalSpec,
  MemoryJournalOptions,
  Outcome,
  RuleHooks,
  Runtime,
} from './daemon/journal.js';
export type { DaemonFact, ExecutionIdentity, FactSink } from './daemon/facts.js';
export { ScriptedServer, createDaemonHarness } from './daemon/harness.js';
export type { AgentFrameValue, DaemonHarness, DaemonHarnessOptions } from './daemon/harness.js';
export { runAgentJoin, type AgentJoinOptions, type AgentJoinResult } from './daemon/join.js';
export { createWsDialer, type WsDialOptions } from './daemon/ws-dial.js';
export {
  DriverInvocationError,
  fakeDriverInvoke,
  invokeDriver,
  parseDriverInvocation,
  type DriverInvocation,
  type DriverInvocationContext,
} from './daemon/drivers.js';
export { FakeImds, type FakeImdsOptions, type ImdsMint } from './daemon/imds.js';
export {
  FakeHypervisor,
  overlayPath,
  seedPath,
  tapName,
  type FakeDomain,
  type FakeDomainState,
  type FakeHypervisorOptions,
  type FakeSnapshot,
  type InstancesConvergeResult,
  type UserDataFetch,
} from './daemon/instances.js';
export {
  echoShell,
  startTunnel,
  type FakeTunnelOptions,
  type TunnelConn,
  type TunnelOutcome,
  type TunnelProgram,
  type TunnelProgramContext,
  type TunnelProgramFactory,
} from './daemon/tunnels.js';

export * from './sim/index.js';
export * from './realtime/index.js';
export {
  attachDevFleet,
  createDevJoinKeys,
  createDevStack,
  DEV_ROOT_TOKEN,
  devFleetNotifier,
} from './dev/stack.js';
export type {
  DevFleet,
  DevFleetNotifier,
  DevFleetOptions,
  DevJoinKeys,
  DevJoinOptions,
  DevPool,
  DevSiteJoinOptions,
  DevStack,
  DevStackIam,
  DevStackOptions,
} from './dev/stack.js';
