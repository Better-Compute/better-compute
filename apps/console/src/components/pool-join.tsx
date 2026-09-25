'use client';

import { useMemo, useState } from 'react';
import { createListResource, type Item } from '@better-compute/console-kit';
import { useList } from '@better-compute/console-kit/react';
import { useConsole } from './console-provider';
import { ErrorLine, Loading } from './ui';

// Joining machines to a pool (PLAN.md §8.3): single- or multi-use join tokens (the secret is shown once) and the
// join requests attestors raise for unknown machines, approved or rejected by a person.

type JoinToken = Item & {
  role: string;
  usesLeft: number;
  allowReclaim: boolean;
  expiresAt: number;
  revokedAt?: number;
};
type JoinRequest = Item & {
  attestor: string;
  state: string;
  claims: Record<string, unknown>;
  hardwareKey?: string;
  mac?: string;
  ip?: string;
  vouchedBy?: string;
  createdAt: number;
  expiresAt: number;
};

const when = (ms: number) => new Date(ms).toLocaleString();

export function PoolJoin({ poolId }: { poolId: string }) {
  const { api, tenantId } = useConsole();
  const tokens = useMemo(
    () =>
      createListResource<JoinToken>({
        key: (token) => token.id,
        load: (cursor, signal) =>
          api.$request(
            'joinTokens/list',
            { tenantId, poolId, ...(cursor ? { cursor } : {}) },
            { signal },
          ),
      }),
    [api, tenantId, poolId],
  );
  const requests = useMemo(
    () =>
      createListResource<JoinRequest>({
        key: (request) => request.id,
        load: (cursor, signal) =>
          api.$request(
            'joinRequests/list',
            { tenantId, poolId, state: 'pending', ...(cursor ? { cursor } : {}) },
            { signal },
          ),
      }),
    [api, tenantId, poolId],
  );
  const tokenList = useList(tokens);
  const requestList = useList(requests);

  const [uses, setUses] = useState(1);
  const [hours, setHours] = useState(1);
  const [reclaim, setReclaim] = useState(false);
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const act = async (run: () => Promise<unknown>, after: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      await after();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const token = await api.$request<{ token?: string }>('joinTokens/create', {
        tenantId,
        poolId,
        maxUses: uses,
        ttlSeconds: hours * 3600,
        allowReclaim: reclaim,
        idempotencyKey: `console-${crypto.randomUUID()}`,
      });
      setCreated(token.token);
    }, tokens.refresh);

  return (
    <section className="panel">
      <h3>Join machines</h3>
      <ErrorLine error={error} />
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Machines{' '}
          <input
            type="number"
            min={1}
            max={1000}
            value={uses}
            style={{ width: 80 }}
            onChange={(event) => setUses(Number(event.target.value))}
          />
        </label>
        <label>
          Valid for{' '}
          <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {[1, 4, 12, 24].map((value) => (
              <option key={value} value={value}>
                {value} h
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={reclaim}
            onChange={(event) => setReclaim(event.target.checked)}
          />
          Known machines may reclaim their node
        </label>
        <button className="primary" type="submit" disabled={busy}>
          Create join token
        </button>
      </form>
      {created && (
        <div className="panel">
          <p className="warning">
            Copy this token now; it is not shown again. Give it to the machine&apos;s installer,
            which runs <code>bcd join</code>.
          </p>
          <code style={{ wordBreak: 'break-all' }}>{created}</code>{' '}
          <button type="button" onClick={() => void navigator.clipboard.writeText(created)}>
            Copy
          </button>{' '}
          <button type="button" onClick={() => setCreated(undefined)}>
            Done
          </button>
        </div>
      )}
      <h4>Active tokens</h4>
      <Loading status={tokenList.status} error={tokenList.error}>
        {tokenList.items.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <table>
            <tbody>
              {tokenList.items.map((token) => (
                <tr key={token.id}>
                  <td>
                    <code>{token.id}</code>
                  </td>
                  <td>{token.role}</td>
                  <td>{token.usesLeft} use(s) left</td>
                  <td>expires {when(token.expiresAt)}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api.$request('joinTokens/revoke', {
                              tenantId,
                              poolId,
                              tokenId: token.id,
                            }),
                          tokens.refresh,
                        )
                      }
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loading>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h4>Pending join requests</h4>
        <button onClick={() => void requests.refresh()}>Refresh</button>
      </div>
      <Loading status={requestList.status} error={requestList.error}>
        {requestList.items.length === 0 ? (
          <p className="muted">None waiting.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Machine</th>
                <th>Seen by</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {requestList.items.map((request) => (
                <tr key={request.id}>
                  <td>
                    <details>
                      <summary>
                        {[request.mac, request.ip].filter(Boolean).join(' · ') || request.id}
                      </summary>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                        {JSON.stringify(
                          {
                            id: request.id,
                            hardwareKey: request.hardwareKey,
                            claims: request.claims,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </td>
                  <td>
                    {request.attestor}
                    {request.vouchedBy ? ` (vouched by ${request.vouchedBy})` : ''}
                  </td>
                  <td>{when(request.expiresAt)}</td>
                  <td className="row">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api.$request('joinRequests/approve', {
                              tenantId,
                              poolId,
                              requestId: request.id,
                            }),
                          requests.refresh,
                        )
                      }
                    >
                      Approve
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        const reason = prompt('Why reject this machine?');
                        if (reason === null) return;
                        void act(
                          () =>
                            api.$request('joinRequests/reject', {
                              tenantId,
                              poolId,
                              requestId: request.id,
                              ...(reason ? { reason } : {}),
                            }),
                          requests.refresh,
                        );
                      }}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loading>
    </section>
  );
}
