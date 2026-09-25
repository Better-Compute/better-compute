import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';
import { createStore, type Store } from './store.js';

// Break-glass SSH for one node (PLAN.md §13, the tunnels module's nodes.issueSshCert / revokeSshCert / listSshCerts):
// who holds or held a certificate, issuing one for the person's own public key (never a private key; the private key
// never leaves their machine), and revoking one. The issued certificate is held until dismissed, to be copied beside
// the key as <key>-cert.pub; it is never re-read.

export interface SshCertRow {
  serial: string;
  nodeId: string;
  identityId: string;
  principal: string;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
  state: 'active' | 'expired' | 'revoked';
  revokedAt?: number;
  revokedBy?: string;
  revokeReason?: string;
}

/** What nodes.issueSshCert returned, plus how to use it. */
export interface IssuedSshCertificate {
  nodeId: string;
  certificate: string;
  serial: string;
  keyId: string;
  principals: string[];
  account: string;
  validBefore: number;
}

export interface SshAccessView extends ValueResource<{ items: SshCertRow[]; nextCursor?: string }> {
  /** The certificate the last issue returned, until `dismissIssued()`. */
  readonly issued: Store<IssuedSshCertificate | undefined>;
  dismissIssued(): void;
  /**
   * Issues a certificate for `publicKey` (an OpenSSH public key line). A private key is refused here, before
   * anything is sent. Needs compute:nodes:ssh-root and a session verified with MFA.
   */
  issue(input: { publicKey: string; account?: string; minutes?: number }): Promise<IssuedSshCertificate>;
  revoke(serial: string, reason?: string): Promise<void>;
  /** Include certificates past their expiry (kept a day) from the next load on. */
  showExpired(show: boolean): Promise<void>;
}

/** Thrown for input refused before any request (a private key pasted by mistake, a malformed key). */
export class SshKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshKeyInputError';
  }
}

const keyTypes = /^(ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+( .*)?$/;

/** Checks a pasted public key line: never a private key, one line, a key type the CA signs. */
export function checkSshPublicKey(text: string): string {
  const line = text.trim();
  if (/PRIVATE KEY/.test(line))
    throw new SshKeyInputError('This is a private key: paste the .pub file instead, and keep the private key to yourself');
  if (line.includes('\n')) throw new SshKeyInputError('Paste a single public key line');
  if (!keyTypes.test(line))
    throw new SshKeyInputError('Paste an Ed25519 or ECDSA P-256 OpenSSH public key (ssh-ed25519 … or ecdsa-sha2-nistp256 …)');
  return line;
}

/**
 * The commands to use an issued certificate: save it beside the key, then ssh as the account. `host` is how the
 * person reaches the node (its address); the certificate only names the node, not a host.
 */
export function sshUsage(issued: IssuedSshCertificate, options: { keyPath?: string; host?: string } = {}): string[] {
  const key = options.keyPath ?? '~/.ssh/id_ed25519';
  return [
    `cat > ${key}-cert.pub   # paste the certificate, then Ctrl-D`,
    `ssh -i ${key} ${issued.account}@${options.host ?? '<node address>'}`,
  ];
}

export function createSshAccessView(
  api: ComputeRequester,
  options: { tenantId: string; nodeId: string },
): SshAccessView {
  const { tenantId, nodeId } = options;
  let includeExpired = false;
  const list = createValueResource({
    load: (signal) =>
      api.$request<{ items: SshCertRow[]; nextCursor?: string }>(
        'nodes/listSshCerts',
        { tenantId, nodeId, ...(includeExpired ? { includeExpired: true } : {}) },
        { signal },
      ),
  });
  const issued = createStore<IssuedSshCertificate | undefined>(undefined);
  const change = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run();
    await list.refresh().catch(() => undefined);
    return result;
  };
  return {
    get: list.get,
    subscribe: list.subscribe,
    refresh: list.refresh,
    issued,
    dismissIssued: () => issued.set(undefined),
    issue: (input) =>
      change(async () => {
        const publicKey = checkSshPublicKey(input.publicKey);
        const minutes = input.minutes ?? 15;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)
          throw new SshKeyInputError('Validity must be 1 to 60 minutes');
        const result = await api.$request<Omit<IssuedSshCertificate, 'nodeId'> & { nodeId?: string }>(
          'nodes/issueSshCert',
          {
            tenantId,
            nodeId,
            publicKey,
            ...(input.account ? { principal: input.account } : {}),
            ttlSeconds: minutes * 60,
          },
        );
        const certificate: IssuedSshCertificate = { ...result, nodeId };
        issued.set(certificate);
        return certificate;
      }),
    revoke: (serial, reason) =>
      change(async () => {
        await api.$request('nodes/revokeSshCert', { tenantId, nodeId, serial, ...(reason ? { reason } : {}) });
      }),
    async showExpired(show) {
      includeExpired = show;
      await list.refresh();
    },
  };
}
