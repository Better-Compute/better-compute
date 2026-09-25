import { create, toBinary } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { AgentRole, Lane, protocolRegistry, site } from '@better-compute/protocol';
import type { FakeKind, FakeKindContext, FakeKindOutcome } from '@better-compute/testing';

// A metal site as a site agent's FakeDaemon sees it (PLAN.md §3.5): per-machine BMCs behind the
// agent, answering metal's site kinds (`bmc.*`, `site.httpProxy`) with the binary result messages a
// real `bcd site` sends. It plugs into the dev fleet with `joinSite({ siteId, kinds: fakeMetalSite(world).kinds })`,
// so metal's commands travel the real gateway: dispatch, credits, journal, results.

export interface FakeBmcMachine {
  /** The BMC's address, as enrolled (`https://10.20.0.5`). */
  address: string;
  macs: string[];
  /** The machine's own IPs (Redfish inspection): the only hosts `site.httpProxy` may reach. */
  ipAddresses: string[];
  power: 'on' | 'off';
  bootDevice: string;
  mounted: string;
  firmware: Record<string, string>;
  /** What the machine's API answers (Talos on :50000), by path; undefined = unreachable. */
  api?: (url: URL) => { status: number; body?: string } | undefined;
}

export interface FakeMetalSite {
  machines: Map<string, FakeBmcMachine>;
  /** Every command the agent ran, in order: kind, BMC operation or URL, parsed args. */
  seen: { kind: string; operation: string; args: Record<string, unknown> }[];
  kinds: Record<string, FakeKind>;
  /** Adds a machine behind the site's BMC network. */
  machine(address: string, init?: Partial<FakeBmcMachine>): FakeBmcMachine;
}

const bmcOk = (value: unknown): FakeKindOutcome => ({
  outcome: 'succeeded',
  result: toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: true, resultJson: JSON.stringify(value) })),
});
const bmcFailed = (errorCode: string, message: string): FakeKindOutcome => ({
  outcome: 'succeeded',
  result: toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: false, errorCode, message })),
});

export function fakeMetalSite(): FakeMetalSite {
  const machines = new Map<string, FakeBmcMachine>();
  const seen: FakeMetalSite['seen'] = [];

  const payloadOf = <T>(context: FakeKindContext): T => {
    const any = context.body.payload;
    if (!any) throw new Error(`${context.body.kind} has no payload`);
    return anyUnpack(any, protocolRegistry) as T;
  };

  const bmcKind = (run: (machine: FakeBmcMachine, operation: string, args: Record<string, any>) => FakeKindOutcome): FakeKind => ({
    lane: Lane.CONTROL,
    roles: [AgentRole.SITE],
    durationMs: 50,
    run(context) {
      const request = payloadOf<site.BmcOperationRequest>(context);
      const args = request.argsJson ? (JSON.parse(request.argsJson) as Record<string, any>) : {};
      seen.push({ kind: context.body.kind, operation: request.operation, args });
      const machine = machines.get(request.address);
      if (!machine) return bmcFailed('unreachable', `no BMC answers at ${request.address}`);
      return run(machine, request.operation, args);
    },
  });

  const kinds: Record<string, FakeKind> = {
    'bmc.query': bmcKind((machine, operation) => {
      if (operation === 'inspect.inspect') return bmcOk({ macs: machine.macs, ipAddresses: machine.ipAddresses });
      if (operation === 'firmware.components') return bmcOk({ components: Object.entries(machine.firmware).map(([id, version]) => ({ id, version })) });
      return bmcOk({ power: machine.power });
    }),
    'bmc.boot': bmcKind((machine, operation, args) => {
      if (operation === 'management.setBootDevice') machine.bootDevice = String(args.device);
      if (operation === 'virtual-media.insert') machine.mounted = String(args.url);
      if (operation === 'virtual-media.eject') machine.mounted = '';
      return bmcOk({});
    }),
    'bmc.power': bmcKind((machine, _operation, args) => {
      machine.power = args.action === 'off' || args.action === 'graceful-off' ? 'off' : 'on';
      return bmcOk({});
    }),
    'site.httpProxy': {
      lane: Lane.CONTROL,
      roles: [AgentRole.SITE],
      durationMs: 20,
      run(context) {
        const request = payloadOf<site.HttpProxyRequest>(context);
        const url = new URL(request.url);
        seen.push({ kind: 'site.httpProxy', operation: request.url, args: { targetNodeId: request.targetNodeId } });
        // The agent enforces what the command says: only the machine's own address.
        const machine = [...machines.values()].find((m) => m.ipAddresses.includes(url.hostname));
        const answer = machine?.api?.(url);
        const response = answer
          ? create(site.HttpProxyResponseSchema, { status: answer.status, body: new TextEncoder().encode(answer.body ?? '') })
          : create(site.HttpProxyResponseSchema, { status: 503 });
        return { outcome: 'succeeded', result: toBinary(site.HttpProxyResponseSchema, response) };
      },
    },
  };

  return {
    machines,
    seen,
    kinds,
    machine(address, init = {}) {
      const machine: FakeBmcMachine = { address, macs: [], ipAddresses: [], power: 'off', bootDevice: 'disk', mounted: '', firmware: {}, ...init };
      machines.set(address, machine);
      return machine;
    },
  };
}
