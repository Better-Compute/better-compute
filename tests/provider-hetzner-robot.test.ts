import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { type CallContext, type ProviderImpl } from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import {
  bootstrapScript,
  robotJoinArgv,
  hetznerRobot,
  hetznerRobotProvider,
  robotClaimName,
  type SshExecutor,
} from '@better-compute/provider-hetzner';

const pins = {
  servingCa: `sha256/${Buffer.alloc(32, 1).toString('base64')}`,
  joinSigning: `sha256/${Buffer.alloc(32, 2).toString('base64')}`,
  joinEncryption: `sha256/${Buffer.alloc(32, 3).toString('base64')}`,
};

// Hetzner Robot against an in-memory emulator of the webservice (servers, rename, rescue, reset)
// and a fake SSH executor: claims instead of orders, power through resets, rescue, and the bootstrap
// that installs the OS and delivers the join token over SSH stdin only.

interface RobotServer {
  server_ip: string;
  server_ipv6_net: string;
  server_number: number;
  server_name: string;
  product: string;
  dc: string;
  status: 'ready' | 'in process';
  cancelled: boolean;
}

class RobotEmulator {
  servers = new Map<number, RobotServer>();
  rescue = new Map<number, { os: string; keys: string[] }>();
  resets: { server: number; type: string }[] = [];
  requests: { method: string; path: string; body: string }[] = [];
  failNext?: { status: number; code: string; interval?: number };

  constructor() {
    for (const [number, product, dc, status] of [
      [1001, 'GEX44', 'FSN1-DC14', 'ready'],
      [1002, 'AX102', 'HEL1-DC2', 'ready'],
      [1003, 'AX41-NVMe', 'FSN1-DC5', 'in process'],
      [1004, 'Custom-XL', 'NBG1-DC3', 'ready'],
    ] as const)
      this.servers.set(number, {
        server_ip: `203.0.113.${number % 250}`,
        server_ipv6_net: '2001:db8:1::',
        server_number: number,
        server_name: number === 1004 ? 'someone-elses-box' : '',
        product,
        dc,
        status,
        cancelled: false,
      });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    this.requests.push({ method, path: url.pathname, body });
    if (headers.get('authorization') !== `Basic ${btoa('#ws+robot:robot-secret')}`)
      return this.error(401, 'UNAUTHORIZED', 'Unauthorized');
    if (this.failNext) {
      const failure = this.failNext;
      delete this.failNext;
      return this.json(failure.status, {
        error: {
          status: failure.status,
          code: failure.code,
          message: 'no',
          interval: failure.interval,
        },
      });
    }
    const form = new URLSearchParams(body);
    let match: RegExpExecArray | null;
    if (method === 'GET' && url.pathname === '/server')
      return this.json(
        200,
        [...this.servers.values()].map((server) => ({ server })),
      );
    if ((match = /^\/server\/(\d+)$/.exec(url.pathname))) {
      const server = this.servers.get(Number(match[1]));
      if (!server) return this.error(404, 'SERVER_NOT_FOUND', 'not found');
      if (method === 'POST') server.server_name = form.get('server_name') ?? server.server_name;
      return this.json(200, { server });
    }
    if ((match = /^\/boot\/(\d+)\/rescue$/.exec(url.pathname))) {
      const number = Number(match[1]);
      const server = this.servers.get(number);
      if (!server) return this.error(404, 'SERVER_NOT_FOUND', 'not found');
      if (method === 'POST')
        this.rescue.set(number, { os: form.get('os')!, keys: form.getAll('authorized_key[]') });
      if (method === 'DELETE') this.rescue.delete(number);
      return this.json(200, {
        rescue: {
          server_ip: server.server_ip,
          server_number: number,
          active: this.rescue.has(number),
        },
      });
    }
    if ((match = /^\/reset\/(\d+)$/.exec(url.pathname)) && method === 'POST') {
      if (!this.servers.has(Number(match[1])))
        return this.error(404, 'SERVER_NOT_FOUND', 'not found');
      this.resets.push({ server: Number(match[1]), type: form.get('type')! });
      return this.json(200, { reset: { server_number: Number(match[1]), type: form.get('type') } });
    }
    return this.error(404, 'NOT_FOUND', `no route ${method} ${url.pathname}`);
  };

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  error(status: number, code: string, message: string): Response {
    return this.json(status, { error: { status, code, message } });
  }
}

const config = {
  user: '#ws+robot',
  password: 'env://ROBOT_PASSWORD',
  rescueKeyFingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
  rescueKey: 'vault://kv/robot-rescue-key',
};
const secrets = {
  resolve: async (ref: string) =>
    ref === 'env://ROBOT_PASSWORD'
      ? 'robot-secret'
      : ref === 'vault://kv/robot-rescue-key'
        ? 'PRIVATE KEY'
        : Promise.reject(new Error(ref)),
};
let now = Date.UTC(2026, 8, 24, 12);
const clock = { now: () => now };
const call = (key: string): CallContext => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock,
  secrets,
  log: console,
});

async function client(api: RobotEmulator, ssh?: SshExecutor): Promise<ProviderImpl> {
  const provider = hetznerRobotProvider({
    fetch: api.fetch,
    endpoint: 'https://robot.test',
    ...(ssh ? { ssh } : {}),
    sleep: async (ms) => {
      now += ms;
    },
    rescuePollMs: 30_000,
    rescueTimeoutMs: 5 * 60_000,
  });
  const parsed = await provider.config['~standard'].validate(config);
  return provider.create((parsed as { value: never }).value, { clock, secrets, log: console });
}

describe('hetznerRobot: providerConformance', () => {
  it('passes the ProviderImpl contract (power is actionable, not observable)', async () => {
    const report = await runConformance(providerConformanceCases(), () => ({
      provider: hetznerRobotProvider({
        fetch: new RobotEmulator().fetch,
        endpoint: 'https://robot.test',
      }),
      config,
      offerId: '1001',
      image: 'ignored',
      context: { secrets, clock },
      powerObservable: false,
    }));
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
  });

  it('declares metal and demands secret references', async () => {
    expect(hetznerRobot).toMatchObject({ id: 'hetzner-robot', provides: ['metal'] });
    const bad = await hetznerRobot.config['~standard'].validate({ ...config, password: 'plain' });
    expect('issues' in bad && bad.issues?.length).toBeTruthy();
  });
});

describe('hetznerRobot specifics', () => {
  it('offers unclaimed, uncancelled servers with product specs and filters', async () => {
    const impl = await client(new RobotEmulator());
    const offers = await impl.listOffers({});
    expect(offers.map((offer) => [offer.id, offer.region, offer.vcpu, offer.available])).toEqual([
      ['1001', 'fsn1', 20, true],
      ['1002', 'hel1', 32, true],
      ['1003', 'fsn1', 12, false],
    ]);
    expect(offers[0]!.gpus).toEqual({ model: 'RTX-4000-SFF-ADA', count: 1 });
    expect((await impl.listOffers({ minGpus: 1 })).map((offer) => offer.id)).toEqual(['1001']);
    expect((await impl.listOffers({ region: 'hel1' })).map((offer) => offer.id)).toEqual(['1002']);
    expect(await impl.listOffers({ kind: 'vps' })).toEqual([]);
  });

  it('claims idempotently by renaming, refuses someone else’s claim, and releases without cancelling', async () => {
    const api = new RobotEmulator();
    const impl = await client(api);
    const machine = await impl.create(
      { offerId: '1002', image: '', userData: '', name: 'n' },
      call('node_01ABC'),
    );
    expect(machine).toMatchObject({
      id: '1002',
      name: robotClaimName('node_01ABC'),
      state: 'running',
      region: 'hel1',
    });
    expect(
      (
        await impl.create(
          { offerId: '1001', image: '', userData: '', name: 'n' },
          call('node_01ABC'),
        )
      ).id,
    ).toBe('1002');
    await expect(
      impl.create({ offerId: '1002', image: '', userData: '', name: 'n' }, call('other')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      impl.create({ offerId: '1004', image: '', userData: '', name: 'n' }, call('mine')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(api.servers.get(1004)!.server_name).toBe('someone-elses-box');
    expect((await impl.listOffers({})).map((offer) => offer.id)).toEqual(['1001', '1003']);
    await impl.delete('1002', call('d'));
    expect(api.servers.get(1002)!).toMatchObject({ server_name: '', cancelled: false });
    expect(
      api.requests.some(
        (request) => request.path.includes('cancellation') || request.path.includes('order'),
      ),
    ).toBe(false);
    expect(await impl.get('1004', call('g'))).toBeUndefined();
  });

  it('maps power to Robot resets and rate limits to RATE_LIMITED', async () => {
    const api = new RobotEmulator();
    const impl = await client(api);
    for (const action of ['reset', 'graceful-restart', 'graceful-off', 'off', 'on'] as const)
      await impl.power!('1001', action, call(action));
    expect(api.resets.map((reset) => reset.type)).toEqual([
      'hw',
      'sw',
      'power',
      'power_long',
      'power',
    ]);
    await expect(impl.power!('1001', 'nmi', call('x'))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    api.failNext = { status: 403, code: 'RATE_LIMIT_EXCEEDED', interval: 3600 };
    await expect(impl.listOffers({})).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 3_600_000,
    });
  });

  it('bootstraps from rescue: waits for SSH, sends the token only over stdin, installs and cleans up', async () => {
    const api = new RobotEmulator();
    const sessions: { host: string; command: string; stdin?: string; key: string }[] = [];
    let probes = 0;
    const ssh: SshExecutor = async (target, command, stdin) => {
      sessions.push({
        host: target.host,
        command,
        key: target.privateKey,
        ...(stdin !== undefined ? { stdin } : {}),
      });
      if (command.startsWith('test -e'))
        return { code: ++probes < 3 ? 255 : 0, stdout: '', stderr: '' };
      if (command === 'sh -s')
        return { code: 255, stdout: '', stderr: 'connection closed by reboot' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const impl = await client(api, ssh);
    const machine = await impl.create(
      { offerId: '1001', image: '', userData: '', name: '' },
      call('node_01xyz'),
    );
    const token = 'bcjt_sealed.TOKEN-VALUE_with.dots';
    await impl.bootstrap!(
      machine,
      {
        joinToken: token,
        bcdUrl: 'https://downloads.example/bcd-linux-amd64',
        sha256: 'ab'.repeat(32),
        controlPlaneUrl: 'https://compute.example/api/compute',
        pins,
      },
      call('boot'),
    );
    // Rescue with the account's key, then a hardware reset into it.
    expect(api.rescue.has(1001)).toBe(false); // deactivated again after the install
    expect(
      api.requests.find(
        (request) => request.path === '/boot/1001/rescue' && request.method === 'POST',
      )!.body,
    ).toContain('authorized_key%5B%5D=aa%3Abb');
    expect(api.resets).toEqual([{ server: 1001, type: 'hw' }]);
    expect(
      sessions.every((session) => session.host === '203.0.113.1' && session.key === 'PRIVATE KEY'),
    ).toBe(true);
    expect(probes).toBe(3);
    // The token travels once, over stdin; never in a command or in the install script.
    const carrying = sessions.filter((session) =>
      [session.command, session.stdin ?? ''].some((text) => text.includes(token)),
    );
    expect(carrying).toEqual([
      {
        host: '203.0.113.1',
        command: 'umask 077 && cat > /root/bc-join-token',
        stdin: token,
        key: 'PRIVATE KEY',
      },
    ]);
    const install = sessions.find((session) => session.command === 'sh -s')!;
    expect(install.stdin).toContain(
      'installimage -a -c /root/bc-autosetup -x /root/bc-post-install.sh',
    );
    expect(install.stdin).toContain(
      `echo '${'ab'.repeat(32)}  /usr/local/bin/bcd' | sha256sum -c -`,
    );
    expect(install.stdin).toContain('HOSTNAME bc-node-01xyz');
    expect(install.stdin).toContain(
      'IMAGE /root/.oldroot/nfs/install/../images/Ubuntu-2404-noble-amd64-base.tar.gz',
    );
    expect(install.stdin).toContain('shred -u /root/bc-join-token');
    // First boot joins through the control plane (bcd-join.service), then runs the node agent.
    expect(install.stdin).toContain(
      `ExecStart=/usr/local/bin/bcd join --server https://compute.example/api/compute --token-file /etc/bcd/join-token --attestor provisioned --serving-ca-pin ${pins.servingCa} --join-signing-pin ${pins.joinSigning} --join-encryption-pin ${pins.joinEncryption}`,
    );
    expect(install.stdin).toContain('systemctl enable bcd-join.service bcd.service');
  });

  it('identifies a server in rescue, and bootstrap reuses that rescue (one reset)', async () => {
    const api = new RobotEmulator();
    let inRescue = false;
    const commands: string[] = [];
    const ssh: SshExecutor = async (_target, command) => {
      commands.push(command);
      // Rescue answers once the reset into it happened.
      inRescue ||= api.resets.length > 0;
      if (command.startsWith('test -e'))
        return { code: inRescue ? 0 : 255, stdout: '', stderr: '' };
      if (command === 'cat /sys/class/dmi/id/product_uuid')
        return { code: 0, stdout: '4C4C4544-0051-3010-8052-B4C04F4A4E32\n', stderr: '' };
      if (command === 'sh -s') return { code: 255, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const impl = await client(api, ssh);
    const machine = await impl.create(
      { offerId: '1001', image: '', userData: '', name: '' },
      call('node_02'),
    );
    expect(await impl.identify!(machine, call('id'))).toEqual({
      productUuid: '4c4c4544-0051-3010-8052-b4c04f4a4e32',
    });
    expect(api.rescue.has(1001)).toBe(true); // left in rescue for bootstrap
    await impl.bootstrap!(
      machine,
      {
        joinToken: 'bcjt_x',
        bcdUrl: 'https://d.example/bcd',
        sha256: 'ab'.repeat(32),
        controlPlaneUrl: 'https://compute.example',
        pins,
      },
      call('boot'),
    );
    expect(api.resets).toEqual([{ server: 1001, type: 'hw' }]);
    expect(api.rescue.has(1001)).toBe(false);
    // A machine that answers garbage is not identified.
    const liar = await client(api, async (_target, command) =>
      command.startsWith('test -e')
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: 'To Be Filled By O.E.M.', stderr: '' },
    );
    await expect(liar.identify!(machine, call('id2'))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('refuses bootstrap without an executor, with a bad digest or plain http, and when rescue never answers', async () => {
    const api = new RobotEmulator();
    const noSsh = await client(api);
    const machine = await noSsh.create(
      { offerId: '1001', image: '', userData: '', name: '' },
      call('k'),
    );
    const args = {
      joinToken: 't',
      bcdUrl: 'https://d.example/bcd',
      sha256: 'ab'.repeat(32),
      controlPlaneUrl: 'https://compute.example',
      pins,
    };
    await expect(noSsh.bootstrap!(machine, args, call('b'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    const silent = await client(api, async () => ({ code: 255, stdout: '', stderr: '' }));
    await expect(
      silent.bootstrap!(machine, { ...args, sha256: 'nope' }, call('b')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      silent.bootstrap!(machine, { ...args, bcdUrl: 'http://d.example/bcd' }, call('b')),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Without the control plane URL the installed OS could never join; one that could break out of
    // the systemd unit is refused before anything reaches the machine.
    const { controlPlaneUrl: _omitted, ...withoutUrl } = args;
    await expect(silent.bootstrap!(machine, withoutUrl, call('b'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    const { pins: _noPins, ...withoutPins } = args;
    await expect(silent.bootstrap!(machine, withoutPins, call('b'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      silent.bootstrap!(machine, { ...args, pins: { ...pins, joinEncryption: 'sha256/x' } }, call('b')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const controlPlaneUrl of ['https://c.example/%h', 'https://c.example/$HOME', 'https://c.example/a b'])
      await expect(
        silent.bootstrap!(machine, { ...args, controlPlaneUrl }, call('b')),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(silent.bootstrap!(machine, args, call('b'))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});

describe('bootstrapScript', () => {
  const script = bootstrapScript({
    hostname: 'bc-node-1',
    image: 'Ubuntu-2404-noble-amd64-base.tar.gz',
    bcdUrl: "https://downloads.example/bcd?x='y'",
    sha256: 'cd'.repeat(32),
    controlPlaneUrl: 'https://compute.example',
    pins,
  });

  it('quotes the URL, embeds the token only from rescue, and pins the binary', () => {
    expect(script).toContain(
      `curl -fsSL --retry 5 -o /usr/local/bin/bcd 'https://downloads.example/bcd?x='\\''y'\\'''`,
    );
    expect(script).toContain('"$(base64 -w0 /root/bc-join-token)"');
    expect(script).toContain(
      `ExecStart=${robotJoinArgv('https://compute.example', pins).join(' ')}`,
    );
    expect(script).toContain('ExecStart=/usr/local/bin/bcd node\n');
    expect(script).toContain('> /etc/bcd/join-token');
    expect(script.startsWith('set -eu\numask 077')).toBe(true);
  });

  // Set BC_SH to a POSIX shell (e.g. GitHub Desktop's git/usr/bin/sh.exe) to syntax-check the script.
  it.skipIf(!process.env.BC_SH)('parses as POSIX shell', () => {
    expect(() => execFileSync(process.env.BC_SH!, ['-n'], { input: script })).not.toThrow();
  });
});

describe('hetznerRobot claim races', () => {
  it('answers CONFLICT when another claim renamed the server right after ours', async () => {
    const api = new RobotEmulator();
    const raced: typeof api.fetch = async (input, init) => {
      const response = await api.fetch(input, init);
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/server/1001'))
        api.servers.get(1001)!.server_name = robotClaimName('someone-else');
      return response;
    };
    const provider = hetznerRobotProvider({ fetch: raced, endpoint: 'https://robot.test' });
    const parsed = await provider.config['~standard'].validate(config);
    const impl = await provider.create((parsed as { value: never }).value, {
      clock,
      secrets,
      log: console,
    });
    await expect(
      impl.create({ offerId: '1001', image: '', userData: '', name: 'n' }, call('mine')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
