'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createPxeDiscoveryView,
  normalizeMac,
  pxeCandidates,
  seenAgo,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

/**
 * PXE discovery (metal.discovered): what a site's agents saw PXE-booting from MACs with no boot entry. Nothing here
 * is trusted. A machine enrolled with only its product UUID (an IPMI BMC cannot name its NICs) waits until an
 * operator confirms the MAC metal proposed for it right after power-cycling it (metal.confirmMac); only then is it
 * booted from that MAC.
 */
export default function DiscoveryPage() {
  const { api, tenantId } = useConsole();
  const [sites, setSites] = useState<{ id: string }[]>();
  const [siteId, setSiteId] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ nodeId: '', mac: '' });

  useEffect(() => {
    api
      .$request<{ items: { id: string }[] }>('sites/list', { tenantId })
      .then((page) => {
        setSites(page.items);
        setSiteId((current) => current || page.items[0]?.id || '');
      })
      .catch(setError);
  }, [api, tenantId]);

  const view = useMemo(
    () => (siteId ? createPxeDiscoveryView(api, { tenantId, siteId }) : undefined),
    [api, tenantId, siteId],
  );
  useEffect(() => {
    void view?.refresh();
  }, [view]);

  const confirm = async (nodeId: string, mac: string) => {
    if (!view) return;
    if (
      !window.confirm(
        `Bind ${mac} as the PXE MAC of ${nodeId}? The machine will then boot from it.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await view.confirmMac(nodeId, mac);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>PXE discovery</h2>
      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label>
            Site
            <select value={siteId} onChange={(event) => setSiteId(event.target.value)}>
              {!sites?.length && <option value="">No site</option>}
              {sites?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.id}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void view?.refresh()} disabled={!view || busy}>
            Refresh
          </button>
        </div>
        <p className="muted">
          Machines the site agents saw PXE-booting with no boot entry in the last 24 hours. They are
          never answered or enrolled. A candidate is the MAC metal saw right after power-cycling a
          machine enrolled without MACs: confirm it only if it is that machine.
        </p>
        <ErrorLine error={error} />
        {view && <DiscoveredTable view={view} busy={busy} onConfirm={confirm} />}
      </section>

      <section className="panel">
        <h3>Bind a MAC by hand</h3>
        <p className="muted">
          For a machine enrolled without MACs whose PXE MAC you know (from its label or its BMC).
        </p>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            const mac = normalizeMac(manual.mac);
            if (mac)
              void confirm(manual.nodeId.trim(), mac).then(() =>
                setManual({ nodeId: '', mac: '' }),
              );
          }}
        >
          <div className="row">
            <label>
              Node
              <input
                placeholder="node_…"
                value={manual.nodeId}
                onChange={(event) => setManual({ ...manual, nodeId: event.target.value })}
              />
            </label>
            <label>
              MAC
              <input
                placeholder="aa:bb:cc:dd:ee:ff"
                value={manual.mac}
                onChange={(event) => setManual({ ...manual, mac: event.target.value })}
              />
              {manual.mac && !normalizeMac(manual.mac) && (
                <span className="error">aa:bb:cc:dd:ee:ff</span>
              )}
            </label>
          </div>
          <button
            className="primary"
            type="submit"
            disabled={
              busy || !view || !/^node_/.test(manual.nodeId.trim()) || !normalizeMac(manual.mac)
            }
          >
            Confirm MAC
          </button>
        </form>
      </section>
    </>
  );
}

function DiscoveredTable({
  view,
  busy,
  onConfirm,
}: {
  view: ReturnType<typeof createPxeDiscoveryView>;
  busy: boolean;
  onConfirm: (nodeId: string, mac: string) => Promise<void>;
}) {
  const state = useStore(view);
  const now = Date.now();
  const rows = pxeCandidates(state.value?.machines ?? []);
  return (
    <Loading status={state.status === 'idle' ? 'loading' : state.status} error={state.error}>
      {rows.length === 0 && <p className="muted">Nothing seen.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>MAC</th>
              <th>Product UUID</th>
              <th>Arch / relay</th>
              <th>Last seen</th>
              <th>Machine</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kind, row }) => (
              <tr key={row.mac}>
                <td>
                  <code>{row.mac}</code>
                  <div className="muted">{row.count} request(s)</div>
                </td>
                <td>
                  <code>{row.productUuid ?? '—'}</code>
                </td>
                <td>
                  {row.arch ?? '—'}
                  <div className="muted">
                    {row.relays.length ? `via ${row.relays.join(', ')}` : 'agent segment'}
                  </div>
                </td>
                <td>{seenAgo(row.lastSeen, now)}</td>
                <td>
                  {kind === 'enrolled' && <code>{row.nodeId}</code>}
                  {kind === 'candidate' && (
                    <>
                      candidate for <code>{row.candidateFor}</code>
                    </>
                  )}
                  {kind === 'unknown' && <span className="muted">not enrolled</span>}
                </td>
                <td>
                  {kind === 'candidate' && (
                    <button
                      className="primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void onConfirm(row.candidateFor!, row.mac)}
                    >
                      Confirm
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Loading>
  );
}
