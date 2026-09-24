import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  base64url,
  createExecTicketIssuer,
  createReplayCache,
  createSshCertificateAuthority,
  formatSshPublicKey,
  parseSshCertificate,
  parseSshPublicKey,
  verifyExecTicket,
} from '@better-compute/pki';

// v0.3 access (PLAN.md §7.6, §13): exec tickets and break-glass SSH certificates. The SSH side is
// checked against OpenSSH's own ssh-keygen when it is installed.

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

describe('exec tickets', () => {
  const setup = () => {
    const clock = manualClock(start);
    const issuer = createExecTicketIssuer({ issuer: 'https://compute.test', clock });
    const verifyOptions = () => ({
      jwks: issuer.jwksJson(),
      nodeId,
      now: clock.now(),
      jtiCache: createReplayCache(),
      issuer: 'https://compute.test',
    });
    return { clock, issuer, verifyOptions };
  };

  it('verifies once, for this node, within 60 s', () => {
    const { clock, issuer, verifyOptions } = setup();
    const ticket = issuer.issue({
      nodeId,
      sid: 'tun_1',
      op: 'exec',
      subject: 'idn_1',
      instanceId: 'inst_1',
    });
    expect(ticket.expiresAt - start).toBe(60_000);
    const options = verifyOptions();
    expect(verifyExecTicket(ticket.token, options)).toMatchObject({
      aud: `node:${nodeId}`,
      sid: 'tun_1',
      op: 'exec',
      sub: 'idn_1',
      inst: 'inst_1',
    });
    // PLAN.md v0.3 exit test: a replayed ticket is rejected.
    expect(reason(() => verifyExecTicket(ticket.token, options))).toBe('replayed');
    expect(
      reason(() => verifyExecTicket(ticket.token, { ...verifyOptions(), nodeId: 'node_other' })),
    ).toBe('ticket for another node');
    clock.advance(66_000);
    expect(
      reason(() => verifyExecTicket(ticket.token, { ...verifyOptions(), now: clock.now() })),
    ).toBe('expired');
    expect(() =>
      issuer.issue({ nodeId, sid: 's', op: 'exec', subject: 'x', ttlSeconds: 61 }),
    ).toThrow(/1 to 60/);
  });

  it('refuses forged, retyped, re-algorithmed and foreign tickets', () => {
    const { issuer, verifyOptions } = setup();
    const token = issuer.issue({ nodeId, sid: 'tun_1', op: 'console', subject: 'idn_1' }).token;
    const [head, body, sig] = token.split('.') as [string, string, string];
    const rewrite = (part: string, change: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(Buffer.from(part, 'base64url').toString());
      change(value);
      return base64url(Buffer.from(JSON.stringify(value)));
    };
    const cases: [string, string][] = [
      [`${head}.${rewrite(body, (c) => (c.aud = 'node:node_other'))}.${sig}`, 'bad signature'],
      [
        `${head}.${rewrite(body, (c) => (c.exp = (c.exp as number) + 3600))}.${sig}`,
        'bad signature',
      ],
      [`${rewrite(head, (h) => (h.alg = 'none'))}.${body}.`, 'algorithm must be ES256'],
      [`${rewrite(head, (h) => (h.alg = 'HS256'))}.${body}.${sig}`, 'algorithm must be ES256'],
      [`${rewrite(head, (h) => (h.typ = 'JWT'))}.${body}.${sig}`, 'not an exec ticket'],
      [`${rewrite(head, (h) => (h.kid = 'tkey_unknown'))}.${body}.${sig}`, 'unknown key'],
      ['a.b', 'malformed'],
    ];
    for (const [forged, expected] of cases)
      expect(
        reason(() => verifyExecTicket(forged, verifyOptions())),
        expected,
      ).toBe(expected);
    const other = createExecTicketIssuer({ issuer: 'https://compute.test' });
    expect(
      reason(() =>
        verifyExecTicket(
          other.issue({ nodeId, sid: 's', op: 'exec', subject: 'x' }).token,
          verifyOptions(),
        ),
      ),
    ).toBe('unknown key');
    expect(reason(() => verifyExecTicket(token, { ...verifyOptions(), ops: ['exec'] }))).toBe(
      'op not allowed',
    );
    expect(
      reason(() => verifyExecTicket(token, { ...verifyOptions(), issuer: 'https://evil.test' })),
    ).toBe('foreign issuer');
  });

  it('keeps the previous key in the JWKS across one rotation', () => {
    const { issuer, verifyOptions } = setup();
    const before = issuer.issue({ nodeId, sid: 's1', op: 'exec', subject: 'x' }).token;
    const oldJwks = issuer.jwksJson();
    issuer.rotate();
    expect(JSON.parse(issuer.jwksJson()).keys).toHaveLength(2);
    expect(verifyExecTicket(before, verifyOptions()).sid).toBe('s1');
    // A daemon still holding the old JWKS cannot accept tickets from the new key yet.
    const after = issuer.issue({ nodeId, sid: 's2', op: 'exec', subject: 'x' }).token;
    expect(reason(() => verifyExecTicket(after, { ...verifyOptions(), jwks: oldJwks }))).toBe(
      'unknown key',
    );
    issuer.rotate();
    expect(reason(() => verifyExecTicket(before, verifyOptions()))).toBe('unknown key');
  });
});

const sshKeygen = ['/usr/bin/ssh-keygen', 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'].find(
  existsSync,
);
const scratch = mkdtempSync(join(tmpdir(), 'bc-ssh-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('SSH break-glass certificates', () => {
  for (const algorithm of ['ed25519', 'ecdsa-p256'] as const)
    it(`issues ${algorithm} CA user certificates that parse and verify`, () => {
      const clock = manualClock(start);
      const ca = createSshCertificateAuthority({ algorithm, clock });
      for (const userKey of [
        generateKeyPairSync('ed25519').publicKey,
        generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey,
      ]) {
        const issued = ca.issueUserCertificate({
          publicKey: formatSshPublicKey(userKey, 'user@laptop'),
          principals: ['root'],
          keyId: 'idn_1/act_9',
          validBefore: start + 30 * 60_000,
        });
        const cert = parseSshCertificate(issued.certificate);
        expect(cert).toMatchObject({
          certType: 'user',
          keyId: 'idn_1/act_9',
          principals: ['root'],
          extensions: { 'permit-pty': '' },
          criticalOptions: {},
          validAfter: start - 60_000,
          validBefore: start + 30 * 60_000,
          signatureValid: true,
        });
        expect(cert.publicKey.equals(userKey)).toBe(true);
        expect(cert.signatureKey.equals(parseSshPublicKey(ca.publicKey))).toBe(true);
        // Any byte flipped in the signed part breaks the signature.
        const [type, data] = issued.certificate.split(' ') as [string, string];
        const bytes = Buffer.from(data, 'base64');
        bytes[80]! ^= 1;
        let tampered = false;
        try {
          tampered = parseSshCertificate(`${type} ${bytes.toString('base64')}`).signatureValid;
        } catch {
          tampered = false;
        }
        expect(tampered).toBe(false);
      }
    });

  it('bounds lifetime, principals and key ids', () => {
    const clock = manualClock(start);
    const ca = createSshCertificateAuthority({ clock });
    const publicKey = formatSshPublicKey(generateKeyPairSync('ed25519').publicKey);
    const base = { publicKey, principals: ['root'], keyId: 'k', validBefore: start + 60_000 };
    expect(() => ca.issueUserCertificate({ ...base, validBefore: start + 3_600_001 })).toThrow(
      /at most 60 minutes/,
    );
    expect(() => ca.issueUserCertificate({ ...base, validBefore: start - 1 })).toThrow(/past/);
    expect(() => ca.issueUserCertificate({ ...base, principals: [] })).toThrow(
      /at least one principal/,
    );
    expect(() => ca.issueUserCertificate({ ...base, principals: ['root,admin'] })).toThrow(
      /Invalid principal/,
    );
    expect(() => ca.issueUserCertificate({ ...base, keyId: 'a\nb' })).toThrow(/one line/);
    const a = ca.issueUserCertificate(base).serial;
    const b = ca.issueUserCertificate(base).serial;
    expect(b > a).toBe(true);
    const forced = parseSshCertificate(
      ca.issueUserCertificate({
        ...base,
        criticalOptions: { 'force-command': '/usr/bin/true', 'source-address': '10.0.0.0/8' },
      }).certificate,
    );
    expect(forced.criticalOptions).toEqual({
      'force-command': '/usr/bin/true',
      'source-address': '10.0.0.0/8',
    });
  });

  it.skipIf(!sshKeygen)(
    'is read by OpenSSH ssh-keygen, and verifies certificates ssh-keygen signs',
    () => {
      const now = Date.now();
      const ca = createSshCertificateAuthority({ algorithm: 'ecdsa-p256' });
      const user = generateKeyPairSync('ed25519').publicKey;
      const issued = ca.issueUserCertificate({
        publicKey: formatSshPublicKey(user),
        principals: ['root', 'ops'],
        keyId: 'idn_42',
        validBefore: now + 15 * 60_000,
        criticalOptions: { 'source-address': '10.0.0.0/8' },
      });
      const certFile = join(scratch, 'user-cert.pub');
      writeFileSync(certFile, `${issued.certificate}\n`);
      const listed = spawnSync(sshKeygen!, ['-L', '-f', certFile], { encoding: 'utf8' });
      expect(listed.stderr).toBe('');
      expect(listed.stdout).toContain('ssh-ed25519-cert-v01@openssh.com user certificate');
      expect(listed.stdout).toContain('Key ID: "idn_42"');
      expect(listed.stdout).toMatch(/Principals:\s+root\s+ops/);
      expect(listed.stdout).toMatch(/source-address 10\.0\.0\.0\/8/);
      expect(listed.stdout).toContain('permit-pty');
      expect(listed.stdout).toContain(`Serial: ${issued.serial}`);

      // The other direction: an ssh-keygen CA signs, our parser verifies.
      const caKey = join(scratch, 'ca');
      const userKey = join(scratch, 'user');
      spawnSync(sshKeygen!, ['-q', '-t', 'ed25519', '-N', '', '-f', caKey]);
      spawnSync(sshKeygen!, ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-f', userKey]);
      const signed = spawnSync(
        sshKeygen!,
        ['-q', '-s', caKey, '-I', 'from-openssh', '-n', 'root', '-V', '+5m', `${userKey}.pub`],
        {
          encoding: 'utf8',
        },
      );
      expect(signed.status).toBe(0);
      const theirs = parseSshCertificate(readFileSync(`${userKey}-cert.pub`, 'utf8'));
      expect(theirs).toMatchObject({
        keyId: 'from-openssh',
        principals: ['root'],
        signatureValid: true,
        keyType: 'ecdsa-sha2-nistp256',
      });
      expect(
        theirs.signatureKey.equals(parseSshPublicKey(readFileSync(`${caKey}.pub`, 'utf8'))),
      ).toBe(true);
    },
  );
});
