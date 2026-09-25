'use client';

import Link from 'next/link';
import { use, useMemo } from 'react';
import { createDetail } from '@better-compute/console-kit';
import { useDetail } from '@better-compute/console-kit/react';
import { useConsole, useDetailEvents } from '@/components/console-provider';
import { DetailActions } from '@/components/detail-actions';
import { NodeCommands } from '@/components/node-commands';
import { SshCertPanel } from '@/components/ssh-cert-panel';
import { Loading } from '@/components/ui';

/** One node: its state, conditions and labels, and the node actions its state allows. */
export default function NodePage({ params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = use(params);
  const { api, tenantId, root, permissions } = useConsole();
  const detail = useMemo(
    () => createDetail(api, { tenantId, kind: 'node', id: nodeId, permissions }),
    [api, tenantId, nodeId, permissions],
  );
  const state = useDetail(detail);
  useDetailEvents(detail);
  const node = state.item;

  return (
    <>
      <h2>{nodeId}</h2>
      <Loading status={state.status === 'gone' ? 'error' : state.status} error={state.error}>
        {state.status === 'gone' && (
          <p className="error">This node no longer exists or is not visible to you.</p>
        )}
        {node && (
          <>
            <section className="panel">
              <table>
                <tbody>
                  {(
                    [
                      'poolId',
                      'siteId',
                      'provisionState',
                      'connectivity',
                      'trust',
                      'cordoned',
                      'maintenance',
                    ] as const
                  ).map((key) => (
                    <tr key={key}>
                      <th>{key}</th>
                      <td>{String(node[key] ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panel">
              <h3>Conditions</h3>
              <ul>
                {(
                  (node.conditions as
                    | { type: string; status: string; reason?: string }[]
                    | undefined) ?? []
                ).map((condition) => (
                  <li
                    key={condition.type}
                    className={condition.status === 'true' ? 'error' : 'muted'}
                  >
                    {condition.type}: {condition.status}
                    {condition.reason ? ` (${condition.reason})` : ''}
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel">
              <h3>Actions</h3>
              <DetailActions
                detail={detail}
                only={['nodes/cordon', 'nodes/uncordon', 'nodes/drain']}
              />
              {node.connectivity === 'connected' && (
                <p>
                  <Link href={`/nodes/${encodeURIComponent(nodeId)}/console`}>
                    Open the console
                  </Link>
                </p>
              )}
            </section>
            {/* Break-glass shells are a platform operation (compute:nodes:ssh-root; IAM still decides). */}
            {root && <SshCertPanel nodeId={nodeId} />}
            <NodeCommands nodeId={nodeId} />
          </>
        )}
      </Loading>
    </>
  );
}
