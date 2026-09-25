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
                        <button type="button" disabled={busy} onClick={() => void act(() => view.snapshot(sandbox.id))}>
                          Snapshot
                        </button>
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
