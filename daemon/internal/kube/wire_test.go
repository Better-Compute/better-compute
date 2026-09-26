package kube

import (
	"reflect"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// The upstream messages (k8s.io/kubelet deviceplugin/v1beta1 api.proto, podresources/v1 api.proto),
// transcribed field for field: the hand encoding must read and write what their generated code does.
const upstream = `
name: "kubelet.proto" package: "v1beta1" syntax: "proto3"
message_type {
  name: "DevicePluginOptions"
  field { name: "pre_start_required" number: 1 label: LABEL_OPTIONAL type: TYPE_BOOL json_name: "preStartRequired" }
  field { name: "get_preferred_allocation_available" number: 2 label: LABEL_OPTIONAL type: TYPE_BOOL json_name: "getPreferredAllocationAvailable" }
}
message_type {
  name: "RegisterRequest"
  field { name: "version" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "version" }
  field { name: "endpoint" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "endpoint" }
  field { name: "resource_name" number: 3 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "resourceName" }
  field { name: "options" number: 4 label: LABEL_OPTIONAL type: TYPE_MESSAGE type_name: ".v1beta1.DevicePluginOptions" json_name: "options" }
}
message_type { name: "NUMANode" field { name: "ID" number: 1 label: LABEL_OPTIONAL type: TYPE_INT64 json_name: "ID" } }
message_type { name: "TopologyInfo" field { name: "nodes" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.NUMANode" json_name: "nodes" } }
message_type {
  name: "Device"
  field { name: "ID" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "ID" }
  field { name: "health" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "health" }
  field { name: "topology" number: 3 label: LABEL_OPTIONAL type: TYPE_MESSAGE type_name: ".v1beta1.TopologyInfo" json_name: "topology" }
}
message_type { name: "ListAndWatchResponse" field { name: "devices" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.Device" json_name: "devices" } }
message_type {
  name: "ContainerAllocateRequest"
  field { name: "devices_ids" number: 1 label: LABEL_REPEATED type: TYPE_STRING json_name: "devicesIDs" }
}
message_type { name: "AllocateRequest" field { name: "container_requests" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerAllocateRequest" json_name: "containerRequests" } }
message_type { name: "CDIDevice" field { name: "name" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "name" } }
message_type {
  name: "ContainerAllocateResponse"
  field { name: "envs" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerAllocateResponse.EnvsEntry" json_name: "envs" }
  field { name: "annotations" number: 4 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerAllocateResponse.AnnotationsEntry" json_name: "annotations" }
  field { name: "cdi_devices" number: 5 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.CDIDevice" json_name: "cdiDevices" }
  nested_type {
    name: "EnvsEntry" options { map_entry: true }
    field { name: "key" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "key" }
    field { name: "value" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "value" }
  }
  nested_type {
    name: "AnnotationsEntry" options { map_entry: true }
    field { name: "key" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "key" }
    field { name: "value" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "value" }
  }
}
message_type { name: "AllocateResponse" field { name: "container_responses" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerAllocateResponse" json_name: "containerResponses" } }
message_type {
  name: "ContainerPreferredAllocationRequest"
  field { name: "available_deviceIDs" number: 1 label: LABEL_REPEATED type: TYPE_STRING json_name: "availableDeviceIDs" }
  field { name: "must_include_deviceIDs" number: 2 label: LABEL_REPEATED type: TYPE_STRING json_name: "mustIncludeDeviceIDs" }
  field { name: "allocation_size" number: 3 label: LABEL_OPTIONAL type: TYPE_INT32 json_name: "allocationSize" }
}
message_type { name: "PreferredAllocationRequest" field { name: "container_requests" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerPreferredAllocationRequest" json_name: "containerRequests" } }
message_type {
  name: "ContainerDevices"
  field { name: "resource_name" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "resourceName" }
  field { name: "device_ids" number: 2 label: LABEL_REPEATED type: TYPE_STRING json_name: "deviceIds" }
  field { name: "topology" number: 3 label: LABEL_OPTIONAL type: TYPE_MESSAGE type_name: ".v1beta1.TopologyInfo" json_name: "topology" }
}
message_type {
  name: "ContainerResources"
  field { name: "name" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "name" }
  field { name: "devices" number: 2 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerDevices" json_name: "devices" }
  field { name: "cpu_ids" number: 3 label: LABEL_REPEATED type: TYPE_INT64 json_name: "cpuIds" }
}
message_type {
  name: "PodResources"
  field { name: "name" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "name" }
  field { name: "namespace" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "namespace" }
  field { name: "containers" number: 3 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.ContainerResources" json_name: "containers" }
}
message_type { name: "ListPodResourcesResponse" field { name: "pod_resources" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".v1beta1.PodResources" json_name: "podResources" } }
`

func descriptors(t *testing.T) protoreflect.FileDescriptor {
	t.Helper()
	fdp := &descriptorpb.FileDescriptorProto{}
	if err := prototext.Unmarshal([]byte(upstream), fdp); err != nil {
		t.Fatal(err)
	}
	fd, err := protodesc.NewFile(fdp, nil)
	if err != nil {
		t.Fatal(err)
	}
	return fd
}

// fromJSON encodes a message with the upstream descriptor.
func fromJSON(t *testing.T, fd protoreflect.FileDescriptor, name, js string) []byte {
	t.Helper()
	m := dynamicpb.NewMessage(fd.Messages().ByName(protoreflect.Name(name)))
	if err := protojson.Unmarshal([]byte(js), m); err != nil {
		t.Fatal(err)
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// toJSON decodes our bytes with the upstream descriptor.
func toJSON(t *testing.T, fd protoreflect.FileDescriptor, name string, b []byte) string {
	t.Helper()
	m := dynamicpb.NewMessage(fd.Messages().ByName(protoreflect.Name(name)))
	if err := proto.Unmarshal(b, m); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	out, err := protojson.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func sameJSON(t *testing.T, fd protoreflect.FileDescriptor, name string, got []byte, want string) {
	t.Helper()
	a := dynamicpb.NewMessage(fd.Messages().ByName(protoreflect.Name(name)))
	if err := proto.Unmarshal(got, a); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	b := dynamicpb.NewMessage(a.Descriptor())
	if err := protojson.Unmarshal([]byte(want), b); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(a, b) {
		t.Fatalf("%s:\n got %s\nwant %s", name, toJSON(t, fd, name, got), want)
	}
}

func TestWireMatchesUpstream(t *testing.T) {
	fd := descriptors(t)

	// What bcd writes, as the kubelet reads it.
	sameJSON(t, fd, "RegisterRequest", (&RegisterRequest{Version: "v1beta1", Endpoint: "bcd-gpu.sock", ResourceName: ResourceGPU,
		Options: &DevicePluginOptions{GetPreferredAllocationAvailable: true}}).marshal(),
		`{"version":"v1beta1","endpoint":"bcd-gpu.sock","resourceName":"bcd.dev/gpu","options":{"getPreferredAllocationAvailable":true}}`)
	sameJSON(t, fd, "ListAndWatchResponse", (&ListAndWatchResponse{Devices: []*Device{
		{ID: "GPU-1", Health: Healthy, NUMA: []int64{0}},
		{ID: "GPU-2", Health: Unhealthy, NUMA: []int64{1}},
		{ID: "GPU-3", Health: Healthy},
	}}).marshal(),
		`{"devices":[{"ID":"GPU-1","health":"Healthy","topology":{"nodes":[{}]}},{"ID":"GPU-2","health":"Unhealthy","topology":{"nodes":[{"ID":"1"}]}},{"ID":"GPU-3","health":"Healthy"}]}`)
	sameJSON(t, fd, "AllocateResponse", (&AllocateResponse{ContainerResponses: []*ContainerAllocateResponse{{
		Envs:        map[string]string{"NVIDIA_VISIBLE_DEVICES": "GPU-1", "BCD_ALLOCATION_IDS": "a1"},
		Annotations: map[string]string{"bcd.dev/allocation-ids": "a1"},
		CDIDevices:  []string{"bcd.dev/gpu=GPU-1", "nvidia.com/gpu=GPU-1"},
	}}}).marshal(),
		`{"containerResponses":[{"envs":{"NVIDIA_VISIBLE_DEVICES":"GPU-1","BCD_ALLOCATION_IDS":"a1"},"annotations":{"bcd.dev/allocation-ids":"a1"},"cdiDevices":[{"name":"bcd.dev/gpu=GPU-1"},{"name":"nvidia.com/gpu=GPU-1"}]}]}`)
	sameJSON(t, fd, "DevicePluginOptions", (&DevicePluginOptions{GetPreferredAllocationAvailable: true}).marshal(), `{"getPreferredAllocationAvailable":true}`)

	// What the kubelet writes, as bcd reads it.
	var alloc AllocateRequest
	if err := alloc.unmarshal(fromJSON(t, fd, "AllocateRequest", `{"containerRequests":[{"devicesIDs":["GPU-1","GPU-2"]},{"devicesIDs":["GPU-3"]}]}`)); err != nil ||
		!reflect.DeepEqual(alloc.ContainerRequests, [][]string{{"GPU-1", "GPU-2"}, {"GPU-3"}}) {
		t.Fatalf("AllocateRequest = %+v, %v", alloc, err)
	}
	var pref PreferredAllocationRequest
	if err := pref.unmarshal(fromJSON(t, fd, "PreferredAllocationRequest",
		`{"containerRequests":[{"availableDeviceIDs":["a","b","c"],"mustIncludeDeviceIDs":["b"],"allocationSize":2}]}`)); err != nil ||
		!reflect.DeepEqual(*pref.ContainerRequests[0], ContainerPreferredAllocationRequest{AvailableDeviceIDs: []string{"a", "b", "c"}, MustIncludeDeviceIDs: []string{"b"}, AllocationSize: 2}) {
		t.Fatalf("PreferredAllocationRequest = %+v, %v", pref.ContainerRequests, err)
	}
	var pods ListPodResourcesResponse
	if err := pods.unmarshal(fromJSON(t, fd, "ListPodResourcesResponse",
		`{"podResources":[{"name":"train","namespace":"ml","containers":[{"name":"main","cpuIds":["3","4"],"devices":[{"resourceName":"bcd.dev/gpu","deviceIds":["GPU-1"],"topology":{"nodes":[{"ID":"1"}]}}]}]}]}`)); err != nil ||
		!reflect.DeepEqual(pods.Pods, []PodResources{{Name: "train", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-1"}}}}}}}) {
		t.Fatalf("ListPodResourcesResponse = %+v, %v", pods.Pods, err)
	}
	var devices ListAndWatchResponse
	if err := devices.unmarshal(fromJSON(t, fd, "ListAndWatchResponse", `{"devices":[{"ID":"x","health":"Healthy","topology":{"nodes":[{"ID":"2"},{}]}}]}`)); err != nil ||
		!reflect.DeepEqual(*devices.Devices[0], Device{ID: "x", Health: Healthy, NUMA: []int64{2, 0}}) {
		t.Fatalf("ListAndWatchResponse = %+v, %v", devices.Devices, err)
	}
}
