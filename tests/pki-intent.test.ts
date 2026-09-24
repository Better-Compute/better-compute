import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { manualClock } from '@better-compute/core';
import {
  AttestedReportBodySchema,
  CommandBodySchema,
  CommandState,
  CommandUpdateSchema,
  DesiredStateBodySchema,
} from '@better-compute/protocol';
import {
  addTrustRoot,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  nodeSpiffeId,
  parseCertificate,
  removeTrustRoot,
  signAttestedReport,
  signCommand,
  signCommandUpdate,
  signDesiredState,
  spkiSha256,
  trustVersionAcknowledged,
  verifyAttestedReport,
  verifyAttestedUpdate,
  verifyCommand,
  verifyDesiredState,
  type NodeCertLookup,
} from '@better-compute/pki';

const start = Date.UTC(2026, 8, 24, 12);
const nodeId = 'node_01k5w0000000000000000000aa';

function reason(fn: () => unknown): string {
  try {
    fn();
    return 'accepted';
  } catch (error) {
    return String((error as { details?: { reason?: string } }).details?.reason);
  }
}

async function asyncReason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'accepted';
  } catch (error) {
    return String((error as { details?: { reason?: string } }).details?.reason);
  }
}

describe('signed commands and desired state', () => {
  const body = () =>
    create(CommandBodySchema, {
      id: 'cmd_1',
      nodeId,
      seq: 7n,
      kind: 'diag.nvml',
      idempotencyKey: 'k',
    });

  it('verifies worker-signed intent under a trusted root and refuses everything else', () => {
    const clock = manualClock(start);
    const authority = createCommandSigningAuthority({ clock });
    const worker = authority.issueWorkerKey({ workerId: 'wkr-1' });
    expect(worker.notAfter - start).toBeLessThanOrEqual(86_400_000);
    const options = { roots: [authority.certificate], now: clock.now(), nodeId, required: true };
    const command = signCommand(body(), worker);
    expect(verifyCommand(command, options)).toMatchObject({
      id: 'cmd_1',
      kind: 'diag.nvml',
      seq: 7n,
    });

    // A relay editing the body, another node's command, an untrusted signer, a stale key.
    const edited = { ...command, body: command.body.slice() };
    edited.body[edited.body.length - 1]! ^= 1;
    expect(reason(() => verifyCommand(edited, options))).toMatch(/bad signature|unreadable/);
    expect(reason(() => verifyCommand(command, { ...options, nodeId: 'node_other' }))).toBe(
      'command for another node',
    );
    const rogue = createCommandSigningAuthority({ clock }).issueWorkerKey({ workerId: 'x' });
    expect(reason(() => verifyCommand(signCommand(body(), rogue), options))).toMatch(
      /trusted root/,
    );
    expect(
      reason(() => verifyCommand(command, { ...options, now: start + 2 * 86_400_000 })),
    ).toMatch(/expired/);
    // A key that is not a command-signing key, e.g. the JoinService key, cannot sign intent.
    expect(
      reason(() => verifyCommand(signCommand(body(), createSigningKey({ clock })), options)),
    ).toMatch(/trusted root/);
    // A join-response signature never verifies as a command (purpose separation).
    const repurposed = { ...command, signature: worker.sign('join-response', [command.body]) };
    expect(reason(() => verifyCommand(repurposed, options))).toBe('bad signature');

    // Unsigned commands pass only where the kind table does not require a signature.
    const unsigned = { ...command, signature: undefined };
    expect(reason(() => verifyCommand(unsigned, options))).toBe('unsigned');
    expect(verifyCommand(unsigned, { ...options, required: false }).id).toBe('cmd_1');
    expect(reason(() => verifyCommand(edited, { ...options, required: false }))).not.toBe(
      'accepted',
    );
    expect(() => authority.issueWorkerKey({ workerId: 'w', ttlSeconds: 86_401 })).toThrow(/24 h/);
  });

  it('signs desired state the same way', () => {
    const authority = createCommandSigningAuthority();
    const worker = authority.issueWorkerKey({ workerId: 'wkr-2' });
    const state = signDesiredState(
      create(DesiredStateBodySchema, { nodeId, generation: 3n }),
      worker,
    );
    const options = { roots: [authority.certificate], now: Date.now(), nodeId, required: true };
    expect(verifyDesiredState(state, options).generation).toBe(3n);
    expect(reason(() => verifyDesiredState(state, { ...options, nodeId: 'node_x' }))).toBe(
      'spec for another node',
    );
    // A command signature does not verify a spec with the same bytes.
    const command = signCommand(create(CommandBodySchema, { nodeId }), worker);
    expect(
      reason(() => verifyDesiredState({ ...state, signature: command.signature }, options)),
    ).toBe('bad signature');
  });

  it('reloads an authority from its export', () => {
    const authority = createCommandSigningAuthority();
    const exported = authority.export();
    const again = createCommandSigningAuthority({
      existing: { privateKey: exported.privateKeyPem, certificate: exported.certificatePem },
    });
    const worker = again.issueWorkerKey({ workerId: 'w' });
    expect(
      verifyCommand(signCommand(create(CommandBodySchema, { nodeId }), worker), {
        roots: [authority.certificate],
        now: Date.now(),
        nodeId,
        required: true,
      }).nodeId,
    ).toBe(nodeId);
  });
});

describe('root rotation', () => {
  it('adds the new root first, switches after every daemon acked, then drops the old', () => {
    const oldRoot = createCommandSigningAuthority();
    const newRoot = createCommandSigningAuthority();
    let bundle = { version: 1n, roots: [oldRoot.certificate] };
    bundle = addTrustRoot(bundle, newRoot.certificate);
    expect(bundle.version).toBe(2n);
    expect(addTrustRoot(bundle, newRoot.certificate)).toBe(bundle);
    expect(trustVersionAcknowledged(2n, [2n, 2n, 1n], 3)).toBe(false);
    expect(trustVersionAcknowledged(2n, [2n, 3n, 2n], 3)).toBe(true);
    // During the overlap, commands signed under either root verify.
    for (const root of [oldRoot, newRoot]) {
      const worker = root.issueWorkerKey({ workerId: 'w' });
      expect(
        verifyCommand(signCommand(create(CommandBodySchema, { nodeId }), worker), {
          roots: bundle.roots,
          now: Date.now(),
          nodeId,
          required: true,
        }).nodeId,
      ).toBe(nodeId);
    }
    bundle = removeTrustRoot(bundle, oldRoot.certificate);
    expect(bundle).toMatchObject({ version: 3n, roots: [newRoot.certificate] });
    expect(() => removeTrustRoot(bundle, newRoot.certificate)).toThrow(/at least one root/);
  });
});

describe('attested results', () => {
  async function node() {
    const clock = manualClock(start);
    const ca = createNodeCa({ clock });
    const key = generateP256KeyPair();
    const issued = await ca.issue(key.publicKey, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 86_400,
      uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 's', nodeId })],
    });
    const cert = parseCertificate(issued.certificate);
    const lookup: NodeCertLookup = async (spki, id) =>
      Buffer.compare(Buffer.from(spki), Buffer.from(spkiSha256(key.publicKey))) === 0
        ? {
            serial: cert.serial,
            nodeId: id === nodeId ? nodeId : 'node_owner',
            role: 'node',
            der: issued.certificate,
            notBefore: cert.notBefore,
            notAfter: cert.notAfter,
          }
        : undefined;
    return { clock, key, lookup, notAfter: cert.notAfter };
  }

  it('accepts a node-signed update and refuses a gateway-forged one', async () => {
    const n = await node();
    const result = new TextEncoder().encode('{"wiped":true}');
    const update = create(CommandUpdateSchema, {
      commandId: 'cmd_wipe',
      state: CommandState.SUCCEEDED,
      result,
      nodeSig: signCommandUpdate(n.key.privateKey, {
        commandId: 'cmd_wipe',
        state: CommandState.SUCCEEDED,
        result,
      }),
    });
    const options = { nodeId, lookup: n.lookup, now: n.clock.now() };
    await expect(verifyAttestedUpdate(update, options)).resolves.toMatchObject({ role: 'node' });
    // The PLAN.md v0.2 exit test: a forged wipe result is rejected.
    const forged = create(CommandUpdateSchema, {
      ...update,
      result: new TextEncoder().encode('{"wiped":false}'),
    });
    expect(await asyncReason(() => verifyAttestedUpdate(forged, options))).toBe('bad signature');
    const failedInstead = create(CommandUpdateSchema, { ...update, state: CommandState.FAILED });
    expect(await asyncReason(() => verifyAttestedUpdate(failedInstead, options))).toBe(
      'bad signature',
    );
    const gatewayKey = generateP256KeyPair();
    const byGateway = create(CommandUpdateSchema, {
      ...update,
      nodeSig: signCommandUpdate(gatewayKey.privateKey, {
        commandId: 'cmd_wipe',
        state: CommandState.SUCCEEDED,
        result,
      }),
    });
    expect(await asyncReason(() => verifyAttestedUpdate(byGateway, options))).toBe(
      'unknown node key',
    );
    expect(
      await asyncReason(() =>
        verifyAttestedUpdate(
          create(CommandUpdateSchema, { ...update, nodeSig: undefined }),
          options,
        ),
      ),
    ).toBe('missing or malformed signature');
    // Journaled offline: accepted within 7 days of expiry, not after.
    expect(
      await asyncReason(() =>
        verifyAttestedUpdate(update, { ...options, now: n.notAfter + 6 * 86_400_000 }),
      ),
    ).toBe('accepted');
    expect(
      await asyncReason(() =>
        verifyAttestedUpdate(update, { ...options, now: n.notAfter + 8 * 86_400_000 }),
      ),
    ).toBe('certificate expired');
  });

  it('verifies allocation reports for the session’s node only', async () => {
    const n = await node();
    const report = signAttestedReport(
      n.key.privateKey,
      create(AttestedReportBodySchema, {
        nodeId,
        bootId: 'b1',
        report: {
          case: 'allocationBound',
          value: { allocationId: 'alloc_1', deviceIds: ['GPU-1'] } as never,
        },
      }),
    );
    const verified = await verifyAttestedReport(report, {
      nodeId,
      lookup: n.lookup,
      now: n.clock.now(),
    });
    expect(verified.body.report.case).toBe('allocationBound');
    const other = signAttestedReport(
      n.key.privateKey,
      create(AttestedReportBodySchema, { nodeId: 'node_other' }),
    );
    expect(
      await asyncReason(() =>
        verifyAttestedReport(other, { nodeId, lookup: n.lookup, now: n.clock.now() }),
      ),
    ).toBe('report names another node');
    expect(
      await asyncReason(() =>
        verifyAttestedReport(report, {
          nodeId: 'node_owner',
          lookup: n.lookup,
          now: n.clock.now(),
        }),
      ),
    ).toBe('report names another node');
  });
});
