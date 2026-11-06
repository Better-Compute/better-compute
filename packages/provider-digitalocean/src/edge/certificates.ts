import { createHash } from 'node:crypto';
import {
  ComputeError,
  isComputeError,
  isSecretRef,
  type CallContext,
  type Logger,
  type ProviderCertificates,
  type ProviderCertificateSpec,
  type ProviderResourceState,
  type SecretRef,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { deploymentHash } from '../ids.js';

// TLS certificates for load balancers (P4). A certificate has no tags at DO; its name is unique in
// the account, so the name carries the ownership, as a load balancer's does: vps's name plus this
// deployment's hash. A racing upload under the same name loses with a 422 and reads the winner.
//
// `managed` is a Let's Encrypt certificate, which DO issues (and renews) only for names in a zone it
// hosts: every name is checked against the account's domains before the request. `custom` uploads
// a tenant's PEMs, resolved from their secret references in the call that sends them and never
// kept, logged, or put in an error: a PEM that is not one is refused by what it is, not by its
// content. A certificate never changes in place: other names, another kind, or a custom
// certificate whose leaf no longer matches the stored fingerprint (a rotated secret) is
// `INVALID_STATE` (`replace`).

/** A certificate (`GET /certificates/{id}`). */
export interface DoCertificate {
  id: string;
  name: string;
  not_after?: string;
  sha1_fingerprint?: string;
  created_at?: string;
  dns_names?: string[];
  state: 'pending' | 'verified' | 'error' | string;
  type: 'custom' | 'lets_encrypt' | string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/;
const hostPattern =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const pemBlock = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END \1-----/g;
/** DO's limit on names per Let's Encrypt certificate (the CA's is 100). */
const maxDomains = 100;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** The DO name of a certificate: vps's name plus this deployment's hash. */
export function certificateName(name: string, deployment: string): string {
  return `${name}-${deploymentHash(deployment)}`;
}

/** The PEM blocks of a text, by label: undefined when anything but blocks is in it. */
function pemBlocks(text: string): { label: string; der: Buffer }[] | undefined {
  const blocks: { label: string; der: Buffer }[] = [];
  let rest = text;
  for (const match of text.matchAll(pemBlock)) {
    blocks.push({ label: match[1]!, der: Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64') });
    rest = rest.replace(match[0], '');
  }
  return rest.trim() === '' && blocks.length > 0 ? blocks : undefined;
}

/** The SHA-1 of a leaf certificate's DER, hex, as DO reports `sha1_fingerprint`. */
export function leafFingerprint(pem: string): string | undefined {
  const blocks = pemBlocks(pem);
  if (!blocks || blocks.length !== 1 || blocks[0]!.label !== 'CERTIFICATE') return undefined;
  return createHash('sha1').update(blocks[0]!.der).digest('hex');
}

const state = (
  id: string,
  value: ProviderResourceState['state'],
  outputs?: Record<string, string>,
  message?: string,
): ProviderResourceState => ({
  id,
  state: value,
  ...(outputs ? { outputs } : {}),
  ...(message !== undefined ? { message } : {}),
});

/** A certificate's outputs: plain values only (never a PEM). */
export function certificateOutputs(cert: DoCertificate): Record<string, string> {
  return {
    kind: cert.type === 'lets_encrypt' ? 'managed' : 'custom',
    domains: [...(cert.dns_names ?? [])]
      .map((d) => d.toLowerCase())
      .sort()
      .join(','),
    ...(cert.not_after ? { notAfter: cert.not_after } : {}),
    ...(cert.sha1_fingerprint ? { fingerprint: cert.sha1_fingerprint.toLowerCase() } : {}),
  };
}

function certificateState(cert: DoCertificate): ProviderResourceState {
  if (cert.state === 'verified') return state(cert.id, 'ready', certificateOutputs(cert));
  if (cert.state === 'error')
    return state(
      cert.id,
      'error',
      certificateOutputs(cert),
      `DigitalOcean could not issue certificate ${cert.id}; replace it once its names resolve to DigitalOcean`,
    );
  return state(cert.id, 'pending', certificateOutputs(cert));
}

export class DoCertificates implements ProviderCertificates {
  protected readonly client: DoClient;
  protected readonly log: Logger;
  /** `-<hash12>`: the suffix every certificate name of ours ends with. */
  protected readonly suffix: string;

  constructor(client: DoClient, deployment: string, log: Logger) {
    this.client = client;
    this.log = log;
    this.suffix = `-${deploymentHash(deployment)}`;
  }

  protected owned(cert: DoCertificate): boolean {
    return (
      cert.name.endsWith(this.suffix) && namePattern.test(cert.name.slice(0, -this.suffix.length))
    );
  }

  /** The certificate, or undefined when it does not exist. */
  protected async certificate(id: string, signal: AbortSignal): Promise<DoCertificate | undefined> {
    try {
      const reply = await this.client.request<{ certificate: DoCertificate }>(
        'GET',
        `/certificates/${encodeURIComponent(id)}`,
        { signal, budget: 'observe' },
      );
      return reply.certificate;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  protected async named(doName: string, signal: AbortSignal): Promise<DoCertificate | undefined> {
    for await (const cert of this.client.pages<DoCertificate>('/certificates', 'certificates', {
      query: { name: doName },
      signal,
      budget: 'observe',
    }))
      if (cert.name === doName) return cert;
    return undefined;
  }

  /** Refuses what DO would refuse, before any request; the managed names, normalized. */
  protected validate(spec: ProviderCertificateSpec): string[] {
    const bad = (reason: string, message: string) => fail('INVALID_INPUT', message, reason);
    if (typeof spec.name !== 'string' || !namePattern.test(spec.name))
      throw bad(
        'name',
        `certificate name ${JSON.stringify(spec.name)} is not [a-z0-9-], at most 51 characters`,
      );
    if (spec.kind === 'managed') {
      if (
        spec.certificate !== undefined ||
        spec.privateKey !== undefined ||
        spec.chain !== undefined
      )
        throw bad('certificate', 'a managed certificate takes no PEMs; DigitalOcean issues it');
      const domains = [...new Set((spec.domains ?? []).map((d) => String(d).toLowerCase()))].sort();
      if (domains.length === 0 || domains.length > maxDomains)
        throw bad('domains', `a managed certificate covers 1 to ${maxDomains} names`);
      for (const domain of domains)
        if (!hostPattern.test(domain))
          throw bad('domains', `${JSON.stringify(domain)} is not a host name`);
      return domains;
    }
    if (spec.kind !== 'custom')
      throw bad('kind', `certificate kind ${String(spec.kind)} is not managed or custom`);
    if (spec.domains !== undefined)
      throw bad('domains', 'a custom certificate covers the names in its PEM; it takes no domains');
    if (!isSecretRef(spec.certificate))
      throw bad('certificate', 'a custom certificate names its PEM as a secret reference');
    if (!isSecretRef(spec.privateKey))
      throw bad('privateKey', 'a custom certificate names its key as a secret reference');
    if (spec.chain !== undefined && !isSecretRef(spec.chain))
      throw bad('chain', 'a custom certificate names its chain as a secret reference');
    return [];
  }

  /** A secret's value, in memory for this call only; a reference that does not resolve is refused. */
  protected async resolve(ref: SecretRef, ctx: CallContext, reason: string): Promise<string> {
    try {
      return await ctx.secrets.resolve(ref);
    } catch {
      throw fail('INVALID_INPUT', `secret reference ${ref} could not be resolved`, reason);
    }
  }

  /** The zone each name falls in must be one of the account's domains (DO issues for those only). */
  protected async refuseUnhosted(domains: readonly string[], signal: AbortSignal): Promise<void> {
    const seen = new Map<string, boolean>();
    const hosted = async (zone: string): Promise<boolean> => {
      if (!seen.has(zone)) {
        try {
          await this.client.request('GET', `/domains/${encodeURIComponent(zone)}`, {
            signal,
            budget: 'observe',
          });
          seen.set(zone, true);
        } catch (error) {
          if (!isComputeError(error, 'NOT_FOUND')) throw error;
          seen.set(zone, false);
        }
      }
      return seen.get(zone)!;
    };
    for (const domain of domains) {
      const labels = domain.replace(/^\*\./, '').split('.');
      let found = false;
      for (let i = 0; i < labels.length - 1 && !found; i++)
        found = await hosted(labels.slice(i).join('.'));
      if (!found)
        throw fail(
          'INVALID_INPUT',
          `${domain} is not in a DNS zone this DigitalOcean account hosts; a managed certificate covers only those`,
          'zoneNotHosted',
        );
    }
  }

  /** An existing certificate checked against the spec: it is never changed in place. */
  protected matching(
    cert: DoCertificate,
    kind: 'managed' | 'custom',
    want: string,
  ): ProviderResourceState {
    const actual =
      kind === 'managed'
        ? [...(cert.dns_names ?? [])]
            .map((d) => d.toLowerCase())
            .sort()
            .join(',')
        : (cert.sha1_fingerprint ?? '').toLowerCase();
    if (certificateOutputs(cert).kind !== kind || actual !== want)
      throw fail(
        'INVALID_STATE',
        `certificate ${cert.id} differs in its ${certificateOutputs(cert).kind !== kind ? 'kind' : kind === 'managed' ? 'names' : 'certificate'}; certificates are not changed in place, replace it`,
        'replace',
      );
    return certificateState(cert);
  }

  async ensureCertificate(
    spec: ProviderCertificateSpec,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    const domains = this.validate(spec);
    const { signal } = ctx;
    const doName = `${spec.name}${this.suffix}`;
    let want: string;
    let leaf: string | undefined;
    if (spec.kind === 'custom') {
      leaf = await this.resolve(spec.certificate!, ctx, 'certificate');
      const fingerprint = leafFingerprint(leaf);
      if (!fingerprint)
        throw fail(
          'INVALID_INPUT',
          'the certificate secret does not hold one PEM certificate',
          'certificate',
        );
      want = fingerprint;
    } else want = domains.join(',');

    const existing = await this.named(doName, signal);
    if (existing) return this.matching(existing, spec.kind, want);

    let body: Record<string, unknown>;
    if (spec.kind === 'managed') {
      await this.refuseUnhosted(domains, signal);
      body = { name: doName, type: 'lets_encrypt', dns_names: domains };
    } else {
      const key = await this.resolve(spec.privateKey!, ctx, 'privateKey');
      const keyBlocks = pemBlocks(key);
      if (!keyBlocks || keyBlocks.length !== 1 || !keyBlocks[0]!.label.endsWith('PRIVATE KEY'))
        throw fail(
          'INVALID_INPUT',
          'the private key secret does not hold one PEM private key',
          'privateKey',
        );
      let chain: string | undefined;
      if (spec.chain !== undefined) {
        chain = await this.resolve(spec.chain, ctx, 'chain');
        if (!pemBlocks(chain)?.every((block) => block.label === 'CERTIFICATE'))
          throw fail('INVALID_INPUT', 'the chain secret does not hold PEM certificates', 'chain');
      }
      body = {
        name: doName,
        type: 'custom',
        leaf_certificate: leaf,
        private_key: key,
        ...(chain !== undefined ? { certificate_chain: chain } : {}),
      };
    }
    let made: DoCertificate;
    try {
      made = (
        await this.client.request<{ certificate: DoCertificate }>('POST', '/certificates', {
          body,
          signal,
          budget: 'mutate',
        })
      ).certificate;
    } catch (error) {
      // A racing upload of the same name won: read it, and hold it to the spec.
      if (isComputeError(error, 'CONFLICT')) {
        const winner = await this.named(doName, signal);
        if (winner) return this.matching(winner, spec.kind, want);
      }
      throw error;
    }
    this.log.info('digitalocean.certificateCreated', {
      certificate: made.id,
      name: doName,
      kind: spec.kind,
    });
    return certificateState(made);
  }

  async getCertificate(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    if (!uuidPattern.test(id)) return undefined;
    const cert = await this.certificate(id.toLowerCase(), ctx.signal);
    return cert ? certificateState(cert) : undefined;
  }

  async deleteCertificate(id: string, ctx: CallContext): Promise<ProviderResourceState> {
    if (!uuidPattern.test(id))
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(id)} is not a DigitalOcean certificate id`,
        'certificateId',
      );
    const { signal } = ctx;
    const cert = await this.certificate(id.toLowerCase(), signal);
    if (!cert) return state(id, 'deleted');
    if (!this.owned(cert))
      throw fail(
        'INVALID_STATE',
        `certificate ${cert.id} is not managed by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    try {
      await this.client.request('DELETE', `/certificates/${encodeURIComponent(cert.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.certificateDeleted', { certificate: cert.id });
    return state(cert.id, 'deleted');
  }
}
