import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  approverSetDigest,
  batchScope,
  createApproverKey,
  createCommandSigningAuthority,
  createSigningKey,
  desiredStateFromStored,
  signApproverSet,
  signBatchApproval,
  signTrustBundle,
  storedDesiredState,
} from '@better-compute/pki';
import {
  BatchApprovalSchema,
  BatchProofSchema,
  AgentRole,
  CommandBodySchema,
  CommandRejectReason,
  Lane,
  CommandState,
  SignatureSchema,
  wrapCommand,
  type CommandBody,
} from '@better-compute/protocol';
import { createCommandSigner } from '@better-compute/server';
import {
  createDaemonHarness,
  type DaemonHarness,
  type DaemonHarnessOptions,
} from '@better-compute/testing';

// Signed intent on the daemon side (PLAN.md §6 "Checks before accepting", §13; v0.2 exit
// "unsigned destructive commands are rejected"): FakeDaemon behaves as bcd must.

const T0 = Date.UTC(2026, 8, 24, 12);
const clock = manualClock(T0 - 3_600_000);
const authority = createCommandSigningAuthority({ clock });
const signer = createCommandSigner({ authority, workerId: 'worker-1', clock });
const joinKey = createSigningKey({ clock, commonName: 'join signing' });

async function daemon(options: DaemonHarnessOptions = {}) {
  const h = createDaemonHarness({
    nodeId: 'node_a',
    start: T0,
    intent: {
      roots: [authority.certificate],
      version: 1n,
      trustSigner: { publicKey: joinKey.publicKey },
    },
    ...options,
  });
  await h.advance(10);
  return h;
}

function send(h: DaemonHarness, body: CommandBody, sign?: (bytes: Uint8Array) => Uint8Array) {
  const command = wrapCommand(body, { attempt: 1 });
  if (sign) {
    const bytes = toBinary(CommandBodySchema, body);
    command.signature = fromSignature(sign(bytes));
  }
  h.server.send({ case: 'command', value: command });
  return body;
}

const fromSignature = (bytes: Uint8Array) => fromBinary(SignatureSchema, bytes);

const states = (h: DaemonHarness, id: string): string[] =>
  h.servers
    .flatMap((s) => s.updates(id))
    .map((u) =>
      u.state === CommandState.REJECTED
        ? `REJECTED:${CommandRejectReason[u.rejectReason]}`
        : CommandState[u.state]!,
    );

/** The daemon took the command into its journal (it runs), and never rejected it. */
function accepted(h: DaemonHarness, id: string) {
  expect(states(h, id).filter((state) => state.startsWith('REJECTED'))).toEqual([]);
  expect(h.daemon.journal.command(id)).toBeDefined();
  expect(h.daemon.journal.command(id)?.result?.outcome).not.toBe('rejected');
}

describe('FakeDaemon signed intent', () => {
  it('rejects every unsigned command BAD_SIGNATURE, destructive or not, and runs a signed one', async () => {
    const h = await daemon();
    const unsigned = send(h, h.commandBody('node.reboot'));
    // Not destructive, still refused unsigned (review 7 HIGH-1: site.httpProxy reaches any BMC of a site).
    const plain = send(h, h.commandBody('diag.nvml'));
    await h.advance(5);
    expect(states(h, unsigned.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
    expect(states(h, plain.id)).toEqual(['REJECTED:BAD_SIGNATURE']);

    const signed = send(h, h.commandBody('node.reboot'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    accepted(h, signed.id);
  });

  it('rejects forged, re-targeted and tampered signatures, and checks a signature even when optional', async () => {
    const h = await daemon();
    const rogue = createCommandSigner({
      authority: createCommandSigningAuthority({ clock }),
      workerId: 'gw',
      clock,
    });
    const forged = send(h, h.commandBody('node.reboot'), (bytes) => rogue.sign(bytes));
    // A valid signature over a DIFFERENT body (a gateway swapping payloads).
    const other = h.commandBody('node.reboot');
    const swapped = send(h, h.commandBody('node.reboot'), () =>
      signer.sign(toBinary(CommandBodySchema, other)),
    );
    const badOptional = send(h, h.commandBody('diag.nvml'), (bytes) => rogue.sign(bytes));
    await h.advance(5);
    for (const body of [forged, swapped, badOptional])
      expect(states(h, body.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
  });

  it('checks expiry before the signature (the §6 acceptance order)', async () => {
    const h = await daemon();
    const late = send(h, h.commandBody('node.reboot', {}, { notAfter: timestampFromMs(T0 - 1) }));
    await h.advance(5);
    expect(states(h, late.id)).toEqual(['REJECTED:EXPIRED']);
  });

  it('rotates roots from a newer, join-key-signed Welcome.trust and ignores anything else', async () => {
    const next = createCommandSigningAuthority({ clock, commonName: 'root 2' });
    const nextSigner = createCommandSigner({ authority: next, workerId: 'worker-2', clock });
    const bundle = (version: number, roots: Uint8Array[], key = joinKey) =>
      signTrustBundle({ version, commandSigningRoots: roots }, key);

    // An unsigned-by-us bundle and a stale one change nothing.
    const intruder = createSigningKey({ clock, commonName: 'not the join key' });
    let h = await daemon({
      autoWelcome: () => ({ trust: bundle(5, [next.certificate], intruder) }),
    });
    let cmd = send(h, h.commandBody('node.reboot'), (bytes) => nextSigner.sign(bytes));
    await h.advance(5);
    expect(states(h, cmd.id)).toEqual(['REJECTED:BAD_SIGNATURE']);

    h = await daemon({ autoWelcome: () => ({ trust: bundle(1, [next.certificate]) }) }); // not newer
    cmd = send(h, h.commandBody('node.reboot'), (bytes) => nextSigner.sign(bytes));
    await h.advance(5);
    expect(states(h, cmd.id)).toEqual(['REJECTED:BAD_SIGNATURE']);

    // Step 1 of a rotation: old and new roots overlap; both workers' commands run.
    h = await daemon({
      autoWelcome: () => ({ trust: bundle(2, [authority.certificate, next.certificate]) }),
    });
    // (diag.nvml: a signature that is present is always checked, and it doesn't reboot the node)
    const byOld = send(h, h.commandBody('diag.nvml'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    const byNew = send(h, h.commandBody('diag.nvml'), (bytes) => nextSigner.sign(bytes));
    await h.advance(5);
    accepted(h, byOld.id);
    accepted(h, byNew.id);

    // Step 3: the old root is dropped; its signatures no longer pass.
    h = await daemon({ autoWelcome: () => ({ trust: bundle(3, [next.certificate]) }) });
    cmd = send(h, h.commandBody('node.reboot'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    expect(states(h, cmd.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
  });

  it('reports the trust version it holds in Hello, and a newer one from Welcome.trust in its status', async () => {
    const next = createCommandSigningAuthority({ clock, commonName: 'root 2' });
    const h = await daemon({
      autoWelcome: () => ({
        trust: signTrustBundle({ version: 2, commandSigningRoots: [authority.certificate, next.certificate] }, joinKey),
      }),
    });
    expect(h.server.of('hello')[0]?.trustVersion).toBe(1n);
    // After Welcome the control plane sends the desired state; the StatusReport that answers it carries the version.
    const spec = storedDesiredState({ nodeId: 'node_a', generation: 1, spec: {} });
    h.server.send({ case: 'desired', value: desiredStateFromStored(spec.body, signer.signDesiredState(spec.body)) });
    await h.advance(20_000);
    const statuses = h.server.of('status');
    expect(statuses.at(-1)?.trustVersion).toBe(2n);
    // The next session says so from its Hello on.
    h.server.conn.close('failover');
    await h.advance(30_000);
    expect(h.server.of('hello')[0]?.trustVersion).toBe(2n);
  });

  it('refuses unsigned specs that change access, and forged specs (signed NodeSpecs)', async () => {
    // The v0.2 policy: only access changes need a signature.
    const h = await daemon({
      intent: { roots: [authority.certificate], version: 1n, signedSpecs: 'access' },
    });
    const rogue = createCommandSigner({
      authority: createCommandSigningAuthority({ clock }),
      workerId: 'gw',
      clock,
    });
    let generation = h.daemon.appliedGeneration;
    const sendSpec = (spec: Record<string, unknown>, sign?: (body: Uint8Array) => Uint8Array) => {
      generation += 1;
      const { body } = storedDesiredState({ nodeId: 'node_a', generation, spec });
      h.server.send({ case: 'desired', value: desiredStateFromStored(body, sign ? sign(body) : null) });
      return generation;
    };
    const access = { access: { sshPrincipals: ['root@node_a'] } };

    // No access change: an unsigned spec is still accepted under the 'access' policy.
    const plain = sendSpec({});
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(plain);
    // Adding principals without a signature: refused, not applied.
    const unsignedAccess = sendSpec(access);
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(plain);
    expect(h.daemon.specRejections).toEqual([{ generation: unsignedAccess, reason: 'unsigned' }]);
    // A worker-signed spec under the trusted root applies.
    const signedAccess = sendSpec(access, (body) => signer.signDesiredState(body));
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(signedAccess);
    expect(h.daemon.spec?.access?.sshPrincipals).toEqual(['root@node_a']);
    // A signature that is present is always checked: a rogue root's is refused even without an access change.
    const forged = sendSpec(access, (body) => rogue.signDesiredState(body));
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(signedAccess);
    expect(h.daemon.specRejections.map((rejection) => rejection.generation)).toContain(forged);

    // The default with roots ('always'): every spec needs a signature.
    const strict = await daemon();
    const before = strict.daemon.appliedGeneration;
    const { body } = storedDesiredState({ nodeId: 'node_a', generation: before + 1, spec: {} });
    strict.server.send({ case: 'desired', value: desiredStateFromStored(body, null) });
    await strict.advance(5);
    expect(strict.daemon.appliedGeneration).toBe(before);
    strict.server.send({
      case: 'desired',
      value: desiredStateFromStored(body, signer.signDesiredState(body)),
    });
    await strict.advance(5);
    expect(strict.daemon.appliedGeneration).toBe(before + 1);
  });

  it('cannot be frozen by an unsigned spec with a huge generation (a compromised gateway)', async () => {
    const h = await daemon();
    const applied = h.daemon.appliedGeneration;
    const freeze = storedDesiredState({ nodeId: 'node_a', generation: 2 ** 53 - 1, spec: {} });
    h.server.send({ case: 'desired', value: desiredStateFromStored(freeze.body, null) });
    await h.advance(5);
    // Refused and not journaled: the next real (signed) generation still applies.
    expect(h.daemon.appliedGeneration).toBe(applied);
    expect(h.daemon.specRejections.at(-1)).toMatchObject({ reason: 'unsigned' });
    const next = storedDesiredState({ nodeId: 'node_a', generation: applied + 1, spec: {} });
    h.server.send({
      case: 'desired',
      value: desiredStateFromStored(next.body, signer.signDesiredState(next.body)),
    });
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(applied + 1);
  });

  it('never lets a Welcome rewind server time, so an old signature cannot become valid again', async () => {
    // A compromised gateway recorded a signed reboot and replays it days later, with a Welcome whose
    // (unsigned) server_time puts the daemon back inside the old worker certificate's window.
    let rewindTo: number | undefined;
    const h = await daemon({
      autoWelcome: () => (rewindTo === undefined ? {} : { serverTime: timestampFromMs(rewindTo) }),
    });
    const recorded = h.commandBody('node.reboot');
    const signature = fromSignature(signer.sign(toBinary(CommandBodySchema, recorded)));
    const epoch = h.daemon.epoch;
    await h.advance(3 * 86_400_000);

    rewindTo = T0;
    const dials = h.servers.length;
    h.server.conn.close('gateway failover');
    await h.advance(30_000);
    // Every session that tries to rewind is dropped before it is welcomed.
    expect(h.servers.length).toBeGreaterThan(dials);
    expect(h.daemon.epoch).toBe(epoch);
    const command = wrapCommand(recorded, { attempt: 1 });
    command.signature = signature;
    h.server.send({ case: 'command', value: command });
    await h.advance(5);
    expect(h.daemon.journal.command(recorded.id)).toBeUndefined();

    // A few seconds back (skew between gateways) is accepted, but the daemon's clock keeps its later time: a
    // ticket or command that expired meanwhile (its jti already pruned) stays expired.
    const before = h.daemon.serverNow();
    rewindTo = h.scheduler.now() - 30_000;
    h.server.conn.close('gateway failover');
    await h.advance(30_000);
    expect(h.daemon.epoch).toBeGreaterThan(epoch);
    expect(h.daemon.serverNow()).toBeGreaterThanOrEqual(before);
    const late = h.commandBody('diag.nvml', {}, { notAfter: timestampFromMs(h.scheduler.now() - 10_000) });
    h.server.send({ case: 'command', value: wrapCommand(late, { attempt: 1 }) });
    await h.advance(5);
    expect(states(h, late.id)).toEqual(['REJECTED:EXPIRED']);
  });

  it('enforces the destructive-batch quorum: approved scope only, and an unbatched hourly cap (v1.0)', async () => {
    const approvers = [createApproverKey(), createApproverKey()];
    const h = await daemon({
      intent: {
        roots: [authority.certificate],
        version: 1n,
        trustSigner: { publicKey: joinKey.publicKey },
        quorum: {
          approverKeys: approvers.map((a) => a.key),
          threshold: 2,
          unbatchedPerHour: 1,
          trustDomain: 'compute.test',
        },
      },
      // A destructive kind that does not reboot the node (node.reboot would end the session).
      kinds: {
        'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' }) },
      },
    });
    const batchId = 'batch_01k5w00000000000000000000q';
    const scope = batchScope(batchId, [
      { subject: 'node_a', kind: 'test.destroy' },
      { subject: 'node_other', kind: 'test.destroy' },
    ]);
    const approvalBy = (signers: number[]) => {
      const input = { batchId, scopeRoot: scope.root, scopeSize: scope.size, notAfter: T0 + 3_600_000 };
      return create(BatchApprovalSchema, {
        ...input,
        notAfter: timestampFromMs(input.notAfter),
        signatures: signers.map((i) =>
          signBatchApproval({ ...input, trustDomain: 'compute.test' }, approvers[i]!.privateKey),
        ),
      });
    };
    const sendBatched = (
      kind: string,
      approval: ReturnType<typeof approvalBy> | undefined,
      proofFor = kind,
    ) => {
      const body = h.rawCommandBody(kind, { batchId });
      const command = wrapCommand(body, { attempt: 1 });
      command.signature = fromSignature(signer.sign(toBinary(CommandBodySchema, body)));
      if (approval) command.batchApproval = approval;
      const proof = scope.proofOf('node_a', proofFor);
      if (proof) command.batchProof = create(BatchProofSchema, proof);
      h.server.send({ case: 'command', value: command });
      return body;
    };
    // Approved by both keys, in scope: runs.
    const approved = sendBatched('test.destroy', approvalBy([0, 1]));
    // Each leaf runs once: a second command on the same approved leaf is refused.
    const again = sendBatched('test.destroy', approvalBy([0, 1]));
    // One approval of two, or no approval at all: refused.
    const short = sendBatched('test.destroy', approvalBy([0]));
    const bare = sendBatched('test.destroy', undefined);
    await h.advance(5);
    accepted(h, approved.id);
    expect(states(h, again.id)).toEqual(['REJECTED:BATCH_UNAPPROVED']);
    expect(states(h, short.id)).toEqual(['REJECTED:BATCH_UNAPPROVED']);
    expect(states(h, bare.id)).toEqual(['REJECTED:BATCH_UNAPPROVED']);
    // Unbatched destructive commands: one per rolling hour here, then UNBATCHED_LIMIT.
    const first = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    const second = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    expect(states(h, first.id).filter((state) => state.startsWith('REJECTED'))).toEqual([]);
    expect(states(h, second.id)).toEqual(['REJECTED:UNBATCHED_LIMIT']);
    // Non-destructive commands never need a batch (signed, as every command is).
    const plain = send(h, h.commandBody('diag.nvml'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    expect(states(h, plain.id).filter((state) => state.startsWith('REJECTED'))).toEqual([]);
  });

  it('spends a batch leaf or an unbatched slot only on an accepted command (review 6 L1)', async () => {
    const approvers = [createApproverKey()];
    const h = await daemon({
      intent: {
        roots: [authority.certificate],
        version: 1n,
        trustSigner: { publicKey: joinKey.publicKey },
        quorum: { approverKeys: approvers.map((a) => a.key), threshold: 1, unbatchedPerHour: 1, trustDomain: 'compute.test' },
      },
      kinds: {
        'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' }) },
      },
    });
    const rogue = createCommandSigner({ authority: createCommandSigningAuthority({ clock }), workerId: 'gw', clock });
    // A forged unbatched command is refused and leaves the one slot free.
    const forged = send(h, h.rawCommandBody('test.destroy'), (bytes) => rogue.sign(bytes));
    await h.advance(5);
    expect(states(h, forged.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
    const real = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    accepted(h, real.id);
    // A forged command carrying the (public) approval and proof cannot burn the approved leaf.
    const batchId = 'batch_01k5w00000000000000000000r';
    const scope = batchScope(batchId, [{ subject: 'node_a', kind: 'test.destroy' }]);
    const input = { batchId, scopeRoot: scope.root, scopeSize: scope.size, notAfter: T0 + 3_600_000, trustDomain: 'compute.test' };
    const approval = create(BatchApprovalSchema, {
      batchId,
      scopeRoot: scope.root,
      scopeSize: scope.size,
      notAfter: timestampFromMs(input.notAfter),
      signatures: [signBatchApproval(input, approvers[0]!.privateKey)],
    });
    const batched = (sign: typeof signer) => {
      const body = h.rawCommandBody('test.destroy', { batchId });
      const command = wrapCommand(body, { attempt: 1 });
      command.signature = fromSignature(sign.sign(toBinary(CommandBodySchema, body)));
      command.batchApproval = approval;
      command.batchProof = create(BatchProofSchema, scope.proofOf('node_a', 'test.destroy')!);
      h.server.send({ case: 'command', value: command });
      return body;
    };
    const burn = batched(rogue);
    await h.advance(5);
    expect(states(h, burn.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
    const legit = batched(signer);
    await h.advance(5);
    accepted(h, legit.id);
  });

  it('takes a changed quorum from Welcome.trust only when the current approvers signed it (review 6 H1, 7 M1)', async () => {
    const approvers = [createApproverKey(), createApproverKey()];
    const quorum = {
      approverKeys: approvers.map((a) => a.key),
      threshold: 2,
      unbatchedPerHour: 0,
      trustDomain: 'compute.test',
      epoch: 1n,
    };
    const kinds = {
      'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' as const }) },
    };
    // The next bundle lifts the quorum (no approver keys): what a compromised api holding the join key would send.
    const lifted = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    const bundle = (signers: number[]) =>
      signTrustBundle(
        {
          version: 2,
          commandSigningRoots: [authority.certificate],
          ...lifted,
          approverSetEpoch: 2,
          approverSetSignatures: signers.map((i) => signApproverSet({ epoch: 2, set: lifted, trustDomain: 'compute.test' }, approvers[i]!.privateKey)),
        },
        joinKey,
      );
    const run = async (signers: number[]) => {
      const h = await daemon({
        intent: { roots: [authority.certificate], version: 1n, trustSigner: { publicKey: joinKey.publicKey }, quorum },
        kinds,
        autoWelcome: () => ({ trust: bundle(signers) }),
      });
      const cmd = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
      await h.advance(5);
      return { h, cmd };
    };
    // Signed by the join key alone, or by one approver of two: the quorum part is refused and the quorum stays,
    // while the rest of the bundle (roots, version 2) applies.
    for (const signers of [[], [0], [0, 0]]) {
      const { h, cmd } = await run(signers);
      expect(states(h, cmd.id)).toEqual(['REJECTED:UNBATCHED_LIMIT']);
      h.server.send({ case: 'desired', value: desiredStateFromStored(storedDesiredState({ nodeId: 'node_a', generation: 1, spec: {} }).body, signer.signDesiredState(storedDesiredState({ nodeId: 'node_a', generation: 1, spec: {} }).body)) });
      await h.advance(20_000);
      expect(h.server.of('status').at(-1)?.trustVersion).toBe(2n);
    }
    // Both current approvers signed the change: it applies, and the quorum is lifted.
    const { h, cmd } = await run([0, 1]);
    accepted(h, cmd.id);
  });

  it('keeps the epoch it holds for an unchanged set, so an old signed change cannot be replayed (review 9 HIGH-2)', async () => {
    const [a, b, c] = [createApproverKey(), createApproverKey(), createApproverKey()];
    const current = { approverKeys: [a.key, b.key], approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    // An old, genuinely signed change (epoch 2) that added c at k = 1 with an unbatched allowance; since removed at
    // epoch 3, which is what this daemon holds.
    const old = { approverKeys: [a.key, b.key, c.key], approverThreshold: 1, quorumTiers: [], unbatchedDestructivePerHour: 5 };
    const oldSignatures = [a, b].map((key) => signApproverSet({ epoch: 2, set: old, trustDomain: 'compute.test' }, key.privateKey));
    const welcomes = [
      // The api (holding the join key) republishes the current set at epoch 0, unsigned...
      signTrustBundle({ version: 2, commandSigningRoots: [authority.certificate], ...current, approverSetEpoch: 0 }, joinKey),
      // ...then replays the old epoch-2 change, whose signers are still current.
      signTrustBundle(
        { version: 3, commandSigningRoots: [authority.certificate], ...old, approverSetEpoch: 2, approverSetSignatures: oldSignatures },
        joinKey,
      ),
    ];
    let session = 0;
    const h = await daemon({
      intent: {
        roots: [authority.certificate],
        version: 1n,
        trustSigner: { publicKey: joinKey.publicKey },
        quorum: { approverKeys: current.approverKeys, threshold: 2, unbatchedPerHour: 0, trustDomain: 'compute.test', epoch: 3n },
      },
      kinds: {
        'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' }) },
      },
      autoWelcome: () => ({ trust: welcomes[Math.min(session++, welcomes.length - 1)]! }),
    });
    h.server.conn.close('failover');
    await h.advance(30_000);
    expect(session).toBeGreaterThanOrEqual(2);
    const cmd = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    // The old change was refused: still k = 2 of {a, b} and no unbatched allowance.
    expect(states(h, cmd.id)).toEqual(['REJECTED:UNBATCHED_LIMIT']);
  });

  it('adopts an epoch only with k of the held set, so S→T→S cannot replay T (review 10 M3), and reports what it holds (M5)', async () => {
    const [a, b, c] = [createApproverKey(), createApproverKey(), createApproverKey()];
    const S = { approverKeys: [a.key, b.key], approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    const T = { approverKeys: [a.key, b.key, c.key], approverThreshold: 1, quorumTiers: [], unbatchedDestructivePerHour: 5 };
    const sign = (epoch: number, set: typeof S, keys: typeof a[]) =>
      keys.map((key) => signApproverSet({ epoch, set, trustDomain: 'compute.test' }, key.privateKey));
    const bundle = (version: number, set: typeof S, epoch: number, signatures: ReturnType<typeof sign>) =>
      signTrustBundle({ version, commandSigningRoots: [authority.certificate], ...set, approverSetEpoch: epoch, approverSetSignatures: signatures }, joinKey);
    const tAt2 = bundle(2, T, 2, sign(2, T, [a, b]));
    // S at 3, admitted by T (k = 1) and signed by S's own keys: what moves a daemon holding S@1 to S@3.
    const sAt3 = bundle(3, S, 3, [...sign(3, S, [a]), ...sign(3, S, [a, b])]);
    const run = async (welcomes: ReturnType<typeof bundle>[]) => {
      let session = 0;
      const h = await daemon({
        intent: {
          roots: [authority.certificate],
          version: 1n,
          trustSigner: { publicKey: joinKey.publicKey },
          quorum: { approverKeys: S.approverKeys, threshold: 2, unbatchedPerHour: 0, trustDomain: 'compute.test', epoch: 1n },
        },
        kinds: {
          'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' }) },
        },
        autoWelcome: () => ({ trust: welcomes[Math.min(session++, welcomes.length - 1)]! }),
      });
      for (let i = 1; i < welcomes.length; i++) {
        h.server.conn.close('failover');
        await h.advance(30_000);
      }
      const cmd = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
      await h.advance(5);
      return { h, cmd };
    };
    // S@1 → S@3 (its own signatures) → the old T@2 replayed: refused, S still enforced (no unbatched allowance).
    let { h, cmd } = await run([sAt3, tAt2]);
    expect(states(h, cmd.id)).toEqual(['REJECTED:UNBATCHED_LIMIT']);
    // The held epoch and digest are reported with the trust version.
    const spec = storedDesiredState({ nodeId: 'node_a', generation: 1, spec: {} });
    h.server.send({ case: 'desired', value: desiredStateFromStored(spec.body, signer.signDesiredState(spec.body)) });
    await h.advance(20_000);
    const status = h.server.of('status').at(-1)!;
    expect(status.approverSetEpoch).toBe(3n);
    expect(Buffer.from(status.approverSetSha256).equals(Buffer.from(approverSetDigest(S)))).toBe(true);
    // The same set at a higher epoch WITHOUT its own signatures: kept at the held epoch (then T@2 still refused).
    const tAt2Later = bundle(3, T, 2, sign(2, T, [a, b]));
    ({ h, cmd } = await run([bundle(2, S, 3, []), tAt2Later]));
    // T@2 with k-of-S signatures is a genuine change from S@1: taken (k = 1, 5 unbatched allowed).
    expect(states(h, cmd.id).filter((state) => state.startsWith('REJECTED'))).toEqual([]);
    // A signed removal keeps its epoch: an older set is never taken back by the now keyless daemon.
    const none = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    ({ h, cmd } = await run([bundle(2, none, 4, sign(4, none, [a, b])), tAt2Later]));
    h.server.send({ case: 'desired', value: desiredStateFromStored(spec.body, signer.signDesiredState(spec.body)) });
    await h.advance(20_000);
    const after = h.server.of('status').at(-1)!;
    expect(after.trustVersion).toBe(3n);
    expect(after.approverSetEpoch).toBe(4n);
    expect(after.approverSetSha256).toHaveLength(0);
  });

  it('a pinned daemon without keys takes only the pinned first set, and nothing destructive before it (review 7 M2)', async () => {
    const [a, b, intruder] = [createApproverKey(), createApproverKey(), createApproverKey()];
    const pinned = { approverKeys: [a.key, b.key], approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    const kinds = {
      'test.destroy': { lane: Lane.CONTROL, roles: [AgentRole.NODE], destructive: true, run: () => ({ outcome: 'succeeded' as const }) },
    };
    const boot = (set: typeof pinned) =>
      daemon({
        intent: {
          roots: [authority.certificate],
          version: 1n,
          trustSigner: { publicKey: joinKey.publicKey },
          trustDomain: 'compute.test',
          approverSetSha256: approverSetDigest(pinned),
        },
        kinds,
        autoWelcome: () => ({
          trust: signTrustBundle({ version: 2, commandSigningRoots: [authority.certificate], ...set, approverSetEpoch: 1 }, joinKey),
        }),
      });
    // A compromised api hands the new node its own set (k = 1): refused, and destructive commands wait.
    let h = await boot({ approverKeys: [intruder.key], approverThreshold: 1, quorumTiers: [], unbatchedDestructivePerHour: 5 });
    const early = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    const plain = send(h, h.commandBody('diag.nvml'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    expect(states(h, early.id)).toEqual(['REJECTED:BATCH_UNAPPROVED']);
    expect(states(h, plain.id).filter((state) => state.startsWith('REJECTED'))).toEqual([]);
    // The pinned set: taken, and the quorum applies (no unbatched allowance here).
    h = await boot(pinned);
    const later = send(h, h.rawCommandBody('test.destroy'), (bytes) => signer.sign(bytes));
    await h.advance(5);
    expect(states(h, later.id)).toEqual(['REJECTED:UNBATCHED_LIMIT']);
  });

  it('without signed intent configured, behaves as v0.1 (nothing checked)', async () => {
    const h = await daemon({ intent: undefined });
    const unsigned = send(h, h.commandBody('node.reboot'));
    await h.advance(5);
    accepted(h, unsigned.id);
  });
});
