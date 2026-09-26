package kube

import (
	"context"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
)

// InUse reports whether a pod still holds a device of an allocation bound to Kubernetes on this node:
// a device plugin id <atom>@<allocation>, or a gpu.bcd.dev device of this node's pool whose DRA name
// ends in the allocation's tag. The devices converger asks it before reporting a Kubernetes hold
// released (review round 5 #3), so compute re-books a GPU only once the pods let go of it.
//
// It fails closed: on a Kubernetes worker whose pod-resources socket is missing or failing it answers
// true (the caller bounds the wait). A node that is not a worker answers false.
func (m *Manager) InUse(ctx context.Context, allocationID string) bool {
	m.init()
	if !m.enabled() {
		return false
	}
	if _, err := os.Stat(m.PodResources); err != nil {
		return true
	}
	client := connect.NewClient[ListPodResourcesRequest, ListPodResourcesResponse](unixClient(m.PodResources),
		"http://localhost"+procListPodResources, connect.WithGRPC(), connect.WithCodec(codec{}))
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.CallUnary(lctx, connect.NewRequest(&ListPodResourcesRequest{}))
	if err != nil {
		return true
	}
	suffix := "@" + allocationID
	tag := draDeviceName("", allocationID) // "-<8 hex>"
	node := m.nodeName()
	for _, pod := range resp.Msg.Pods {
		for _, c := range pod.Containers {
			for _, d := range c.Devices {
				if !strings.HasPrefix(d.ResourceName, "bcd.dev/") {
					continue
				}
				for _, id := range d.DeviceIDs {
					if strings.HasSuffix(id, suffix) {
						return true
					}
				}
			}
			for _, d := range c.Claimed {
				if d.Driver == DRADriverName && d.Pool == node && strings.HasSuffix(d.Device, tag) {
					return true
				}
			}
		}
	}
	return false
}
