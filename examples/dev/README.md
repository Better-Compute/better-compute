# Development: `better-compute dev --sim 8`

A control plane with every module on PGlite, and eight simulated HGX H100 machines that join it the way `bcd` does. Each machine gets a join token sealed to the control plane's JoinService key. It calls the Join RPC through a gateway, opens a Session stream, passes `diag.nvml` acceptance, and is adopted by the real runtime. Nothing is mocked above the daemon.

```sh
cd examples/dev
better-compute dev --memory --sim 8
```

`--memory` uses a throwaway database; leave it out to keep data in `.better-compute/example-db`. `--sim-variant l40s` gives 4×L40S machines, and `hgx-h100-gpu-missing` gives machines that fail acceptance and are never adopted. Standard error shows:

```
better-compute listening on http://127.0.0.1:3000/api/compute
Dev gateway (h2c, header auth, loopback only): http://127.0.0.1:52011
Embedded IAM root tenant ten_…; root token (dev only): biam_ses_…
Joined 8 simulated hgx-h100 node(s) into pool_…
8 simulated node(s) adopted
```

The embedded better-iam lives in memory for this run only. Its root token is a development credential.

## Look around

In a second terminal, as the root administrator:

```sh
export BETTER_COMPUTE_URL=http://127.0.0.1:3000
export BETTER_COMPUTE_TOKEN=biam_ses_…   # the root token dev printed
export TENANT=ten_…                      # the root tenant dev printed
better-compute api nodes.list tenantId=$TENANT --query "items[].{id: id, state: provisionState, gpus: gpuCount}"
better-compute api pools.list tenantId=$TENANT
```

## Reserve GPUs

Offer the pool to your own tenant with a quota, then reserve:

```sh
better-compute api pools.list tenantId=$TENANT --query "items[].id" --format table
export POOL=pool_…                        # the pool dev created
better-compute api pools.offer tenantId=$TENANT poolId=$POOL toTenantId=$TENANT quota:='{"gpu": 64}'
better-compute reserve --tenant $TENANT --pool $POOL --gpus 4 --for 1h
better-compute capacity --tenant $TENANT --pool $POOL
```

The reservation is placed on one machine. It binds through the node's desired state, and becomes `active` once the simulated daemon reports `AllocationBound`: its CDI devices are in the reservation's `binding`.

## Watch events

Server-sent events of your tenant, from the transactional outbox:

```sh
curl -N -H "Authorization: Bearer $BETTER_COMPUTE_TOKEN" "http://127.0.0.1:3000/watch?types=node.*,reservation.*"
```

Cordon a node in another terminal (`better-compute api nodes.cordon tenantId=$TENANT nodeId=node_… reason=demo`) and watch `node.cordoned` arrive.

## Tunnels

`tunnels.open` (exec and console sessions into nodes) arrives with the v0.3 tunnels wiring. Once the configuration sets `tunnels: { issuer }`, `better-compute serve` mounts the relay. This example will gain an `exec` walkthrough then.
