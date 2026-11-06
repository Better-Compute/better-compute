import { createHash } from 'node:crypto';
import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteResult } from './index.js';
import { fixture, type DoState, type Json } from './state.js';
import { uuidFrom } from './vpcs.js';

// Certificates under `/v2/certificates`: create (201), list (paged, filtered by `name`), read and
// delete over `state.certificates`. A `custom` one takes PEMs and is `verified` at once; its
// fingerprint is the SHA-1 of the leaf's DER (the base64 between the PEM armour). A
// `lets_encrypt` one takes `dns_names` that must each fall in a domain of the account (else a 422),
// and is `pending` for `emulator.certificateReads` reads before it is `verified`. A name already in
// use is the `422-name-in-use` fixture. A certificate a load balancer still uses (a forwarding rule
// or a global domain) can't be deleted: the 422 `is in use`.

const template = fixture('certificates').certificate as Json;
const pem = /^-----BEGIN ([A-Z ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END \1-----\s*$/;

const readsLeft = new WeakMap<DoState, Map<string, number>>();

function readsOf(state: DoState): Map<string, number> {
  let map = readsLeft.get(state);
  if (!map) {
    map = new Map();
    readsLeft.set(state, map);
  }
  return map;
}

function unprocessable(message: string): RouteResult {
  return {
    status: 422,
    body: { id: 'unprocessable_entity', message, request_id: 'emulated-cert' },
  };
}

/** The SHA-1 of a PEM block's DER, hex; undefined when it is not one PEM block of `label`. */
export function pemFingerprint(text: unknown, label: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  const match = pem.exec(text.trim());
  if (!match || !match[1]!.endsWith(label)) return undefined;
  return createHash('sha1')
    .update(Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64'))
    .digest('hex');
}

/** Whether a name falls in a domain of the account (a wildcard by its parent). */
function hosted(state: DoState, name: string): boolean {
  const labels = name.replace(/^\*\./, '').split('.');
  for (let i = 0; i < labels.length - 1; i++)
    if (state.domains.has(labels.slice(i).join('.'))) return true;
  return false;
}

function afterRead(state: DoState, cert: Json): void {
  const reads = readsOf(state);
  const left = reads.get(cert.id);
  if (left === undefined) return;
  if (left > 1) {
    reads.set(cert.id, left - 1);
    return;
  }
  reads.delete(cert.id);
  cert.state = 'verified';
  cert.not_after = isoSeconds(state.now() + 90 * 86_400_000);
  cert.sha1_fingerprint = createHash('sha1').update(cert.id).digest('hex');
}

/** Puts a certificate in the account, as if uploaded out of band; returns the stored resource. */
export function seedCertificate(state: DoState, seed: Json): Json {
  const id = seed.id ?? uuidFrom(`cert:${state.nextId()}`);
  const cert = { ...structuredClone(template), created_at: isoSeconds(state.now()), ...seed, id };
  state.certificates.set(id, cert);
  return cert;
}

function inUse(state: DoState, id: string): Json | undefined {
  return [...state.loadBalancers.values()].find(
    (lb) =>
      ((lb.forwarding_rules ?? []) as Json[]).some((rule) => rule.certificate_id === id) ||
      ((lb.domains ?? []) as Json[]).some((domain) => domain.certificate_id === id),
  );
}

export function registerCertificates(emulator: DoEmulator): void {
  emulator.route('POST', /^\/certificates$/, (context) => {
    const { state } = context;
    const body = context.body ?? {};
    if (typeof body.name !== 'string' || body.name === '') return unprocessable('Name is required');
    if ([...state.certificates.values()].some((c) => c.name === body.name))
      return emulator.error('422-name-in-use');
    const id = uuidFrom(`cert:${state.nextId()}:${body.name}`);
    let cert: Json;
    if (body.type === 'lets_encrypt') {
      const names = body.dns_names;
      if (!Array.isArray(names) || names.length === 0)
        return unprocessable('dns_names is required');
      for (const name of names as string[])
        if (!hosted(state, name))
          return unprocessable(`The domain ${name} is not managed by DigitalOcean`);
      cert = {
        ...structuredClone(template),
        id,
        name: body.name,
        type: 'lets_encrypt',
        dns_names: [...names],
        state: 'pending',
        not_after: '',
        sha1_fingerprint: '',
        created_at: isoSeconds(state.now()),
      };
      readsOf(state).set(id, emulator.certificateReads);
    } else if (body.type === 'custom') {
      const fingerprint = pemFingerprint(body.leaf_certificate, 'CERTIFICATE');
      if (!fingerprint) return unprocessable('The leaf certificate is invalid');
      if (!pemFingerprint(body.private_key, 'PRIVATE KEY'))
        return unprocessable('The private key is invalid');
      if (
        body.certificate_chain !== undefined &&
        !String(body.certificate_chain).includes('CERTIFICATE')
      )
        return unprocessable('The certificate chain is invalid');
      cert = {
        ...structuredClone(template),
        id,
        name: body.name,
        type: 'custom',
        dns_names: [],
        state: 'verified',
        not_after: isoSeconds(state.now() + 365 * 86_400_000),
        sha1_fingerprint: fingerprint,
        created_at: isoSeconds(state.now()),
      };
    } else return unprocessable('Type is invalid');
    state.certificates.set(id, cert);
    if (cert.type === 'lets_encrypt' && emulator.certificateReads === 0) afterRead(state, cert);
    return { status: 201, body: { certificate: structuredClone(cert) } };
  });
  emulator.route('GET', /^\/certificates$/, (context) => {
    const name = context.url.searchParams.get('name');
    const all = [...context.state.certificates.values()].filter(
      (c) => name === null || c.name === name,
    );
    for (const cert of all) afterRead(context.state, cert);
    return emulator.paged(context, 'certificates', structuredClone(all));
  });
  emulator.route('GET', /^\/certificates\/([0-9a-f-]+)$/, (context) => {
    const cert = context.state.certificates.get(context.match[1]!);
    if (!cert) return emulator.error('not-found');
    afterRead(context.state, cert);
    return { status: 200, body: { certificate: structuredClone(cert) } };
  });
  emulator.route('DELETE', /^\/certificates\/([0-9a-f-]+)$/, (context) => {
    const { state } = context;
    const id = context.match[1]!;
    if (!state.certificates.has(id)) return emulator.error('not-found');
    const user = inUse(state, id);
    if (user) return unprocessable(`The certificate is in use by load balancer ${user.id}`);
    state.certificates.delete(id);
    readsOf(state).delete(id);
    return { status: 204 };
  });
}
