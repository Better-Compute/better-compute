package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// Clean runs when the spec no longer names k8s-join on a node bcd joined (the pool's policy dropped
// Kubernetes, or the machine left the pool): compute takes the machine back from the cluster. bcd
// cordons its Node, deletes the pods on it that are not the cluster's own node agents (DaemonSet and
// static pods stay, unless they ask for a bcd.dev device or a resource claim), each with at most
// releaseGrace to stop whatever its own grace period says, and records the release, which stops the
// device plugins or DRA driver. The Manager's reaper keeps running after it and forces what still
// holds a device (security review 2 #1). It does not reset the kubelet: the machine stays a
// (cordoned) member until an operator removes it, and the unit's return uncordons it. Everything
// goes through the kubelet's own credentials.
func (u JoinUnit) Clean(ctx context.Context, sys hostconfig.System) ([]converge.Action, error) {
	state, ok, err := ReadState(sys)
	if err != nil || !ok || state.Released {
		return nil, err
	}
	joined, _, err := kubeletServer(sys)
	if err != nil {
		return nil, err
	}
	released := state
	released.Released, released.GPU = true, false
	if !joined || state.NodeName == "" {
		return []converge.Action{writeState(sys, released)}, nil
	}
	name := state.NodeName
	return []converge.Action{
		{
			Description: "cordon Node " + name,
			Apply: func(ctx context.Context) error {
				_, err := sys.Run(ctx, kubectl("cordon", name))
				// Clusters whose admission forbids a node to change its own spec still get drained.
				if err != nil && !strings.Contains(strings.ToLower(err.Error()), "forbidden") {
					return err
				}
				return nil
			},
		},
		{
			Description: "delete the workload pods on Node " + name,
			Apply: func(ctx context.Context) error {
				pods, err := workloadPods(ctx, sys, name)
				if err != nil {
					return err
				}
				for _, p := range pods {
					if _, err := sys.Run(ctx, kubectl("delete", "pod", "--namespace", p[0], p[1], "--wait=false", "--ignore-not-found", releaseGraceArg)); err != nil {
						return fmt.Errorf("delete pod %s/%s: %w", p[0], p[1], err)
					}
				}
				return nil
			},
		},
		writeState(sys, released),
	}, nil
}

// releaseGraceArg caps a drained pod's grace period (its own may be a year).
const releaseGraceArg = "--grace-period=30"

// podResources is the part of a container spec that asks for devices.
type podResources struct {
	Resources struct {
		Limits   map[string]any `json:"limits"`
		Requests map[string]any `json:"requests"`
	} `json:"resources"`
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name            string            `json:"name"`
			Namespace       string            `json:"namespace"`
			Annotations     map[string]string `json:"annotations"`
			OwnerReferences []struct {
				Kind string `json:"kind"`
			} `json:"ownerReferences"`
		} `json:"metadata"`
		Spec struct {
			Containers     []podResources `json:"containers"`
			InitContainers []podResources `json:"initContainers"`
			ResourceClaims []any          `json:"resourceClaims"`
		} `json:"spec"`
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	} `json:"items"`
}

// workloadPods lists the Node's running pods a drain deletes, as [namespace, name]: not DaemonSet
// pods (they would come straight back) unless they ask for a bcd.dev device or a resource claim,
// not static (mirror) pods (the API cannot stop them: InUse's process backstop sees what they hold),
// not finished ones.
func workloadPods(ctx context.Context, sys hostconfig.System, node string) ([][2]string, error) {
	out, err := sys.Run(ctx, kubectl("get", "pods", "--all-namespaces", "--field-selector", "spec.nodeName="+node, "-o", "json"))
	if err != nil {
		return nil, fmt.Errorf("list the pods on Node %s: %w", node, err)
	}
	var list podList
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("pods on Node %s: %w", node, err)
	}
	var pods [][2]string
	for _, p := range list.Items {
		if p.Status.Phase == "Succeeded" || p.Status.Phase == "Failed" {
			continue
		}
		if _, mirror := p.Metadata.Annotations["kubernetes.io/config.mirror"]; mirror {
			continue
		}
		daemon := false
		for _, o := range p.Metadata.OwnerReferences {
			daemon = daemon || o.Kind == "DaemonSet"
		}
		devices := len(p.Spec.ResourceClaims) > 0
		for _, c := range append(p.Spec.Containers, p.Spec.InitContainers...) {
			for _, list := range []map[string]any{c.Resources.Limits, c.Resources.Requests} {
				for name := range list {
					devices = devices || strings.HasPrefix(name, "bcd.dev/")
				}
			}
		}
		if !daemon || devices {
			pods = append(pods, [2]string{p.Metadata.Namespace, p.Metadata.Name})
		}
	}
	sort.Slice(pods, func(i, j int) bool { return pods[i][0]+"/"+pods[i][1] < pods[j][0]+"/"+pods[j][1] })
	return pods, nil
}
