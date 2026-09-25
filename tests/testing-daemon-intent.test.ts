import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  createCommandSigningAuthority,
  createSigningKey,
  desiredStateFromStored,
  signTrustBundle,
  storedDesiredState,
} from '@better-compute/pki';
import {
  CommandBodySchema,
  CommandRejectReason,
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
  it('rejects an unsigned destructive command BAD_SIGNATURE and runs a signed one', async () => {
    const h = await daemon();
    const unsigned = send(h, h.commandBody('node.reboot'));
    const plain = send(h, h.commandBody('diag.nvml')); // not destructive: unsigned is fine
    await h.advance(5);
    expect(states(h, unsigned.id)).toEqual(['REJECTED:BAD_SIGNATURE']);
    expect(states(h, plain.id)).not.toContain('REJECTED:BAD_SIGNATURE');

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

  it('without signed intent configured, behaves as v0.1 (nothing checked)', async () => {
    const h = await daemon({ intent: undefined });
    const unsigned = send(h, h.commandBody('node.reboot'));
    await h.advance(5);
    accepted(h, unsigned.id);
  });
});
