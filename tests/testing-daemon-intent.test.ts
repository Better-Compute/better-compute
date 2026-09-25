import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  createCommandSigningAuthority,
  createSigningKey,
  signTrustBundle,
} from '@better-compute/pki';
import {
  CommandBodySchema,
  CommandRejectReason,
  CommandState,
  SignatureSchema,
  wrapCommand,
  type CommandBody,
} from '@better-compute/protocol';
// Until server exports it (runtime/command-signing.ts).
import { createCommandSigner } from '../packages/server/src/runtime/command-signing.js';
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

  it('without signed intent configured, behaves as v0.1 (nothing checked)', async () => {
    const h = await daemon({ intent: undefined });
    const unsigned = send(h, h.commandBody('node.reboot'));
    await h.advance(5);
    accepted(h, unsigned.id);
  });
});
