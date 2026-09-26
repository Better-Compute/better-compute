'use client';

import { useMemo } from 'react';
import { useWorkspace } from '@/components/shell/workspace';
import { useFeedback } from '@/components/ui/feedback';
import type { CommandBatchView, FleetNode, Rollout, Sandbox } from '@/lib/data/fleet';
import { fleetActions } from './store';

// Every fleet action goes through here: the shared confirmation (naming the API call, taking an audit reason)
// for anything that moves work, the action, then a toast saying what happened with Undo where one exists. Pages,
// the node drawer and ⌘K page commands call the same functions, so they behave the same everywhere. While the
// workspace clock is scrubbed into the past, nothing acts: the operator is told to go back to live first.

const names = (nodes: readonly FleetNode[]) => (nodes.length === 1 ? nodes[0]!.hostname : `${nodes.length} nodes`);
const LABEL = /^([A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?)(?:=(.{0,63})|-)$/;

export function useFleetCommands() {
  const { now, live } = useWorkspace();
  const { toast, confirm, confirmWithReason } = useFeedback();

  return useMemo(() => {
    const ids = (nodes: readonly FleetNode[]) => nodes.map((node) => node.id);
    /** False (and a toast) while viewing the past. */
    const canAct = () => {
      if (live) return true;
      toast({ title: "You're viewing the past", detail: 'Return the clock to live before changing the fleet.', status: 'warn' });
      return false;
    };
    const at = () => now;

    const api = {
      live,
      async cordon(nodes: readonly FleetNode[], options: { confirm?: boolean } = {}) {
        if (!canAct()) return;
        let reason: string | null = '';
        if (options.confirm !== false) {
          reason = await confirmWithReason({
            title: `Cordon ${names(nodes)}?`,
            body: 'New reservations, instances and sandboxes stop landing here. Running work keeps running.',
            method: nodes.length === 1 ? `nodes.cordon { nodeId: "${nodes[0]!.id}", version: ${nodes[0]!.version} }` : `nodes.cordon × ${nodes.length}`,
            confirmLabel: 'Cordon',
            reason: { placeholder: 'e.g. RMA ticket 4411' },
          });
          if (reason === null) return;
        }
        fleetActions.cordon(ids(nodes), at(), reason || undefined);
        toast({
          title: `Cordoned ${names(nodes)}`,
          detail: 'New work stops landing there; running work is untouched.',
          status: 'ok',
          action: { label: 'Undo', onAction: () => fleetActions.uncordon(ids(nodes), at()) },
        });
      },
      uncordon(nodes: readonly FleetNode[]) {
        if (!canAct()) return;
        fleetActions.uncordon(ids(nodes), at());
        toast({
          title: `Uncordoned ${names(nodes)}`,
          detail: 'Schedulable again once nothing else holds it back.',
          status: 'live',
          action: { label: 'Undo', onAction: () => fleetActions.cordon(ids(nodes), at()) },
        });
      },
      async drain(nodes: readonly FleetNode[]) {
        if (!canAct()) return;
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
        if (reason === null) return;
        fleetActions.drain(ids(nodes), at(), reason || undefined);
        toast({
          title: `Draining ${names(nodes)}`,
          detail: 'Work moves off over the next minute or two; the node stays cordoned afterwards.',
          status: 'warn',
          action: { label: 'Stop and uncordon', onAction: () => fleetActions.uncordon(ids(nodes), at()) },
        });
      },
      maintenance(nodes: readonly FleetNode[], on: boolean) {
        if (!canAct()) return;
        fleetActions.maintenance(ids(nodes), on, at());
        toast({
          title: `${on ? 'Maintenance on' : 'Maintenance off'}: ${names(nodes)}`,
          status: on ? 'off' : 'live',
          action: { label: 'Undo', onAction: () => fleetActions.maintenance(ids(nodes), !on, at()) },
        });
      },
      async revokeIdentity(node: FleetNode) {
        if (!canAct()) return;
        const reason = await confirmWithReason({
          title: `Revoke ${node.hostname}'s identity?`,
          body: 'Every certificate of the current identity generation is revoked and the gateway drops the session. The machine must rejoin with a new join token. This cannot be undone.',
          method: `nodes.revokeIdentity { nodeId: "${node.id}" }`,
          confirmLabel: 'Revoke identity',
          danger: true,
          reason: { required: true, placeholder: 'why (security audit log)' },
          typeToConfirm: node.hostname,
        });
        if (reason === null) return;
        fleetActions.revokeIdentity(node.id, at());
        toast({ title: `Identity revoked: ${node.hostname}`, detail: `Identity generation ${node.identityGeneration + 1}; certificates below it are refused.`, status: 'crit' });
      },
      label(nodes: readonly FleetNode[], set: Record<string, string>, remove: readonly string[] = []) {
        if (!canAct()) return;
        fleetActions.label(ids(nodes), set, remove, at());
        const text = [...Object.entries(set).map(([k, v]) => `${k}=${v}`), ...remove.map((k) => `−${k}`)].join(', ');
        toast({ title: `Labels on ${names(nodes)}`, detail: text, status: 'ok' });
      },
      /** Asks for `key=value` (or `key-` to remove) and labels every node. */
      async labelPrompt(nodes: readonly FleetNode[]) {
        if (!canAct()) return;
        const value = await confirmWithReason({
          title: `Label ${names(nodes)}`,
          body: 'Operator labels; placement matches them through nodeLabels. Write key=value, or key- to remove one. bc.dev/ labels are system-only.',
          method: nodes.length === 1 ? `nodes.label { nodeId: "${nodes[0]!.id}" }` : `nodes.label × ${nodes.length}`,
          confirmLabel: 'Apply',
          reason: { placeholder: 'team=training', required: true },
        });
        if (!value) return;
        const match = LABEL.exec(value);
        if (!match || match[1]!.startsWith('bc.dev/')) {
          toast({ title: 'Not a label', detail: match ? 'bc.dev/ labels are written by the system only.' : 'Write key=value or key-.', status: 'crit' });
          return;
        }
        if (match[2] === undefined) api.label(nodes, {}, [match[1]!]);
        else api.label(nodes, { [match[1]!]: match[2] });
      },
      taint(nodes: readonly FleetNode[], add: readonly string[], remove: readonly string[] = []) {
        if (!canAct()) return;
        fleetActions.taint(ids(nodes), add, remove, at());
        toast({
          title: `Taints on ${names(nodes)}`,
          detail: [...add.map((k) => `+${k}`), ...remove.map((k) => `−${k}`)].join(', '),
          status: add.length ? 'off' : 'ok',
          action: { label: 'Undo', onAction: () => fleetActions.taint(ids(nodes), remove, add, at()) },
        });
      },
      acknowledge(node: FleetNode, conditionType: string) {
        if (!canAct()) return;
        fleetActions.acknowledge(node.id, conditionType, at());
        toast({ title: `Acknowledged ${conditionType}`, detail: `${node.hostname} leaves the attention list until it changes.`, status: 'ok' });
      },
      async rollout(rollout: Rollout, next: 'paused' | 'running' | 'aborted') {
        if (!canAct()) return;
        if (next === 'aborted') {
          const reason = await confirmWithReason({
            title: `Abort the bcd ${rollout.version} rollout?`,
            body: 'Nodes mid-upgrade finish or time out; no new node starts. Upgraded nodes stay on the new version unless you roll back.',
            method: `rollouts.abort { rolloutId: "${rollout.id}" }`,
            confirmLabel: 'Abort rollout',
            danger: true,
            reason: { required: true },
          });
          if (reason === null) return;
          fleetActions.rollout(rollout.id, 'aborted', at(), reason);
          toast({ title: `Rollout ${rollout.version} aborted`, detail: reason, status: 'crit' });
          return;
        }
        fleetActions.rollout(rollout.id, next, at());
        toast({
          title: `Rollout ${rollout.version} ${next === 'paused' ? 'paused' : 'resumed'}`,
          detail: next === 'paused' ? 'Nodes mid-upgrade finish; the wave stops there.' : `Wave ${rollout.wave + 1} of ${rollout.waves.length} continues.`,
          status: next === 'paused' ? 'off' : 'live',
          action: { label: 'Undo', onAction: () => fleetActions.rollout(rollout.id, next === 'paused' ? 'running' : 'paused', at()) },
        });
      },
      async approveBatch(batch: CommandBatchView) {
        if (!canAct()) return;
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
        if (!ok) return;
        fleetActions.approveBatch(batch, at());
        const count = batch.approvals.length + 1;
        toast({
          title: count >= batch.requiredApprovals ? 'Batch approved: commands are running' : `Approval recorded (${count}/${batch.requiredApprovals})`,
          detail: batch.reason,
          status: count >= batch.requiredApprovals ? 'live' : 'ok',
        });
      },
      async cancelBatch(batch: CommandBatchView) {
        if (!canAct()) return;
        const ok = await confirm({
          title: 'Cancel this batch?',
          body: `${batch.scopeSize} queued commands are cancelled and the approvals discarded.`,
          method: `commandBatches.cancel { batchId: "${batch.batchId}" }`,
          confirmLabel: 'Cancel batch',
          danger: true,
        });
        if (!ok) return;
        fleetActions.cancelBatch(batch, at());
        toast({ title: 'Batch cancelled', detail: batch.reason, status: 'off' });
      },
      async confirmMac(mac: string, node: FleetNode | undefined, nodeId: string) {
        if (!canAct()) return;
        const ok = await confirm({
          title: `Confirm ${mac} for ${node?.hostname ?? nodeId}?`,
          body: 'The machine is enrolled with this MAC and PXE boots from it. Confirm only when the BMC inventory or a site visit matches.',
          method: `metal.confirmMac { nodeId: "${nodeId}", mac: "${mac}" }`,
          confirmLabel: 'Confirm MAC',
        });
        if (!ok) return;
        fleetActions.confirmMac(mac, nodeId, at());
        toast({ title: `MAC confirmed for ${node?.hostname ?? nodeId}`, detail: 'Inspection starts on the next PXE boot.', status: 'live' });
      },
      ignoreMac(mac: string) {
        if (!canAct()) return;
        fleetActions.ignoreMac(mac, at());
        toast({ title: `Ignoring ${mac}`, status: 'off' });
      },
      async deleteSandboxes(sandboxes: readonly Sandbox[]) {
        if (!canAct()) return;
        const ok = await confirm({
          title: sandboxes.length === 1 ? `Delete sandbox ${sandboxes[0]!.id}?` : `Delete ${sandboxes.length} sandboxes?`,
          body: 'Their instances are destroyed now; snapshots marked keep survive.',
          method: sandboxes.length === 1 ? `sandboxes.delete { sandboxId: "${sandboxes[0]!.id}" }` : `sandboxes.delete × ${sandboxes.length}`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        fleetActions.deleteSandboxes(sandboxes.map((sandbox) => sandbox.id), at());
        toast({ title: `Deleted ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`}`, status: 'off' });
      },
      extendSandboxes(sandboxes: readonly Sandbox[], seconds: number) {
        if (!canAct()) return;
        fleetActions.extendSandboxes(sandboxes.map((sandbox) => sandbox.id), seconds, at());
        toast({ title: `Extended ${sandboxes.length === 1 ? 'sandbox' : `${sandboxes.length} sandboxes`} by ${Math.round(seconds / 60)} min`, status: 'live' });
      },
    };
    return api;
  }, [now, live, toast, confirm, confirmWithReason]);
}
