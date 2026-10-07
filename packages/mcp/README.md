# @better-compute/mcp

Model Context Protocol tools that let AI agents find GPU capacity, reserve and release GPUs, manage instances and sandboxes, and check nodes, always acting as their caller.

## Install

```sh
npm install @better-compute/mcp
```

It is also included in the umbrella package as `better-compute/mcp`:

```sh
npm install better-compute
```

Better IAM (`npm install better-iam`) provides the optional `@better-iam/mcp` peer (^0.2.0), whose gate decides who may call which tool. The package itself depends only on `@better-compute/client`.

## Usage

```ts
import { createMcpGate } from '@better-iam/mcp';
import { createComputeMcp, gateTools } from '@better-compute/mcp';

// Each request gets a client that forwards the caller's own Authorization header to compute.
const mcp = createComputeMcp({ baseURL: 'https://compute.example.com' });
const gate = createMcpGate({ iam, tenantId, tools: gateTools(), unlisted: 'deny' });

export default {
  fetch: (request: Request) => gate(request, (forwarded, caller) => mcp.handler(forwarded, caller)),
};
```

Every tool calls the compute API **as the caller**, so compute and Better IAM make the real decision; a tool never grants more than its caller has. The MCP endpoint is a small stateless Streamable HTTP JSON-RPC handler (`initialize`, `ping`, `tools/list`, `tools/call`, notifications), so no MCP SDK is needed.

A host that runs the control plane in the same process can use `computeMcpEndpoint({ compute, gate, delegations? })` instead: tool calls then go through `compute.handler` in process, still with the caller's own `Authorization` header, and nothing is reachable without the gate.

## Tools

| Tool | Route | Gate rule |
| --- | --- | --- |
| `list_pools` | `pools.list` | any authenticated caller |
| `capacity_summary` | `capacity.summary` / `capacity.byPool` | any authenticated caller |
| `preview_reservation` | `capacity.preview` | `compute:pools:read` on the pool |
| `reserve_gpus` | `reservations.create` | `compute:pools:read` on the pool |
| `release_reservation` | `reservations.release` | any authenticated caller |
| `list_reservations` | `reservations.list` (own by default, `scope: 'all'`) | any authenticated caller |
| `get_reservation` | `reservations.get` | any authenticated caller |
| `extend_reservation` | `reservations.extend` (confirmation-aware, same key on retry) | any authenticated caller |
| `node_status` | `nodes.get` | `compute:nodes:read` on the node |
| `run_diagnostic` | `commands.run` (`diag.nvml`) | `compute:nodes:read` on the node |
| `create_instance` | `instances.create` | `compute:pools:read` on the pool |
| `list_instances` | `instances.list` (own by default, `scope: 'all'`) | any authenticated caller |
| `get_instance`, `start_instance`, `stop_instance`, `delete_instance` | `instances.get/start/stop/delete` | any authenticated caller |
| `list_sandbox_templates` | `sandboxTemplates.list` (without user data or env) | any authenticated caller |
| `create_sandbox` | `sandboxes.create` | `compute:sandboxes:read` on the template |
| `list_sandboxes`, `get_sandbox`, `extend_sandbox`, `delete_sandbox` | `sandboxes.list/get/extend/delete` | any authenticated caller |
| `list_sandbox_snapshots`, `delete_sandbox_snapshot` | `sandboxSnapshots.list/delete` | any authenticated caller |
| `list_sandbox_volumes`, `resize_sandbox_volume`, `delete_sandbox_volume` | `sandboxVolumes.list/resize/delete` | any authenticated caller |
| `create_sandbox_volume` | `sandboxVolumes.create` | `compute:pools:read` on the pool |
| `list_command_batches`, `get_command_batch` | `commandBatches.list/get` (read-only) | any authenticated caller |
| `exec_command` (only with `execCommand: true`) | `commands.run` (allowlisted kinds) | `compute:nodes:read` on the node |
| `propose_command_batch` (only with `execCommand: true`) | `commandBatches.create` | any authenticated caller |
| `fleet_export`, `fleet_plan` (only with `fleet: true`) | `fleet.export`, `fleet.plan` (read-only) | `compute:fleet:admin` on the fleet |

- **Fleet tools plan but never apply.** `fleet_plan` returns the changes and a `planHash`, but not the call list. A person applies the reviewed plan with `better-compute fleet apply FILE --plan-hash HASH`. Pass the same `fleet: true` to `gateTools()`.
- **Command batches need people.** `propose_command_batch` only proposes a batch of node reboots; nothing runs until operators approve it with their approver keys (`better-compute batch approve`). There is no approve tool. Pass the same `execCommand: true` to `gateTools()`.
- **The gate checks visibility only.** Actions that must be confirmed are never gate actions, so nobody is asked twice about different resources.
- **Arguments** are checked against each tool's JSON Schema before anything is called.
- **Compute errors** come back as tool errors (`CODE: message`); unexpected failures are reported generically, with no internals.
- **Concurrency.** One caller may have at most `maxConcurrentCallsPerCaller` (default 4) tool calls in flight; more answer `RATE_LIMITED`. The count lives in process memory by default; pass a shared `callLimiter` when several MCP instances serve the same callers.
- **Confirmations.** When compute answers `CONFIRMATION_REQUIRED` (a delegated agent whose person confirms this action), `reserve_gpus`, `extend_reservation`, `create_instance`, `create_sandbox` and `create_sandbox_volume` return `{ status: 'confirmation-required', confirmationId, idempotencyKey }`. The model retries with the same `idempotencyKey` after the approval. With `confirmations: { status(id) }`, the tool instead polls and retries once itself. `confirmations: iamConfirmations(iam.api.delegations)` polls Better IAM's `getConfirmation` per request with the caller's own bearer token and tenant (`rejected` → `confirmation-denied`, a lapsed pending request → `confirmation-expired`).
- **Remote IAM.** When Better IAM runs elsewhere, give the gate `iam: remoteMcpIam(createIamClient<BetterIam>({ baseURL }))`: it authenticates with `sts.getCallerIdentity` and decides with `authorize`/`authorizeMany`, each as the caller (only identity headers are forwarded), and asks for confirmations through the caller's delegation.
- **Tenant.** Tools act in `tenantId` (fixed or per caller); by default, the gate caller's tenant.

## Documentation

- [MCP](https://better-compute.com/docs/guides/clients/mcp)
- [Delegated confirmation](https://better-compute.com/docs/guides/iam/delegated-confirmation)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
