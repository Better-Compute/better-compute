import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type ComputeError,
  type ProviderCertificateSpec,
} from '@better-compute/core';
import { certificateName, type DoCompute } from '@better-compute/provider-digitalocean';
import { seedCertificate, pemFingerprint } from './support/do-emulator/certificates.js';
import { seedDomain } from './support/do-emulator/dns.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import { seedLoadBalancer } from './support/do-emulator/load-balancers.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean certificates (P4) against the emulator: managed (Let's Encrypt) ones only for
// names in a zone DigitalOcean hosts, custom ones from PEMs resolved from secrets just in time, both
// immutable and named with this deployment's hash, and deletes only of certificates of ours.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });

const leaf = (seed: string) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(`leaf-der-${seed}`).toString('base64')}\n-----END CERTIFICATE-----\n`;
const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from('very-secret-key-material').toString('base64')}\n-----END PRIVATE KEY-----\n`;
const pems: Record<string, string> = {
  'secret://tenant/cert': leaf('one'),
  'secret://tenant/cert-rotated': leaf('two'),
  'secret://tenant/key': key,
  'secret://tenant/chain': leaf('chain'),
  'secret://tenant/garbage': 'not a pem',
};

function call(): CallContext {
  return {
    ...ctx(),
    secrets: {
      resolve: async (ref: string) => {
        const value = pems[ref];
        if (value === undefined) throw new Error('no such secret');
        return value;
      },
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const calls = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));
const writes = (emu: DoEmulator) => emu.requests.filter((r) => r.method !== 'GET');

async function setup(emu = emulator()): Promise<{ emu: DoEmulator; impl: DoCompute }> {
  return { emu, impl: await build(emu, doAccount) };
}

const custom: ProviderCertificateSpec = {
  name: 'bc-cert1',
  kind: 'custom',
  certificate: 'secret://tenant/cert',
  privateKey: 'secret://tenant/key',
};
const managed: ProviderCertificateSpec = {
  name: 'bc-cert2',
  kind: 'managed',
  domains: ['www.example.com', '*.example.com'],
};

beforeEach(freshBudgets);

describe('provider-digitalocean certificates: custom', () => {
  it('uploads PEMs from secrets once, and reports the fingerprint but never the key', async () => {
    const { emu, impl } = await setup();
    const made = await impl.certificates.ensureCertificate(
      { ...custom, chain: 'secret://tenant/chain' },
      call(),
    );
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: 'ready',
      outputs: {
        kind: 'custom',
        domains: '',
        notAfter: expect.any(String),
        fingerprint: pemFingerprint(leaf('one'), 'CERTIFICATE'),
      },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/certificates$/);
    expect(post!.body).toEqual({
      name: certificateName('bc-cert1', 'default'),
      type: 'custom',
      leaf_certificate: leaf('one'),
      private_key: key,
      certificate_chain: leaf('chain'),
    });
    expect(JSON.stringify(made)).not.toContain('PRIVATE KEY');
    // Found by name: the same certificate, and no second upload.
    expect((await impl.certificates.ensureCertificate(custom, call())).id).toBe(made.id);
    expect(writes(emu)).toHaveLength(1);
    expect(await impl.certificates.getCertificate(made.id, call())).toEqual(made);
  });

  it('a rotated PEM behind the same name is INVALID_STATE (replace), with no write', async () => {
    const { emu, impl } = await setup();
    await impl.certificates.ensureCertificate(custom, call());
    const rotated = await failure(
      impl.certificates.ensureCertificate(
        { ...custom, certificate: 'secret://tenant/cert-rotated' },
        call(),
      ),
    );
    expect([rotated.code, rotated.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    const kind = await failure(
      impl.certificates.ensureCertificate({ ...managed, name: 'bc-cert1' }, call()),
    );
    expect([kind.code, kind.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    expect(writes(emu)).toHaveLength(1);
  });

  it('refuses a PEM that is not one before any write, without echoing it', async () => {
    const { emu, impl } = await setup();
    for (const [spec, reason] of [
      [{ ...custom, certificate: 'secret://tenant/garbage' }, 'certificate'],
      [{ ...custom, privateKey: 'secret://tenant/cert' }, 'privateKey'],
      [{ ...custom, chain: 'secret://tenant/garbage' }, 'chain'],
    ] as const) {
      const error = await failure(impl.certificates.ensureCertificate(spec, call()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_INPUT', reason]);
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(
        /not a pem|BEGIN|c2VjcmV0/,
      );
    }
    expect(writes(emu)).toHaveLength(0);
  });

  it('never puts the key in a log line or an error', async () => {
    const lines: string[] = [];
    const record = (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {}));
    const log = { debug: record, info: record, warn: record, error: record };
    const emu = emulator();
    const impl = await build(emu, doAccount, {}, { log });
    emu.failNext({ method: 'POST', path: /^\/certificates$/ }, 422, {
      id: 'unprocessable_entity',
      message: 'The certificate and key do not match',
    });
    const error = await failure(impl.certificates.ensureCertificate(custom, call()));
    await impl.certificates.ensureCertificate(custom, call());
    const all = lines.join('\n') + error.message + JSON.stringify(error.details);
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      'very-secret',
      Buffer.from('very-secret-key-material').toString('base64'),
      'do-token',
    ])
      expect(all).not.toContain(secret);
  });
});

describe('provider-digitalocean certificates: managed', () => {
  it("asks Let's Encrypt for names in a hosted zone; pending until issued", async () => {
    const { emu, impl } = await setup();
    seedDomain(emu.state, 'example.com');
    const made = await impl.certificates.ensureCertificate(managed, call());
    expect(made).toEqual({
      id: expect.any(String),
      state: 'pending',
      outputs: { kind: 'managed', domains: '*.example.com,www.example.com' },
    });
    expect(calls(emu, 'POST', /^\/v2\/certificates$/)[0]!.body).toEqual({
      name: certificateName('bc-cert2', 'default'),
      type: 'lets_encrypt',
      dns_names: ['*.example.com', 'www.example.com'],
    });
    const issued = await impl.certificates.ensureCertificate(managed, call());
    expect(issued).toMatchObject({
      id: made.id,
      state: 'ready',
      outputs: {
        notAfter: expect.any(String),
        fingerprint: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
    // Other names under the same name: a replace.
    const other = await failure(
      impl.certificates.ensureCertificate({ ...managed, domains: ['api.example.com'] }, call()),
    );
    expect([other.code, other.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
  });

  it('a name outside every zone DigitalOcean hosts is INVALID_INPUT before any write', async () => {
    const { emu, impl } = await setup();
    seedDomain(emu.state, 'example.com');
    const error = await failure(
      impl.certificates.ensureCertificate(
        { ...managed, domains: ['www.example.com', 'app.elsewhere.org'] },
        call(),
      ),
    );
    expect([error.code, error.details?.reason]).toEqual(['INVALID_INPUT', 'zoneNotHosted']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('reports an errored issue as error', async () => {
    const { emu, impl } = await setup();
    seedCertificate(emu.state, {
      name: certificateName('bc-cert2', 'default'),
      type: 'lets_encrypt',
      dns_names: ['*.example.com', 'www.example.com'],
      state: 'error',
      sha1_fingerprint: '',
      not_after: '',
    });
    seedDomain(emu.state, 'example.com');
    expect(await impl.certificates.ensureCertificate(managed, call())).toMatchObject({
      state: 'error',
      message: expect.stringContaining('could not issue'),
    });
  });
});

describe('provider-digitalocean certificates: validation and delete', () => {
  it('refuses what it can before any request', async () => {
    const { emu, impl } = await setup();
    const refusals: [ProviderCertificateSpec, string][] = [
      [{ ...custom, name: 'Bad Name' }, 'name'],
      [{ ...custom, kind: 'other' } as never, 'kind'],
      [{ ...custom, domains: ['a.example.com'] }, 'domains'],
      [{ ...custom, certificate: undefined }, 'certificate'],
      [{ ...custom, privateKey: 'plain-text-key' } as never, 'privateKey'],
      [{ ...managed, domains: [] }, 'domains'],
      [{ ...managed, domains: ['not a host'] }, 'domains'],
      [{ ...managed, certificate: 'secret://tenant/cert' }, 'certificate'],
    ];
    for (const [bad, reason] of refusals) {
      const error = await failure(impl.certificates.ensureCertificate(bad, call()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([
        'INVALID_INPUT',
        reason,
      ]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('deletes a certificate of ours; a gone one counts as deleted; one in use is CONFLICT', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.certificates.ensureCertificate(custom, call());
    const lb = seedLoadBalancer(emu.state, {
      name: 'x',
      forwarding_rules: [
        {
          entry_protocol: 'https',
          entry_port: 443,
          target_protocol: 'http',
          target_port: 80,
          certificate_id: id,
        },
      ],
    });
    const busy = await failure(impl.certificates.deleteCertificate(id, call()));
    expect([busy.code, busy.details?.reason]).toEqual(['CONFLICT', 'inUse']);
    emu.state.loadBalancers.delete(lb.id);
    expect(await impl.certificates.deleteCertificate(id, call())).toEqual({ id, state: 'deleted' });
    expect(await impl.certificates.deleteCertificate(id, call())).toEqual({ id, state: 'deleted' });
    expect(await impl.certificates.getCertificate(id, call())).toBe(undefined);
  });

  it('never deletes a certificate that is not ours; no DELETE is sent', async () => {
    const { emu, impl } = await setup();
    const hand = seedCertificate(emu.state, { name: 'bc-cert1' });
    const other = seedCertificate(emu.state, { name: certificateName('bc-cert1', 'other') });
    for (const cert of [hand, other]) {
      const error = await failure(impl.certificates.deleteCertificate(cert.id, call()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    }
    expect(calls(emu, 'DELETE', /certificates/)).toHaveLength(0);
    const malformed = await failure(impl.certificates.deleteCertificate('../droplets', call()));
    expect([malformed.code, malformed.details?.reason]).toEqual(['INVALID_INPUT', 'certificateId']);
  });

  it('a racing upload of the same name reads the winner', async () => {
    const { emu, impl } = await setup();
    emu.beforeAction('POST /certificates', ({ state }) => {
      seedCertificate(state, {
        name: certificateName('bc-cert1', 'default'),
        type: 'custom',
        sha1_fingerprint: pemFingerprint(leaf('one'), 'CERTIFICATE'),
      });
    });
    const won = await impl.certificates.ensureCertificate(custom, call());
    expect(won.state).toBe('ready');
    expect(emu.state.certificates.size).toBe(1);
  });
});
