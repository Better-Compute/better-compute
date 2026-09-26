package kube

import (
	"context"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// inClusterSystem is a hosted Manager's System: bcd runs as the cluster's DaemonSet, which has no
// kubelet kubeconfig (/etc/kubernetes/kubelet.conf is the k8s-join record's). Its kubectl calls
// drop --kubeconfig, so kubectl takes the pod's service account (in-cluster config: the token and
// CA mounted at /var/run/secrets/kubernetes.io/serviceaccount, KUBERNETES_SERVICE_HOST). The
// DaemonSet's RBAC grants what they need: nodes get/patch, pods list/delete, resourceclaims get,
// resourceslices create/patch/delete.
type inClusterSystem struct {
	hostconfig.System
}

func (s inClusterSystem) Run(ctx context.Context, cmd hostconfig.Cmd) ([]byte, error) {
	if cmd.Name == "kubectl" && len(cmd.Args) >= 2 && cmd.Args[0] == "--kubeconfig" && cmd.Args[1] == KubeletConf {
		cmd.Args = cmd.Args[2:]
	}
	return s.System.Run(ctx, cmd)
}
