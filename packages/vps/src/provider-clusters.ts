import {
  ComputeError,
  type CallContext,
  type ProviderImpl,
  type ProviderKubernetesCluster,
} from '@better-compute/core';

// `providerAccounts.clusters` (AWS A9): the managed Kubernetes clusters a provider account can see,
// whoever created them, with what a machine needs to join one through `policy.kubernetes` (for EKS,
// nodeadm's cluster: `k8s-join` mode `eks`). A read of the provider through the account's client, with
// no transaction open; nothing is stored. Only the declared plain fields are passed on, so whatever
// else a provider returns (a token, a kubeconfig) never reaches the caller.

/** How long one listing may take (the provider pages through `ListClusters`/`DescribeCluster`). */
const LIST_BUDGET_MS = 55_000;

/** The account's clusters, as the provider lists them. UNSUPPORTED when the provider cannot list them. */
export async function listProviderClusters(
  client: ProviderImpl,
  provider: string,
  call: Omit<CallContext, 'signal'> & { signal?: AbortSignal },
): Promise<{ items: ProviderKubernetesCluster[] }> {
  const kubernetes = client.kubernetes;
  if (!kubernetes || typeof kubernetes.listClusters !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider} does not list Kubernetes clusters`,
      undefined,
      { provider },
    );
  const timeout = AbortSignal.timeout(LIST_BUDGET_MS);
  const listed = await kubernetes.listClusters({
    ...call,
    signal: call.signal ? AbortSignal.any([call.signal, timeout]) : timeout,
  });
  return { items: listed.map(plainCluster) };
}

/** The declared fields of one cluster, nothing else. */
function plainCluster(cluster: ProviderKubernetesCluster): ProviderKubernetesCluster {
  const view: ProviderKubernetesCluster = {
    name: cluster.name,
    id: cluster.id,
    location: cluster.location,
    state: cluster.state,
    managed: cluster.managed === true,
  };
  if (cluster.version !== undefined) view.version = cluster.version;
  if (cluster.endpoint !== undefined) view.endpoint = cluster.endpoint;
  if (cluster.eks)
    view.eks = {
      name: cluster.eks.name,
      apiServerEndpoint: cluster.eks.apiServerEndpoint,
      certificateAuthority: cluster.eks.certificateAuthority,
      cidr: cluster.eks.cidr,
    };
  return view;
}
