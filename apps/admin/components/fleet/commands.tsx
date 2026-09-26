'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useConnection } from '@/components/shell/connection';
import { useWorkspaceSettings, useClockGetter } from '@/components/shell/workspace';
import { api as client } from '@/lib/api';
import { useFeedback } from '@/components/ui/feedback';
import type { CommandBatchView, FleetNode, Rollout, Sandbox } from '@/lib/data/fleet';
import { refreshLive } from './live';
import { setFleetActor } from '@/lib/data/fleet-actions';
import { fleetActions } from './store';

// Every fleet action goes through here: the shared confirmation (naming the API call, taking an audit reason)
// for anything that moves work, the action, then a toast saying what happened with Undo where one exists. Pages,
// the node drawer and ⌘K page commands call the same functions, so they behave the same everywhere. While the
// workspace clock is scrubbed into the past, nothing acts: the operator is told to go back to live first.

const names = (nodes: readonly FleetNode[]) => (nodes.length === 1 ? nodes[0]!.hostname : `${nodes.length} nodes`);
const LABEL = /^([A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?)(?:=(.{0,63})|-)$/;

export function useFleetCommands() {
  const { live, source } = useWorkspaceSettings();
  const clock = useClockGetter();
  const connection = useConnection().status;
  const tenantId = connection?.tenantId;
  // The live proxy forwards mutations only with a signed-in operator's own credential (status.writable).
  const writable = connection?.writable === true;
  const operator = connection?.operator ?? null;
  const router = useRouter();
  // Audit entries and simulated approvals name the signed-in operator.
  useEffect(() => setFleetActor(operator?.email ?? operator?.name), [operator?.email, operator?.name]);
  const { toast, confirm, confirmWithReason } = useFeedback();

  return useMemo(() => {
    const ids = (nodes: readonly FleetNode[]) => nodes.map((node) => node.id);
    /** False (and a toast) while viewing the past. */
    const canAct = () => {
      if (live) return true;
      toast({ title: "You're viewing the past", detail: 'Return the clock to live before changing the fleet.', status: 'warn' });
      return false;
    };
    /** Live and read-only: refuse before asking anything (the proxy would answer 403 READ_ONLY). */
    const canWrite = () => {
      if (!remote || writable) return true;
      toast({ title: 'Sign in to make changes', detail: 'Signed out, the live connection only reads.', status: 'warn', action: { label: 'Sign in', onAction: () => router.push('/signin') } });
      return false;
    };
    const at = () => clock().now;
    const remote = source === 'live';
    /** Live mode: run each call against the API, report how many succeeded, then refresh the fleet. */
    const send = async (label: string, calls: [path: string, input: Record<string, unknown>][]): Promise<boolean> => {
      if (!tenantId) return toastFalse({ title: 'No tenant', detail: 'The connection has no tenant; check Settings → Connection.', status: 'crit' });
      const results = await Promise.allSettled(calls.map(([path, input]) => client.$request(path, { tenantId, ...input })));
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const first = failed[0]?.reason as { code?: string; message?: string } | undefined;
      if (first?.code === 'READ_ONLY') {
        toast({ title: 'Sign in to make changes', detail: 'Signed out, the live connection only reads.', status: 'warn', action: { label: 'Sign in', onAction: () => router.push('/signin') } });
        return false;
      }
      toast(
        failed.length
          ? { title: `${label}: ${failed.length} of ${calls.length} failed`, detail: first ? `${first.code ?? 'ERROR'}: ${first.message ?? ''}` : undefined, status: 'crit', timeout: 0 }
          : { title: `${label}: done`, detail: calls.length > 1 ? `${calls.length} calls to ${calls[0]![0]}` : calls[0]![0], status: 'ok' },
      );
      void refreshLive();
      return failed.length === 0;
    };
    const toastFalse = (input: Parameters<typeof toast>[0]) => {
      toast(input);
      return false;
    };

    const api = {
      live,
      /** False in live mode until operators sign in; actions refuse with a toast. */
      canWrite: !remote || writable,
      async cordon(nodes: readonly FleetNode[], options: { confirm?: boolean } = {}) {
        if (!canAct() || !canWrite()) return false;
        let reason: string | null = '';
        if (options.confirm !== false) {
          reason = await confirmWithReason({
            title: `Cordon ${names(nodes)}?`,
            body: 'New reservations, instances and sandboxes stop landing here. Running work keeps running.',
            method: nodes.length === 1 ? `nodes.cordon { nodeId: "${nodes[0]!.id}", version: ${nodes[0]!.version} }` : `nodes.cordon × ${nodes.length}`,
            confirmLabel: 'Cordon',
            reason: { placeholder: 'e.g. RMA ticket 4411' },
          });
          if (reason === null) return false;
        }
        if (remote) return send(`Cordon ${names(nodes)}`, nodes.map((node) => ['nodes/cordon', { nodeId: node.id, version: node.version, ...(reason ? { reason } : {}) }]));
        fleetActions.cordon(ids(nodes), at(), reason || undefined);
        toast({
          title: `Cordoned ${names(nodes)}`,
          detail: 'New work stops landing there; running work is untouched.',
          status: 'ok',
          action: { label: 'Undo', onAction: () => fleetActions.uncordon(ids(nodes), at()) },
        });
        return true;
      },
      uncordon(nodes: readonly FleetNode[]) {
        if (!canAct() || !canWrite()) return false;
        if (remote) return send(`Uncordon ${names(nodes)}`, nodes.map((node) => ['nodes/uncordon', { nodeId: node.id }]));
        fleetActions.uncordon(ids(nodes), at());
        toast({
          title: `Uncordoned ${names(nodes)}`,
          detail: 'Schedulable again once nothing else holds it back.',
          status: 'live',
          action: { label: 'Undo', onAction: () => fleetActions.cordon(ids(nodes), at()) },
        });
        return true;
      },
      async drain(nodes: readonly FleetNode[]) {
        if (!canAct() || !canWrite()) return false;
        const booked = nodes.reduce((sum, node) => sum + node.gpus.filter((gpu) => gpu.allocation).length, 0);
        const workloads = nodes.reduce((sum, node) => sum + node.instanceCount + node.sandboxCount, 0);
        const big = nodes.length > 8;
        const reason = await confirmWithReason({
          title: `Drain ${names(nodes)}?`,
          body: `Cordons and moves work off: ${booked} booked GPUs and ${workloads} instances or sandboxes are rescheduled or released under their policies.`,
          method: nodes.length === 1 ? `nodes.drain { nodeId: "${nodes[0]!.id}" }` : `nodes.drain × ${nodes.length}`,
          confirmLabel: 'Drain',
          danger: big,
          reason: { placeholder: 'e.g. XID 79 on GPU 3', required: big },
          ...(big ? { typeToConfirm: `drain ${nodes.length}` } : {}),
        });
        if (reason === null) return false;
        if (remote) return send(`Drain ${names(nodes)}`, nodes.map((node) => ['nodes/drain', { nodeId: node.id, ...(reason ? { reason } : {}) }]));
        fleetActions.drain(ids(nodes), at(), reason || undefined);
        toast({
          title: `Draining ${names(nodes)}`,
          detail: 'Work moves off over the next minute or two; the node stays cordoned afterwards.',
          status: 'warn',
          action: { label: 'Stop and uncordon', onAction: () => fleetActions.uncordon(ids(nodes), at()) },
        });
        return true;
      },
      maintenance(nodes: readonly FleetNode[], on: boolean) {
        if (!canAct() || !canWrite()) return false;
        if (remote) return toastFalse({ title: 'Not in live mode', detail: on ? 'Put metal nodes into maintenance with metal.manage (CLI: better-compute metal manage).' : 'Return nodes with metal.provide.', status: 'warn' });
        fleetActions.maintenance(ids(nodes), on, at());
        toast({
          title: `${on ? 'Maintenance on' : 'Maintenance off'}: ${names(nodes)}`,
          status: on ? 'off' : 'live',
          action: { label: 'Undo', onAction: () => fleetActions.maintenance(ids(nodes), !on, at()) },
        });
        return true;
      },
      async revokeIdentity(node: FleetNode) {
        if (!canAct() || !canWrite()) return false;
        const reason = await confirmWithReason({
          title: `Revoke ${node.hostname}'s identity?`,
          body: 'Every certificate of the current identity generation is revoked and the gateway drops the session. The machine must rejoin with a new join token. This cannot be undone.',
          method: `nodes.revokeIdentity { nodeId: "${node.id}" }`,
          confirmLabel: 'Revoke identity',
          danger: true,
          reason: { required: true, placeholder: 'why (security audit log)' },
          typeToConfirm: node.hostname,
        });
        if (reason === null) return false;
        if (remote) return send(`Revoke ${node.hostname}'s identity`, [['nodes/revokeIdentity', { nodeId: node.id, ...(reason ? { reason } : {}) }]]);
        fleetActions.revokeIdentity(node.id, at());
        toast({ title: `Identity revoked: ${node.hostname}`, detail: `Identity generation ${node.identityGeneration + 1}; certificates below it are refused.`, status: 'crit' });
        return true;
      },
      label(nodes: readonly FleetNode[], set: Record<string, string>, remove: readonly string[] = []) {
        if (!canAct() || !canWrite()) return false;
        if (remote) return send(`Label ${names(nodes)}`, nodes.map((node) => ['nodes/label', { nodeId: node.id, set, remove: [...remove] }]));
        fleetActions.label(ids(nodes), set, remove, at());
        const text = [...Object.entries(set).map(([k, v]) => `${k}=${v}`), ...remove.map((k) => `−${k}`)].join(', ');
        toast({ title: `Labels on ${names(nodes)}`, detail: text, status: 'ok' });
        return true;
      },
      /** Asks for `key=value` (or `key-` to remove) and labels every node. */
      async labelPrompt(nodes: readonly FleetNode[]) {
        if (!canAct() || !canWrite()) return false;
        const value = await confirmWithReason({
          title: `Label ${names(nodes)}`,
          body: 'Operator labels; placement matches them through nodeLabels. Write key=value, or key- to remove one. bc.dev/ labels are system-only.',
          method: nodes.length === 1 ? `nodes.label { nodeId: "${nodes[0]!.id}" }` : `nodes.label × ${nodes.length}`,
          confirmLabel: 'Apply',
          reason: { placeholder: 'team=training', required: true },
        });
        if (!value) return false;
        const match = LABEL.exec(value);
        if (!match || match[1]!.startsWith('bc.dev/')) {
          return toastFalse({ title: 'Not a label', detail: match ? 'bc.dev/ labels are written by the system only.' : 'Write key=value or key-.', status: 'crit' });
        }
        return match[2] === undefined ? api.label(nodes, {}, [match[1]!]) : api.label(nodes, { [match[1]!]: match[2] });
      },
      taint(nodes: readonly FleetNode[], add: readonly string[], remove: readonly string[] = []) {
        if (!canAct() || !canWrite()) return false;
        if (remote) return send(`Taint ${names(nodes)}`, nodes.map((node) => ['nodes/taint', { nodeId: node.id, add: [...add], remove: [...remove] }]));
        fleetActions.taint(ids(nodes), add, remove, at());
        toast({
          title: `Taints on ${names(nodes)}`,
          detail: [...add.map((k) => `+${k}`), ...remove.map((k) => `−${k}`)].join(', '),
          status: add.length ? 'off' : 'ok',
          action: { label: 'Undo', onAction: () => fleetActions.taint(ids(nodes), remove, add, at()) },
        });
        return true;
      },
      acknowledge(node: FleetNode, conditionType: string) {
        if (!canAct()) return false;
        fleetActions.acknowledge(node.id, conditionType, at());
        toast({ title: `Acknowledged ${conditionType}`, detail: `${node.hostname} leaves the attention list until it changes.`, status: 'ok' });
        return true;
      },
      async rollout(rollout: Rollout, next: 'paused' | 'running' | 'aborted') {
        if (!canAct() || !canWrite()) return false;
        if (next === 'aborted') {
          const reason = await confirmWithReason({
            title: `Abort the bcd ${rollout.version} rollout?`,
            body: 'Nodes mid-upgrade finish or time out; no new node starts. Upgraded nodes stay on the new version unless you roll back.',
            method: `rollouts.abort { rolloutId: "${rollout.id}" }`,
            confirmLabel: 'Abort rollout',
            danger: true,
            reason: { required: true },
          });
          if (reason === null) return false;
          if (remote) return send(`Abort rollout ${rollout.version}`, [['rollouts/abort', { rolloutId: rollout.id, reason }]]);
          fleetActions.rollout(rollout.id, 'aborted', at(), reason);
          toast({ title: `Rollout ${rollout.version} aborted`, detail: reason, status: 'crit' });
          return true;
        }
        if (remote) return send(`${next === 'paused' ? 'Pause' : 'Resume'} rollout ${rollout.version}`, [[next === 'paused' ? 'rollouts/pause' : 'rollouts/resume', { rolloutId: rollout.id }]]);
        fleetActions.rollout(rollout.id, next, at());
        toast({
          title: `Rollout ${rollout.version} ${next === 'paused' ? 'paused' : 'resumed'}`,
          detail: next === 'paused' ? 'Nodes mid-upgrade finish; the wave stops there.' : `Wave ${rollout.wave + 1} of ${rollout.waves.length} continues.`,
          status: next === 'paused' ? 'off' : 'live',
          action: { label: 'Undo', onAction: () => fleetActions.rollout(rollout.id, next === 'paused' ? 'running' : 'paused', at()) },
        });
        return true;
      },
      async approveBatch(batch: CommandBatchView) {
        if (!canAct() || !canWrite()) return false;
        if (remote)
          return toastFalse({
            title: 'Sign with your approver key',
            detail: `Approvals are signatures over the scope root; run: better-compute batch approve ${batch.batchId}`,
            status: 'warn',
            timeout: 0,
          });
        const ok = await confirm({
          title: 'Sign and approve this batch?',
          body: (
            <>
              <span className="mb-1 block text-text-primary">{batch.reason}</span>
              Your approver key signs the scope root. The {batch.scopeSize} commands run once {batch.requiredApprovals} approvers have signed.
            </>
          ),
          method: `commandBatches.approve { batchId: "${batch.batchId}" }`,
          confirmLabel: 'Sign and approve',
        });
        if (!ok) return false;
        fleetActions.approveBatch(batch, at());
        const count = batch.approvals.length + 1;
        toast({
          title: count >= batch.requiredApprovals ? 'Batch approved: commands are running' : `Approval recorded (${count}/${batch.requiredApprovals})`,
          detail: batch.reason,
          status: count >= batch.requiredApprovals ? 'live' : 'ok',
        });
        return true;
      },
      async cancelBatch(batch: CommandBatchView) {
        if (!canAct() || !canWrite()) return false;
        const ok = await confirm({
          title: 'Cancel this batch?',
          body: `${batch.scopeSize} queued commands are cancelled and the approvals discarded.`,
          method: `commandBatches.cancel { batchId: "${batch.batchId}" }`,
          confirmLabel: 'Cancel batch',
          danger: true,
        });
        if (!ok) return false;
        if (remote) return send('Cancel batch', [['commandBatches/cancel', { batchId: batch.batchId }]]);
        fleetActions.cancelBatch(batch, at());
        toast({ title: 'Batch cancelled', detail: batch.reason, status: 'off' });
        return true;
      },
      async confirmMac(mac: string, node: FleetNode | undefined, nodeId: string) {
        if (!canAct() || !canWrite()) return false;
        const ok = await confirm({
          title: `Confirm ${mac} for ${node?.hostname ?? nodeId}?`,
          body: 'The machine is enrolled with this MAC and PXE boots from it. Confirm only when the BMC inventory or a site visit matches.',
          method: `metal.confirmMac { nodeId: "${nodeId}", mac: "${mac}" }`,
          confirmLabel: 'Confirm MAC',
        });
        if (!ok) return false;
        if (remote) return send(`Confirm ${mac}`, [['metal/confirmMac', { nodeId, mac }]]);
        fleetActions.confirmMac(mac, nodeId, at());
        toast({ title: `MAC confirmed for ${node?.hostname ?? nodeId}`, detail: 'Inspection starts on the next PXE boot.', status: 'live' });
        return true;
      },
      ignoreMac(mac: string) {
        if (!canAct()) return false;
        fleetActions.ignoreMac(mac, at());
        toast({ title: `Ignoring ${mac}`, status: 'off' });
        return true;
      },
      async deleteSandboxes(sandboxes: readonly Sandbox[]) {
        if (!canAct() || !canWrite()) return false;
        const ok = await confirm({
          title: sandboxes.length === 1 ? `Delete sandbox ${sandboxes[0]!.id}?` : `Delete ${sandboxes.length} sandboxes?`,
          body: 'Their instances are destroyed now; snapshots marked keep survive.',
          method: sandboxes.length === 1 ? `sandboxes.delete { sandboxId: "${sandboxes[0]!.id}" }` : `sandboxes.delete × ${sandboxes.length}`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return false;
        if (remote) return send(`Delete ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`}`, sandboxes.map((sandbox) => ['sandboxes/delete', { sandboxId: sandbox.id }]));
        fleetActions.deleteSandboxes(sandboxes.map((sandbox) => sandbox.id), at());
        toast({ title: `Deleted ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`}`, status: 'off' });
        return true;
      },
      extendSandboxes(sandboxes: readonly Sandbox[], seconds: number) {
        if (!canAct() || !canWrite()) return false;
        if (remote) return send(`Extend ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`}`, sandboxes.map((sandbox) => ['sandboxes/extend', { sandboxId: sandbox.id, by: seconds * 1000 }]));
        fleetActions.extendSandboxes(sandboxes.map((sandbox) => sandbox.id), seconds, at());
        toast({ title: `Extended ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`} by ${Math.round(seconds / 60)} min`, status: 'live' });
        return true;
      },
    };
    return api;
  }, [clock, live, source, tenantId, writable, router, toast, confirm, confirmWithReason]);
}
