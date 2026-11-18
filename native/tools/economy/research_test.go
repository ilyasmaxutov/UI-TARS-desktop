package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func researchRequest(t *testing.T, e *Engine) SweepRequest {
	t.Helper()
	put(t, e, "host.log", "initialize=ok\nresume=accepted\ntransport=closed_after_write\n")
	put(t, e, "state.txt", "command_id=cmd-7\nstate=in_flight\n")
	return SweepRequest{SweepID: "sweep1", Plan: ResearchPlan{Schema: 1, InvestigationID: "investigation", TaskID: "task", GoalRevision: 1, OriginalGoal: "Почему resume завис?", PlanVersion: 1, Question: "Доставлена команда или нет?", Scope: []string{"host.log", "state.txt"}, StopRules: []string{"No mutation until readback", "Stop on insufficient coverage"}, Budget: ResearchBudget{MaxSweeps: 6, WallSeconds: 30, OutputUTF8Bytes: 24576, MaxNoProgress: 3}, Hypotheses: []Hypothesis{{ID: "h1", Claim: "ACK lost after acceptance", Predicts: []string{"command is present in authoritative readback"}, State: "open"}, {ID: "h2", Claim: "command not accepted", Predicts: []string{"authoritative final readback proves absence"}, State: "open"}}, Probes: []Probe{
		{ID: "host", Question: "What happened before disconnect?", Discriminates: []string{"h1", "h2"}, Operations: []Operation{{ID: "log", Op: "read", Path: "host.log", Lines: 20}}, Effect: "read-only", Priority: 0, ExpectedInformation: "accepted vs error", Acceptance: "exact captured lines"},
		{ID: "state", Question: "What local state was committed?", Discriminates: []string{"h1", "h2"}, Operations: []Operation{{ID: "state", Op: "read", Path: "state.txt", Lines: 20}}, Effect: "read-only", Priority: 1, ExpectedInformation: "in_flight requires remote readback", Acceptance: "local state is not a remote outcome"},
	}}, SourceSnapshot: SourceExpectation{RootHash: digest([]byte(e.Root)), Pins: []SourcePin{}}, Limits: SweepLimits{24576, 30}, PermissionScope: SweepPermission{Paths: []string{"host.log", "state.txt"}, Effect: "read-only"}}
}
func sweep(t *testing.T, e *Engine, r SweepRequest) SweepReport {
	t.Helper()
	v, er := e.sweep(context.Background(), r)
	if er != nil {
		t.Fatal(er)
	}
	return v
}
func TestResearchTenSharedDiagnosticContracts(t *testing.T) {
	base := "../../../fixtures/research"
	var cases []struct{ ID, Request string }
	b, er := os.ReadFile(filepath.Join(base, "cases.json"))
	if er != nil {
		t.Fatal(er)
	}
	json.Unmarshal(b, &cases)
	if len(cases) != 10 {
		t.Fatal(len(cases))
	}
	for _, c := range cases {
		t.Run(c.ID, func(t *testing.T) {
			e := testEngine(t)
			var r SweepRequest
			b, er := os.ReadFile(filepath.Join(base, c.Request))
			if er != nil {
				t.Fatal(er)
			}
			if er = strictDecode(b, &r); er != nil {
				t.Fatal(er)
			}
			r.SourceSnapshot.RootHash = digest([]byte(e.Root))
			for _, p := range r.PermissionScope.Paths {
				data, er := os.ReadFile(filepath.Join(base, c.ID, p))
				if er != nil {
					t.Fatal(er)
				}
				put(t, e, p, string(data))
			}
			report := sweep(t, e, r)
			if report.State != "observed" || len(report.EvidenceRefs) != 2 || report.LocalModelCalls != 0 {
				t.Fatal(report)
			}
			if report.NextAction != "evaluate_once" {
				t.Fatal(report.NextAction)
			}
		})
	}
}
func TestSweepTwoAlternativesRemainInterpretations(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	v := sweep(t, e, r)
	if len(v.Probes) != 2 || len(v.EvidenceRefs) != 2 || len(v.UntestedHypotheses) != 0 || len(v.UnknownEffects) != 0 {
		t.Fatal(v)
	}
	if strings.Contains(strings.ToLower(v.Summary), "solved") {
		t.Fatal("invented cause")
	}
	for _, h := range r.Plan.Hypotheses {
		if h.State != "open" {
			t.Fatal("tool changed hypothesis")
		}
	}
}
func TestSweepReplayReadsSnapshotNotChangedProject(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	a := sweep(t, e, r)
	put(t, e, "state.txt", "new value\n")
	b := sweep(t, e, r)
	if !b.Replayed || a.ReportArtifact != b.ReportArtifact || a.SourceHash != b.SourceHash || a.ReportSHA256 != b.ReportSHA256 {
		t.Fatal(b)
	}
}
func TestSweepChangedIDInputRejected(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	sweep(t, e, r)
	r.Plan.Question = "other"
	if _, er := e.sweep(context.Background(), r); er == nil {
		t.Fatal("changed intent accepted")
	}
}
func TestSweepReplayDetectsTamperedReport(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	a := sweep(t, e, r)
	p := filepath.Join(e.Store.Root, "artifacts", a.ReportArtifact, "data.json")
	b, _ := os.ReadFile(p)
	b[10] = 'X'
	os.WriteFile(p, b, 0600)
	if _, er := e.sweep(context.Background(), r); er == nil {
		t.Fatal("tampered report accepted")
	}
}
func TestSweepRejectsWrongRootBeforeOperations(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.SourceSnapshot.RootHash = strings.Repeat("0", 64)
	_, er := e.sweep(context.Background(), r)
	if er == nil {
		t.Fatal("wrong root accepted")
	}
	dirs, _ := os.ReadDir(filepath.Join(e.Store.Root, "artifacts"))
	if len(dirs) != 0 {
		t.Fatal("effects before preflight")
	}
}
func TestSweepRejectsStalePinnedSource(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.SourceSnapshot.Pins = []SourcePin{{"state.txt", digest([]byte("old content"))}}
	if _, er := e.sweep(context.Background(), r); er == nil {
		t.Fatal("stale accepted")
	}
}
func TestSweepPinnedSameSizeRewriteDetected(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	put(t, e, "state.txt", "aaaa")
	r.SourceSnapshot.Pins = []SourcePin{{"state.txt", digest([]byte("aaaa"))}}
	st, _ := os.Stat(filepath.Join(e.Root, "state.txt"))
	put(t, e, "state.txt", "bbbb")
	os.Chtimes(filepath.Join(e.Root, "state.txt"), st.ModTime(), st.ModTime())
	if _, er := e.sweep(context.Background(), r); er == nil {
		t.Fatal("stat-only check accepted changed bytes")
	}
}
func TestSweepMissingSourceIsNotNegativeProof(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	os.Remove(filepath.Join(e.Root, "state.txt"))
	v := sweep(t, e, r)
	if v.State != "partial" || v.Probes[1].Coverage != "unknown" || len(v.Gaps) == 0 {
		t.Fatal(v)
	}
	if v.EvidenceRefs[1].Negative {
		t.Fatal("missing != negative")
	}
}
func TestSweepBoundedSearchNegativeEvidence(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations = []Operation{{ID: "q", Op: "search", Paths: []string{"host.log"}, Query: "not present"}}
	v := sweep(t, e, r)
	if !v.EvidenceRefs[0].Negative || v.EvidenceRefs[0].Coverage != "complete" {
		t.Fatal(v)
	}
}
func TestSweepTruncatedNegativeEvidenceStaysPartial(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	put(t, e, "host.log", strings.Repeat("x", 70000))
	r.Plan.Probes[0].Operations = []Operation{{ID: "q", Op: "search", Paths: []string{"host.log"}, Query: "missing"}}
	v := sweep(t, e, r)
	if v.EvidenceRefs[0].Coverage != "partial" || v.State != "partial" {
		t.Fatal(v)
	}
}
func TestSweepDependencySearchThenRead(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations = []Operation{{ID: "q", Op: "search", Paths: []string{"host.log"}, Query: "resume"}, {ID: "r", Op: "read_matches", From: "q"}}
	v := sweep(t, e, r)
	if len(v.EvidenceRefs) != 3 || v.Probes[0].State != "observed" {
		t.Fatal(v)
	}
}
func TestSweepMutationRejectedRegardlessOfLabel(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations = []Operation{{ID: "check", Op: "check", Check: "approved"}}
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("check accepted as read-only")
	}
}
func TestSweepExternalProbeDenied(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Effect = "external"
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("external accepted")
	}
}
func TestSweepProbeScopeCannotExpand(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations[0].Path = "outside.txt"
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("scope escape")
	}
}
func TestSweepTraversalDenied(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Scope = []string{"."}
	r.PermissionScope.Paths = []string{"."}
	r.Plan.Probes[0].Operations[0].Path = "../outside"
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("escape")
	}
}
func TestSweepUnscopedGitDenied(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations = []Operation{{ID: "git", Op: "git_status"}}
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("Git scope bypass")
	}
}
func TestSweepCycleFailsPreflight(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Operations[0].Depends = []string{"state"}
	r.Plan.Probes[1].Operations[0].Depends = []string{"log"}
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("cycle")
	}
}
func TestSweepUnknownHypothesisFails(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Discriminates = []string{"invented"}
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("unknown hypothesis")
	}
}
func TestSweepMissingStopFails(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.StopRules = nil
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("missing stop")
	}
}
func TestSweepCannotRaisePlanLimit(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Limits.WallSeconds = r.Plan.Budget.WallSeconds + 1
	if _, er := validateResearch(r, digest([]byte(e.Root))); er == nil {
		t.Fatal("budget escalation")
	}
}
func TestSweepNoveltyIgnoresIDsAndTimes(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	a := sweep(t, e, r)
	r.SweepID = "sweep2"
	r.Plan.InvestigationID = "renamed"
	r.Plan.PlanVersion++
	r.Plan.Probes[0].Question = "Same query rephrased"
	b := sweep(t, e, r)
	for i := range a.EvidenceRefs {
		if a.EvidenceRefs[i].NoveltyKey != b.EvidenceRefs[i].NoveltyKey {
			t.Fatal("rename was counted as progress")
		}
	}
}
func TestSweepUnknownDoesNotRestartRead(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	p, er := validateResearch(r, digest([]byte(e.Root)))
	if er != nil {
		t.Fatal(er)
	}
	fp := digest(encoded(map[string]any{"packet": p, "root": e.Root, "checks": e.Checks, "version": Version}))
	j := PacketJournal{ID: p.ID, Fingerprint: fp, Results: map[string]Result{"log": {ID: "log", Op: "read", State: "running"}}}
	atomicJSON(filepath.Join(e.Store.Root, "packets", p.ID+".json"), j)
	v := sweep(t, e, r)
	if v.Probes[0].State != "blocked" || v.Probes[1].State != "observed" {
		t.Fatal(v)
	}
}
func TestSweepRestartBetweenBatchAndReportReusesCompletedBatch(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	first := sweep(t, e, r)
	jpath := filepath.Join(e.Store.Root, "packets", "sweep_"+r.SweepID+".json")
	var j sweepJournal
	loadJSON(jpath, &j, 2<<20)
	j.Report = nil
	atomicJSON(jpath, j)
	put(t, e, "state.txt", "changed after crash")
	second := sweep(t, e, r)
	if !second.Resumed || second.EvidenceRefs[0].Locator != first.EvidenceRefs[0].Locator || second.EvidenceRefs[1].Locator != first.EvidenceRefs[1].Locator || second.SourceCoverage != "unknown" {
		t.Fatal(second)
	}
}
func TestSweepReportUTF8Limit(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	put(t, e, "host.log", strings.Repeat("строка \\\"\n", 1000))
	r.Limits.OutputUTF8Bytes = 4096
	v := sweep(t, e, r)
	if len(encoded(v)) > 4096 || len(encoded(v)) != v.Bytes {
		t.Fatalf("wire %d reported %d", len(encoded(v)), v.Bytes)
	}
}
func TestSweepSmallTaskStillUsesBatch(t *testing.T) {
	e := testEngine(t)
	put(t, e, "x", "one line")
	v := batch(t, e, Packet{ID: "simple", Operations: []Operation{{ID: "one", Op: "read", Path: "x", Lines: 1}}})
	if len(v.Results) != 1 || v.ModelCalls != 0 {
		t.Fatal(v)
	}
}
func TestSweepNoCodeModeOrNetworkDependency(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	v := sweep(t, e, r)
	if v.LocalModelCalls != 0 || v.ObservedTokens != nil {
		t.Fatal("invented model usage")
	}
}
func TestSweepSymlinkCannotProduceCompleteEvidence(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	outside := filepath.Join(filepath.Dir(e.Root), "secret")
	os.WriteFile(outside, []byte("secret"), 0600)
	os.Remove(filepath.Join(e.Root, "state.txt"))
	if er := os.Symlink(outside, filepath.Join(e.Root, "state.txt")); er != nil {
		t.Fatal(er)
	}
	v := sweep(t, e, r)
	if v.SourceCoverage == "complete" || v.EvidenceRefs[1].Coverage != "unknown" {
		t.Fatal(v)
	}
}
func TestSweepSchemaStaysUnderOriginalDiscoveryBudget(t *testing.T) {
	if n := len(encoded(toolSchemas())); n > 7000 {
		t.Fatalf("schema %d > 7000", n)
	}
}
func TestSweepMCPWireCarriesEvidenceWithinBudget(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Plan.Probes[0].Question = strings.Repeat("\\\"", 250)
	var in bytes.Buffer
	fmt.Fprintln(&in, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	fmt.Fprintln(&in, string(encoded(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "diagnostic_sweep", "arguments": r}})))
	var out bytes.Buffer
	if er := serveMCP(context.Background(), e, &in, &out); er != nil {
		t.Fatal(er)
	}
	found := false
	for _, line := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte{'\n'}) {
		if len(line)+1 > MaxPacketBytes {
			t.Fatal("outer MCP frame exceeds limit")
		}
		var v map[string]json.RawMessage
		json.Unmarshal(line, &v)
		if string(v["id"]) == "2" {
			if !bytes.Contains(line, []byte("evidenceRefs")) {
				t.Fatal(string(line))
			}
			found = true
		}
	}
	if !found {
		t.Fatal(out.String())
	}
}

func TestSweepJournalCannotLaunderCoverage(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	sweep(t, e, r)
	path := filepath.Join(e.Store.Root, "packets", "sweep_"+r.SweepID+".json")
	var j sweepJournal
	if er := loadJSON(path, &j, 2<<20); er != nil {
		t.Fatal(er)
	}
	j.Report.EvidenceRefs[0].Negative = true
	if er := atomicJSON(path, j); er != nil {
		t.Fatal(er)
	}
	if _, er := e.sweep(context.Background(), r); er == nil || !strings.Contains(er.Error(), "INTEGRITY") {
		t.Fatal("altered journal accepted", er)
	}
}
func TestResearchSkillIsActuallyDeliveredAndBounded(t *testing.T) {
	if len(diagnosisFirstSkill) > 4096 || !strings.Contains(diagnosisFirstSkill, "Simple") && !strings.Contains(diagnosisFirstSkill, "simple") {
		t.Fatal("invalid skill")
	}
	e := testEngine(t)
	in := bytes.NewBufferString("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n")
	var out bytes.Buffer
	if er := serveMCP(context.Background(), e, in, &out); er != nil {
		t.Fatal(er)
	}
	if !strings.Contains(out.String(), "competing causal explanations") || !strings.Contains(out.String(), "rootHash") {
		t.Fatal(out.String())
	}
}

func TestCancelledSweepNeverClaimsCompleteSource(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	v, er := e.sweep(ctx, r)
	if er != nil {
		return
	}
	if v.SourceCoverage == "complete" || len(v.Gaps) == 0 {
		t.Fatal(v)
	}
}
func TestResearchSourceCaptureKeepsUnknownOnMissingRoot(t *testing.T) {
	e := testEngine(t)
	c := e.captureSources([]string{"does-not-exist"})
	if c.Coverage == "complete" {
		t.Fatal(c)
	}
}

func TestOversizedIrreducibleQuestionsDeniedBeforeReading(t *testing.T) {
	e := testEngine(t)
	r := researchRequest(t, e)
	r.Limits.OutputUTF8Bytes = 4096
	for i := range r.Plan.Probes {
		r.Plan.Probes[i].Question = strings.Repeat("q", 1024)
	}
	if _, er := e.sweep(context.Background(), r); er == nil || !strings.Contains(er.Error(), "OUTPUT_LIMIT") {
		t.Fatal(er)
	}
	entries, _ := os.ReadDir(filepath.Join(e.Store.Root, "artifacts"))
	if len(entries) != 0 {
		t.Fatal("read before preflight", entries)
	}
}
