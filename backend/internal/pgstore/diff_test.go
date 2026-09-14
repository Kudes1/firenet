package pgstore

import "testing"

func TestDiffSnapshots(t *testing.T) {
	before := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
		{Kind: kindDevice, Key: "r3"}: {Change: "added", Data: []byte(`{"name":"r3","kind":"router"}`)},
	}
	after := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},    // unchanged
		{Kind: kindDevice, Key: "r2"}: {Change: "modified", Data: []byte(`{"name":"r2","kind":"switch"}`)}, // modified
		{Kind: kindDevice, Key: "r4"}: {Change: "added", Data: []byte(`{"name":"r4","kind":"router"}`)},    // added
		// r3 removed
	}

	diffs := diffSnapshots(before, after)
	if len(diffs) != 3 {
		t.Fatalf("got %d diffs, want 3 (r2 modified, r3 removed, r4 added): %+v", len(diffs), diffs)
	}

	byKey := map[string]EntityDiff{}
	for _, d := range diffs {
		byKey[d.Key] = d
	}

	if d := byKey["r2"]; d.Change != "modified" || string(d.Before) != `{"name":"r2","kind":"router"}` || string(d.After) != `{"name":"r2","kind":"switch"}` {
		t.Fatalf("r2 diff wrong: %+v", d)
	}
	if d := byKey["r3"]; d.Change != "removed" || d.After != nil {
		t.Fatalf("r3 diff wrong: %+v", d)
	}
	if d := byKey["r4"]; d.Change != "added" || d.Before != nil {
		t.Fatalf("r4 diff wrong: %+v", d)
	}
	if _, ok := byKey["r1"]; ok {
		t.Fatal("r1 is unchanged and should not appear in the diff")
	}
}

func TestDiffSnapshotsIsSorted(t *testing.T) {
	before := map[entityRef]entityRow{}
	after := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "z"}: {Change: "added", Data: []byte(`{}`)},
		{Kind: kindDevice, Key: "a"}: {Change: "added", Data: []byte(`{}`)},
		{Kind: kindSubnet, Key: "a"}: {Change: "added", Data: []byte(`{}`)},
	}
	diffs := diffSnapshots(before, after)
	if len(diffs) != 3 {
		t.Fatalf("got %d diffs, want 3", len(diffs))
	}
	// kindDevice < kindSubnet lexically ("device" < "subnet"), then by key.
	want := []entityRef{{kindDevice, "a"}, {kindDevice, "z"}, {kindSubnet, "a"}}
	for i, d := range diffs {
		if d.Kind != want[i].Kind || d.Key != want[i].Key {
			t.Fatalf("diff %d = (%s,%s), want (%s,%s)", i, d.Kind, d.Key, want[i].Kind, want[i].Key)
		}
	}
}
