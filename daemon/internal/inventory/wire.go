package inventory

// protoWriter appends the protobuf binary encoding of proto3 fields, as encode.go calls it: fields in
// field-number order, fields with implicit presence omitted at their default value, optional fields
// written whenever set, repeated fields written element by element. That is the output of
// protobuf-go and protobuf-es for messages without maps, which no section has.
type protoWriter struct {
	buf []byte
}

const (
	wireVarint = 0
	wireBytes  = 2
)

func (w *protoWriter) varint(v uint64) {
	for v >= 0x80 {
		w.buf = append(w.buf, byte(v)|0x80)
		v >>= 7
	}
	w.buf = append(w.buf, byte(v))
}

func (w *protoWriter) tag(field, wireType int) {
	w.varint(uint64(field)<<3 | uint64(wireType))
}

func (w *protoWriter) u64(field int, v uint64) {
	if v != 0 {
		w.tag(field, wireVarint)
		w.varint(v)
	}
}

func (w *protoWriter) u32(field int, v uint32) { w.u64(field, uint64(v)) }

func (w *protoWriter) boolean(field int, v bool) {
	if v {
		w.tag(field, wireVarint)
		w.varint(1)
	}
}

// enum writes an enum value; negative values are sign-extended to 64 bits, as protobuf does.
func (w *protoWriter) enum(field int, v int32) {
	if v != 0 {
		w.tag(field, wireVarint)
		w.varint(uint64(int64(v)))
	}
}

func (w *protoWriter) str(field int, s string) {
	if s != "" {
		w.delimited(field, s)
	}
}

func (w *protoWriter) strs(field int, values []string) {
	for _, s := range values {
		w.delimited(field, s)
	}
}

// delimited writes a length-delimited field: a string, or an encoded message.
func (w *protoWriter) delimited(field int, s string) {
	w.tag(field, wireBytes)
	w.varint(uint64(len(s)))
	w.buf = append(w.buf, s...)
}

func (w *protoWriter) optU64(field int, v *uint64) {
	if v != nil {
		w.tag(field, wireVarint)
		w.varint(*v)
	}
}

func (w *protoWriter) optU32(field int, v *uint32) {
	if v != nil {
		w.tag(field, wireVarint)
		w.varint(uint64(*v))
	}
}

func (w *protoWriter) optBool(field int, v *bool) {
	if v == nil {
		return
	}
	w.tag(field, wireVarint)
	if *v {
		w.varint(1)
	} else {
		w.varint(0)
	}
}

// message writes a nested message; encode appends its fields.
func (w *protoWriter) message(field int, encode func(*protoWriter)) {
	var sub protoWriter
	encode(&sub)
	w.delimited(field, string(sub.buf))
}
