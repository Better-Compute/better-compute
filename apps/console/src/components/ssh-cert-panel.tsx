'use client';

import { useEffect, useMemo, useState } from 'react';
import { createSshAccessView, sshUsage, SshKeyInputError } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from './console-provider';
import { ErrorLine } from './ui';

/**
 * Break-glass shell on a node (PLAN.md §13, `nodes.issueSshCert` / `listSshCerts` / `revokeSshCert`): a short-lived
 * OpenSSH user certificate from the compute SSH CA for the caller's own public key, and who holds one. Needs
 * `compute:nodes:ssh-root` and an MFA session; the private key never leaves the caller's machine (a pasted private
 * key is refused before anything is sent).
 */
export function SshCertPanel({ nodeId }: { nodeId: string }) {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => createSshAccessView(api, { tenantId, nodeId }), [api, tenantId, nodeId]);
  const state = useStore(view);
  const issued = useStore(view.issued);
  const [publicKey, setPublicKey] = useState('');
  const [account, setAccount] = useState('root');
  const [minutes, setMinutes] = useState(15);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void view.refresh();
  }, [view]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const failure = error as { details?: { reason?: string } } | undefined;
  const reason = failure?.details?.reason;
  return (
    <section className="panel">
      <h3>Break-glass SSH</h3>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await view.issue({ publicKey, account, minutes });
            setPublicKey('');
          });
        }}
      >
        <label>
          Your public key (Ed25519 or ECDSA P-256, the .pub file)
          <textarea
            rows={2}
            placeholder="ssh-ed25519 AAAA… you@laptop"
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
          />
        </label>
        <div className="row">
          <label>
            Account <input value={account} onChange={(event) => setAccount(event.target.value)} />
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
      {reason === 'mfa-required' || reason === 'session-required' ? (
        <p className="warning">This needs a signed-in session verified with a second factor. Sign in again with MFA.</p>
      ) : error instanceof SshKeyInputError ? (
        <p className="error">{error.message}</p>
      ) : (
        <ErrorLine error={error} />
      )}

      {issued && (
        <>
          <p className="ok">
            Valid until {new Date(issued.validBefore).toLocaleString()} for {issued.principals.join(', ')}. It opens
            this node only. Save it next to your key as <code>&lt;key&gt;-cert.pub</code>:
          </p>
          <textarea readOnly rows={4} style={{ width: '100%' }} value={issued.certificate} />
          <pre>{sshUsage(issued).join('\n')}</pre>
          <div className="row">
            <button type="button" onClick={() => void navigator.clipboard.writeText(issued.certificate)}>
              Copy
            </button>
            <button type="button" onClick={() => view.dismissIssued()}>
              Done
            </button>
          </div>
        </>
      )}

      <h4>Who holds access</h4>
      <label className="row">
        <input
          type="checkbox"
          checked={expired}
          onChange={(event) => {
            setExpired(event.target.checked);
            void act(() => view.showExpired(event.target.checked));
          }}
        />
        Include expired
      </label>
      {state.value && state.value.items.length === 0 && <p className="muted">No certificates.</p>}
      {state.value && state.value.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Holder</th>
              <th>Principal</th>
              <th>Issued</th>
              <th>Until</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.value.items.map((cert) => (
              <tr key={cert.serial}>
                <td>{cert.identityId}</td>
                <td>
                  <code>{cert.principal}</code>
                </td>
                <td>{new Date(cert.issuedAt).toLocaleString()}</td>
                <td>{new Date(cert.expiresAt).toLocaleTimeString()}</td>
                <td className={cert.state === 'active' ? 'ok' : 'muted'}>
                  {cert.state}
                  {cert.revokeReason && <div className="muted">{cert.revokeReason}</div>}
                </td>
                <td>
                  {cert.state === 'active' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        window.confirm(`Revoke ${cert.identityId}'s certificate ${cert.serial}?`) &&
                        void act(() => view.revoke(cert.serial, 'revoked from the console'))
                      }
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
