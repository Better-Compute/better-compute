# @better-compute/mcp

Model Context Protocol tools for better-compute (PLAN.md §9.3): AI agents can find GPU capacity,
reserve and release GPUs, check nodes and run diagnostics. Every tool calls the compute API **as the
caller**, so compute and better-iam make the real decision; a tool never grants more than its caller has.

**Status: v0.3.** It depends only on `@better-compute/client`. The MCP endpoint is a small stateless
Streamable HTTP JSON-RPC handler (`initialize`, `ping`, `tools/list`, `tools/call`, notifications),
so no MCP SDK is needed. `@better-iam/mcp` is an optional peer, used for the gate.

```ts
import { createMcpGate } from '@better-iam/mcp';
import { createComputeMcp, gateTools } from 'better-compute/mcp';

// Each request gets a client that forwards the caller's own Authorization header to compute.
const mcp = createComputeMcp({ baseURL: 'https://compute.example.com' });
const gate = createMcpGate({ iam, tenantId, tools: gateTools(), unlisted: 'deny' });

export default {
  fetch: (request: Request) => gate(request, (forwarded, caller) => mcp.handler(forwarded, caller)),
};
```

## Tools

| Tool | Route | Gate rule |
| --- | --- | --- |
| `list_pools` | `pools.list` | any authenticated caller |
| `capacity_summary` | `capacity.summary` / `capacity.byPool` | any authenticated caller |
| `preview_reservation` | `capacity.preview` | `compute:pools:read` on the pool |
| `reserve_gpus` | `reservations.create` | `compute:pools:read` on the pool |
| `release_reservation` | `reservations.release` | any authenticated caller |
| `node_status` | `nodes.get` | `compute:nodes:read` on the node |
| `run_diagnostic` | `commands.run` (`diag.nvml`) | `compute:nodes:read` on the node |
| `create_instance` | `instances.create` | `compute:pools:read` on the pool |
| `exec_command` (only with `execCommand: true`) | `commands.run` (allowlisted kinds) | `compute:nodes:read` on the node |
| `fleet_export`, `fleet_plan` (only with `fleet: true`) | `fleet.export`, `fleet.plan` (read-only) | `compute:fleet:admin` on the fleet |

- **Fleet tools plan but never apply.** `fleet_plan` returns the changes and a `planHash`, but not the call list. A person applies the reviewed plan with `better-compute fleet apply FILE --plan-hash HASH`. Pass the same `fleet: true` to `gateTools()`.

- **The gate checks visibility only.** Actions that must be confirmed are never gate actions, so
  nobody is asked twice about different resources.
- **Arguments** are checked against each tool's JSON Schema before anything is called.
- **Compute errors** come back as tool errors (`CODE: message`); unexpected failures are reported
  generically, with no internals.
- **Confirmations.** When compute answers `CONFIRMATION_REQUIRED` (a delegated agent whose person
  confirms this action), `reserve_gpus` and `create_instance` return
  `{ status: 'confirmation-required', confirmationId, idempotencyKey }`. The model retries with the
  same `idempotencyKey` after the approval. With `confirmations: { status(id) }`, the tool instead
  polls and retries once itself. `confirmations: iamConfirmations(iam.api.delegations)` polls
  better-iam's `getConfirmation` per request with the caller's own bearer token and tenant
  (`rejected` → `confirmation-denied`, a lapsed pending request → `confirmation-expired`).
- **Remote IAM (v0.4).** When better-iam runs elsewhere, give the gate
  `iam: remoteMcpIam(createIamClient<BetterIam>({ baseURL }))`: it authenticates with
  `sts.getCallerIdentity` and decides with `authorize`/`authorizeMany`, each as the caller (only
  identity headers are forwarded), and asks for confirmations through the caller's delegation.
- **Tenant.** Tools act in `tenantId` (fixed or per caller); by default, the gate caller's tenant.
