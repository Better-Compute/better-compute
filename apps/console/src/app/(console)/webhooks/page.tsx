'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createWebhooksView,
  deliverySummary,
  type WebhookDeliveryRow,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

/**
 * Webhooks (PLAN.md §9.3): the organization's endpoints for signed event deliveries
 * (`X-Better-Compute-Signature: v1=<hmac>`). The signing secret is shown once, after create or rotate.
 */
export default function WebhooksPage() {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => createWebhooksView(api, { tenantId }), [api, tenantId]);
  const state = useStore(view);
  const secret = useStore(view.secret);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('reservation.*, node.*');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>();
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);

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
  const showDeliveries = (webhookId: string) =>
    act(async () => {
      setOpen(webhookId);
      setDeliveries(await view.deliveries(webhookId));
    });

  const summary = deliverySummary(deliveries);
  return (
    <>
      <h2>Webhooks</h2>
      <section className="panel">
        <h3>New webhook</h3>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await view.create({
                url: url.trim(),
                events: events
                  .split(',')
                  .map((type) => type.trim())
                  .filter(Boolean),
                ...(description.trim() ? { description: description.trim() } : {}),
              });
              setUrl('');
              setDescription('');
            });
          }}
        >
          <label>
            Endpoint (https)
            <input
              type="url"
              placeholder="https://hooks.example.com/compute"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            Events (comma-separated patterns)
            <input value={events} onChange={(event) => setEvents(event.target.value)} />
          </label>
          <label>
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={busy || !url.trim()}>
            Create
          </button>
        </form>
        <ErrorLine error={error} />
      </section>

      {secret && (
        <section className="panel">
          <h3>Signing secret</h3>
          <p className="warning">
            Shown once. Store it where your receiver verifies <code>X-Better-Compute-Signature</code>.
          </p>
          <textarea readOnly rows={2} style={{ width: '100%' }} value={secret.secret} />
          <div className="row">
            <button type="button" onClick={() => void navigator.clipboard.writeText(secret.secret)}>
              Copy
            </button>
            <button type="button" onClick={() => view.dismissSecret()}>
              Done
            </button>
          </div>
        </section>
      )}

      <Loading status={state.status} error={state.error}>
        {state.value && state.value.items.length === 0 && (
          <p className="muted">No webhooks yet.</p>
        )}
        {state.value && state.value.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Events</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.value.items.map((hook) => (
                <tr key={hook.id}>
                  <td>
                    <code>{hook.url}</code>
                    {hook.description && <div className="muted">{hook.description}</div>}
                  </td>
                  <td>{hook.events.join(', ')}</td>
                  <td className={hook.active ? 'ok' : 'muted'}>
                    {hook.active ? 'active' : 'paused'}
                    {hook.previousSecretExpiresAt && (
                      <div className="muted">
                        old secret valid until{' '}
                        {new Date(hook.previousSecretExpiresAt).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => view.setActive(hook.id, !hook.active))}
                      >
                        {hook.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => view.ping(hook.id).then(() => showDeliveries(hook.id)))}
                      >
                        Ping
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => view.rotateSecret(hook.id, 3600))}
                      >
                        Rotate secret
                      </button>
                      <button type="button" disabled={busy} onClick={() => void showDeliveries(hook.id)}>
                        Deliveries
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          window.confirm(`Delete the webhook to ${hook.url}?`) &&
                          void act(() => view.remove(hook.id))
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

      {open && (
        <section className="panel">
          <h3>Deliveries</h3>
          <p className="muted">
            {summary.delivered} delivered, {summary.pending} pending, {summary.dead} failed
            {summary.lastFailure &&
              ` · last failure: ${summary.lastFailure.eventType} ${summary.lastFailure.status ?? ''} ${
                summary.lastFailure.error ?? ''
              }`}
          </p>
          <table>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{new Date(delivery.createdAt).toLocaleString()}</td>
                  <td>{delivery.eventType}</td>
                  <td className={delivery.state === 'dead' ? 'error' : delivery.state === 'delivered' ? 'ok' : 'muted'}>
                    {delivery.state}
                    {delivery.lastStatus !== undefined && ` (${delivery.lastStatus})`}
                  </td>
                  <td>{delivery.attempts} attempt(s)</td>
                  <td>
                    {delivery.state === 'dead' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(() => view.redeliver(delivery.id).then(() => showDeliveries(open)))
                        }
                      >
                        Redeliver
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
