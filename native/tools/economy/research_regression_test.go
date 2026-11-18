package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchRejectsEmptyQueryEvenForEmptyScope(t *testing.T) {
	e := testEngine(t)
	_, _, err := e.search(Operation{Op: "search", Query: "", Paths: []string{"."}})
	if err == nil {
		t.Fatal("empty query was reported as successful negative evidence")
	}
}
func TestRecoveredSearchDependencyChecksContentHash(t *testing.T) {
	e := testEngine(t)
	put(t, e, "good.txt", "safe\n")
	put(t, e, "evil.txt", "not the searched source\n")
	raw := encoded(map[string]any{"matches": []map[string]any{{"path": "good.txt", "line": 1}}})
	id, err := e.Store.save("search", raw, "search result")
	if err != nil {
		t.Fatal(err)
	}
	bad := []byte(strings.Replace(string(raw), "good.txt", "evil.txt", 1))
	if len(bad) != len(raw) {
		t.Fatal("test must preserve size")
	}
	if err = os.WriteFile(filepath.Join(e.Store.Root, "artifacts", id, "data.json"), bad, 0600); err != nil {
		t.Fatal(err)
	}
	_, _, err = e.execute(context.Background(), Operation{ID: "read", Op: "read_matches", From: "search"}, map[string]Result{"search": {ID: "search", Op: "search", State: "completed", Artifact: id}})
	if err == nil {
		t.Fatal("read_matches trusted a same-size tampered dependency after restart")
	}
}
func TestCoverageUnknownNeverDowngradesToPartial(t *testing.T) {
	raw := json.RawMessage(`{"sourceChangedDuringRead":true,"complete":false}`)
	var v any
	json.Unmarshal(raw, &v)
	for i := 0; i < 500; i++ {
		c, _ := rawCoverage(v)
		if c != "unknown" {
			t.Fatal(c)
		}
	}
}

func TestCompleted04PacketRetainsSnapshotAfterUpgrade(t *testing.T) {
	e := testEngine(t)
	put(t, e, "a.txt", "old source")
	p := Packet{ID: "old", Operations: []Operation{{ID: "r", Op: "read", Path: "a.txt"}}}
	first, er := e.batch(context.Background(), p)
	if er != nil {
		t.Fatal(er)
	}
	path := filepath.Join(e.Store.Root, "packets", "old.json")
	var j PacketJournal
	if er = loadJSON(path, &j, 8<<20); er != nil {
		t.Fatal(er)
	}
	j.Version = "0.4.0"
	j.Fingerprint = digest(encoded(map[string]any{"packet": p, "root": e.Root, "checks": e.Checks, "version": "0.4.0"}))
	if er = atomicJSON(path, j); er != nil {
		t.Fatal(er)
	}
	put(t, e, "a.txt", "new source")
	second, er := e.batch(context.Background(), p)
	if er != nil {
		t.Fatal(er)
	}
	if !second.Replayed || second.Results[0].Artifact != first.Results[0].Artifact {
		t.Fatal(second)
	}
	j.Results["r"] = Result{ID: "r", Op: "read", State: "running"}
	atomicJSON(path, j)
	if _, er = e.batch(context.Background(), p); er == nil {
		t.Fatal("unfinished legacy packet resumed across changed runner")
	}
}
