'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createSandboxesView,
  sandboxExecCommand,
  timeLeft,
  type SandboxTemplateRow,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

/**
 * Sandboxes (PLAN.md §3.7): short-lived instances from the organization's templates, claimed warm when a template
 * keeps a pool, deleted at their expiry unless extended. A shell is `better-compute sandbox exec` (ssh through a
 * tunnel; there is no agent in the guest).
 */
export default function SandboxesPage() {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => createSandboxesView(api, { tenantId }), [api, tenantId]);
  const state = useStore(view);
  const [templates, setTemplates] = useState<SandboxTemplateRow[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  // Snapshots need a SnapshotStore (presigned uploads) in the deployment; without one the button goes away.
  const [snapshotsOff, setSnapshotsOff] = useState(false);

  useEffect(() => {
    void view.refresh();
    void view
      .templates()
      .then((items) => {
        setTemplates(items);
        setTemplateId((current) => current || items[0]?.id || '');
      })
      .catch(setError);
  }, [view]);
  // The countdowns tick every second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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
  const template = templates.find((item) => item.id === templateId);
  const reloadTemplates = async () => setTemplates(await view.templates());
  const [draft, setDraft] = useState({ name: '', poolId: '', flavor: '', imageId: '', warmMin: 0, maxHours: 4 });

  return (
    <>
      <h2>Sandboxes</h2>
      <section className="panel">
        <h3>New sandbox</h3>
        {templates.length === 0 ? (
          <p className="muted">No templates yet: an administrator creates them (sandboxTemplates.create).</p>
        ) : (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() => view.create({ templateId, ttlSeconds: minutes * 60 }));
            }}
          >
            <label>
              Template
              <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.flavor}, warm {item.warm.min}–{item.warm.max})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lifetime (minutes)
              <input
                type="number"
                min={1}
                max={template ? Math.floor(template.maxTtlSeconds / 60) : undefined}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            <button className="primary" type="submit" disabled={busy || !templateId}>
              Create
            </button>
          </form>
        )}
        <ErrorLine error={error} />
      </section>

      <section className="panel">
        <h3>Templates</h3>
        <p className="muted">
          What sandboxes start from, and how many stay warm (billed as warm vCPU-hours). Managing them needs
          compute:sandboxes:manage.
        </p>
        {templates.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Pool / flavor / image</th>
                <th>Lifetime</th>
                <th>Warm</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {templates.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.name}
                    <div className="muted">
                      <code>{item.id}</code>
                    </div>
                  </td>
                  <td>
                    {item.poolId} / {item.flavor} / {item.imageId}
                  </td>
                  <td>
                    {Math.round(item.defaultTtlSeconds / 60)} min (max {Math.round(item.maxTtlSeconds / 3600)} h)
                  </td>
                  <td>
                    {item.warm.min}–{item.warm.max}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await view.updateTemplate(item.id, {
                              warm: { min: item.warm.min + 1, max: Math.max(item.warm.max, item.warm.min + 1) },
                            });
                            await reloadTemplates();
                          })
                        }
                      >
                        Warm +1
                      </button>
                      <button
                        type="button"
                        disabled={busy || item.warm.min === 0}
                        onClick={() =>
                          void act(async () => {
                            await view.updateTemplate(item.id, { warm: { min: item.warm.min - 1, max: item.warm.max } });
                            await reloadTemplates();
                          })
                        }
                      >
                        Warm −1
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          window.confirm(`Delete the template ${item.name}?`) &&
                          void act(async () => {
                            await view.deleteTemplate(item.id);
                            await reloadTemplates();
                          })
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
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await view.createTemplate({
                name: draft.name.trim(),
                poolId: draft.poolId.trim(),
                flavor: draft.flavor.trim(),
                imageId: draft.imageId.trim(),
                maxTtlSeconds: draft.maxHours * 3600,
                ...(draft.warmMin > 0 ? { warm: { min: draft.warmMin } } : {}),
              });
              setDraft({ name: '', poolId: '', flavor: '', imageId: '', warmMin: 0, maxHours: 4 });
              await reloadTemplates();
            });
          }}
        >
          <div className="row">
            {(['name', 'poolId', 'flavor', 'imageId'] as const).map((field) => (
              <label key={field}>
                {field === 'poolId' ? 'Pool' : field === 'imageId' ? 'Image' : field[0]!.toUpperCase() + field.slice(1)}
                <input
                  value={draft[field]}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
              </label>
            ))}
            <label>
              Warm
              <input
                type="number"
                min={0}
                max={100}
                value={draft.warmMin}
                onChange={(event) => setDraft({ ...draft, warmMin: Number(event.target.value) })}
              />
            </label>
            <label>
              Max lifetime (h)
              <input
                type="number"
                min={1}
                max={720}
                value={draft.maxHours}
                onChange={(event) => setDraft({ ...draft, maxHours: Number(event.target.value) })}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy || !draft.name.trim() || !draft.poolId.trim() || !draft.flavor.trim() || !draft.imageId.trim()}
          >
            Create template
          </button>
        </form>
      </section>

      <label className="row">
        <input
          type="checkbox"
          checked={all}
          onChange={(event) => {
            setAll(event.target.checked);
            void act(() => view.scope(event.target.checked ? 'all' : 'mine'));
          }}
        />
        Everyone’s sandboxes
      </label>
      <Loading status={state.status} error={state.error}>
        {state.value && state.value.items.length === 0 && <p className="muted">No sandboxes.</p>}
        {state.value && state.value.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Sandbox</th>
                <th>State</th>
                <th>Expires in</th>
                <th>Shell</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.value.items.map((sandbox) => {
                const left = timeLeft(sandbox.expiresAt, now);
                return (
                  <tr key={sandbox.id}>
                    <td>
                      <code>{sandbox.id}</code>
                      <div className="muted">
                        {templates.find((item) => item.id === sandbox.templateId)?.name ?? sandbox.templateId}
                        {sandbox.warm ? ' · warm' : ''}
                        {sandbox.fromSnapshot ? ` · from ${sandbox.fromSnapshot}` : ''}
                      </div>
                    </td>
                    <td>{sandbox.state}</td>
                    <td className={left.urgent ? 'warning' : ''}>{left.text}</td>
                    <td>
                      <code>{sandboxExecCommand(sandbox.id)}</code>
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => view.extend(sandbox.id, 30 * 60_000))}
                        >
                          +30 min
                        </button>
                        {!snapshotsOff && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                view.snapshot(sandbox.id).catch((failure: { code?: string }) => {
                                  if (failure?.code !== 'INVALID_CONFIG') throw failure;
                                  setSnapshotsOff(true);
                                  throw new Error('Snapshots are not configured on this deployment (no SnapshotStore).');
                                }),
                              )
                            }
                          >
                            Snapshot
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            window.confirm(`Delete ${sandbox.id}?`) && void act(() => view.remove(sandbox.id))
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Loading>
    </>
  );
}
