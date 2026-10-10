package service

import (
	"encoding/json"
	"testing"
)

func TestProductionCanvasLegacyCanonicalContent(t *testing.T) {
	// Persisted U02 request hashes depend on the exact field order and omitempty
	// behavior; adding reference fields must not invalidate an old retry.
	raw := json.RawMessage(`{"schemaVersion":1,"nodes":[{"id":"group","type":"group","title":"组","position":{"x":0,"y":0},"width":600,"height":400,"metadata":{"content":"","groupId":""}},{"id":"text","type":"text","title":"文本","position":{"x":12,"y":34},"width":240,"height":160,"metadata":{"fontSize":16,"groupId":"group","content":"台词"}}],"connections":[],"viewport":{"x":0,"y":0,"k":1},"backgroundMode":"dots"}`)
	want := `{"schemaVersion":1,"nodes":[{"id":"group","type":"group","title":"组","position":{"x":0,"y":0},"width":600,"height":400,"metadata":{}},{"id":"text","type":"text","title":"文本","position":{"x":12,"y":34},"width":240,"height":160,"metadata":{"content":"台词","groupId":"group","fontSize":16}}],"connections":[],"viewport":{"x":0,"y":0,"k":1},"backgroundMode":"dots"}`
	got, err := normalizeProductionCanvasContent(raw)
	if err != nil || string(got) != want {
		t.Fatalf("legacy canonical changed: %s, %v", got, err)
	}
}
