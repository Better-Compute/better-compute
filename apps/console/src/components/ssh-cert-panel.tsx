'use client';

import { useState } from 'react';
import { useConsole } from './console-provider';
import { ErrorLine } from './ui';

interface IssuedSshCert {
  certificate: string;
  serial: string;
  keyId: string;
  /** Node-bound (`root@node_…`): the certificate opens this node only. */
  principals: string[];
  account: string;
  validBefore: number;
}

/**
 * Break-glass shell on a node (PLAN.md §13, `nodes.issueSshCert`): a short-lived OpenSSH user certificate from the
 * compute SSH CA for the caller's own public key. Needs `compute:nodes:ssh-root` and an MFA session; the private key
 * never leaves the caller's machine.
 */
export function SshCertPanel({ nodeId }: { nodeId: string }) {
  const { api, tenantId } = useConsole();
  const [publicKey, setPublicKey] = useState('');
  const [principal, setPrincipal] = useState('root');
  const [minutes, setMinutes] = useState(15);
  const [issued, setIssued] = useState<IssuedSshCert>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [revokedAt, setRevokedAt] = useState<number>();

  const issue = async () => {
    setBusy(true);
    setError(undefined);
    setIssued(undefined);
    setRevokedAt(undefined);
    try {
      setIssued(
        await api.$request<IssuedSshCert>('nodes/issueSshCert', {
          tenantId,
          nodeId,
          publicKey: publicKey.trim(),
          principal,
          ttlSeconds: minutes * 60,
        }),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  // Done with it early, or it leaked: the node's KRL lists it from its next spec (nodes.revokeSshCert).
  const revoke = async () => {
    if (!issued) return;
    setBusy(true);
    setError(undefined);
    try {
      const revoked = await api.$request<{ revokedAt: number }>('nodes/revokeSshCert', {
        tenantId,
        nodeId,
        serial: issued.serial,
        reason: 'revoked from the console',
      });
      setRevokedAt(revoked.revokedAt);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const failure = error as { details?: { reason?: string } } | undefined;
  return (
    <section className="panel">
      <h3>Break-glass SSH</h3>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void issue();
        }}
      >
        <label>
          Your public key (Ed25519 or ECDSA P-256)
          <textarea
            rows={2}
            placeholder="ssh-ed25519 AAAA… you@laptop"
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
          />
        </label>
        <div className="row">
          <label>
            Account{' '}
            <input value={principal} onChange={(event) => setPrincipal(event.target.value)} />
          </label>
          <label>
            Valid for{' '}
            <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
              {[5, 15, 30, 60].map((value) => (
                <option key={value} value={value}>
                  {value} min
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="primary" type="submit" disabled={busy || !publicKey.trim()}>
          Issue certificate
        </button>
      </form>
      {failure?.details?.reason === 'mfa-required' ? (
        <p className="warning">
          This needs a session verified with a second factor. Sign in again with MFA.
        </p>
      ) : (
        <ErrorLine error={error} />
      )}
      {issued && (
        <>
          <p className="ok">
            Valid until {new Date(issued.validBefore).toLocaleString()} for{' '}
            {issued.principals.join(', ')} ({issued.keyId}). Save it next to your key as{' '}
            <code>&lt;key&gt;-cert.pub</code>, then connect with{' '}
            <code>ssh {issued.account}@&lt;node&gt;</code>. It opens this node only.
          </p>
          <textarea readOnly rows={4} style={{ width: '100%' }} value={issued.certificate} />
          <div className="row">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(issued.certificate)}
            >
              Copy
            </button>
            {revokedAt === undefined ? (
              <button type="button" disabled={busy} onClick={() => void revoke()}>
                Revoke now
              </button>
            ) : (
              <span className="warning">
                Revoked {new Date(revokedAt).toLocaleTimeString()}; the node refuses it from its
                next spec.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
