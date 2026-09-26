'use client';

import { useCallback, useEffect, useState } from 'react';
import { useList } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

interface VolumeRow {
  id: string;
  name: string;
  poolId: string;
  sizeGiB: number;
  state: string;
  nodeId?: string;
  serial?: string;
}

/**
 * Sandbox volumes (agent memory, v1.1): persistent disks on one host that outlive sandboxes. A template that
 * names a volume mounts it in every sandbox it creates (sandboxTemplates `volumes`); data survives runs.
 */
export default function VolumesPage() {
  const { api, tenantId, resources } = useConsole();
  const pools = useList(resources.pools);
  const [volumes, setVolumes] = useState<VolumeRow[]>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ poolId: '', name: '', sizeGiB: 10 });

  const refresh = useCallback(async () => {
    const page = await api.$request<{ items: VolumeRow[] }>('sandboxVolumes/list', { tenantId });
    setVolumes(page.items);
  }, [api, tenantId]);
  useEffect(() => {
    void refresh().catch(setError);
  }, [refresh]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const validName = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(draft.name);

  return (
    <>
      <h2>Sandbox volumes</h2>
      <section className="panel">
        <h3>New volume</h3>
        <p className="muted">
          A persistent disk on one host of the pool (agent memory). Sandboxes of templates that mount it run on that
          host and keep its data across runs. Billed until deleted; it only grows.
        </p>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api.$request('sandboxVolumes/create', {
                tenantId,
                poolId: draft.poolId,
                name: draft.name,
                sizeGiB: draft.sizeGiB,
                idempotencyKey: `console-${globalThis.crypto.randomUUID()}`,
              });
              setDraft({ poolId: draft.poolId, name: '', sizeGiB: 10 });
            });
          }}
        >
          <div className="row">
            <label>
              Pool
              <select value={draft.poolId} onChange={(event) => setDraft({ ...draft, poolId: event.target.value })}>
                <option value="">Choose…</option>
                {pools.items.map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input
                placeholder="agent-notes"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value.trim() })}
              />
              {draft.name && !validName && (
                <span className="error">Lowercase letters, digits, . _ - (at most 63)</span>
              )}
            </label>
            <label>
              Size (GiB)
              <input
                type="number"
                min={1}
                max={16384}
                value={draft.sizeGiB}
                onChange={(event) => setDraft({ ...draft, sizeGiB: Number(event.target.value) })}
              />
            </label>
          </div>
          <button
            className="primary"
            type="submit"
            disabled={busy || !draft.poolId || !validName || !(draft.sizeGiB >= 1 && draft.sizeGiB <= 16384)}
          >
            Create volume
          </button>
        </form>
        <ErrorLine error={error} />
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Volumes</h3>
          <button onClick={() => void act(async () => undefined)} disabled={busy}>
            Refresh
          </button>
        </div>
        <Loading status={volumes ? 'ready' : 'loading'} error={undefined}>
          {volumes && volumes.length === 0 && <p className="muted">No volumes.</p>}
          {volumes && volumes.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Volume</th>
                  <th>Pool / host</th>
                  <th>Size</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {volumes.map((volume) => (
                  <tr key={volume.id}>
                    <td>
                      {volume.name}
                      <div className="muted">
                        <code>{volume.id}</code>
                        {volume.serial ? ` · /dev/disk/by-id/virtio-${volume.serial}` : ''}
                      </div>
                    </td>
                    <td>
                      {volume.poolId}
                      <div className="muted">{volume.nodeId ?? 'not placed yet'}</div>
                    </td>
                    <td>{volume.sizeGiB} GiB</td>
                    <td>{volume.state}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          disabled={busy || volume.state !== 'ready'}
                          onClick={() => {
                            const answer = window.prompt(`Grow ${volume.name} to how many GiB?`, String(volume.sizeGiB * 2));
                            const size = Number(answer);
                            if (!answer || !(size > volume.sizeGiB)) return;
                            void act(() =>
                              api.$request('sandboxVolumes/resize', { tenantId, volumeId: volume.id, sizeGiB: size }),
                            );
                          }}
                        >
                          Grow
                        </button>
                        <button
                          type="button"
                          disabled={busy || volume.state !== 'ready'}
                          onClick={() =>
                            window.confirm(`Delete ${volume.name} and wipe its data? This cannot be undone.`) &&
                            void act(() => api.$request('sandboxVolumes/delete', { tenantId, volumeId: volume.id }))
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loading>
      </section>
    </>
  );
}
