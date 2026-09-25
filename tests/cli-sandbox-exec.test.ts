import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { createSshCertificateAuthority, formatSshPublicKey } from '@better-compute/pki';
import { handleTunnel } from '@better-compute/server';
import { createDevStack, fakeIam, type DevStack, type TunnelProgramFactory } from '@better-compute/testing';

// `better-compute sandbox exec` (PLAN.md §3.7): sandboxes.exec grants a certificate and a single-use ssh ticket;
// the CLI bridges one local connection to the tunnel and runs the OpenSSH client against it. Here the vps
// module is left out: sandboxes.exec is answered from a real tunnels.open ssh ticket to an instance on the dev
// fleet, whose FakeDaemon program stands in for the guest's sshd (it answers each chunk upper-cased), and
// CliIO.spawn plays ssh.

const INSTANCE = 'inst_01k5w000000000000000000sbx';
const SANDBOX = 'sbx_01k5w0000000000000000000sbx';
const TOKEN = 'biam_ses_sandbox_exec_test';
const ROOT = 'tenant-root';
const CERT = 'ssh-ed25519-cert-v01@openssh.com AAAAtest sandbox';

/** ssh -o values arrive quoted (paths may contain spaces). */
const unquote = (value: string) => value.replace(/^"|"$/g, '');

const sshd: TunnelProgramFactory = (context) => ({
  data: (bytes) => context.write(new TextDecoder().decode(bytes).toUpperCase()),
  hangup: () => context.exit(0, 'closed'),
});

let stack: DevStack | undefined;
let host: Server | undefined;
afterEach(async () => {
  host?.close();
  host = undefined;
  await stack?.close();
  stack = undefined;
});

describe('sandbox exec', () => {
  it('bridges one ssh connection through the tunnel with the granted certificate', { timeout: 120_000 }, async () => {
    const iam = fakeIam({
      callers: {
        [TOKEN]: {
          identityId: 'idn_dev',
          identityKind: 'user',
          tenantId: ROOT,
          sessionId: 'ses_dev',
          sessionKind: 'user',
          mfa: true,
        },
      },
      allow: [{}],
    });
    stack = await createDevStack({
      iam: { port: iam, rootTenantId: ROOT, root: { token: TOKEN } },
      daemon: { tunnels: { program: sshd } },
    });
    const { poolId } = await stack.createPool();
    const [nodeId] = await stack.join({ poolId, seed: 'sandbox-exec' });
    await stack.waitFor([nodeId!], { timeoutMs: 60_000 });
    const sql = stack.database;
    await sql.query(`CREATE TABLE IF NOT EXISTS instances (id text PRIMARY KEY, tenant_id text NOT NULL,
                       node_id text, state text NOT NULL, draft bool NOT NULL DEFAULT false)`);
    await sql.query(`INSERT INTO instances (id, tenant_id, node_id, state) VALUES ($1, $2, $3, 'running')`, [
      INSTANCE,
      ROOT,
      nodeId,
    ]);
    await sql.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('instance', $1, $2, '{}')
       ON CONFLICT DO NOTHING`,
      [INSTANCE, ROOT],
    );
    await sql.query(`UPDATE node_sessions SET capabilities = ARRAY['tunnel.instance-dial'] WHERE node_id = $1`, [
      nodeId,
    ]);

    const compute = stack.compute;
    host = createServer((req, res) => void compute.nodeHandler(req, res));
    host.on('upgrade', (req, socket, head) => {
      void handleTunnel(req, socket, head, {
        sql: sql as never,
        issuer: stack!.tunnelIssuer,
        issuerName: compute.endpoint.origin,
        relay: stack!.tunnelRelay as never,
        authorize: async () => true,
        basePath: compute.endpoint.basePath,
      }).then((handled) => {
        if (!handled) socket.destroy();
      });
    });
    await new Promise<void>((resolve) => host!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(host.address() as AddressInfo).port}${compute.endpoint.basePath}`;

    const home = await mkdtemp(join(tmpdir(), 'bc-sbx-home-'));
    await mkdir(join(home, '.ssh'));
    await writeFile(
      join(home, '.ssh', 'id_ed25519.pub'),
      `${formatSshPublicKey(generateKeyPairSync('ed25519').publicKey, 'dev@laptop')}\n`,
    );
    const granted: unknown[] = [];
    const knownHosts: string[] = [];
    let certified: ReturnType<typeof createSshCertificateAuthority> | undefined;
    const spawned: { command: string; args: readonly string[]; cert: string; answer: string }[] = [];
    let status = 0;
    const io: CliIO = {
      out() {},
      err() {},
      cwd: home,
      env: { HOME: home, BETTER_COMPUTE_URL: url, BETTER_COMPUTE_TOKEN: TOKEN, BETTER_COMPUTE_TENANT: ROOT },
      // sandboxes.exec answered from a real ssh ticket for the instance; everything else goes to the host.
      fetch: async (input, init) => {
        const target = String(input instanceof Request ? input.url : input);
        if (!target.endsWith('/sandboxes/exec')) return fetch(input, init);
        const body = JSON.parse(String(init?.body)) as { publicKey: string; sandboxId: string; ttlSeconds: number };
        granted.push(body);
        const opened = await fetch(`${url}/tunnels/open`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'x-better-compute': '1',
          },
          body: JSON.stringify({ tenantId: ROOT, instanceId: INSTANCE, op: 'ssh' }),
        });
        const { data } = (await opened.json()) as { data: { path: string } };
        return Response.json({
          data: {
            sandboxId: body.sandboxId,
            instanceId: INSTANCE,
            path: data.path,
            account: 'sandbox',
            ...(certified
              ? {
                  certificate: certified.issueUserCertificate({
                    publicKey: body.publicKey,
                    principals: [`sandbox@${INSTANCE}`],
                    keyId: 'test',
                    validBefore: Date.now() + 5 * 60_000,
                  }).certificate,
                  hostPrincipal: INSTANCE,
                  hostCertified: true,
                }
              : { certificate: CERT }),
          },
        });
      },
      // Plays ssh: one connection to the forwarded port, a version line out, the "guest's" answer back.
      spawn: async (command, args) => {
        const port = Number(args[args.indexOf('-p') + 1]);
        const certPath = unquote(String(args.find((arg) => arg.startsWith('CertificateFile='))).slice(16));
        const cert = await readFile(certPath, 'utf8');
        const knownHostsPath = unquote(String(args.find((arg) => arg.startsWith('UserKnownHostsFile='))).slice(19));
        knownHosts.push(await readFile(knownHostsPath, 'utf8').catch(() => ''));
        const socket = connect(port, '127.0.0.1');
        let answer = '';
        socket.on('data', (chunk) => (answer += chunk.toString()));
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        socket.write('SSH-2.0-probe\r\n');
        for (let i = 0; i < 200 && !answer.includes('SSH-2.0-PROBE'); i++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        socket.destroy();
        spawned.push({ command, args, cert, answer });
        return status;
      },
    };

    // An uncertified guest is refused unless trust on first use is asked for; nothing runs.
    await expect(createCli().run(['sandbox', 'exec', SANDBOX], io)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(spawned).toEqual([]);
    granted.length = 0;
    await createCli().run(['sandbox', 'exec', SANDBOX, '--minutes', '5', '--accept-host-key', '--', 'uname', '-a'], io);
    expect(granted).toMatchObject([{ sandboxId: SANDBOX, ttlSeconds: 300 }]);
    expect((granted[0] as { publicKey: string }).publicKey).toMatch(/^ssh-ed25519 /);
    const [run] = spawned;
    expect(run!.command).toBe('ssh');
    expect(run!.cert.trim()).toBe(CERT);
    expect(run!.answer).toContain('SSH-2.0-PROBE');
    expect(run!.args).toEqual(expect.arrayContaining(['-l', 'sandbox', '127.0.0.1', 'uname', '-a', 'IdentitiesOnly=yes']));
    expect(run!.args).toContain(`HostKeyAlias=${SANDBOX}`);
    // The certificate's temporary directory is gone afterwards.
    await expect(
      readFile(unquote(String(run!.args.find((arg) => arg.startsWith('CertificateFile='))).slice(16))),
    ).rejects.toThrow();
    // The remote command can never be read as ssh options, and nothing of the user's is handed to the guest.
    expect(run!.args[run!.args.indexOf('127.0.0.1') - 1]).toBe('--');
    // No ssh_config (the user's or the system's) and no global known hosts.
    expect(run!.args.slice(0, 2)).toEqual(['-F', 'none']);
    expect(run!.args.some((arg) => arg.startsWith('GlobalKnownHostsFile='))).toBe(true);
    expect(run!.args).toEqual(
      expect.arrayContaining(['-a', 'ForwardAgent=no', 'ProxyCommand=none', 'ClearAllForwardings=yes']),
    );

    // Without a host certificate: an empty known_hosts, accepted on first use.
    expect(knownHosts[0]).toBe('');
    expect(run!.args).toContain('StrictHostKeyChecking=accept-new');

    // A guest with a host certificate: pinned to the sandbox CA (the one that signed our certificate), strictly.
    certified = createSshCertificateAuthority();
    await createCli().run(['sandbox', 'exec', SANDBOX, '--', 'true'], io);
    const pinnedRun = spawned[1]!;
    expect(knownHosts[1]).toBe(`@cert-authority ${INSTANCE} ${certified.publicKey.split(' ').slice(0, 2).join(' ')}\n`);
    expect(pinnedRun.args).toEqual(
      expect.arrayContaining(['StrictHostKeyChecking=yes', `HostKeyAlias=${INSTANCE}`]),
    );
    certified = undefined;

    // ssh's own status becomes the command's.
    status = 3;
    await expect(createCli().run(['sandbox', 'exec', SANDBOX, '--accept-host-key'], io)).rejects.toMatchObject({
      code: 'REMOTE_EXIT',
      status: 3,
    });
  });

  it('says what unblocks a restore that still answers to its source’s SSH identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bc-sandbox-restore-'));
    await mkdir(join(home, '.ssh'));
    await writeFile(
      join(home, '.ssh', 'id_ed25519.pub'),
      `${formatSshPublicKey(generateKeyPairSync('ed25519').publicKey, 'dev@laptop')}\n`,
    );
    const io: CliIO = {
      out() {},
      env: { HOME: home, BETTER_COMPUTE_TOKEN: TOKEN, BETTER_COMPUTE_TENANT: ROOT },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 'INVALID_STATE',
              message: `Sandbox ${SANDBOX} shares its SSH identity with another running guest`,
              details: { reason: 'restore-shares-identity' },
            },
          },
          { status: 409 },
        ),
      spawn: async () => 0,
    };
    await expect(
      createCli().run(['sandbox', 'exec', SANDBOX, '--url', 'https://compute.test'], io),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      hint: expect.stringContaining(`sandbox get ${SANDBOX} shows identityRebound: true`),
    });
  });
});
