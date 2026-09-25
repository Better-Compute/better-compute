import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createComputeClient } from '@better-compute/client';
import {
  checkSshPublicKey,
  createSshAccessView,
  sshUsage,
  SshKeyInputError,
  type ComputeRequester,
} from '@better-compute/console-kit';
import { createExecTicketIssuer, createSshCertificateAuthority, formatSshPublicKey } from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, options } from './support/server.js';

// console-kit's break-glass SSH view over a real server with the tunnels module: list who holds access, issue a
// certificate for a pasted public key (a private key is refused before anything is sent), revoke it.

const NODE = 'node_01k5w0000000000000000000ssv';
const TOKEN = 'biam_ses_console_ssh_acme';
let compute: BetterCompute<any, any> | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  compute = undefined;
});

describe('ssh access view', () => {
  it('issues, lists and revokes break-glass certificates for a node', { timeout: 60_000 }, async () => {
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
    compute = betterCompute({
      ...options(db, iam),
      tunnels: { issuer: createExecTicketIssuer({ issuer: BASE_URL }), ssh: createSshCertificateAuthority() },
    } as never) as BetterCompute<any, any>;
    await compute.initialize();
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_ssv', $1, 'shared', 'eu', 1)`,
      [ACME],
    );
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_ssv', $2, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [NODE, ACME],
    );
    await db.query(`INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')`, [
      NODE,
      ACME,
    ]);
    const api = createComputeClient({
      baseURL: BASE_URL,
      token: TOKEN,
      fetch: async (input, init) => compute!.handler(new Request(input, init)),
    }) as unknown as ComputeRequester;

    const view = createSshAccessView(api, { tenantId: ACME, nodeId: NODE });
    await view.refresh();
    expect(view.get().error).toBeUndefined();
    expect(view.get().value?.items).toEqual([]);

    // A private key pasted by mistake never leaves the page.
    await expect(view.issue({ publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' })).rejects.toBeInstanceOf(
      SshKeyInputError,
    );
    expect(() => checkSshPublicKey('ssh-rsa AAAAB3Nza')).toThrow(/Ed25519 or ECDSA/);

    const key = formatSshPublicKey(generateKeyPairSync('ed25519').publicKey, 'ops@laptop');
    const issued = await view.issue({ publicKey: `${key}\n`, minutes: 5 });
    expect(issued).toMatchObject({ nodeId: NODE, account: 'root', principals: [`root@${NODE}`] });
    expect(issued.certificate).toMatch(/^ssh-ed25519-cert-v01@openssh\.com /);
    expect(view.issued.get()?.serial).toBe(issued.serial);
    expect(sshUsage(issued, { host: '10.0.0.5' })[1]).toBe('ssh -i ~/.ssh/id_ed25519 root@10.0.0.5');
    // The list reloads after the change: the holder, active, never the certificate itself.
    expect(view.get().value?.items).toMatchObject([{ serial: issued.serial, identityId: 'idn_ops', state: 'active' }]);
    expect(JSON.stringify(view.get().value)).not.toContain('cert-v01');

    await view.revoke(issued.serial, 'done');
    expect(view.get().value?.items).toMatchObject([
      { serial: issued.serial, state: 'revoked', revokedBy: 'idn_ops', revokeReason: 'done' },
    ]);
    view.dismissIssued();
    expect(view.issued.get()).toBeUndefined();
  });
});
