'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useInView } from 'motion/react';
import type { IconType } from 'react-icons';
import {
  RiCheckLine,
  RiCloseLine,
  RiCloudLine,
  RiCpuLine,
  RiInstallLine,
  RiKey2Line,
  RiRadarLine,
  RiShieldKeyholeLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { DiagramFrame, PlayToggle, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * An attested node join, simulated in the browser from the real code paths: the agent half (`runAgentJoin`,
 * the attestor producers), the gateway's relay-only `Join` (P14), JoinService's one transaction in api
 * (packages/server/src/join/service.ts) and the pki attestors (packages/pki/src/attestors). Refusal codes are the
 * `security.join.refused` reasons those files write; the agent only ever sees the same generic denial.
 */

type Actor = 'bcd' | 'gateway' | 'api' | 'worker';
type Status = 'pending' | 'active' | 'passed' | 'failed' | 'skipped';

interface Refusal {
  id: string;
  label: string;
  /** The `security.join.refused` reason (`<attestor>:<reason>` or JoinService's `join:<reason>`), or an error code. */
  code: string;
  /** Whose event stream the refusal lands in: the token's tenant once its secret verified, else the root tenant. */
  tenant?: 'token' | 'root';
  note: ReactNode;
  /** Refused after the join: a command outside the restricted certificate's kinds. */
  command?: boolean;
}

interface Attestor {
  id: string;
  phase: string;
  roles: string;
  icon: IconType;
  blurb: string;
  evidence: { title: string; body: ReactNode };
  verify: { title: string; body: ReactNode };
  issue: { title: string; body: ReactNode };
  final: { title: string; actor: Actor; body: ReactNode };
  /** tpm answers a signed challenge first, so its verify step takes two rounds with the SAME CSR. */
  rounds?: 2;
  /** `new`: JoinService inserts a node. `kept`: the attestor named the node, which is re-keyed in place. */
  node: 'new' | 'kept';
  /** What a kept node's row shows before the join. */
  prior?: { connectivity: string; cert: string };
  cert: string;
  states: { issued: string; final: string };
  extra: { name: string; before?: string; after: string };
  answer: string;
  outbox: string[];
  audit: string;
  refusals: Refusal[];
}

/** Inline code inside step text. */
function C({ children }: { children: ReactNode }) {
  return <code className="font-mono text-text-primary">{children}</code>;
}

const newNode = {
  title: 'Node and certificate',
  body: (
    <>
      A new node in <C>adopting</C> and a 24 h certificate with URI SAN{' '}
      <C>spiffe://&lt;td&gt;/site/&lt;site&gt;/node/&lt;id&gt;</C>, role <C>node</C>. The response
      is signed with the pinned join-signing key.
    </>
  ),
};

const adopted = {
  title: 'Adopted',
  actor: 'worker' as const,
  body: (
    <>
      The first inventory derives the devices. NodeLifecycle runs the pool’s acceptance checks, such
      as <C>diag.nvml</C>; on a pass the node is <C>adopted</C> and NodeSpec writes generation 1.
    </>
  ),
};

const reclaimed = {
  outbox: ['node.joined { reclaimed: true }', 'security.certificate-revoked'],
  audit: 'node.reclaimed',
};

/** The attestors JoinService can run (PLAN.md §13): `join-token` is built in, the rest are passed in `attestors`. */
const attestors: Attestor[] = [
  {
    id: 'join-token',
    phase: 'v0.1',
    roles: 'node, site',
    icon: RiKey2Line,
    blurb:
      'A token from joinTokens.create: single use by default, stored as a hash, sealed in transit. Built in.',
    evidence: {
      title: 'Sealed join token',
      body: (
        <>
          Reads <C>bcjt_&lt;id&gt;.&lt;secret&gt;</C> from <C>BCD_JOIN_TOKEN</C> or stdin and seals
          it to the pinned JoinService key: a JWE whose header names <C>sha256(csr)</C>.
        </>
      ),
    },
    verify: {
      title: 'Attestor verifies',
      body: (
        <>
          One transaction locks the <C>join_tokens</C> row: the secret in constant time, revocation,
          expiry at <C>compute_now()</C>, uses left, role, then the <C>expect</C> binding. One use
          is spent.
        </>
      ),
    },
    issue: newNode,
    final: adopted,
    node: 'new',
    cert: 'node · 24 h',
    states: { issued: 'adopting', final: 'adopted' },
    extra: { name: 'uses_left', before: '1', after: '0' },
    answer: 'JoinResponse { body, sig }',
    outbox: ['node.joined'],
    audit: 'node.joined',
    refusals: [
      {
        id: 'expired',
        label: 'Token expired',
        code: 'join-token:expired',
        tenant: 'token',
        note: (
          <>
            Expiry is checked at <C>compute_now()</C>, the database’s clock, so no caller can move
            it.
          </>
        ),
      },
      {
        id: 'exhausted',
        label: 'Token already used',
        code: 'join-token:exhausted',
        tenant: 'token',
        note: (
          <>
            <C>maxUses</C> defaults to 1, and the first join spent it.
          </>
        ),
      },
      {
        id: 'seal',
        label: 'Seal replayed, other CSR',
        code: 'join:token',
        tenant: 'root',
        note: 'The seal names the CSR it was made for, so a relay cannot reuse it with a key of its own.',
      },
      {
        id: 'expect',
        label: 'Wrong machine',
        code: 'join:expect',
        tenant: 'root',
        note: (
          <>
            The token’s <C>expect</C> binding names a product UUID this machine does not claim.
          </>
        ),
      },
    ],
  },
  {
    id: 'x509pop',
    phase: 'v0.2',
    roles: 'node, site',
    icon: RiShieldKeyholeLine,
    blurb:
      'A node whose certificate expired while it was offline comes back as itself, within 7 days.',
    evidence: {
      title: 'Proof by the old key',
      body: (
        <>
          Its last certificate chain and a signature by that key, purpose <C>x509pop</C>, over{' '}
          <C>sha256(csr)</C>, its node id and the client time.
        </>
      ),
    },
    verify: {
      title: 'Attestor verifies',
      body: (
        <>
          The leaf must be byte for byte a <C>node_certs</C> row of the current identity generation,
          unrevoked and at most 7 days past <C>notAfter</C>; client time within ±60 s; the proof
          valid and never replayed.
        </>
      ),
    },
    issue: {
      title: 'Re-keyed in place',
      body: (
        <>
          The same node, <C>identity_gen</C> + 1, every older certificate revoked <C>reclaimed</C>,
          and a new 24 h certificate.
        </>
      ),
    },
    final: {
      title: 'Back as itself',
      actor: 'gateway',
      body: (
        <>
          Same node, same state: the gateway replays its unfinished commands in <C>seq</C> order.
        </>
      ),
    },
    node: 'kept',
    prior: { connectivity: 'unreachable', cert: 'node · expired' },
    cert: 'node · 24 h',
    states: { issued: 'adopted', final: 'adopted' },
    extra: { name: 'identity_gen', before: '1', after: '2' },
    answer: 'JoinResponse { body, sig }',
    ...reclaimed,
    refusals: [
      {
        id: 'past-grace',
        label: 'Offline over 7 days',
        code: 'x509pop:past-grace',
        tenant: 'root',
        note: 'The grace ends 7 days after notAfter; from then on the machine needs a join token.',
      },
      {
        id: 'revoked',
        label: 'Certificate revoked',
        code: 'x509pop:revoked',
        tenant: 'root',
        note: 'A revoked certificate never comes back, even inside the grace.',
      },
      {
        id: 'bad-proof',
        label: 'Proof replayed, other CSR',
        code: 'x509pop:bad-proof',
        tenant: 'root',
        note: (
          <>
            The proof covers <C>sha256(csr)</C>: captured, it is useless with another key.
          </>
        ),
      },
    ],
  },
  {
    id: 'provisioned',
    phase: 'v0.2',
    roles: 'node',
    icon: RiInstallLine,
    blurb:
      'The OS an image deploy (or a provider bootstrap) installed joins with the token in its user data.',
    evidence: {
      title: 'Single-use token',
      body: (
        <>
          The <C>provisioned</C> token rendered into its user data, sealed like any token, and the
          machine’s product UUID.
        </>
      ),
    },
    verify: {
      title: 'Attestor verifies',
      body: (
        <>
          A <C>provisioned</C> token with exactly one use left, spent here. The product UUID must
          match the token’s <C>expect</C> or the node the deploy was for.
        </>
      ),
    },
    issue: {
      title: 'Re-keyed in place',
      body: (
        <>
          The node the deploy was for keeps its provisioning state and gets a new 24 h certificate;
          the ramdisk’s is revoked.
        </>
      ),
    },
    final: {
      title: 'Deploy continues',
      actor: 'worker',
      body: (
        <>
          The rejoin completes the self-terminating <C>boot.kexec</C> step (
          <C>await: &apos;rejoin&apos;</C>), and the deploy workflow goes on toward <C>deployed</C>.
        </>
      ),
    },
    node: 'kept',
    prior: { connectivity: 'disconnected', cert: 'ramdisk · 2 h' },
    cert: 'node · 24 h',
    states: { issued: 'deploying', final: 'deploying' },
    extra: { name: 'uses_left', before: '1', after: '0' },
    answer: 'JoinResponse { body, sig }',
    ...reclaimed,
    refusals: [
      {
        id: 'exhausted',
        label: 'Token already spent',
        code: 'provisioned:exhausted',
        tenant: 'token',
        note: 'Single use: the first boot of the deployed OS spent it.',
      },
      {
        id: 'token-role',
        label: 'A plain node token',
        code: 'provisioned:token-role',
        tenant: 'token',
        note: (
          <>
            Only a <C>provisioned</C> token is a machine credential here.
          </>
        ),
      },
      {
        id: 'uuid',
        label: 'Another machine’s UUID',
        code: 'provisioned:product-uuid-mismatch',
        tenant: 'token',
        note: 'The claimed product UUID is not the one inventory recorded for the deployed node.',
      },
    ],
  },
  {
    id: 'discovery',
    phase: 'v0.2',
    roles: 'ramdisk',
    icon: RiRadarLine,
    blurb: 'A PXE-booted ramdisk, vouched for by the site agent that served its boot.',
    evidence: {
      title: 'Token and assertion',
      body: (
        <>
          The single-use <C>discovery</C> token from the iPXE script, sealed, and the site agent’s{' '}
          <C>SignedDiscoveryAssertion</C> for this MAC.
        </>
      ),
    },
    verify: {
      title: 'Attestor verifies',
      body: (
        <>
          The signer is a site agent holding <C>site:&lt;id&gt;:boot</C> at the asserted epoch; the
          signature, a 15-minute age limit and the MAC check out. Each assertion admits one join.
        </>
      ),
    },
    issue: {
      title: 'Restricted certificate',
      body: (
        <>
          Role <C>ramdisk</C>, at most 2 h, limited to <C>inventory</C>, <C>diag.*</C>, <C>wipe</C>,{' '}
          <C>deploy.*</C> and <C>boot.kexec</C>. The node keeps its metal state.
        </>
      ),
    },
    final: {
      title: 'Restricted session',
      actor: 'gateway',
      body: (
        <>
          The gateway reads <C>allowed_kinds</C> at <C>Hello</C> and cancels any other kind{' '}
          <C>kind-not-allowed</C>.
        </>
      ),
    },
    node: 'kept',
    prior: { connectivity: 'disconnected', cert: '—' },
    cert: 'ramdisk · 2 h',
    states: { issued: 'inspecting', final: 'inspecting' },
    extra: { name: 'allowed_kinds', after: 'inventory, diag.*, wipe, deploy.*, boot.kexec' },
    answer: 'JoinResponse { body, sig }',
    outbox: ['node.joined { reclaimed: true }'],
    audit: 'node.reclaimed',
    refusals: [
      {
        id: 'stale-epoch',
        label: 'Fenced boot server',
        code: 'discovery:stale-epoch',
        tenant: 'token',
        note: 'Only the current holder of the site’s boot lease can vouch for a machine.',
      },
      {
        id: 'reused',
        label: 'Assertion replayed',
        code: 'discovery:assertion-reused',
        tenant: 'token',
        note: (
          <>
            <C>attestation_uses</C> admits each signed assertion once, whatever token comes with it.
          </>
        ),
      },
      {
        id: 'kind',
        label: 'Kind not allowed',
        code: 'INVALID_STATE',
        command: true,
        note: (
          <>
            <C>commands.run</C> with <C>node.reboot</C> is refused at enqueue: this certificate does
            not allow that kind.
          </>
        ),
      },
    ],
  },
  {
    id: 'cloud-iid',
    phase: 'v0.3',
    roles: 'node',
    icon: RiCloudLine,
    blurb:
      'A platform-owned cloud VM joins with its provider’s signed instance identity, no token.',
    evidence: {
      title: 'Instance identity',
      body: (
        <>
          A GCP identity token whose <C>aud</C> is <C>&lt;audience&gt;#&lt;sha256(csr)&gt;</C>, or
          an AWS identity document and its signature.
        </>
      ),
    },
    verify: {
      title: 'Attestor verifies',
      body: (
        <>
          The provider checks signature, issuer, audience and age; the host’s <C>resolve</C> maps
          the instance to its pool or refuses it. Each instance joins once.
        </>
      ),
    },
    issue: newNode,
    final: adopted,
    node: 'new',
    cert: 'node · 24 h',
    states: { issued: 'adopting', final: 'adopted' },
    extra: { name: 'attestation_uses', after: 'sha256(gcp, project, instance)' },
    answer: 'JoinResponse { body, sig }',
    outbox: ['node.joined'],
    audit: 'node.joined',
    refusals: [
      {
        id: 'reused',
        label: 'Same instance again',
        code: 'cloud-iid:instance-reused',
        tenant: 'root',
        note: 'One join per instance, ever. A machine that lost its certificate re-joins with x509pop.',
      },
      {
        id: 'aud',
        label: 'Token relayed, other CSR',
        code: 'cloud-iid:gcp:aud',
        tenant: 'root',
        note: (
          <>
            The audience carries <C>sha256(csr)</C>, so a captured token fails with another key.
          </>
        ),
      },
      {
        id: 'unknown',
        label: 'Instance not yours',
        code: 'cloud-iid:unknown-instance',
        tenant: 'root',
        note: (
          <>
            <C>resolve</C> found no provider account or pool that created this instance.
          </>
        ),
      },
    ],
  },
  {
    id: 'tpm',
    phase: 'v0.5',
    roles: 'node',
    icon: RiCpuLine,
    blurb:
      'The TPM’s endorsement key proves the machine: an identity no disk swap or reinstall changes.',
    evidence: {
      title: 'EK and attestation key',
      body: (
        <>
          The EK public area and manufacturer certificate and an attestation key; later, a PCR quote
          whose nonce is <C>sha256(secret ‖ sha256(csr))</C>.
        </>
      ),
    },
    verify: {
      title: 'Challenge, then quote',
      body: (
        <>
          Round 1 checks the EK chain and answers a signed <C>JoinChallenge</C> (at most 5 min),
          issuing and spending nothing. Round 2 checks the secret, the quote’s signature, nonce and
          PCRs, then the policy.
        </>
      ),
    },
    issue: {
      title: 'Node and certificate',
      body: (
        <>
          A new node in <C>adopting</C> and a 24 h certificate. The EK hash is bound to it in{' '}
          <C>node_bindings</C>, so that TPM can never admit another node.
        </>
      ),
    },
    final: adopted,
    rounds: 2,
    node: 'new',
    cert: 'node · 24 h',
    states: { issued: 'adopting', final: 'adopted' },
    extra: { name: 'node_bindings', after: 'tpm · sha256(EK)' },
    answer: 'JoinChallenge, then JoinResponse',
    outbox: ['node.joined'],
    audit: 'node.joined',
    refusals: [
      {
        id: 'late',
        label: 'Answer too late',
        code: 'tpm:challenge-expired',
        tenant: 'root',
        note: 'The sealed challenge state carries a deadline of at most 5 minutes.',
      },
      {
        id: 'unknown-ek',
        label: 'EK not known',
        code: 'tpm:unknown-ek',
        tenant: 'root',
        note: (
          <>
            Not bound, not allowed by <C>resolve</C>, and enrollment is off. With enrollment on, the
            join waits for <C>joinRequests.approve</C> instead.
          </>
        ),
      },
      {
        id: 'pcr',
        label: 'PCRs off policy',
        code: 'tpm:pcr-policy:…',
        tenant: 'root',
        note: (
          <>
            The quote was genuine, but the host’s <C>pcrPolicy</C> named a reason to refuse it.
          </>
        ),
      },
    ],
  },
];

/** The seven steps, in order; the verify step is where every join refusal happens. */
const VERIFY = 3;
const ISSUE = 4;
const SESSION = 5;
const FINAL = 6;

/** One beat per step, and two for tpm's two-round verify step. */
const plainBeats = [0, 1, 2, 3, 4, 5, 6];
const twoRoundBeats = [0, 1, 2, 3, 3, 4, 5, 6];

const FIRST_MS = 350;
const BEAT_MS = 620;
/** How long a finished join rests before the next attestor plays. */
const HOLD_MS = 3400;

/** An example `node_…` id (`newId('node')`: the prefix and 26 base32 characters). */
const NODE_ID = 'node_01k5xq3m8e2t7w9c4hvr6bzn1d';

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring';

function stepsOf(attestor: Attestor): { actor: Actor; title: string; body: ReactNode }[] {
  return [
    {
      actor: 'bcd',
      title: 'Key and CSR',
      body: (
        <>
          A fresh P-256 key, in the TPM when there is one, and a PKCS#10 CSR. The signed answer will
          name its <C>sha256</C>.
        </>
      ),
    },
    { actor: 'bcd', ...attestor.evidence },
    {
      actor: 'gateway',
      title: 'Join, relayed',
      body: (
        <>
          <C>AgentGateway.Join</C> over TLS pinned to the serving CA. The gateway forwards it to
          JoinService in api; it holds no CA and no signing key.
        </>
      ),
    },
    { actor: 'api', ...attestor.verify },
    { actor: 'api', ...attestor.issue },
    {
      actor: 'gateway',
      title: 'Session opens',
      body: (
        <>
          bcd checks the signature against its pin, <C>csr_sha256</C> and the SPIFFE SAN, then sends{' '}
          <C>Hello</C> over mTLS. The gateway bumps the epoch and answers <C>Welcome</C>: heartbeat
          10 s, lease 40 s.
        </>
      ),
    },
    { ...attestor.final },
  ];
}

function summaryOf(attestor: Attestor, refusal: Refusal | null) {
  if (!refusal) return `${attestor.id}: joined. ${attestor.final.title}.`;
  if (refusal.command)
    return `${attestor.id}: joined with a restricted certificate; node.reboot refused with INVALID_STATE.`;
  return `${attestor.id}: refused. The agent sees PERMISSION_DENIED, Join refused; the audit reason is ${refusal.code}.`;
}

interface Choice {
  attestor: number;
  refusal: string | null;
  /** Bumped by every selection and replay, so the steps run again from the top. */
  run: number;
  /** Started by the reader rather than by autoplay: only those runs are announced. */
  user: boolean;
}

export function JoinFlow() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduced = useReducedMotionSafe();
  const ids = useId();

  const [choice, setChoice] = useState<Choice>({ attestor: 0, refusal: null, run: 0, user: false });
  const [tick, setTick] = useState({ run: -1, beats: 0 });
  const [paused, setPaused] = useState(false);
  // Pressing play is an explicit choice, so it overrides the reduced-motion default.
  const [chosen, setChosen] = useState(false);

  const attestor = attestors[choice.attestor]!;
  const refusal = attestor.refusals.find((item) => item.id === choice.refusal) ?? null;
  const failAt = refusal ? (refusal.command ? FINAL : VERIFY) : null;
  const beats = attestor.rounds === 2 ? twoRoundBeats : plainBeats;
  const end = failAt === null ? beats.length : beats.lastIndexOf(failAt) + 1;
  // With reduced motion every run shows its outcome at once.
  const progress = reduced ? end : tick.run === choice.run ? Math.min(tick.beats, end) : 0;
  const done = progress >= end;
  const autoplay = !paused && (!reduced || chosen);
  const steps = stepsOf(attestor);

  // One beat at a time while the demo is on screen.
  useEffect(() => {
    if (reduced || done || !inView) return;
    const timer = setTimeout(
      () => setTick({ run: choice.run, beats: progress + 1 }),
      progress === 0 ? FIRST_MS : BEAT_MS,
    );
    return () => clearTimeout(timer);
  }, [reduced, done, inView, progress, choice.run]);

  // Autoplay walks the attestors, each admitted; the reader picks refusals.
  useEffect(() => {
    if (!autoplay || !done || !inView) return;
    const timer = setTimeout(
      () =>
        setChoice((current) => ({
          attestor: (current.attestor + 1) % attestors.length,
          refusal: null,
          run: current.run + 1,
          user: false,
        })),
      HOLD_MS,
    );
    return () => clearTimeout(timer);
  }, [autoplay, done, inView, choice.run]);

  function pick(attestorIndex: number, refusalId: string | null) {
    setPaused(true);
    setChoice((current) => ({
      attestor: attestorIndex,
      refusal: refusalId,
      run: current.run + 1,
      user: true,
    }));
  }

  function replay() {
    setChoice((current) => ({ ...current, run: current.run + 1, user: true }));
  }

  function toggle() {
    if (autoplay) {
      setPaused(true);
    } else {
      setChosen(true);
      setPaused(false);
    }
  }

  function statusOf(index: number): Status {
    if (failAt !== null && done) {
      if (index === failAt) return 'failed';
      if (index > failAt) return 'skipped';
    }
    if (beats.lastIndexOf(index) < progress) return 'passed';
    if (!done && beats[progress] === index) return 'active';
    return 'pending';
  }

  const issued = statusOf(ISSUE) === 'passed';
  const connected = statusOf(SESSION) === 'passed';
  const finished = statusOf(FINAL) === 'passed';
  /** A node row exists: issued now, or named by the attestor from the start. */
  const hasRow = issued || attestor.node === 'kept';
  const outcome = !done
    ? 'pending'
    : refusal === null
      ? 'admitted'
      : refusal.command
        ? 'restricted'
        : 'refused';

  /** tpm's verify step: which round is running. */
  function roundLabel(status: Status) {
    const first = beats.indexOf(VERIFY);
    if (status === 'active')
      return progress - first === 0 ? 'round 1 · JoinChallenge' : 'round 2 · same CSR';
    if (status === 'failed') return 'round 2';
    return '2 rounds';
  }

  // What each side sees, as it becomes known: JoinService answers (and commits its events) when it issues.
  const answer: { key: string; value: string; mark?: 'ink' | 'hatch' }[] = [];
  if (outcome === 'refused' && refusal) {
    answer.push(
      { key: 'bcd gets', value: 'PERMISSION_DENIED · Join refused', mark: 'hatch' },
      { key: 'outbox', value: 'security.join.refused' },
      { key: 'reason', value: refusal.code, mark: 'hatch' },
      {
        key: 'tenant',
        value: refusal.tenant === 'token' ? 'the token’s tenant' : 'the root tenant',
      },
    );
  } else if (issued) {
    answer.push({ key: 'bcd gets', value: attestor.answer, mark: 'ink' });
    if (outcome === 'restricted') {
      answer.push(
        { key: 'commands.run', value: 'INVALID_STATE', mark: 'hatch' },
        { key: 'details', value: "{ kind: 'node.reboot', allowedKinds }" },
        { key: 'in flight', value: 'cancelled · kind-not-allowed' },
      );
    } else {
      const events =
        finished && attestor.node === 'new'
          ? [...attestor.outbox, 'node.adopted']
          : attestor.outbox;
      events.forEach((event, index) =>
        answer.push({ key: index === 0 ? 'outbox' : '', value: event }),
      );
      answer.push({ key: 'audit', value: attestor.audit });
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      <div ref={ref}>
        {/* Announces only the runs the reader started, once they finish. */}
        <p className="sr-only" aria-live="polite">
          {choice.user && done ? summaryOf(attestor, refusal) : ''}
        </p>
        <DiagramFrame
          live={autoplay}
          label={
            <>
              Attested join · <span className="font-mono text-text-primary">{attestor.id}</span>
            </>
          }
          actions={
            <>
              <PlayToggle paused={!autoplay} onClick={toggle} compact />
              <ReplayButton onClick={replay} />
            </>
          }
          footer={
            <>
              Every refusal looks the same to the agent; only the audit event carries the reason.
              Simulated from JoinService and the pki attestors: <C>join-token</C> is built in, the
              others are opt-in through <C>betterCompute({'{ attestors }'})</C>. bcd is written but
              not released yet; tests run these joins with the TypeScript agent.
            </>
          }
        >
          <div className="@container">
            {/* Attestor and outcome */}
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2.5">
                <p id={`${ids}-attestor`} className="eyebrow">
                  Attestor
                </p>
                <LayoutGroup id={ids}>
                  <div
                    role="group"
                    aria-labelledby={`${ids}-attestor`}
                    className="grid grid-cols-2 gap-1 @md:grid-cols-3 @4xl:grid-cols-6"
                  >
                    {attestors.map((item, index) => {
                      const Icon = item.icon;
                      const selected = index === choice.attestor;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => pick(index, null)}
                          aria-pressed={selected}
                          aria-label={`${item.id}, ${item.phase}, admits ${item.roles}`}
                          className={cx(
                            'group relative flex min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-start transition-[color,background-color,scale] duration-200 active:scale-[0.98]',
                            focusRing,
                            selected
                              ? 'text-text-primary'
                              : 'text-text-secondary hover:bg-background-secondary-default hover:text-text-primary',
                          )}
                        >
                          {selected ? (
                            <motion.span
                              layoutId="join-attestor"
                              aria-hidden
                              className="absolute inset-0 rounded-lg border border-border-button-default bg-background-primary-default shadow-xs"
                              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                            />
                          ) : null}
                          <Icon
                            aria-hidden
                            className={cx(
                              'relative mt-px size-4 shrink-0 transition-[color,scale] duration-200 group-hover:scale-110',
                              selected
                                ? 'text-foreground-icon-primary'
                                : 'text-foreground-icon-secondary group-hover:text-foreground-icon-primary',
                            )}
                          />
                          <span className="relative flex min-w-0 flex-col">
                            <span className="truncate font-mono text-caption-1-medium">
                              {item.id}
                            </span>
                            <span className="truncate text-caption-2-regular text-text-tertiary">
                              {item.phase} · {item.roles}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </LayoutGroup>
                <div className="relative min-h-10 @3xl:min-h-5">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={attestor.id}
                      className="text-caption-1-regular leading-5 text-text-secondary"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                    >
                      {attestor.blurb}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <p id={`${ids}-outcome`} className="eyebrow">
                  Try an outcome
                </p>
                <div
                  role="group"
                  aria-labelledby={`${ids}-outcome`}
                  className="flex flex-wrap gap-1.5"
                >
                  <OutcomeChip
                    selected={choice.refusal === null}
                    onClick={() => pick(choice.attestor, null)}
                  >
                    Admitted
                  </OutcomeChip>
                  {attestor.refusals.map((item) => (
                    <OutcomeChip
                      key={item.id}
                      refused
                      selected={choice.refusal === item.id}
                      onClick={() => pick(choice.attestor, item.id)}
                    >
                      {item.label}
                    </OutcomeChip>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-6 border-t border-separator-border pt-5 @xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] @xl:gap-7">
              {/* Steps */}
              <div className="flex min-w-0 flex-col gap-3">
                <p className="eyebrow">Join</p>
                <ol
                  key={`${attestor.id}-${choice.run}`}
                  aria-label="Join steps"
                  className="flex flex-col gap-3"
                >
                  {steps.map((step, index) => {
                    const status = statusOf(index);
                    const failure = status === 'failed' ? refusal : null;
                    return (
                      <li
                        key={index}
                        className={cx(
                          'relative flex items-start gap-3 transition-opacity duration-300',
                          status === 'pending' && 'opacity-55',
                          status === 'skipped' && 'opacity-40',
                        )}
                      >
                        {/* The rail to the next step draws in once this one passes. */}
                        {index < steps.length - 1 ? (
                          <span
                            aria-hidden
                            className="absolute start-[7.5px] top-[1.125rem] -bottom-3 w-px bg-border-button-default"
                          >
                            <motion.span
                              className="absolute inset-0 origin-top bg-text-primary"
                              initial={false}
                              animate={{ scaleY: status === 'passed' ? 1 : 0 }}
                              transition={{ duration: 0.35, ease }}
                            />
                          </span>
                        ) : null}
                        <Marker status={status} />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="rounded-md border border-border-button-default bg-background-primary-default px-1 font-mono text-caption-2-regular text-text-secondary">
                              {step.actor}
                            </span>
                            <span className="text-body-2-medium text-text-primary">
                              {step.title}
                            </span>
                            {index === VERIFY && attestor.rounds === 2 ? (
                              <span className="rounded-full border border-dashed border-border-button-hover px-1.5 font-mono text-caption-2-regular text-text-secondary">
                                {roundLabel(status)}
                              </span>
                            ) : null}
                            <span className="sr-only">
                              {status === 'passed'
                                ? '(done)'
                                : status === 'active'
                                  ? '(running)'
                                  : status === 'failed'
                                    ? '(refused)'
                                    : status === 'skipped'
                                      ? '(not reached)'
                                      : ''}
                            </span>
                            {status === 'skipped' ? (
                              <span
                                aria-hidden
                                className="text-caption-2-regular text-text-tertiary"
                              >
                                not reached
                              </span>
                            ) : null}
                          </div>
                          <p
                            className={cx(
                              'text-caption-1-regular leading-5 wrap-anywhere',
                              failure ? 'text-text-primary' : 'text-text-secondary',
                            )}
                          >
                            {failure ? failure.note : step.body}
                          </p>
                          {failure ? (
                            <motion.span
                              className="hatch mt-0.5 inline-flex w-fit max-w-full items-center gap-1 rounded-md border border-text-primary bg-background-primary-default px-1.5 py-px font-mono text-caption-2-medium text-text-primary"
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.3, ease }}
                            >
                              <RiCloseLine aria-hidden className="size-3 shrink-0" />
                              <span className="truncate">{failure.code}</span>
                            </motion.span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {/* Node row and answer */}
              <div className="flex min-w-0 flex-col gap-3">
                <p className="eyebrow">Node</p>
                <div
                  className={cx(
                    'relative flex flex-col gap-2 rounded-xl border bg-background-primary-default p-3.5 shadow-xs transition-colors duration-300',
                    outcome === 'refused'
                      ? 'hatch border-text-primary'
                      : issued
                        ? 'border-text-primary'
                        : 'border-border-button-default',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={hasRow ? 'id' : outcome === 'refused' ? 'none' : 'waiting'}
                        title={hasRow ? NODE_ID : undefined}
                        className={cx(
                          'min-w-0 flex-1 truncate font-mono text-caption-1-medium',
                          hasRow ? 'text-text-primary' : 'text-text-tertiary',
                        )}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2 }}
                      >
                        {hasRow ? NODE_ID : outcome === 'refused' ? 'no node' : 'no node yet'}
                      </motion.span>
                    </AnimatePresence>
                    <NodeBadge
                      state={
                        outcome === 'refused'
                          ? 'refused'
                          : connected
                            ? 'connected'
                            : issued
                              ? 'issued'
                              : 'waiting'
                      }
                    />
                  </div>
                  {outcome === 'refused' ? (
                    <motion.div
                      className="flex flex-col gap-1 rounded-lg bg-background-primary-default px-2.5 py-2"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, ease }}
                    >
                      <span className="text-body-2-medium text-text-primary">Nothing changed</span>
                      <span className="text-caption-1-regular leading-5 text-text-secondary">
                        The join’s transaction rolled back:{' '}
                        {attestor.node === 'new' ? 'no node' : 'the node untouched'}, no
                        certificate, nothing spent. The refusal is recorded in a transaction of its
                        own.
                      </span>
                    </motion.div>
                  ) : (
                    <div className="flex flex-col font-mono text-caption-1-regular leading-6">
                      <Field
                        name="provision_state"
                        value={
                          hasRow ? (finished ? attestor.states.final : attestor.states.issued) : '—'
                        }
                        highlight={finished && attestor.states.final !== attestor.states.issued}
                      />
                      <Field
                        name="connectivity"
                        value={
                          connected
                            ? 'connected'
                            : attestor.prior
                              ? attestor.prior.connectivity
                              : issued
                                ? 'disconnected'
                                : '—'
                        }
                        highlight={connected}
                      />
                      <Field
                        name="session_epoch"
                        value={
                          attestor.node === 'kept'
                            ? connected
                              ? 'n + 1'
                              : 'n'
                            : connected
                              ? '1'
                              : issued
                                ? '0'
                                : '—'
                        }
                      />
                      <Field
                        name="certificate"
                        value={issued ? attestor.cert : (attestor.prior?.cert ?? '—')}
                      />
                      <Field
                        name={attestor.extra.name}
                        value={issued ? attestor.extra.after : (attestor.extra.before ?? '—')}
                        highlight={issued}
                      />
                    </div>
                  )}
                </div>

                <p className="eyebrow mt-2">Answer</p>
                <div className="min-h-[6.5rem] rounded-lg border border-dashed border-border-button-default px-3 py-2.5">
                  <AnimatePresence mode="wait" initial={false}>
                    {answer.length ? (
                      <motion.dl
                        key={`${attestor.id}-${choice.run}`}
                        className="flex flex-col gap-1 font-mono text-caption-2-regular leading-5"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {answer.map((row) => (
                          <motion.div
                            key={`${row.key}:${row.value}`}
                            className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, ease }}
                          >
                            <dt className="truncate text-text-secondary">{row.key}</dt>
                            <dd className="min-w-0">
                              <span
                                title={row.value}
                                className={cx(
                                  'block truncate text-text-primary',
                                  row.mark === 'ink' &&
                                    '-ms-1 w-fit max-w-full rounded-md bg-background-secondary-default px-1',
                                  row.mark === 'hatch' &&
                                    'hatch -ms-1 w-fit max-w-full rounded-md border border-text-primary px-1',
                                )}
                              >
                                {row.value}
                              </span>
                            </dd>
                          </motion.div>
                        ))}
                      </motion.dl>
                    ) : (
                      <motion.p
                        key="waiting"
                        className="flex items-center gap-2 text-caption-1-regular text-text-tertiary"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {progress > 0 ? <span aria-hidden className="live-dot" /> : null}
                        Waiting for JoinService
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </DiagramFrame>
      </div>
    </MotionConfig>
  );
}

function OutcomeChip({
  selected,
  refused = false,
  onClick,
  children,
}: {
  selected: boolean;
  refused?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-caption-1-medium transition-[color,border-color,background-color,scale] duration-200 active:scale-[0.97]',
        focusRing,
        selected
          ? 'border-text-primary bg-background-primary-default text-text-primary shadow-xs'
          : 'border-border-button-default text-text-secondary hover:border-border-button-hover hover:text-text-primary',
      )}
    >
      {/* Admitted is solid ink; a refusal is hatched. */}
      <span
        aria-hidden
        className={cx(
          'flex size-3.5 shrink-0 items-center justify-center rounded-full',
          refused ? 'hatch border border-current' : 'bg-current',
        )}
      >
        {refused ? (
          <RiCloseLine className="size-2.5" />
        ) : (
          <RiCheckLine className="size-2.5 text-background-full" />
        )}
      </span>
      {children}
    </button>
  );
}

function Marker({ status }: { status: Status }) {
  return (
    <span
      className={cx(
        'relative mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border bg-surface-raised transition-colors duration-300',
        status === 'skipped'
          ? 'border-dashed border-text-tertiary'
          : status === 'pending'
            ? 'border-border-button-hover'
            : 'border-text-primary',
      )}
    >
      {status === 'active' ? <span aria-hidden className="live-dot" /> : null}
      {status === 'passed' ? (
        <motion.span
          className="absolute -inset-px flex items-center justify-center rounded-full bg-text-primary text-background-full"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 26 }}
        >
          <RiCheckLine className="size-3" aria-hidden />
        </motion.span>
      ) : null}
      {status === 'failed' ? (
        <motion.span
          className="hatch absolute -inset-px flex items-center justify-center rounded-full border border-text-primary bg-background-primary-default text-text-primary"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 22 }}
        >
          <RiCloseLine className="size-3" aria-hidden />
        </motion.span>
      ) : null}
    </span>
  );
}

function NodeBadge({ state }: { state: 'waiting' | 'issued' | 'connected' | 'refused' }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={state}
        className={cx(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-caption-2-medium tracking-wide uppercase',
          state === 'waiting' && 'border-dashed border-border-button-hover text-text-tertiary',
          state === 'issued' &&
            'border-text-primary bg-background-primary-default text-text-primary',
          state === 'connected' && 'border-text-primary bg-text-primary text-background-full',
          state === 'refused' &&
            'hatch border-text-primary bg-background-primary-default text-text-primary',
        )}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ type: 'spring', stiffness: 500, damping: 26 }}
      >
        {state === 'connected' ? <RiCheckLine className="size-3" aria-hidden /> : null}
        {state === 'refused' ? <RiCloseLine className="size-3" aria-hidden /> : null}
        {state}
      </motion.span>
    </AnimatePresence>
  );
}

function Field({ name, value, highlight }: { name: string; value: string; highlight?: boolean }) {
  const empty = value === '—';
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-[7.5rem] shrink-0 truncate text-text-secondary">{name}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={value}
          title={value}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 4 }}
          transition={{ duration: 0.2 }}
          className={cx(
            'min-w-0 truncate',
            empty ? 'text-text-tertiary' : 'text-text-primary',
            highlight && !empty && '-ms-1 rounded-md bg-background-secondary-default px-1',
          )}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
