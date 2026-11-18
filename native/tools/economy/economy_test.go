package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testEngine(t *testing.T) *Engine {
	t.Helper()
	d := t.TempDir()
	r := filepath.Join(d, "project")
	os.Mkdir(r, 0700)
	e, err := newEngine(r, filepath.Join(d, "state"))
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func put(t *testing.T, e *Engine, p, s string) {
	t.Helper()
	f := filepath.Join(e.Root, p)
	os.MkdirAll(filepath.Dir(f), 0700)
	if err := os.WriteFile(f, []byte(s), 0600); err != nil {
		t.Fatal(err)
	}
}
func batch(t *testing.T, e *Engine, p Packet) Envelope {
	t.Helper()
	v, err := e.batch(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestLocalTwentyReads(t *testing.T) {
	e := testEngine(t)
	p := Packet{ID: "twenty"}
	for i := 0; i < 20; i++ {
		name := fmt.Sprintf("f%d.txt", i)
		put(t, e, name, strings.Repeat("sample content\n", 100))
		p.Operations = append(p.Operations, Operation{ID: fmt.Sprint("r", i), Op: "read", Path: name, Lines: 100})
	}
	v := batch(t, e, p)
	if len(v.Results) != 20 || len(encoded(v)) > MaxPacketBytes || v.ModelCalls != 0 {
		t.Fatal(v)
	}
	for _, r := range v.Results {
		if r.State != "completed" || r.Artifact == "" {
			t.Fatal(r)
		}
	}
	t.Logf("20 actual reads; %d response bytes; 0 local model calls", len(encoded(v)))
}
func TestReplaySnapshotDoesNotRepeat(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "original\n")
	p := Packet{"p", []Operation{{ID: "r", Op: "read", Path: "x"}}}
	v := batch(t, e, p)
	put(t, e, "x", "changed\n")
	v2 := batch(t, e, p)
	if !v2.Replayed || v.Results[0].Artifact != v2.Results[0].Artifact || !strings.Contains(v2.Results[0].Text, "original") {
		t.Fatal(v2)
	}
	p.ID = "p2"
	v3 := batch(t, e, p)
	if !strings.Contains(v3.Results[0].Text, "changed") {
		t.Fatal(v3)
	}
}
func TestDuplicateReadSameWave(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "data\n")
	v := batch(t, e, Packet{"dup", []Operation{{ID: "a", Op: "read", Path: "x"}, {ID: "b", Op: "read", Path: "x"}}})
	if !v.Results[1].Reused || v.Results[0].Artifact != v.Results[1].Artifact {
		t.Fatal(v)
	}
}
func TestSameIDChangedIntentRejected(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "x")
	p := Packet{"p", []Operation{{ID: "a", Op: "read", Path: "x"}}}
	batch(t, e, p)
	p.Operations[0].Lines = 20
	if _, err := e.batch(context.Background(), p); err == nil {
		t.Fatal("accepted altered intent")
	}
}
func TestDependenciesAndFailureIsolation(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "function saveSettings() {}\n")
	p := Packet{"deps", []Operation{{ID: "search", Op: "search", Query: "saveSettings"}, {ID: "read", Op: "read_matches", From: "search"}, {ID: "bad", Op: "read", Path: "missing"}, {ID: "blocked", Op: "read", Path: "x", Depends: []string{"bad"}}}}
	v := batch(t, e, p)
	if v.Results[0].State != "completed" || v.Results[1].State != "completed" || v.Results[2].State != "failed" || v.Results[3].State != "blocked" {
		t.Fatal(v)
	}
}
func TestCycleDeniedBeforeEffects(t *testing.T) {
	e := testEngine(t)
	_, er := e.batch(context.Background(), Packet{"cyc", []Operation{{ID: "a", Op: "files", Depends: []string{"b"}}, {ID: "b", Op: "files", Depends: []string{"a"}}}})
	if er == nil {
		t.Fatal("cycle accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(e.Store.Root, "artifacts"))
	if len(entries) != 0 {
		t.Fatal(entries)
	}
}
func TestUnapprovedCheckNoProcess(t *testing.T) {
	e := testEngine(t)
	v := batch(t, e, Packet{"check", []Operation{{ID: "c", Op: "check", Check: "anything"}}})
	if v.Results[0].State != "failed" {
		t.Fatal(v)
	}
}
func TestRecoveredRunningCheckNeverReexecutes(t *testing.T) {
	e := testEngine(t)
	p := Packet{"recover", []Operation{{ID: "c", Op: "check", Check: "x"}}}
	fp := digest(encoded(map[string]any{"packet": p, "root": e.Root, "checks": e.Checks, "version": Version}))
	j := PacketJournal{ID: p.ID, Fingerprint: fp, Results: map[string]Result{"c": {ID: "c", Op: "check", State: "running"}}}
	atomicJSON(filepath.Join(e.Store.Root, "packets", p.ID+".json"), j)
	v := batch(t, e, p)
	if v.Results[0].State != "unknown" {
		t.Fatal(v)
	}
}
func TestPathAndSecretGuards(t *testing.T) {
	e := testEngine(t)
	put(t, e, ".env", "TOKEN=bad")
	for _, p := range []string{"../escape", "C:\\secret", "/etc/passwd", ".env"} {
		v := batch(t, e, Packet{uid("p_"), []Operation{{ID: "r", Op: "read", Path: p}}})
		if v.Results[0].State != "failed" {
			t.Fatalf("allowed %s", p)
		}
	}
}
func TestSymlinkDenied(t *testing.T) {
	e := testEngine(t)
	outside := filepath.Join(filepath.Dir(e.Root), "outside")
	os.WriteFile(outside, []byte("secret"), 0600)
	if err := os.Symlink(outside, filepath.Join(e.Root, "link")); err != nil {
		t.Skip("symlink not available")
	}
	v := batch(t, e, Packet{"link", []Operation{{ID: "r", Op: "read", Path: "link"}}})
	if v.Results[0].State != "failed" {
		t.Fatal(v)
	}
}
func TestGeneratedExcludedButExplicitlyAvailable(t *testing.T) {
	e := testEngine(t)
	put(t, e, "node_modules/x", "needle\n")
	put(t, e, "src/y", "needle\n")
	v := batch(t, e, Packet{"exclude", []Operation{{ID: "s", Op: "search", Query: "needle"}}})
	if strings.Contains(v.Results[0].Text, "node_modules/x") {
		t.Fatal(v)
	}
	v = batch(t, e, Packet{"include", []Operation{{ID: "s", Op: "search", Query: "needle", IncludeGenerated: true}}})
	if !strings.Contains(v.Results[0].Text, "node_modules/x") {
		t.Fatal(v)
	}
}
func TestRangeIsBoundedAndBinaryExplicit(t *testing.T) {
	e := testEngine(t)
	put(t, e, "bin", string([]byte{0, 1, 2, 3, 4}))
	v := batch(t, e, Packet{"binary", []Operation{{ID: "t", Op: "read", Path: "bin"}, {ID: "b", Op: "read_bytes", Path: "bin", Offset: 1, Length: 2}}})
	if v.Results[0].State != "failed" || v.Results[1].State != "completed" || !strings.Contains(v.Results[1].Text, "AQI=") {
		t.Fatal(v)
	}
}
func TestLongLineIsExplicitlyIncomplete(t *testing.T) {
	v, er := readLines(strings.NewReader(strings.Repeat("a", 70000)), 1, 5, 4096, 1<<20)
	if er != nil || v["complete"] != false {
		t.Fatal(v, er)
	}
}
func TestSearchLiteralNotRegex(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "a.*b\naxb\n")
	v := batch(t, e, Packet{"literal", []Operation{{ID: "s", Op: "search", Query: "a.*b"}}})
	if !strings.Contains(v.Results[0].Text, "a.*b") || strings.Contains(v.Results[0].Text, "axb") {
		t.Fatal(v)
	}
}
func TestContextKeepsGoalAndRules(t *testing.T) {
	e := testEngine(t)
	id, err := e.Store.save("evidence", []byte(`{"fact":"observed not inferred"}`), "fact")
	if err != nil {
		t.Fatal(err)
	}
	p, err := e.pack(ContextSpec{Goal: "исходная цель", Rules: []string{"НЕ запускать GUI"}, Materials: []string{id, id}, MaxBytes: 2048})
	if err != nil || !strings.Contains(p.Text, "НЕ запускать GUI") || len(p.MaterialIDs) != 1 {
		t.Fatal(p, err)
	}
	_, err = e.pack(ContextSpec{Goal: strings.Repeat("x", 3000), MaxBytes: 1024})
	if err == nil {
		t.Fatal("silently cut goal")
	}
}
func TestContextRejectsCorruptedMaterial(t *testing.T) {
	e := testEngine(t)
	id, _ := e.Store.save("evidence", []byte("abc"), "abc")
	os.WriteFile(filepath.Join(e.Store.Root, "artifacts", id, "data.json"), []byte("xyz"), 0600)
	if _, err := e.pack(ContextSpec{Goal: "goal", Materials: []string{id}, MaxBytes: 2048}); err == nil {
		t.Fatal("corruption accepted")
	}
}
func TestStoreLimitBeforeWork(t *testing.T) {
	e := testEngine(t)
	e.Store.Limits.StoreBytes = 100
	_, err := e.Store.save("a", []byte("x"), "x")
	if err == nil {
		t.Fatal("store overflow allowed")
	}
}
func TestOutputBoundPreservesStatusAndRefs(t *testing.T) {
	rs := []Result{}
	for i := 0; i < 32; i++ {
		rs = append(rs, Result{ID: fmt.Sprint(i), State: "failed", Text: strings.Repeat("Ошибка🧩", 1000), Artifact: "a_example"})
	}
	v, err := envelope("long", rs, 8192, false)
	if err != nil || len(encoded(v)) > 8192 {
		t.Fatal(err, len(encoded(v)))
	}
	for _, r := range v.Results {
		if r.State != "failed" || r.Artifact != "a_example" {
			t.Fatal(r)
		}
	}
}
func TestCaptureHelper(t *testing.T) {
	if os.Getenv("STUDIO_CAPTURE_FIXTURE") != "1" {
		return
	}
	fmt.Print(strings.Repeat("line\n", 500))
	fmt.Fprintln(os.Stdout, "ERROR middle-test-marker")
	fmt.Print(strings.Repeat("tail\n", 500))
	fmt.Fprintln(os.Stderr, "stderr evidence")
	if os.Getenv("STUDIO_CAPTURE_EXIT") == "7" {
		os.Exit(7)
	}
	os.Exit(0)
}
func TestRealCaptureExitCodeAndInspect(t *testing.T) {
	e := testEngine(t)
	t.Setenv("STUDIO_CAPTURE_FIXTURE", "1")
	t.Setenv("STUDIO_CAPTURE_EXIT", "7")
	exe, _ := os.Executable()
	a, err := e.capture(context.Background(), CheckSpec{Program: exe, Args: []string{"-test.run=^TestCaptureHelper$"}, TimeoutSeconds: 5})
	if err != nil || a.ExitCode == nil || *a.ExitCode != 7 || !a.Complete {
		t.Fatal(a, err)
	}
	s, _, err := e.Store.inspect(Operation{Artifact: a.ID, Query: "middle-test-marker"})
	if err != nil || !strings.Contains(s, "middle-test-marker") {
		t.Fatal(s, err)
	}
}
func TestCaptureQuotaNotFalseSuccess(t *testing.T) {
	e := testEngine(t)
	e.Limits.CaptureBytes = 128
	t.Setenv("STUDIO_CAPTURE_FIXTURE", "1")
	exe, _ := os.Executable()
	a, err := e.capture(context.Background(), CheckSpec{Program: exe, Args: []string{"-test.run=^TestCaptureHelper$"}, TimeoutSeconds: 5})
	if err != nil || a.Complete || !strings.Contains(a.Reason, "capture_limit") {
		t.Fatal(a, err)
	}
	var n int64
	for _, v := range a.Files {
		n += v.Bytes
	}
	if n > 128 {
		t.Fatal(n)
	}
}
func TestCaptureSourceUnchanged(t *testing.T) {
	e := testEngine(t)
	put(t, e, "keep", "unchanged")
	before, _ := os.ReadFile(filepath.Join(e.Root, "keep"))
	t.Setenv("STUDIO_CAPTURE_FIXTURE", "1")
	exe, _ := os.Executable()
	e.capture(context.Background(), CheckSpec{Program: exe, Args: []string{"-test.run=^TestCaptureHelper$"}, TimeoutSeconds: 5})
	after, _ := os.ReadFile(filepath.Join(e.Root, "keep"))
	if !bytes.Equal(before, after) {
		t.Fatal("source changed")
	}
}
func TestMCPRealPipes(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "hello\n")
	rin, win := io.Pipe()
	rout, wout := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveMCP(ctx, e, rin, wout); wout.Close() }()
	dec := json.NewDecoder(rout)
	send := func(v any) {
		_, err := win.Write(append(encoded(v), '\n'))
		if err != nil {
			t.Fatal(err)
		}
	}
	send(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	var response map[string]any
	if err := dec.Decode(&response); err != nil {
		t.Fatal(err)
	}
	send(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "local_batch", "arguments": Packet{"mcp", []Operation{{ID: "r", Op: "read", Path: "x"}}}}})
	if err := dec.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded(response)), "hello") {
		t.Fatal(response)
	}
	win.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestGitStatusAndDiffLocal(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git missing")
	}
	e := testEngine(t)
	c := exec.Command(git, "init", "--quiet")
	c.Dir = e.Root
	if err = c.Run(); err != nil {
		t.Fatal(err)
	}
	put(t, e, "x.txt", "new\n")
	v := batch(t, e, Packet{"git", []Operation{{ID: "s", Op: "git_status"}, {ID: "d", Op: "git_diff"}}})
	for _, r := range v.Results {
		if r.State != "completed" {
			t.Fatal(r)
		}
	}
	s, _, err := e.Store.inspect(Operation{Artifact: v.Results[0].Artifact})
	if err != nil || !strings.Contains(s, "x.txt") {
		t.Fatal(s, err)
	}
}
func TestCancellationBeforeBatch(t *testing.T) {
	e := testEngine(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	v, err := e.batch(ctx, Packet{"cancel", []Operation{{ID: "x", Op: "files"}}})
	if err != nil || v.Results[0].State != "cancelled" {
		t.Fatal(v, err)
	}
}
func TestLockSecondOwnerDenied(t *testing.T) {
	p := filepath.Join(t.TempDir(), "l")
	unlock, err := lockFile(p)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if other, err := lockFile(p); err == nil {
		other()
		t.Fatal("second lock accepted")
	}
}
func TestJSONStrictUnknownField(t *testing.T) {
	var p Packet
	if strictDecode([]byte(`{"id":"p","operations":[],"shell":"bad"}`), &p) == nil {
		t.Fatal("unknown accepted")
	}
}
func TestPacketOperationLimit(t *testing.T) {
	ops := make([]Operation, 33)
	for i := range ops {
		ops[i] = Operation{ID: fmt.Sprint(i), Op: "files"}
	}
	if validatePacket(Packet{"p", ops}) == nil {
		t.Fatal("too many accepted")
	}
}
func TestPrivateStoreOutsideProject(t *testing.T) {
	r := t.TempDir()
	if _, err := newEngine(r, filepath.Join(r, "store")); err == nil {
		t.Fatal("in-project state allowed")
	}
}
func TestMCPDescriptorsSmall(t *testing.T) {
	if n := len(encoded(toolSchemas())); n > 7000 {
		t.Fatal(n)
	}
}
func TestNoNetworkPackagesInLocalFiles(t *testing.T) {
	for _, p := range []string{"files.go", "batch.go", "capture.go", "context.go", "mcp.go"} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte(`"net/http"`)) {
			t.Fatal(p)
		}
	}
}

var _ = time.Second

func TestEnvelopeByteCountExact(t *testing.T) {
	v, err := envelope("p", []Result{{ID: "x", Op: "read", State: "completed", Text: strings.Repeat("x", 1000)}}, 4096, false)
	if err != nil || v.Bytes != len(encoded(v)) {
		t.Fatalf("count %d actual %d err %v", v.Bytes, len(encoded(v)), err)
	}
}
func TestInspectBinaryRangeInLongLog(t *testing.T) {
	e := testEngine(t)
	id, err := e.Store.save("data", []byte(strings.Repeat("A", 70000)+"MARK"), "long")
	if err != nil {
		t.Fatal(err)
	}
	_, v, err := e.Store.inspect(Operation{Artifact: id, Offset: 70000, Length: 4})
	if err != nil || v.(map[string]any)["base64"] != "TUFSSw==" {
		t.Fatalf("%v %v", v, err)
	}
}
func TestResolveNpmCodexWithoutExecutingShim(t *testing.T) {
	root := t.TempDir()
	shim := filepath.Join(root, "codex.cmd")
	os.WriteFile(shim, []byte("DO NOT EXECUTE"), 0600)
	exe := filepath.Join(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe")
	os.MkdirAll(filepath.Dir(exe), 0700)
	os.WriteFile(exe, []byte("MZ fixture"), 0600)
	p, err := resolveWindowsCodex(shim)
	if err != nil || p != exe {
		t.Fatalf("%s %v", p, err)
	}
}

func TestOwnerCheckManifestForwardedWithoutReplacingInstructions(t *testing.T) {
	args := strings.Join(profileOverrides("/local/tool", "/project", "/private/state", "/private/checks.json"), " ")
	if !strings.Contains(args, "--checks") || !strings.Contains(args, "/private/checks.json") {
		t.Fatal(args)
	}
	if strings.Contains(args, "developer_instructions") || strings.Contains(args, "hooks=false") || strings.Contains(args, "bypass") {
		t.Fatal(args)
	}
}
