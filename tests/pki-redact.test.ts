import { describe, expect, it } from 'vitest';
import { findSecrets, generateP256KeyPair, privateKeyPem, redactSecrets } from '@better-compute/pki';

// One secret scanner for everything that leaves a machine for support (PLAN.md §6, §16 v0.1 "support bundles
// hold no tokens"): join and IAM tokens, JWTs/JWEs, private keys, URL passwords and known values.

describe('redactSecrets', () => {
  it('replaces every kind, keeping a token prefix so readers know what was there', () => {
    const key = privateKeyPem(generateP256KeyPair().privateKey);
    const jwt = `${Buffer.from('{"alg":"EdDSA","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.c2lnbmF0dXJl`;
    const text = [
      'env: BCD_JOIN_TOKEN=bcjt_jt_01j8x2example.Zm9vYmFyYmF6cXV4',
      'authorization: Bearer biam_ses_01j8abcdEFGH.secret-part',
      `cookie: session=${jwt}`,
      'database: postgres://compute:hunter2hunter2@db.internal:5432/compute',
      key,
      'deployment secret: better-compute-secret-0123456789abcdef',
    ].join('\n');
    const { text: out, redacted } = redactSecrets(text, {
      known: ['better-compute-secret-0123456789abcdef'],
    });
    expect(redacted).toBe(6);
    expect(out).toContain('BCD_JOIN_TOKEN=bcjt_[redacted]');
    expect(out).toContain('Bearer biam_[redacted]');
    expect(out).toContain('session=[redacted:jwt]');
    expect(out).toContain('postgres://compute:[redacted:url-password]@db.internal:5432/compute');
    expect(out).toContain('[redacted:private-key]');
    expect(out).toContain('deployment secret: [redacted:known-value]');
    expect(out).not.toMatch(/hunter2|Zm9vYmFy|secret-part|PRIVATE KEY|0123456789abcdef/);
    expect(findSecrets(out, { known: ['better-compute-secret-0123456789abcdef'] })).toEqual([]);
  });

  it('leaves ordinary diagnostics alone', () => {
    const text = [
      'bcd 0.1.0 node=node_01j8 boot=b-1 units=bcd.service',
      'gateway https://gw-1.internal:9443 region=eu-1 (no credentials in this URL)',
      'bcjt tokens are redacted; biam is the IAM prefix',
      'eyJ alone is not a token',
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      'key=short',
    ].join('\n');
    expect(redactSecrets(text, { known: ['short', ''] })).toEqual({ text, redacted: 0 });
  });

  it('merges overlapping matches, so a known value inside a token takes the whole token with it', () => {
    const text = 'token bcjt_jt_1.abcdefgh and abcdefgh-longer.';
    const findings = findSecrets(text, { known: ['abcdefgh', 'abcdefgh-longer'] });
    expect(findings.map((finding) => finding.kind)).toEqual(['join-token', 'known-value']);
    expect(findings[1]!.length).toBe('abcdefgh-longer'.length);
    expect(redactSecrets(text, { known: ['abcdefgh', 'abcdefgh-longer'] }).text).toBe(
      'token bcjt_[redacted] and [redacted:known-value].',
    );
  });
});
