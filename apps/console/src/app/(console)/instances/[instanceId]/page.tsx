'use client';

import Link from 'next/link';
import { use, useMemo } from 'react';
import { createDetail } from '@better-compute/console-kit';
import { useDetail } from '@better-compute/console-kit/react';
import { useConsole, useDetailEvents } from '@/components/console-provider';
import { DetailActions } from '@/components/detail-actions';
import { Loading } from '@/components/ui';

/** One instance: its state and placement, the lifecycle actions its state allows, and its terminal. */
export default function InstancePage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  const { api, tenantId } = useConsole();
  const detail = useMemo(
    () => createDetail(api, { tenantId, kind: 'instance', id: instanceId }),
    [api, tenantId, instanceId],
  );
  const state = useDetail(detail);
  useDetailEvents(detail);
  const instance = state.item;

  return (
    <>
      <h2>{instanceId}</h2>
      {state.status === 'gone' ? (
        <p className="error">This instance no longer exists or is not visible to you.</p>
      ) : (
        <Loading status={state.status} error={state.error}>
          {instance && (
            <>
              <section className="panel">
                <table>
                  <tbody>
                    {(
                      [
                        'state',
                        'desiredState',
                        'poolId',
                        'flavor',
                        'imageId',
                        'nodeId',
                        'address',
                      ] as const
                    ).map((key) => (
                      <tr key={key}>
                        <th>{key}</th>
                        <td>{instance[key] === undefined ? '—' : String(instance[key])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="panel">
                <h3>Actions</h3>
                <DetailActions
                  detail={detail}
                  only={['instances/start', 'instances/stop', 'instances/delete']}
                />
                {instance.state === 'running' && (
                  <p>
                    <Link href={`/instances/${encodeURIComponent(instanceId)}/terminal`}>
                      Open a terminal
                    </Link>
                  </p>
                )}
              </section>
            </>
          )}
        </Loading>
      )}
    </>
  );
}
