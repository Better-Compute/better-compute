'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createInstanceForm } from '@better-compute/console-kit';
import { useList, useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

/** The organization's instances (v0.3 vps), and the instance form (flavors per pool, idempotent submit). */
export default function InstancesPage() {
  const { resources, api, tenantId } = useConsole();
  const list = useList(resources.instances);
  const pools = useList(resources.pools);
  const form = useMemo(() => createInstanceForm(api, { tenantId }), [api, tenantId]);
  const state = useStore(form);
  const values = state.values;
  const [keys, setKeys] = useState('');

  return (
    <>
      <h2>Instances</h2>
      <section className="panel">
        <h3>Create an instance</h3>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit().then((result) => {
              if (result.status === 'done') void resources.instances.refresh();
            });
          }}
        >
          <label>
            Pool
            <select
              value={values.poolId ?? ''}
              onChange={(event) => form.change({ poolId: event.target.value })}
            >
              <option value="">Choose…</option>
              {pools.items
                .filter((pool) => pool.class === 'vm' || pool.class === undefined)
                .map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.id}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Size
            <select
              value={values.flavor ?? ''}
              disabled={state.flavorsStatus !== 'ready'}
              onChange={(event) => form.change({ flavor: event.target.value })}
            >
              <option value="">
                {state.flavorsStatus === 'loading' ? 'Loading sizes…' : 'Choose…'}
              </option>
              {state.flavors.map((flavor) => (
                <option key={flavor.name} value={flavor.name}>
                  {flavor.name}: {flavor.vcpu} vCPU, {flavor.memoryGiB} GiB, {flavor.diskGiB} GiB
                  disk
                  {flavor.gpus ? `, ${flavor.gpus} GPU` : ''}
                </option>
              ))}
            </select>
            {state.flavorsStatus === 'error' && (
              <span className="error">Could not load this pool&apos;s sizes.</span>
            )}
          </label>
          <label>
            Image
            <input
              placeholder="ubuntu-24.04"
              value={values.imageId ?? ''}
              onChange={(event) => form.change({ imageId: event.target.value.trim() })}
            />
          </label>
          <label>
            SSH public keys (one per line, optional)
            <textarea
              rows={3}
              value={keys}
              onChange={(event) => {
                setKeys(event.target.value);
                const lines = event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
                form.change({ sshKeys: lines });
              }}
            />
            {state.errors.sshKeys && <span className="error">{state.errors.sshKeys}</span>}
          </label>
          {state.status === 'awaiting-confirmation' && (
            <p className="warning">
              A person must approve this request ({state.confirmationId}). Submit again after they
              do; it will not create two machines.
            </p>
          )}
          {state.status === 'error' && <ErrorLine error={state.error} />}
          {state.status === 'done' ? (
            <p className="ok">
              Created: {String(state.instance?.id)}.{' '}
              <button
                type="button"
                onClick={() => {
                  setKeys('');
                  form.reset();
                }}
              >
                New instance
              </button>
            </p>
          ) : (
            <button
              className="primary"
              type="submit"
              disabled={Object.keys(state.errors).length > 0 || state.status === 'submitting'}
            >
              {state.status === 'awaiting-confirmation' ? 'Retry after approval' : 'Create'}
            </button>
          )}
        </form>
      </section>
      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Your instances</h3>
          <button onClick={() => void resources.instances.refresh()}>Refresh</button>
        </div>
        <Loading status={list.status} error={list.error}>
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>Pool</th>
                <th>Size</th>
                <th>State</th>
                <th>Node</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((instance) => (
                <tr key={instance.id}>
                  <td>
                    <Link href={`/instances/${encodeURIComponent(instance.id)}`}>
                      {instance.id}
                    </Link>
                  </td>
                  <td>{String(instance.poolId ?? '')}</td>
                  <td>{String(instance.flavor ?? '')}</td>
                  <td>{String(instance.state ?? '')}</td>
                  <td>{String(instance.nodeId ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasMore && (
            <button onClick={() => void resources.instances.loadMore()}>Load more</button>
          )}
        </Loading>
      </section>
    </>
  );
}
