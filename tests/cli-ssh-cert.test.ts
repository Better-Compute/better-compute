import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import {
  createExecTicketIssuer,
  createSshCertificateAuthority,
  formatSshPublicKey,
  parseSshCertificate,
} from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, options } from './support/server.js';

// `better-compute ssh-cert`: break-glass SSH from a terminal, through nodes.issueSshCert, with the certificate written
// beside the operator's key (OpenSSH's <key>-cert.pub).

const NODE = 'node_01k5w0000000000000000000ssh';
const TOKEN = 'biam_ses_ops_sshcert_test';
let compute: BetterCompute<any, any> | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  compute = undefined;
});

describe('ssh-cert', () => {
  it('writes a node-bound certificate for the operator’s own key beside it', { timeout: 60_000 }, async () => {
    const db = pglite();
    const iam = fakeIam({
      callers: {
        [TOKEN]: {
          identityId: 'idn_ops',
          identityKind: 'user',
          tenantId: ACME,
          sessionId: 'ses_ops',
          sessionKind: 'user',
          mfa: true,
        },
      },
      allow: [{}],
    });
    const ca = createSshCertificateAuthority();
    compute = betterCompute({
      ...options(db, iam),
      tunnels: { issuer: createExecTicketIssuer({ issuer: BASE_URL }), ssh: ca },
    } as never) as BetterCompute<any, any>;
    await compute.initialize();
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_ssh', $1, 'shared', 'eu', 1)`,
      [ACME],
    );
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_ssh', $2, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [NODE, ACME],
    );
    await db.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')`,
      [NODE, ACME],
    );

    const home = await mkdtemp(join(tmpdir(), 'bc-ssh-'));
    await mkdir(join(home, '.ssh'));
    const { publicKey } = generateKeyPairSync('ed25519');
    await writeFile(join(home, '.ssh', 'id_ed25519.pub'), `${formatSshPublicKey(publicKey, 'ops@laptop')}\n`);
    const out: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      err() {},
      cwd: home,
      env: { HOME: home, BETTER_COMPUTE_URL: BASE_URL, BETTER_COMPUTE_TOKEN: TOKEN },
      fetch: async (input, init) => compute!.handler(new Request(input, init)),
    };
    await createCli().run(['ssh-cert', '--tenant', ACME, '--node', NODE, '--minutes', '5'], io);
    const result = JSON.parse(out.join('\n'));
    expect(result).toMatchObject({
      certificate: join(home, '.ssh', 'id_ed25519-cert.pub'),
      principals: [`root@${NODE}`],
      account: 'root',
    });
    const certificate = parseSshCertificate(await readFile(result.certificate, 'utf8'));
    expect(certificate.principals).toEqual([`root@${NODE}`]);
    // Five minutes, as asked.
    expect(Date.parse(result.validBefore) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    expect(Date.parse(result.validBefore) - Date.now()).toBeGreaterThan(4 * 60_000);

    // A private key is refused before anything is sent.
    await writeFile(join(home, 'wrong.pub'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
    await expect(
      createCli().run(['ssh-cert', '--tenant', ACME, '--node', NODE, '--key', 'wrong.pub'], io),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
