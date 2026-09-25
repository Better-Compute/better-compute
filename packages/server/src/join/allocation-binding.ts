import { create } from '@bufbuild/protobuf';
import type { AllocationBindingCheck } from '@better-compute/capacity';
import { nodeCertsLookup, verifyAttestedReport } from '@better-compute/pki';
import { AttestedReportSchema, SignatureSchema } from '@better-compute/protocol';

// Attested bindings (PLAN.md §13, P14; v0.2 exit "a gateway-forged AllocationBound is rejected"): the
// capacity worker verifies a stored AllocationBound before the reservation goes active. The node
// signed the report with its own key; the gateway only relays the bytes, so it cannot forge or
// swap a binding.

export interface PkiAllocationBindingCheckOptions {
  /** Epoch milliseconds (default `Date.now`); the deployment passes its clock. */
  now?: () => number;
  /** Certificate roles that may report allocations (default `node` and `node-tenant`). */
  roles?: readonly string[];
}

/**
 * Capacity's `attestedBindings` over pki: the node's signature (a current or, within the offline
 * grace, recently expired certificate of that node, never a revoked one), a role that runs
 * workloads, and a body reporting exactly this allocation bound. The signed CDI devices and env file
 * replace whatever the gateway said. Never throws for a bad report: it answers why.
 */
export function pkiAllocationBindingCheck(
  options: PkiAllocationBindingCheckOptions = {},
): AllocationBindingCheck {
  const now = options.now ?? Date.now;
  const roles = new Set(options.roles ?? ['node', 'node-tenant']);
  return async (tx, { allocationId, nodeId, evidence }) => {
    if (!evidence.kid || evidence.sig.length === 0) return { ok: false, reason: 'unsigned report' };
    let verified: Awaited<ReturnType<typeof verifyAttestedReport>>;
    try {
      verified = await verifyAttestedReport(
        create(AttestedReportSchema, {
          body: evidence.body,
          nodeSig: create(SignatureSchema, { kid: evidence.kid, sig: evidence.sig }),
        }),
        { nodeId, lookup: nodeCertsLookup(tx), now: now() },
      );
    } catch (error) {
      const reason = (error as { details?: { reason?: unknown } }).details?.reason;
      return { ok: false, reason: typeof reason === 'string' ? reason : 'bad signature' };
    }
    if (!roles.has(verified.role))
      return { ok: false, reason: `a ${verified.role} certificate cannot report allocations` };
    const report = verified.body.report;
    if (report.case !== 'allocationBound' || report.value.allocationId !== allocationId)
      return { ok: false, reason: 'the signed report is not this allocation bound' };
    return {
      ok: true,
      cdiDevices: [...report.value.cdiDevices],
      envFile: report.value.envFile,
    };
  };
}
