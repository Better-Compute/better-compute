'use client';

import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useInView } from 'motion/react';
import {
  RiArrowLeftRightLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiSubtractLine,
  RiTimeLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { DiagramFrame, PlayToggle, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * The bare-metal lifecycle (PLAN.md §3.5, §11.1) as a state machine driven by the real `metal.*` methods, simulated
 * in the browser. Every name and rule below mirrors the code:
 * - `transitions` is core's `provisionStateTable` and `recoverTargets` its `metalRecoverTargets`
 *   (packages/core/src/states.ts);
 * - each method applies the verb of metal's `metalVerbTransitions`, with the same checks and error messages
 *   (packages/metal/src/verbs.ts, api.ts, store.ts);
 * - the profiles are metal's built-ins (packages/metal/src/profiles.ts) plus one tenant deploy profile, expanded the
 *   way provision's `expandProfile` does (main and acceptance rows, then on-failure rows, then cleanup rows) and run one
 *   transition at a time by the engine's rules (packages/provision/src/expand.ts, engine.ts);
 * - the metal reconciler (packages/metal/src/reconcile.ts) starts each state's workflow, then applies `complete` or
 *   `fail`, so enrolling → inspecting → commissioning → ready chains on its own.
 */

// --- Core's provision state table ----------------------------------------------------------------------------------

type ProvisionState =
  | 'adopting'
  | 'adopted'
  | 'enrolling'
  | 'inspecting'
  | 'commissioning'
  | 'ready'
  | 'deploying'
  | 'deployed'
  | 'releasing'
  | 'rescue'
  | 'failed'
  | 'retiring'
  | 'retired';

type ProvisionVerb =
  | 'adopt'
  | 'complete'
  | 'manage'
  | 'inspect'
  | 'provide'
  | 'deploy'
  | 'release'
  | 'rescue'
  | 'unrescue'
  | 'fail'
  | 'abort'
  | 'recover'
  | 'retire';

type FailableState =
  | 'enrolling'
  | 'inspecting'
  | 'commissioning'
  | 'deploying'
  | 'releasing'
  | 'rescue'
  | 'retiring';

const transitions: Record<
  ProvisionState,
  Partial<Record<ProvisionVerb, ProvisionState | readonly ProvisionState[]>>
> = {
  adopting: { complete: 'adopted', adopt: 'adopting', retire: 'retiring' },
  adopted: { adopt: 'adopting', release: 'releasing', retire: 'retiring' },
  enrolling: { complete: 'inspecting', fail: 'failed', abort: 'failed', retire: 'retiring' },
  inspecting: { complete: 'commissioning', fail: 'failed', abort: 'failed' },
  commissioning: { complete: 'ready', fail: 'failed', abort: 'failed' },
  ready: {
    deploy: 'deploying',
    manage: 'enrolling',
    inspect: 'inspecting',
    provide: 'commissioning',
    retire: 'retiring',
  },
  deploying: { complete: 'deployed', fail: 'failed', abort: 'failed' },
  deployed: { release: 'releasing', rescue: 'rescue' },
  releasing: { complete: 'ready', fail: 'failed', abort: 'failed' },
  rescue: { unrescue: 'deployed', release: 'releasing', fail: 'failed' },
  failed: { recover: ['enrolling', 'releasing', 'deployed', 'retiring'], retire: 'retiring' },
  retiring: { complete: 'retired', fail: 'failed' },
  retired: {},
};

/** Back to the last stable point, never straight to `ready`: a failed deploy recovers into `releasing`. */
const recoverTargets: Record<FailableState, ProvisionState> = {
  enrolling: 'enrolling',
  inspecting: 'enrolling',
  commissioning: 'enrolling',
  deploying: 'releasing',
  releasing: 'releasing',
  rescue: 'deployed',
  retiring: 'retiring',
};

function targets(from: ProvisionState, verb: ProvisionVerb): readonly ProvisionState[] {
  const target = transitions[from][verb];
  if (target === undefined) return [];
  return typeof target === 'string' ? [target] : target;
}

/** Provision states a workflow drives; the metal reconciler starts one on entering them. */
const workflowStates: readonly ProvisionState[] = [
  'enrolling',
  'inspecting',
  'commissioning',
  'deploying',
  'releasing',
  'retiring',
  'rescue',
];

// --- The metal group ------------------------------------------------------------------------------------------------

const methods = [
  'enroll',
  'manage',
  'inspect',
  'provide',
  'deploy',
  'undeploy',
  'rescue',
  'abort',
  'recover',
  'retire',
] as const;
type Method = (typeof methods)[number];

const methodVerb: Record<Exclude<Method, 'enroll'>, ProvisionVerb> = {
  manage: 'manage',
  inspect: 'inspect',
  provide: 'provide',
  deploy: 'deploy',
  undeploy: 'release',
  rescue: 'rescue',
  abort: 'abort',
  recover: 'recover',
  retire: 'retire',
};

const methodHint: Record<Method, string> = {
  enroll: 'a new node; credentials kept as a secret:// ref',
  manage: 're-verifies BMC access',
  inspect: 're-inspects the machine',
  provide: 're-commissions it',
  deploy: "runs the tenant's profile",
  undeploy: "wipe: 'quick', then ready",
  rescue: 'boots the rescue ramdisk',
  abort: 'cancels the workflow; maintenance on',
  recover: "to failedFrom's recover target",
  retire: 'erase, power off, revoke identity',
};

const methodInput: Record<Method, string> = {
  enroll: "{ tenantId, siteId, poolId: 'pool_metal', bmc: { address, driver: 'redfish', credentials } }",
  manage: '{ tenantId, nodeId }',
  inspect: '{ tenantId, nodeId }',
  provide: '{ tenantId, nodeId }',
  deploy: "{ tenantId, nodeId, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1 }",
  undeploy: "{ tenantId, nodeId, wipe: 'quick' }",
  rescue: '{ tenantId, nodeId }',
  abort: '{ tenantId, nodeId }',
  recover: '{ tenantId, nodeId }',
  retire: '{ tenantId, nodeId }',
};

// --- Profiles and their expansion -----------------------------------------------------------------------------------

type Place = 'control-plane' | 'site' | 'node' | 'ramdisk';
type AgentPlace = Exclude<Place, 'control-plane'>;

/** A profile step with what its registered step definition resolves it to. */
interface ProfileStep {
  use: string;
  args?: string;
  /** The persisted `runs_on`: registered metal steps run in the control plane even when a profile writes `on: 'site'`. */
  runsOn: Place;
  /** Where the step's commands go (a control-plane step relays them with `awaitCommand`). */
  sendsTo?: AgentPlace;
  command?: string;
  timeout: string;
  await?: 'rejoin';
  onFailure?: 'continue' | ProfileStep;
  does: string;
}

interface Profile {
  id: string;
  version: number;
  steps: ProfileStep[];
  acceptance?: ProfileStep[];
  cleanup?: ProfileStep[];
}

/** One persisted workflow step, as `expandProfile` plans it. */
interface StepSpec extends Omit<ProfileStep, 'use' | 'onFailure'> {
  id: string;
  phase: 'main' | 'on-failure' | 'cleanup';
  action: string;
  onFailure: 'fail' | 'continue' | 'step';
  parentId?: string;
  acceptance?: boolean;
}

const cp = 'control-plane' as const;

const ensureRamdisk: ProfileStep = {
  use: 'metal.ensureRamdisk',
  runsOn: cp,
  sendsTo: 'site',
  command: 'bmc.boot, boot.prepareRamdisk, bmc.power',
  timeout: '20m',
  does: 'Boots the machine into the ramdisk unless it is already there',
};
const bootCleanUp: ProfileStep = {
  use: 'boot.cleanUp',
  runsOn: cp,
  sendsTo: 'site',
  command: 'boot.cleanUp',
  timeout: '2m',
  does: 'Removes the boot entries and deletes their discovery tokens',
};
const powerOff: ProfileStep = {
  use: 'power.setPower',
  args: "{ action: 'off' }",
  runsOn: cp,
  sendsTo: 'site',
  command: 'bmc.power',
  timeout: '5m',
  does: 'Powers the machine off through its BMC',
};
const dcgm = (level: number, sendsTo: AgentPlace): ProfileStep => ({
  use: 'diag.dcgm',
  args: `{ level: ${level} }`,
  runsOn: cp,
  sendsTo,
  command: 'diag.dcgm',
  timeout: '1h',
  does: `DCGM level ${level}; the node-signed result is verified`,
});

/** metal-enroll@1: enrolling → inspecting. */
const enrollProfile: Profile = {
  id: 'metal-enroll',
  version: 1,
  steps: [
    {
      use: 'power.getPower',
      runsOn: cp,
      sendsTo: 'site',
      command: 'bmc.query',
      timeout: '2m',
      does: 'The BMC answers with the stored credentials',
    },
    {
      use: 'inspect.oob',
      runsOn: cp,
      sendsTo: 'site',
      command: 'bmc.query',
      timeout: '5m',
      does: 'Out-of-band inspection finds the PXE MACs and the SMBIOS UUID',
    },
  ],
};

/** metal-inspect@2: inspecting → commissioning. */
const inspectProfile: Profile = {
  id: 'metal-inspect',
  version: 2,
  steps: [
    ensureRamdisk,
    {
      use: 'inventory.refresh',
      runsOn: cp,
      sendsTo: 'ramdisk',
      command: 'inventory.refresh',
      timeout: '10m',
      does: 'In-band inventory from the ramdisk',
    },
  ],
  cleanup: [bootCleanUp],
};

/** metal-commission@1: commissioning → ready. */
const commissionProfile: Profile = {
  id: 'metal-commission',
  version: 1,
  steps: [
    ensureRamdisk,
    dcgm(2, 'ramdisk'),
    {
      use: 'disk.wipe',
      args: "{ mode: 'quick' }",
      runsOn: cp,
      sendsTo: 'ramdisk',
      command: 'disk.wipe',
      timeout: '6h',
      does: 'Wipes every disk and reads it back; the node signs the result',
    },
    powerOff,
  ],
  cleanup: [bootCleanUp],
};

/** metal-release@1: releasing → ready, only after a verified wipe. */
const releaseProfile: Profile = {
  id: 'metal-release',
  version: 1,
  steps: [
    ensureRamdisk,
    {
      use: 'disk.wipe',
      runsOn: cp,
      sendsTo: 'ramdisk',
      command: 'disk.wipe',
      timeout: '6h',
      does: "Wipes with the mode metal.undeploy chose ('quick'); only an attested wipe returns the node to ready",
    },
    powerOff,
  ],
  cleanup: [bootCleanUp],
};

/** metal-retire@1: retiring → retired. */
const retireProfile: Profile = {
  id: 'metal-retire',
  version: 1,
  steps: [
    { ...ensureRamdisk, onFailure: 'continue' },
    {
      use: 'disk.wipe',
      args: "{ mode: 'crypto-erase' }",
      runsOn: cp,
      sendsTo: 'ramdisk',
      command: 'disk.wipe',
      timeout: '6h',
      onFailure: 'continue',
      does: 'Crypto-erases every disk',
    },
    { ...powerOff, onFailure: 'continue' },
    {
      use: 'metal.revokeIdentity',
      runsOn: cp,
      timeout: '1m',
      does: 'Revokes the node certificates and forgets the BMC credentials',
    },
  ],
  cleanup: [bootCleanUp],
};

/** metal-rescue@1: the node stays in rescue until it is released. */
const rescueProfile: Profile = { id: 'metal-rescue', version: 1, steps: [ensureRamdisk] };

/**
 * The tenant's deploy profile: PLAN.md §11.4's `ubuntu-24.04-gpu-host`, with the `userdata.render` step that
 * `deploy.deploy` needs before it when a profile has `userData` (as tests/metal-lifecycle.test.ts writes it).
 */
const gpuHostProfile: Profile = {
  id: 'ubuntu-24.04-gpu-host',
  version: 1,
  steps: [
    {
      use: 'userdata.render',
      runsOn: cp,
      timeout: '2m',
      does: 'Renders cloud-init with a single-use provisioned join token, stored as a secret',
    },
    {
      use: 'boot.prepareRamdisk',
      runsOn: cp,
      sendsTo: 'site',
      command: 'boot.prepareRamdisk',
      timeout: '2m',
      does: 'A boot entry per MAC, with a single-use discovery token',
    },
    {
      use: 'management.setBootDevice',
      args: "{ device: 'pxe' }",
      runsOn: cp,
      sendsTo: 'site',
      command: 'bmc.boot',
      timeout: '2m',
      does: 'One-time network boot',
    },
    {
      use: 'power.setPower',
      args: "{ action: 'cycle' }",
      runsOn: cp,
      sendsTo: 'site',
      command: 'bmc.power',
      timeout: '5m',
      does: 'Power-cycles the machine into the ramdisk',
    },
    {
      use: 'wait.agentJoined',
      args: "{ role: 'ramdisk' }",
      runsOn: cp,
      timeout: '15m',
      does: 'Waits for the ramdisk session',
    },
    {
      use: 'inspect.inspect',
      runsOn: 'ramdisk',
      command: 'driver.invoke',
      timeout: '10m',
      does: "A driver operation: one driver.invoke command for the profile's inspect driver (agent)",
    },
    dcgm(2, 'ramdisk'),
    {
      use: 'deploy.deploy',
      runsOn: cp,
      sendsTo: 'ramdisk',
      command: 'deploy.image',
      timeout: '30m',
      does: 'Streams the catalog image to disk; the written sha256 must match the catalog',
    },
    {
      use: 'management.setBootDevice',
      args: "{ device: 'disk' }",
      runsOn: cp,
      sendsTo: 'site',
      command: 'bmc.boot',
      timeout: '2m',
      does: 'Boot from disk from now on',
    },
    {
      use: 'boot.kexec',
      runsOn: 'ramdisk',
      command: 'boot.kexec',
      timeout: '15m',
      await: 'rejoin',
      does: 'Self-terminating: it completes when the installed OS rejoins as node',
      onFailure: {
        use: 'power.setPower',
        args: "{ action: 'reset' }",
        runsOn: cp,
        sendsTo: 'site',
        command: 'bmc.power',
        timeout: '5m',
        does: 'Fires only when the rejoin times out',
      },
    },
    {
      use: 'wait.generationObserved',
      runsOn: cp,
      timeout: '10m',
      does: 'Waits until the node has converged its desired state (hostConfig)',
    },
  ],
  acceptance: [dcgm(1, 'node')],
  cleanup: [bootCleanUp],
};

/** The shipped profile each workflow-driven state runs (a pool with agent 'bcd'); deploying runs the tenant's. */
const stateProfiles: Partial<Record<ProvisionState, Profile>> = {
  enrolling: enrollProfile,
  inspecting: inspectProfile,
  commissioning: commissionProfile,
  releasing: releaseProfile,
  retiring: retireProfile,
  rescue: rescueProfile,
};

function planned(step: ProfileStep, id: string, phase: StepSpec['phase']): StepSpec {
  const { use, onFailure: _onFailure, ...rest } = step;
  return { ...rest, id, phase, action: use, onFailure: 'fail' };
}

/** Main and acceptance rows as `main.N`, then `main.N.on-failure` rows, then `cleanup.N`: `expandProfile`'s order. */
function expand(profile: Profile): StepSpec[] {
  const main: StepSpec[] = [];
  const failure: StepSpec[] = [];
  const entries = [
    ...profile.steps.map((step) => ({ step, acceptance: false })),
    ...(profile.acceptance ?? []).map((step) => ({ step, acceptance: true })),
  ];
  for (const { step, acceptance } of entries) {
    const spec = planned(step, `main.${main.length + 1}`, 'main');
    if (acceptance) spec.acceptance = true;
    if (typeof step.onFailure === 'object') {
      spec.onFailure = 'step';
      failure.push({
        ...planned(step.onFailure, `${spec.id}.on-failure`, 'on-failure'),
        parentId: spec.id,
        onFailure: 'continue',
      });
    } else if (step.onFailure) spec.onFailure = step.onFailure;
    main.push(spec);
  }
  const cleanup = (profile.cleanup ?? []).map((step, i) => ({
    ...planned(step, `cleanup.${i + 1}`, 'cleanup'),
    onFailure: 'continue' as const,
  }));
  return [...main, ...failure, ...cleanup];
}

// --- The simulation -------------------------------------------------------------------------------------------------

type StepState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
type WorkflowState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type Fault = 'dcgm' | 'wipe' | 'rejoin';

interface ErrorBody {
  code: string;
  message: string;
}

interface RunStep {
  spec: StepSpec;
  state: StepState;
  tick: number;
  ticks: number;
  notes: string[];
  badge?: string;
  bad?: boolean;
}

interface Workflow {
  id: string;
  profile: Profile;
  /** The provision state it serves (`metal_nodes.phase`). */
  serves: ProvisionState;
  state: WorkflowState;
  outcome: null | 'failed' | 'cancelled';
  error: ErrorBody | null;
  steps: RunStep[];
  /** `metal_nodes.workflow_id` still names it. Every verb clears it; the engine still finishes the workflow. */
  attached: boolean;
  /** The reconciler has seen it end (a finished rescue workflow stays attached). */
  settled: boolean;
  /** The release wipe's result: attested or not. */
  wipeAttested: boolean | null;
}

interface SimEvent {
  seq: number;
  type: string;
  data: string;
}

interface Call {
  seq: number;
  method: Method;
  ok: boolean;
  output: string;
  code?: string;
  status?: number;
}

interface Sim {
  nodeSeq: number;
  nodeId: string;
  state: ProvisionState;
  failedFrom: FailableState | null;
  maintenance: boolean;
  lastError: ErrorBody | null;
  /** Which agent holds the node's session (`node_sessions.role`). */
  session: 'none' | 'ramdisk' | 'node';
  workflow: Workflow | null;
  wfSeq: number;
  visited: ProvisionState[];
  deployedOnce: boolean;
  events: SimEvent[];
  eventSeq: number;
  call: Call | null;
  callSeq: number;
  faults: Record<Fault, boolean>;
  /** What the last engine or reconciler transition did. */
  note: string;
}

const crockford = '0123456789abcdefghjkmnpqrstvwxyz';
function suffix(value: number): string {
  let out = '';
  let n = value;
  for (let i = 0; i < 3; i++) {
    out = crockford[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}
const nodeIdFor = (n: number) => `node_01jq3m8x4f7k2p9t6w1c5v8${suffix(n + 700)}`;
const workflowIdFor = (n: number) => `wf_01jq3mb2c6h9k3n7r1t5x8z${suffix(n + 1200)}`;

const noFaults: Record<Fault, boolean> = { dcgm: false, wipe: false, rejoin: false };

function emit(sim: Sim, type: string, data: string): Pick<Sim, 'events' | 'eventSeq'> {
  const seq = sim.eventSeq + 1;
  return { eventSeq: seq, events: [{ seq, type, data }, ...sim.events].slice(0, 4) };
}

function visit(visited: ProvisionState[], state: ProvisionState): ProvisionState[] {
  return visited.includes(state) ? visited : [...visited, state];
}

const isActive = (workflow: Workflow) => workflow.state === 'pending' || workflow.state === 'running';

/** `metal.enroll`: a new node in `enrolling`, whose reconciler starts `metal-enroll`. */
function enrolled(n: number, previous?: Sim): Sim {
  const base: Sim = {
    nodeSeq: n,
    nodeId: nodeIdFor(n),
    state: 'enrolling',
    failedFrom: null,
    maintenance: false,
    lastError: null,
    session: 'none',
    workflow: null,
    wfSeq: previous?.wfSeq ?? 0,
    visited: ['enrolling'],
    deployedOnce: false,
    events: [],
    eventSeq: previous?.eventSeq ?? 0,
    call: null,
    callSeq: previous?.callSeq ?? 0,
    faults: previous?.faults ?? noFaults,
    note: 'metal.enroll created the node in enrolling and queued the metal reconciler',
  };
  const seq = base.callSeq + 1;
  return {
    ...base,
    ...emit(base, 'node.enrolled', "poolId: 'pool_metal', siteId: 'site_a'"),
    callSeq: seq,
    call: {
      seq,
      method: 'enroll',
      ok: true,
      output: "{ nodeId, provisionState: 'enrolling', maintenance: false, bmc: { driver: 'redfish', credentialsSet: true } }",
    },
  };
}

type Check =
  | { ok: true; verb: ProvisionVerb | null; to: ProvisionState }
  | { ok: false; verb: ProvisionVerb; message: string };

/** What the method would do, or the `INVALID_STATE` message it throws. */
function check(sim: Sim, method: Method): Check {
  if (method === 'enroll') return { ok: true, verb: null, to: 'enrolling' };
  const verb = methodVerb[method];
  if (method === 'recover') {
    if (sim.state !== 'failed' || !sim.failedFrom)
      return { ok: false, verb, message: `Node ${sim.nodeId} is ${sim.state}, not failed` };
    return { ok: true, verb, to: recoverTargets[sim.failedFrom] };
  }
  const next = targets(sim.state, verb);
  if (next.length !== 1) return { ok: false, verb, message: `provision: cannot ${verb} from ${sim.state}` };
  return { ok: true, verb, to: next[0]! };
}

/** The engine's `abortWorkflow`: pending and in-flight steps are cancelled; cleanup still runs. */
function abortWorkflow(workflow: Workflow): Workflow {
  const error = { code: 'CANCELLED', message: 'aborted' };
  if (workflow.state === 'pending')
    return {
      ...workflow,
      state: 'cancelled',
      error,
      steps: workflow.steps.map((step) => (step.state === 'pending' ? { ...step, state: 'cancelled' } : step)),
    };
  return {
    ...workflow,
    outcome: 'cancelled',
    error,
    steps: workflow.steps.map((step) => {
      if (step.spec.phase === 'cleanup') return step;
      if (step.state === 'pending') return { ...step, state: 'cancelled' };
      if (step.state === 'running' || step.state === 'waiting')
        return { ...step, state: 'cancelled', badge: 'CANCELLED', bad: true };
      return step;
    }),
  };
}

/** A `metal.*` call: one transaction that checks the move, records it and clears the node's workflow. */
function callMethod(sim: Sim, method: Method): Sim {
  if (method === 'enroll') return enrolled(sim.nodeSeq + 1, sim);
  const result = check(sim, method);
  const seq = sim.callSeq + 1;
  if (!result.ok)
    return {
      ...sim,
      callSeq: seq,
      call: { seq, method, ok: false, code: 'INVALID_STATE', status: 409, output: result.message },
    };
  const from = sim.state;
  const to = result.to;
  const failing = to === 'failed';
  let workflow = sim.workflow;
  if (method === 'abort' && workflow?.attached && isActive(workflow)) workflow = abortWorkflow(workflow);
  if (workflow) workflow = { ...workflow, attached: false };
  const maintenance = sim.maintenance || failing;
  const next: Sim = {
    ...sim,
    state: to,
    failedFrom: failing ? (from as FailableState) : method === 'recover' ? null : sim.failedFrom,
    maintenance,
    lastError:
      method === 'abort'
        ? { code: 'ABORTED', message: 'aborted by an operator' }
        : method === 'recover'
          ? null
          : sim.lastError,
    workflow,
    visited: visit(sim.visited, to),
    callSeq: seq,
    call: {
      seq,
      method,
      ok: true,
      output: `{ provisionState: '${to}'${failing ? `, failedFrom: '${from}'` : ''}, maintenance: ${maintenance} }`,
    },
    note: `metal.${method} applied ${result.verb}: ${from} → ${to}`,
  };
  return { ...next, ...emit(next, `node.provision.${to}`, `from: '${from}', verb: '${result.verb}'`) };
}

const heavy = ['diag.dcgm', 'disk.wipe', 'deploy.deploy'];
const placeLabel: Record<AgentPlace, string> = { site: 'site agent', ramdisk: 'ramdisk', node: 'node' };

function ticksFor(spec: StepSpec, sim: Sim): number {
  if (spec.action === 'metal.ensureRamdisk') return sim.session === 'ramdisk' ? 1 : 3;
  if (spec.action === 'boot.kexec') return sim.faults.rejoin ? 4 : 3;
  return heavy.includes(spec.action) ? 2 : 1;
}

function notesFor(spec: StepSpec, sim: Sim): string[] {
  if (spec.action === 'metal.ensureRamdisk')
    return sim.session === 'ramdisk'
      ? ['the ramdisk is already connected, so nothing boots']
      : [
          'bmc.boot → site agent: one-time PXE',
          'boot.prepareRamdisk → site agent: a boot entry with a single-use discovery token',
          'bmc.power → site agent: power cycle, then wait for the ramdisk to join',
        ];
  if (spec.action === 'boot.kexec')
    return [
      'boot.kexec → ramdisk: the ramdisk ends, so the command never reports',
      "await: 'rejoin': waiting for a new boot_id or role",
      sim.faults.rejoin ? 'no session yet' : 'the installed OS is booting',
      'still no session; the step times out at 15m',
    ];
  const send = spec.command
    ? `${spec.command} → ${spec.sendsTo ? placeLabel[spec.sendsTo] : spec.runsOn}`
    : "runs in the worker that owns the node's shard";
  if (spec.action === 'deploy.deploy') return [send, 'range reads, zstd, disk; sha256 checked'];
  if (spec.action === 'diag.dcgm' || spec.action === 'disk.wipe') return [send, 'waiting for the node-signed result'];
  return [send];
}

/** One engine transition of an active workflow. */
function engineStep(sim: Sim, workflow: Workflow): Sim {
  if (workflow.state === 'pending') {
    const next = { ...sim, workflow: { ...workflow, state: 'running' as const }, note: 'workflow.started' };
    return { ...next, ...emit(next, 'workflow.started', `workflowId: '${workflow.id.slice(0, 12)}…'`) };
  }
  const inFlight = workflow.steps.findIndex((step) => step.state === 'running' || step.state === 'waiting');
  if (inFlight >= 0) return progress(sim, workflow, inFlight);
  const next = nextStep(workflow);
  if (next >= 0) {
    const spec = workflow.steps[next]!.spec;
    const steps = workflow.steps.slice();
    steps[next] = {
      spec,
      // A step on an agent is exactly one command: it starts and waits on it in the same transaction.
      state: spec.runsOn === 'control-plane' ? 'running' : 'waiting',
      tick: 0,
      ticks: ticksFor(spec, sim),
      notes: notesFor(spec, sim),
    };
    return { ...sim, workflow: { ...workflow, steps } };
  }
  // Nothing runnable is left: pending steps (unused on-failure rows) are skipped and the workflow ends.
  const state: WorkflowState =
    workflow.outcome === 'failed' ? 'failed' : workflow.outcome === 'cancelled' ? 'cancelled' : 'succeeded';
  const done: Workflow = {
    ...workflow,
    state,
    outcome: null,
    steps: workflow.steps.map((step) => (step.state === 'pending' ? { ...step, state: 'skipped' } : step)),
  };
  const next2 = { ...sim, workflow: done, note: `workflow.${state}` };
  return {
    ...next2,
    ...emit(next2, `workflow.${state}`, done.error ? `error: ${done.error.code}` : `profileId: '${done.profile.id}'`),
  };
}

/** The engine's `nextStep`: main rows until an outcome is set, on-failure rows of a failed parent, then cleanup. */
function nextStep(workflow: Workflow): number {
  for (const [i, step] of workflow.steps.entries()) {
    if (step.state !== 'pending') continue;
    if (step.spec.phase === 'main') {
      if (workflow.outcome) continue;
      return i;
    }
    if (step.spec.phase === 'on-failure') {
      const parent = workflow.steps.find((candidate) => candidate.spec.id === step.spec.parentId);
      if (parent?.state === 'failed' && workflow.outcome === 'failed') return i;
      continue;
    }
    return i;
  }
  return -1;
}

function progress(sim: Sim, workflow: Workflow, index: number): Sim {
  const step = workflow.steps[index]!;
  const steps = workflow.steps.slice();
  if (step.tick + 1 < step.ticks) {
    steps[index] = { ...step, tick: step.tick + 1 };
    return { ...sim, workflow: { ...workflow, steps } };
  }
  const { action, args } = step.spec;
  let faults = sim.faults;
  let session = sim.session;
  let wipeAttested = workflow.wipeAttested;
  let failure: ErrorBody | null = null;
  let badge: string | undefined;
  let bad = false;
  if (action === 'diag.dcgm') {
    if (faults.dcgm) {
      const level = args?.match(/\d+/)?.[0] ?? '1';
      failure = { code: 'DRIVER_ERROR', message: `DCGM level ${level} failed: pcie.bandwidth` };
      faults = { ...faults, dcgm: false };
    } else badge = 'passed · attested';
  } else if (action === 'disk.wipe') {
    if (workflow.serves === 'releasing') {
      wipeAttested = !faults.wipe;
      if (faults.wipe) faults = { ...faults, wipe: false };
    }
    badge = wipeAttested === false ? 'attested: false' : 'attested: true';
    bad = wipeAttested === false;
  } else if (action === 'boot.kexec') {
    if (faults.rejoin) {
      failure = { code: 'REJOIN_TIMEOUT', message: 'the agent did not rejoin before the step timed out' };
      faults = { ...faults, rejoin: false };
      session = 'none';
    } else {
      session = 'node';
      badge = 'rejoined as node';
    }
  } else if (action === 'metal.ensureRamdisk') {
    badge = session === 'ramdisk' ? 'connected' : 'booted';
    session = 'ramdisk';
  } else if (action === 'power.setPower') {
    if (args?.includes("'cycle'")) session = 'ramdisk';
    else session = 'none';
  } else if (action === 'wait.agentJoined') {
    session = 'ramdisk';
  }

  let next: Workflow = { ...workflow, wipeAttested };
  let note = `${step.spec.id} ${action} succeeded`;
  if (failure) {
    steps[index] = { ...step, state: 'failed', badge: failure.code, bad: true };
    note = `${step.spec.id} ${action} failed: ${failure.code}`;
    if (step.spec.phase === 'main' && step.spec.onFailure !== 'continue') {
      // The rest of the main phase will not run; cleanup (and an on-failure row) still does.
      for (const [i, other] of steps.entries())
        if (other.spec.phase === 'main' && other.state === 'pending') steps[i] = { ...other, state: 'cancelled' };
      next = {
        ...next,
        outcome: 'failed',
        error: { code: failure.code, message: `${step.spec.id} (${action}): ${failure.message}` },
      };
    }
  } else steps[index] = { ...step, state: 'succeeded', badge, bad };
  const after = { ...sim, faults, session, workflow: { ...next, steps }, note };
  return failure
    ? { ...after, ...emit(after, 'workflow.step.failed', `stepId: '${step.spec.id}', action: '${action}'`) }
    : after;
}

/** The metal reconciler settling a workflow that ended: `complete`, or `fail` with `failedFrom` and maintenance on. */
function reconcileFinished(sim: Sim, workflow: Workflow): Sim {
  const from = sim.state;
  const fail = (error: ErrorBody): Sim => {
    const next: Sim = {
      ...sim,
      state: 'failed',
      failedFrom: from as FailableState,
      maintenance: true,
      lastError: error,
      workflow: { ...workflow, attached: false, settled: true },
      visited: visit(sim.visited, 'failed'),
      note: `the metal reconciler applied fail: ${from} → failed (${error.code}), maintenance on`,
    };
    return { ...next, ...emit(next, 'node.provision.failed', `from: '${from}', error: ${error.code}`) };
  };
  if (workflow.state !== 'succeeded')
    return fail(workflow.error ?? { code: 'WORKFLOW_LOST', message: `workflow ${workflow.id} is gone` });
  if (from === 'rescue')
    return {
      ...sim,
      workflow: { ...workflow, settled: true },
      note: 'the ramdisk is up; the node stays in rescue until metal.undeploy',
    };
  if (from === 'releasing' && workflow.wipeAttested === false)
    return fail({
      code: 'UNVERIFIED_WIPE',
      message: 'the release wipe is not attested; the node does not return to ready',
    });
  const to = targets(from, 'complete')[0]!;
  const next: Sim = {
    ...sim,
    state: to,
    workflow: { ...workflow, attached: false, settled: true },
    visited: visit(sim.visited, to),
    deployedOnce: sim.deployedOnce || to === 'deployed',
    note: `the metal reconciler applied complete: ${from} → ${to}${to === 'deployed' ? " (role 'host')" : ''}`,
  };
  return { ...next, ...emit(next, `node.provision.${to}`, `from: '${from}'`) };
}

/** The metal reconciler entering a workflow-driven state: start that state's profile, owned by 'metal'. */
function startWorkflow(sim: Sim): Sim {
  const profile = sim.state === 'deploying' ? gpuHostProfile : stateProfiles[sim.state]!;
  const n = sim.wfSeq + 1;
  const workflow: Workflow = {
    id: workflowIdFor(n),
    profile,
    serves: sim.state,
    state: 'pending',
    outcome: null,
    error: null,
    steps: expand(profile).map((spec) => ({ spec, state: 'pending', tick: 0, ticks: 1, notes: [] })),
    attached: true,
    settled: false,
    wipeAttested: null,
  };
  const next: Sim = {
    ...sim,
    wfSeq: n,
    workflow,
    note: `the metal reconciler started ${profile.id}@${profile.version} for ${sim.state}`,
  };
  return {
    ...next,
    ...emit(next, 'node.provision.workflow', `state: '${sim.state}', profileId: '${profile.id}'`),
  };
}

/** The next transition anywhere (engine first, then the reconciler), or null when everything rests. */
function advance(sim: Sim): Sim | null {
  const workflow = sim.workflow;
  // One active workflow per node: a new one starts only after the previous one ended (a CONFLICT, retried).
  if (workflow && isActive(workflow)) return engineStep(sim, workflow);
  if (workflow && workflow.attached && !workflow.settled) return reconcileFinished(sim, workflow);
  if (workflowStates.includes(sim.state) && !workflow?.attached) return startWorkflow(sim);
  return null;
}

function settle(sim: Sim): Sim {
  let current = sim;
  for (let i = 0; i < 400; i++) {
    const next = advance(current);
    if (!next) break;
    current = next;
  }
  return current;
}

/** How long the current picture stays before the next transition. */
function delayFor(sim: Sim): number {
  const step = sim.workflow?.steps.find((candidate) => candidate.state === 'running' || candidate.state === 'waiting');
  if (!step) return 420;
  if (step.spec.action === 'metal.ensureRamdisk') return 640;
  if (step.spec.action === 'boot.kexec') return 700;
  return heavy.includes(step.spec.action) ? 600 : 560;
}

/** The self-running tour: the reader can take over at any point. */
function tourMove(sim: Sim): Method | null {
  switch (sim.state) {
    case 'ready':
      return sim.deployedOnce ? 'retire' : 'deploy';
    case 'deployed':
    case 'rescue':
      return 'undeploy';
    case 'failed':
      return 'recover';
    case 'retired':
      return 'enroll';
    default:
      return null;
  }
}

const TOUR_WAIT = 2200;

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring';

const faultDefs: { key: Fault; label: string; code: string; where: string }[] = [
  { key: 'dcgm', label: 'diag.dcgm fails', code: 'DRIVER_ERROR', where: 'the next DCGM run (commissioning or deploy)' },
  { key: 'wipe', label: 'release wipe unattested', code: 'UNVERIFIED_WIPE', where: 'the next release wipe' },
  { key: 'rejoin', label: 'kexec never rejoins', code: 'REJOIN_TIMEOUT', where: "the next deploy's boot.kexec" },
];

// --- The component --------------------------------------------------------------------------------------------------

export function MetalLifecycle() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.25 });
  const reduced = useReducedMotionSafe();
  const baseId = useId();
  const [sim, setSim] = useState<Sim>(() => enrolled(1));
  const [paused, setPaused] = useState(false);
  const [tour, setTour] = useState(true);
  // While the reader points at or focuses the demo, the tour waits (workflows keep running).
  const [held, setHeld] = useState(false);
  const [preview, setPreview] = useState<Method | null>(null);
  const [pressing, setPressing] = useState<Method | null>(null);
  const [touched, setTouched] = useState(false);

  // Reduced motion: rest on the settled result (the node commissioned and ready) until the reader acts.
  useEffect(() => {
    if (!reduced || touched) return;
    setSim((current) => settle(current));
    setPaused(true);
  }, [reduced, touched]);

  const next = useMemo(() => advance(sim), [sim]);

  // The clock: one engine or reconciler transition at a time, while on screen and not paused.
  useEffect(() => {
    if (!next || paused || !inView) return;
    const timer = setTimeout(() => setSim(next), delayFor(sim));
    return () => clearTimeout(timer);
  }, [next, sim, paused, inView]);

  // The tour calls the next method once everything rests, showing which row it presses first.
  useEffect(() => {
    if (next || paused || !tour || !inView || held) return;
    const method = tourMove(sim);
    if (!method) return;
    const press = setTimeout(() => setPressing(method), TOUR_WAIT - 650);
    const fire = setTimeout(() => {
      setPressing(null);
      setSim((current) => callMethod(current, method));
    }, TOUR_WAIT);
    return () => {
      clearTimeout(press);
      clearTimeout(fire);
      setPressing(null);
    };
  }, [next, sim, paused, tour, inView, held]);

  function run(method: Method) {
    setTouched(true);
    setTour(false);
    setPaused(false);
    setPressing(null);
    setSim((current) => callMethod(current, method));
  }

  function restart() {
    setTouched(true);
    setTour(true);
    setPaused(false);
    setSim((current) => enrolled(current.nodeSeq + 1, current));
  }

  function toggle() {
    setTouched(true);
    if (paused || !tour) {
      setPaused(false);
      setTour(true);
    } else setPaused(true);
  }

  function toggleFault(key: Fault) {
    setSim((current) => ({ ...current, faults: { ...current.faults, [key]: !current.faults[key] } }));
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
  }

  const workflow = sim.workflow;
  const running = Boolean(workflow && isActive(workflow));
  const previewCheck = preview ? check(sim, preview) : null;
  const previewTo = previewCheck?.ok ? previewCheck.to : null;

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={ref}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={onBlur}
      >
        <DiagramFrame
          live={running && !paused}
          label={
            <>
              Bare metal · <span className="font-mono text-text-primary">{sim.nodeId.slice(0, 13)}…</span>
              <span className="hidden sm:inline"> · redfish BMC in pool_metal</span>
            </>
          }
          actions={
            <>
              <PlayToggle paused={paused || !tour} onClick={toggle} compact />
              <ReplayButton onClick={restart} label="Re-enroll" />
            </>
          }
          footer={
            <>
              Simulated in your browser from core&rsquo;s provision state table and metal&rsquo;s built-in profiles,
              expanded and run the way the workflow engine does. The control-plane side is implemented; the Go agents
              that answer these commands (<span className="font-mono">bcd site</span>,{' '}
              <span className="font-mono">bcd ramdisk</span>) are not implemented yet: today only{' '}
              <span className="font-mono">bcd node</span> runs.
            </>
          }
        >
          <p className="sr-only" aria-live="polite">
            {`Node is ${sim.state}${sim.state === 'failed' && sim.failedFrom ? `, failed from ${sim.failedFrom}` : ''}.`}
          </p>

          {/* Laid out by the slot's width (container queries), so it fits a split column or a full-width band. */}
          <div className="@container">
            <StateMap sim={sim} previewTo={previewTo} running={running} />

            <div className="mt-6 flex flex-col gap-5 border-t border-separator-border pt-5 @4xl:grid @4xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] @4xl:items-start @4xl:gap-6">
              {/* Narrow: methods, their result, the workflow they start, then faults and the node. */}
              <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-5">
                <VerbList
                  sim={sim}
                  baseId={baseId}
                  pressing={pressing}
                  onRun={run}
                  onPreview={setPreview}
                  className="order-1 @4xl:order-none"
                />
                <LastCall call={sim.call} className="order-2 @4xl:order-none" />
                <Faults faults={sim.faults} onToggle={toggleFault} className="order-4 @4xl:order-none" />
              </div>
              <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-4">
                <WorkflowCard sim={sim} className="order-3 @4xl:order-2" />
                <NodeView sim={sim} className="order-5 @4xl:order-1" />
              </div>
            </div>
          </div>
        </DiagramFrame>
      </div>
    </MotionConfig>
  );
}

// --- State map ------------------------------------------------------------------------------------------------------

type LaneItem = ProvisionState | { text: string } | 'to' | 'both';

function lanesFor(sim: Sim): { name: string; items: LaneItem[]; muted?: boolean; note?: string }[] {
  return [
    { name: 'enroll', items: ['enrolling', 'to', 'inspecting', 'to', 'commissioning', 'to', 'ready'] },
    { name: 'lease', items: ['deploying', 'to', 'deployed', 'to', 'releasing', 'to', { text: 'ready' }] },
    { name: 'rescue', items: [{ text: 'deployed' }, 'both', 'rescue', 'to', { text: 'releasing' }] },
    {
      name: 'fail',
      items: [
        'failed',
        'to',
        { text: sim.failedFrom ? `recover: ${recoverTargets[sim.failedFrom]}` : 'recover: last stable state' },
      ],
    },
    { name: 'retire', items: ['retiring', 'to', 'retired'] },
    { name: 'adopt', items: ['adopting', 'to', 'adopted'], muted: true, note: 'nodes.adopt' },
  ];
}

function StateMap({ sim, previewTo, running }: { sim: Sim; previewTo: ProvisionState | null; running: boolean }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">provisionStateTable</p>
        <ul aria-hidden className="hidden items-center gap-3 text-caption-2-regular text-text-secondary @md:flex">
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-text-primary" /> current
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-text-primary" /> visited
          </li>
          <li className="flex items-center gap-1.5">
            <span className="hatch size-2.5 rounded-full border border-text-primary" /> failed
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-dashed border-text-primary" /> target
          </li>
        </ul>
      </div>
      <LayoutGroup id="metal-lifecycle-map">
        <div className="grid gap-x-8 gap-y-2 @4xl:grid-cols-2">
          {lanesFor(sim).map((lane) => (
            <div key={lane.name} className="flex min-w-0 items-start gap-3">
              <span className="w-12 shrink-0 pt-1.5 font-mono text-caption-2-regular text-text-tertiary">
                {lane.name}
              </span>
              <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5" aria-label={`${lane.name} states`}>
                {lane.items.map((item, i) => {
                  if (item === 'to' || item === 'both') {
                    const Icon = item === 'to' ? RiArrowRightSLine : RiArrowLeftRightLine;
                    return (
                      <li key={i} aria-hidden className="text-foreground-icon-tertiary">
                        <Icon className="size-3.5" />
                      </li>
                    );
                  }
                  if (typeof item === 'object')
                    return (
                      <li key={i} className="px-0.5 font-mono text-caption-2-regular text-text-tertiary">
                        {item.text}
                      </li>
                    );
                  return (
                    <StateChip
                      key={item}
                      state={item}
                      current={sim.state === item}
                      visited={sim.visited.includes(item)}
                      target={previewTo === item && sim.state !== item}
                      running={running && sim.state === item}
                      muted={lane.muted}
                    />
                  );
                })}
                {lane.note ? (
                  <li className="ps-1 font-mono text-caption-2-regular text-text-tertiary">({lane.note})</li>
                ) : null}
              </ol>
            </div>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}

function StateChip({
  state,
  current,
  visited,
  target,
  running,
  muted,
}: {
  state: ProvisionState;
  current: boolean;
  visited: boolean;
  target: boolean;
  running: boolean;
  muted?: boolean;
}) {
  const failed = state === 'failed' && current;
  return (
    <li className="relative" aria-current={current ? 'true' : undefined}>
      {current ? (
        <motion.span
          layoutId="metal-state-ring"
          aria-hidden
          className="absolute -inset-1 rounded-full border border-text-tertiary"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      ) : null}
      <AnimatePresence>
        {target ? (
          <motion.span
            aria-hidden
            className="absolute -inset-1 rounded-full border border-dashed border-text-primary"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.2, ease }}
          />
        ) : null}
      </AnimatePresence>
      <span
        className={cx(
          'relative inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-mono text-caption-2-medium transition-[background-color,border-color,color] duration-300',
          failed
            ? 'hatch border-text-primary bg-background-primary-default text-text-primary'
            : current
              ? 'border-text-primary bg-text-primary text-background-full'
              : visited
                ? 'border-text-primary bg-background-primary-default text-text-primary'
                : muted
                  ? 'border-dashed border-border-button-default text-text-tertiary'
                  : 'border-border-button-default bg-background-primary-default text-text-secondary',
        )}
      >
        {running ? (
          <span aria-hidden className="size-1.5 rounded-full bg-background-full motion-safe:animate-pulse" />
        ) : null}
        {state}
        {current ? <span className="sr-only"> (current)</span> : null}
      </span>
    </li>
  );
}

// --- Methods, faults, last call -------------------------------------------------------------------------------------

function VerbList({
  sim,
  baseId,
  pressing,
  onRun,
  onPreview,
  className,
}: {
  sim: Sim;
  baseId: string;
  pressing: Method | null;
  onRun: (method: Method) => void;
  onPreview: (method: Method | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="eyebrow mb-2">metal.* methods</p>
      <ul className="grid gap-1.5 @xl:grid-cols-2 @4xl:grid-cols-1">
        {methods.map((method) => {
          const result = check(sim, method);
          const rejected = sim.call && !sim.call.ok && sim.call.method === method ? sim.call.seq : null;
          const describedBy = `${baseId}-${method}`;
          return (
            <li key={method}>
              {/* Invalid methods stay focusable (aria-disabled): pressing one shows the error the API throws. */}
              <button
                type="button"
                onClick={() => onRun(method)}
                onPointerEnter={() => onPreview(method)}
                onPointerLeave={() => onPreview(null)}
                onFocus={() => onPreview(method)}
                onBlur={() => onPreview(null)}
                aria-disabled={result.ok ? undefined : true}
                aria-describedby={describedBy}
                className={cx(
                  'block w-full cursor-pointer rounded-lg border px-3 py-1.5 text-left transition-[border-color,background-color,box-shadow] duration-200',
                  focusRing,
                  result.ok
                    ? 'border-border-button-default bg-background-primary-default shadow-xs hover:border-border-button-hover'
                    : 'border-dashed border-border-button-default hover:border-border-button-hover',
                  rejected && 'border-solid border-text-primary',
                  pressing === method && 'ring-1 ring-text-primary ring-offset-2 ring-offset-surface-raised',
                )}
              >
                <motion.span
                  key={rejected ?? 'idle'}
                  className="flex flex-col gap-0.5"
                  initial={rejected ? { x: 0 } : false}
                  animate={rejected ? { x: [0, -4, 4, -2, 0] } : undefined}
                  transition={{ duration: 0.35, ease }}
                >
                <span className="flex items-center gap-2">
                  <span
                    className={cx(
                      'font-mono text-caption-1-medium',
                      result.ok ? 'text-text-primary' : 'text-text-tertiary',
                    )}
                  >
                    metal.{method}
                  </span>
                  <span
                    className={cx(
                      'ms-auto shrink-0 font-mono text-caption-2-medium',
                      result.ok
                        ? 'text-text-secondary'
                        : 'rounded-sm border border-dashed border-border-button-hover px-1 text-text-tertiary',
                    )}
                  >
                    {result.ok
                      ? method === 'enroll'
                        ? 'new node → enrolling'
                        : `${result.verb} → ${result.to}`
                      : 'INVALID_STATE'}
                  </span>
                </span>
                <span
                  id={describedBy}
                  className={cx(
                    'font-mono text-caption-2-regular break-words',
                    result.ok ? 'text-text-secondary' : 'text-text-tertiary',
                  )}
                >
                  {result.ok ? methodHint[method] : result.message}
                </span>
                </motion.span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LastCall({ call, className }: { call: Call | null; className?: string }) {
  return (
    <div
      className={cx('rounded-lg border border-dashed border-border-button-default px-3 py-2.5', className)}
      aria-live="polite"
    >
      <p className="mb-1 text-caption-2-regular text-text-secondary">Last call</p>
      {call ? (
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={call.seq}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease }}
            className="flex flex-col gap-1 font-mono text-caption-2-regular leading-4 break-words"
          >
            <span className="text-text-secondary">
              compute.api.<span className="text-text-primary">metal.{call.method}</span>(credential,{' '}
              {methodInput[call.method]})
            </span>
            {call.ok ? (
              <span className="text-text-primary">→ {call.output}</span>
            ) : (
              <span className="text-text-primary">
                <span className="hatch me-1.5 inline-block rounded-sm border border-text-primary px-1">
                  {call.code} · {call.status}
                </span>
                {call.output}
              </span>
            )}
          </motion.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
}

function Faults({
  faults,
  onToggle,
  className,
}: {
  faults: Record<Fault, boolean>;
  onToggle: (key: Fault) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="eyebrow mb-2">Inject a fault</p>
      <ul className="flex flex-col gap-1.5">
        {faultDefs.map((fault) => {
          const armed = faults[fault.key];
          return (
            <li key={fault.key}>
              <button
                type="button"
                aria-pressed={armed}
                onClick={() => onToggle(fault.key)}
                title={`Arms ${fault.where}`}
                className={cx(
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-[border-color,background-color] duration-200',
                  focusRing,
                  armed
                    ? 'border-text-primary bg-background-primary-default'
                    : 'border-dashed border-border-button-default hover:border-border-button-hover',
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    armed ? 'hatch border-text-primary text-text-primary' : 'border-border-button-hover',
                  )}
                >
                  {armed ? <RiCheckLine className="size-3" /> : null}
                </span>
                <span
                  className={cx(
                    'font-mono text-caption-1-regular',
                    armed ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  {fault.label}
                </span>
                <span className="ms-auto shrink-0 font-mono text-caption-2-regular text-text-tertiary">
                  {fault.code}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-caption-2-regular text-text-tertiary">
        An armed fault hits the next step it names, the way the real failure would.
      </p>
    </div>
  );
}

// --- Workflow and node ----------------------------------------------------------------------------------------------

function completesTo(state: ProvisionState): string {
  if (state === 'rescue') return 'stays in rescue until metal.undeploy';
  if (state === 'releasing') return 'complete → ready, only after an attested wipe';
  if (state === 'deploying') return "complete → deployed, role 'host'";
  const to = targets(state, 'complete')[0];
  return to ? `complete → ${to}` : '';
}

function restingNote(sim: Sim): string {
  switch (sim.state) {
    case 'ready':
      return 'ready is a resting state: nothing runs until a metal.* method moves the node.';
    case 'deployed':
      return 'deployed: the node serves its role until metal.undeploy (or metal.rescue).';
    case 'failed':
      return `failed from ${sim.failedFrom ?? 'a workflow'}, maintenance on: metal.recover or metal.retire.`;
    case 'retired':
      return 'retired is terminal: certificates revoked, BMC credentials forgotten.';
    default:
      return sim.note;
  }
}

function WorkflowCard({ sim, className }: { sim: Sim; className?: string }) {
  const workflow = sim.workflow;
  const inFlight = workflow?.steps.find((step) => step.state === 'running' || step.state === 'waiting');
  const detached = Boolean(workflow && !workflow.attached && isActive(workflow));

  return (
    <div
      className={cx(
        'min-w-0 overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default shadow-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-separator-border px-3.5 py-2.5">
        <span className="eyebrow">workflow</span>
        {workflow ? (
          <>
            <span className="font-mono text-caption-1-medium text-text-primary">
              {workflow.profile.id}@{workflow.profile.version}
            </span>
            <WorkflowStatePill state={workflow.state} />
            <span className="ms-auto min-w-0 truncate font-mono text-caption-2-regular text-text-tertiary">
              {workflow.id}
            </span>
          </>
        ) : (
          <span className="font-mono text-caption-1-regular text-text-tertiary">none yet</span>
        )}
      </div>

      {workflow ? (
        <>
          <p className="px-3.5 pt-2.5 text-caption-2-regular leading-4 text-text-secondary">
            {detached ? (
              <>
                Detached: the node moved to <span className="font-mono text-text-primary">{sim.state}</span>. This
                workflow still finishes (with its cleanup) before the next one can start: one active workflow per
                node.
              </>
            ) : (
              <>
                Serves <span className="font-mono text-text-primary">{workflow.serves}</span> · on success{' '}
                <span className="font-mono">{completesTo(workflow.serves)}</span> · rows as{' '}
                <span className="font-mono">profiles.render</span> returns them
              </>
            )}
          </p>
          <ol className="flex flex-col gap-px p-1.5">
            {workflow.steps.map((step) => (
              <StepRow key={step.spec.id} step={step} />
            ))}
          </ol>
        </>
      ) : null}

      <div className="min-h-[3.25rem] border-t border-separator-border px-3.5 py-2">
        {inFlight ? (
          <>
            <p className="font-mono text-caption-2-medium leading-4 break-words text-text-primary">
              {inFlight.spec.id} {inFlight.spec.action}: {inFlight.notes[inFlight.tick] ?? inFlight.notes.at(-1)}
            </p>
            <p className="mt-0.5 text-caption-2-regular leading-4 text-text-secondary">
              {inFlight.spec.does} · timeout {inFlight.spec.timeout}
            </p>
          </>
        ) : (
          <p className="text-caption-2-regular leading-4 text-text-secondary">
            {workflow && (isActive(workflow) || (workflow.attached && !workflow.settled))
              ? sim.note
              : restingNote(sim)}
          </p>
        )}
      </div>
    </div>
  );
}

function WorkflowStatePill({ state }: { state: WorkflowState }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={state}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2, ease }}
        className={cx(
          'inline-flex h-5 items-center gap-1.5 rounded-full border px-1.5 font-mono text-caption-2-medium',
          state === 'succeeded' && 'border-text-primary bg-text-primary text-background-full',
          state === 'running' && 'border-text-primary text-text-primary',
          state === 'failed' && 'hatch border-text-primary text-text-primary',
          (state === 'pending' || state === 'cancelled') && 'border-dashed border-border-button-hover text-text-secondary',
        )}
      >
        {state === 'running' ? <span aria-hidden className="live-dot" /> : null}
        {state}
      </motion.span>
    </AnimatePresence>
  );
}

function StepRow({ step }: { step: RunStep }) {
  const { spec } = step;
  const live = step.state === 'running' || step.state === 'waiting';
  const faded = step.state === 'skipped' || step.state === 'cancelled';
  const shortId = spec.phase === 'on-failure' ? spec.parentId! : spec.id;
  const tag = spec.phase === 'on-failure' ? 'on-failure' : spec.acceptance ? 'acceptance' : null;
  return (
    <li
      className={cx(
        'flex items-start gap-2.5 rounded-md px-2 py-1 transition-[background-color,opacity] duration-200',
        live && 'bg-background-secondary-default',
        faded && 'opacity-55',
      )}
    >
      <span className="mt-0.5">
        <StepIcon state={step.state} />
      </span>
      <span className="sr-only">
        {spec.id}, {step.state}.
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span aria-hidden className="w-[3.75rem] shrink-0 font-mono text-caption-2-regular text-text-tertiary">
          {shortId}
        </span>
        <span className="min-w-0 font-mono text-caption-1-regular leading-5 break-words">
          {tag ? (
            <span className="me-1.5 inline-block rounded-sm border border-dashed border-border-button-hover px-1 align-[0.0625rem] text-caption-2-regular text-text-secondary">
              {tag}
            </span>
          ) : null}
          <span
            className={cx(
              'text-text-primary',
              step.state === 'cancelled' && 'line-through decoration-text-tertiary',
            )}
          >
            {spec.action}
          </span>
          {spec.args ? <span className="ms-1.5 text-text-secondary">{spec.args}</span> : null}
        </span>
        <span className="ms-auto flex shrink-0 flex-wrap items-center gap-1">
          {step.badge ? (
            <span
              className={cx(
                'rounded-sm px-1 font-mono text-caption-2-regular',
                step.bad ? 'hatch border border-text-primary text-text-primary' : 'text-text-secondary',
              )}
            >
              {step.badge}
            </span>
          ) : null}
          <PlacePill place={spec.runsOn} />
          {spec.sendsTo ? (
            <span className="font-mono text-caption-2-regular text-text-secondary">→ {placeLabel[spec.sendsTo]}</span>
          ) : null}
          {spec.await ? (
            <span className="rounded-full border border-dashed border-text-primary px-1.5 font-mono text-caption-2-medium text-text-primary">
              await: {spec.await}
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function PlacePill({ place }: { place: Place }) {
  return (
    <span
      className={cx(
        'rounded-full border px-1.5 font-mono text-caption-2-medium',
        place === 'control-plane'
          ? 'border-border-button-hover text-text-secondary'
          : 'border-text-primary bg-text-primary text-background-full',
      )}
    >
      {place}
    </span>
  );
}

function StepIcon({ state }: { state: StepState }) {
  const base = 'flex size-4 shrink-0 items-center justify-center rounded-full';
  switch (state) {
    case 'succeeded':
      return (
        <span aria-hidden className={cx(base, 'bg-text-primary text-background-full')}>
          <RiCheckLine className="size-3" />
        </span>
      );
    case 'failed':
      return (
        <span aria-hidden className={cx(base, 'hatch border border-text-primary text-text-primary')}>
          <RiCloseLine className="size-3" />
        </span>
      );
    case 'running':
      return (
        <span aria-hidden className={cx(base, 'text-text-primary')}>
          <RiLoader4Line className="size-4 motion-safe:animate-spin" />
        </span>
      );
    case 'waiting':
      return (
        <span aria-hidden className={cx(base, 'hatch hatch-drift border border-text-primary text-text-primary')}>
          <RiTimeLine className="size-2.5" />
        </span>
      );
    case 'skipped':
      return (
        <span aria-hidden className={cx(base, 'border border-dashed border-text-tertiary text-text-tertiary')}>
          <RiSubtractLine className="size-3" />
        </span>
      );
    case 'cancelled':
      return (
        <span aria-hidden className={cx(base, 'border border-dashed border-text-tertiary text-text-tertiary')}>
          <RiCloseLine className="size-3" />
        </span>
      );
    default:
      return <span aria-hidden className={cx(base, 'border border-dashed border-border-button-hover')} />;
  }
}

function NodeView({ sim, className }: { sim: Sim; className?: string }) {
  const rows: { key: string; value: ReactNode; strong?: boolean }[] = [
    { key: 'provisionState', value: `'${sim.state}'`, strong: true },
    { key: 'failedFrom', value: sim.failedFrom ? `'${sim.failedFrom}'` : '—' },
    { key: 'maintenance', value: String(sim.maintenance) },
    {
      key: 'workflowId',
      value: sim.workflow?.attached ? `'${sim.workflow.id}'` : '—',
    },
    { key: 'lastError', value: sim.lastError ? `{ code: '${sim.lastError.code}' }` : '—' },
  ];
  return (
    <div className={cx('grid gap-3 @lg:grid-cols-2', className)}>
      <div className="min-w-0 rounded-lg border border-dashed border-border-button-default px-3 py-2.5">
        <p className="mb-1.5 text-caption-2-regular text-text-secondary">MetalNodeView</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 font-mono text-caption-2-regular leading-5">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-text-secondary">{row.key}</dt>
              <dd className="min-w-0 overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={String(row.value)}
                    title={typeof row.value === 'string' ? row.value : undefined}
                    className={cx(
                      'block truncate',
                      row.value === '—' ? 'text-text-tertiary' : 'text-text-primary',
                      row.strong && 'font-medium',
                    )}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.2 }}
                  >
                    {row.value}
                  </motion.span>
                </AnimatePresence>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="min-w-0 rounded-lg border border-dashed border-border-button-default px-3 py-2.5">
        <p className="mb-1.5 text-caption-2-regular text-text-secondary">Events</p>
        <ol className="flex flex-col gap-1 font-mono text-caption-2-regular leading-4">
          <AnimatePresence initial={false}>
            {sim.events.map((event, i) => (
              <motion.li
                key={event.seq}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: i === 0 ? 1 : 0.7, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease }}
                className="min-w-0"
              >
                <span className="block truncate text-text-primary">{event.type}</span>
                <span className="block truncate text-text-secondary" title={event.data}>
                  {event.data}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </div>
    </div>
  );
}
