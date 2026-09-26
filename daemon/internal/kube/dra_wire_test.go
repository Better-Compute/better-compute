package kube

import (
	"reflect"
	"testing"

	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"
)

// dra/v1 and pluginregistration/v1, transcribed from k8s.io/kubelet.
const upstreamDRA = `
name: "dra.proto" package: "k8s.io.kubelet.pkg.apis.dra.v1" syntax: "proto3"
message_type {
  name: "PluginInfo"
  field { name: "type" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "type" }
  field { name: "name" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "name" }
  field { name: "endpoint" number: 3 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "endpoint" }
  field { name: "supported_versions" number: 4 label: LABEL_REPEATED type: TYPE_STRING json_name: "supportedVersions" }
}
message_type {
  name: "RegistrationStatus"
  field { name: "plugin_registered" number: 1 label: LABEL_OPTIONAL type: TYPE_BOOL json_name: "pluginRegistered" }
  field { name: "error" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "error" }
}
message_type {
  name: "Claim"
  field { name: "namespace" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "namespace" }
  field { name: "uid" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "uid" }
  field { name: "name" number: 3 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "name" }
}
message_type { name: "NodePrepareResourcesRequest" field { name: "claims" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.Claim" json_name: "claims" } }
message_type {
  name: "Device"
  field { name: "request_names" number: 1 label: LABEL_REPEATED type: TYPE_STRING json_name: "requestNames" }
  field { name: "pool_name" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "poolName" }
  field { name: "device_name" number: 3 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "deviceName" }
  field { name: "cdi_device_ids" number: 4 label: LABEL_REPEATED type: TYPE_STRING json_name: "cdiDeviceIds" }
}
message_type {
  name: "NodePrepareResourceResponse"
  field { name: "devices" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.Device" json_name: "devices" }
  field { name: "error" number: 2 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "error" }
}
message_type {
  name: "NodePrepareResourcesResponse"
  field { name: "claims" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.NodePrepareResourcesResponse.ClaimsEntry" json_name: "claims" }
  nested_type {
    name: "ClaimsEntry" options { map_entry: true }
    field { name: "key" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "key" }
    field { name: "value" number: 2 label: LABEL_OPTIONAL type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.NodePrepareResourceResponse" json_name: "value" }
  }
}
message_type { name: "NodeUnprepareResourceResponse" field { name: "error" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "error" } }
message_type {
  name: "NodeUnprepareResourcesResponse"
  field { name: "claims" number: 1 label: LABEL_REPEATED type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.NodeUnprepareResourcesResponse.ClaimsEntry" json_name: "claims" }
  nested_type {
    name: "ClaimsEntry" options { map_entry: true }
    field { name: "key" number: 1 label: LABEL_OPTIONAL type: TYPE_STRING json_name: "key" }
    field { name: "value" number: 2 label: LABEL_OPTIONAL type: TYPE_MESSAGE type_name: ".k8s.io.kubelet.pkg.apis.dra.v1.NodeUnprepareResourceResponse" json_name: "value" }
  }
}
`

func TestDRAWireMatchesUpstream(t *testing.T) {
	fdp := &descriptorpb.FileDescriptorProto{}
	if err := prototext.Unmarshal([]byte(upstreamDRA), fdp); err != nil {
		t.Fatal(err)
	}
	fd, err := protodesc.NewFile(fdp, nil)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, fd, "PluginInfo", (&PluginInfo{Type: "DRAPlugin", Name: "gpu.bcd.dev", Endpoint: "/var/lib/kubelet/plugins/gpu.bcd.dev/dra.sock",
		SupportedVersions: []string{"v1.DRAPlugin", "v1beta1.DRAPlugin"}}).marshal(),
		`{"type":"DRAPlugin","name":"gpu.bcd.dev","endpoint":"/var/lib/kubelet/plugins/gpu.bcd.dev/dra.sock","supportedVersions":["v1.DRAPlugin","v1beta1.DRAPlugin"]}`)
	sameJSON(t, fd, "NodePrepareResourcesResponse", (&PrepareResponse{Claims: map[string]ClaimResult{
		"u1": {Devices: []PreparedDevice{{RequestNames: []string{"gpu"}, PoolName: "n1", DeviceName: "gpu-1", CDIDeviceIDs: []string{"bcd.dev/gpu=GPU-1", "nvidia.com/gpu=GPU-1"}}}},
		"u2": {Error: "device n1/gpu-3 is not bound"},
	}}).marshal(),
		`{"claims":{"u1":{"devices":[{"requestNames":["gpu"],"poolName":"n1","deviceName":"gpu-1","cdiDeviceIds":["bcd.dev/gpu=GPU-1","nvidia.com/gpu=GPU-1"]}]},"u2":{"error":"device n1/gpu-3 is not bound"}}}`)
	sameJSON(t, fd, "NodeUnprepareResourcesResponse", (&UnprepareResponse{Claims: map[string]string{"u1": "", "u2": "boom"}}).marshal(),
		`{"claims":{"u1":{},"u2":{"error":"boom"}}}`)

	var req ClaimsRequest
	if err := req.unmarshal(fromJSON(t, fd, "NodePrepareResourcesRequest", `{"claims":[{"namespace":"ml","uid":"u1","name":"c1"},{"uid":"u2"}]}`)); err != nil ||
		!reflect.DeepEqual(req.Claims, []Claim{{Namespace: "ml", UID: "u1", Name: "c1"}, {UID: "u2"}}) {
		t.Fatalf("claims = %+v, %v", req.Claims, err)
	}
	var status RegistrationStatus
	if err := status.unmarshal(fromJSON(t, fd, "RegistrationStatus", `{"pluginRegistered":false,"error":"bad version"}`)); err != nil || status != (RegistrationStatus{Error: "bad version"}) {
		t.Fatalf("status = %+v, %v", status, err)
	}
}
