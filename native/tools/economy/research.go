package main

// Research is a bounded procedure over the existing local_batch executor, not an
// agent loop. Statements/expected outcomes belong to the plan author; observed
// bytes and coverage belong to this tool. No interpretation is promoted to fact.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type ResearchBudget struct {
	MaxSweeps       int `json:"maxSweeps"`
	WallSeconds     int `json:"wallSeconds"`
	OutputUTF8Bytes int `json:"outputUtf8Bytes"`
	MaxNoProgress   int `json:"maxNoProgress"`
}
type Hypothesis struct {
	ID              string   `json:"id"`
	Claim           string   `json:"claim"`
	Predicts        []string `json:"predicts"`
	CounterEvidence []string `json:"counterEvidence,omitempty"`
	State           string   `json:"state"`
}
type Probe struct {
	ID                  string      `json:"id"`
	Question            string      `json:"question"`
	Discriminates       []string    `json:"discriminates"`
	Operations          []Operation `json:"operations"`
	Effect              string      `json:"effect"`
	Priority            int         `json:"priority"`
	ExpectedInformation string      `json:"expectedInformation"`
	Acceptance          string      `json:"acceptance"`
}
type ResearchPlan struct {
	Schema          int            `json:"schema"`
	InvestigationID string         `json:"investigationId"`
	TaskID          string         `json:"taskId"`
	GoalRevision    int            `json:"goalRevision"`
	OriginalGoal    string         `json:"originalGoal"`
	PlanVersion     int            `json:"planVersion"`
	Question        string         `json:"question"`
	Scope           []string       `json:"scope"`
	StopRules       []string       `json:"stopRules"`
	Budget          ResearchBudget `json:"budget"`
	Hypotheses      []Hypothesis   `json:"hypotheses"`
	Probes          []Probe        `json:"probes"`
}
type SourcePin struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type SourceExpectation struct {
	RootHash string      `json:"rootHash"`
	Pins     []SourcePin `json:"pins"`
}
type SweepPermission struct {
	Paths    []string `json:"paths"`
	Effect   string   `json:"effect"`
	AllowGit bool     `json:"allowGit"`
}
type SweepLimits struct {
	OutputUTF8Bytes int `json:"outputUtf8Bytes"`
	WallSeconds     int `json:"wallSeconds"`
}
type SweepRequest struct {
	SweepID         string            `json:"sweepId"`
	Plan            ResearchPlan      `json:"plan"`
	SourceSnapshot  SourceExpectation `json:"sourceSnapshot"`
	Limits          SweepLimits       `json:"limits"`
	PermissionScope SweepPermission   `json:"permissionScope"`
}
type SourceVersion struct {
	Path       string `json:"path"`
	Bytes      int64  `json:"bytes"`
	ModifiedNS int64  `json:"modifiedNS"`
	SHA256     string `json:"sha256,omitempty"`
	Problem    string `json:"problem,omitempty"`
}
type SourceCapture struct {
	RootHash string          `json:"rootHash"`
	Hash     string          `json:"hash"`
	Files    []SourceVersion `json:"files"`
	Coverage string          `json:"coverage"`
	Gaps     []string        `json:"gaps"`
}
type EvidenceRef struct {
	ID          string `json:"id"`
	ProbeID     string `json:"probeId"`
	OperationID string `json:"operationId"`
	Kind        string `json:"kind"`
	Locator     string `json:"locator"`
	SHA256      string `json:"sha256"`
	ObservedAt  string `json:"observedAt"`
	Coverage    string `json:"coverage"`
	SourceHash  string `json:"sourceHash"`
	NoveltyKey  string `json:"noveltyKey"`
	Negative    bool   `json:"negative"`
}
type ProbeObservation struct {
	Question    string   `json:"question"`
	ProbeID     string   `json:"probeId"`
	State       string   `json:"state"`
	Coverage    string   `json:"coverage"`
	EvidenceIDs []string `json:"evidenceIds"`
	Summary     string   `json:"summary"`
}
type EvidenceExcerpt struct {
	EvidenceID string `json:"evidenceId"`
	Text       string `json:"text"`
	Truncated  bool   `json:"truncated"`
}
type SweepReport struct {
	Schema                 int                `json:"schema"`
	SweepID                string             `json:"sweepId"`
	InvestigationID        string             `json:"investigationId"`
	TaskID                 string             `json:"taskId"`
	GoalRevision           int                `json:"goalRevision"`
	PlanVersion            int                `json:"planVersion"`
	State                  string             `json:"state"`
	SourceHash             string             `json:"sourceHash"`
	SourceCoverage         string             `json:"sourceCoverage"`
	Probes                 []ProbeObservation `json:"probes"`
	EvidenceRefs           []EvidenceRef      `json:"evidenceRefs"`
	Excerpts               []EvidenceExcerpt  `json:"excerpts"`
	Summary                string             `json:"summary"`
	Gaps                   []string           `json:"gaps"`
	UnknownEffects         []string           `json:"unknownEffects"`
	UntestedHypotheses     []string           `json:"untestedHypotheses"`
	NextSuggestedQuestions []string           `json:"nextSuggestedQuestions"`
	NextAction             string             `json:"nextAction"`
	ReportArtifact         string             `json:"reportArtifact"`
	ReportSHA256           string             `json:"reportSha256"`
	DurationMS             int64              `json:"durationMs"`
	Bytes                  int                `json:"utf8Bytes"`
	Limit                  int                `json:"limitUtf8Bytes"`
	Truncated              bool               `json:"truncated"`
	Replayed               bool               `json:"replayed"`
	Resumed                bool               `json:"resumed"`
	LocalModelCalls        int                `json:"localModelCalls"`
	ObservedTokens         *int               `json:"observedTokens"`
}
type sweepJournal struct {
	Fingerprint string        `json:"fingerprint"`
	Request     SweepRequest  `json:"request"`
	Before      SourceCapture `json:"before"`
	Started     string        `json:"started"`
	Report      *SweepReport  `json:"report,omitempty"`
}

func boundedText(s string, max int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= max && !strings.ContainsRune(s, '\x00')
}
func safeResearchPath(p string) bool {
	if p == "." {
		return true
	}
	if p == "" || len(p) > 1024 || strings.ContainsAny(p, "\\:\x00\r\n") || strings.HasPrefix(p, "/") {
		return false
	}
	for _, c := range strings.Split(p, "/") {
		if c == "" || c == "." || c == ".." || secretName(c) {
			return false
		}
	}
	return true
}
func underScope(p string, roots []string) bool {
	if !safeResearchPath(p) {
		return false
	}
	for _, r := range roots {
		if r == "." || p == r || strings.HasPrefix(p, r+"/") {
			return true
		}
	}
	return false
}
func isDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Both CLI and MCP use this preflight before executing any operation. Permission
// scope only narrows the fixed engine root; a plan cannot grant new authority.
func validateResearch(r SweepRequest, rootHash string) (Packet, error) {
	p := r.Plan
	packet := Packet{ID: "diag_" + r.SweepID, Operations: []Operation{}}
	if len(encoded(r)) > 256<<10 {
		return packet, errors.New("RESEARCH_SIZE: request exceeds 256 KiB")
	}
	if checkID(r.SweepID) != nil || len(r.SweepID) > 80 || checkID(p.InvestigationID) != nil || checkID(p.TaskID) != nil {
		return packet, errors.New("RESEARCH_ID: invalid identity")
	}
	if p.Schema != 1 || p.GoalRevision < 1 || p.PlanVersion < 1 {
		return packet, errors.New("RESEARCH_VERSION: positive goal/plan revisions and schema 1 required")
	}
	if !boundedText(p.OriginalGoal, 65536) || !boundedText(p.Question, 2048) {
		return packet, errors.New("RESEARCH_GOAL: original goal and diagnostic question required")
	}
	if len(p.Scope) < 1 || len(p.Scope) > 16 || len(r.PermissionScope.Paths) < 1 || len(r.PermissionScope.Paths) > 16 {
		return packet, errors.New("RESEARCH_SCOPE: 1..16 explicit paths required")
	}
	for _, s := range p.Scope {
		if !safeResearchPath(s) {
			return packet, errors.New("RESEARCH_SCOPE: unsafe path")
		}
	}
	for _, s := range r.PermissionScope.Paths {
		if !underScope(s, p.Scope) {
			return packet, errors.New("RESEARCH_SCOPE: permission scope must narrow plan scope")
		}
	}
	if r.PermissionScope.Effect != "read-only" {
		return packet, errors.New("RESEARCH_EFFECT: only read-only sweeps; mutations require the existing outbox")
	}
	if r.SourceSnapshot.RootHash != rootHash || !isDigest(rootHash) {
		return packet, errors.New("RESEARCH_ROOT: source root identity differs")
	}
	if len(r.SourceSnapshot.Pins) > 32 {
		return packet, errors.New("RESEARCH_PINS: too many source pins")
	}
	pins := map[string]bool{}
	for _, pin := range r.SourceSnapshot.Pins {
		if !underScope(pin.Path, r.PermissionScope.Paths) || !isDigest(pin.SHA256) || pins[pin.Path] {
			return packet, errors.New("RESEARCH_PINS: invalid, duplicate or out-of-scope pin")
		}
		pins[pin.Path] = true
	}
	if len(p.StopRules) < 1 || len(p.StopRules) > 8 {
		return packet, errors.New("RESEARCH_STOP: explicit stop rules required")
	}
	for _, s := range p.StopRules {
		if !boundedText(s, 1024) {
			return packet, errors.New("RESEARCH_STOP: invalid rule")
		}
	}
	b := p.Budget
	if b.MaxSweeps < 1 || b.MaxSweeps > 32 || b.MaxNoProgress < 1 || b.MaxNoProgress > 5 || b.WallSeconds < 1 || b.WallSeconds > 300 || b.OutputUTF8Bytes < 2048 || b.OutputUTF8Bytes > MaxPacketBytes {
		return packet, errors.New("RESEARCH_BUDGET: invalid finite budget")
	}
	if r.Limits.OutputUTF8Bytes < 2048 || r.Limits.OutputUTF8Bytes > b.OutputUTF8Bytes || r.Limits.WallSeconds < 1 || r.Limits.WallSeconds > b.WallSeconds {
		return packet, errors.New("RESEARCH_LIMITS: request cannot expand plan budget")
	}
	if len(p.Hypotheses) < 2 || len(p.Hypotheses) > 5 {
		return packet, errors.New("RESEARCH_HYPOTHESES: 2..5 alternatives required; simple reads use local_batch")
	}
	hypotheses := map[string]bool{}
	for _, h := range p.Hypotheses {
		if checkID(h.ID) != nil || hypotheses[h.ID] || !boundedText(h.Claim, 2048) || len(h.Predicts) < 1 || len(h.Predicts) > 8 {
			return packet, errors.New("RESEARCH_HYPOTHESIS: invalid claim or predictions")
		}
		for _, x := range h.Predicts {
			if !boundedText(x, 1024) {
				return packet, errors.New("RESEARCH_PREDICTION: invalid text")
			}
		}
		if h.State != "open" && h.State != "supported" && h.State != "weakened" && h.State != "refuted" && h.State != "unresolved" {
			return packet, errors.New("RESEARCH_HYPOTHESIS_STATE: unknown state")
		}
		if len(h.CounterEvidence) > 32 {
			return packet, errors.New("RESEARCH_HYPOTHESIS: too much counter evidence")
		}
		for _, id := range h.CounterEvidence {
			if checkID(id) != nil {
				return packet, errors.New("RESEARCH_EVIDENCE_ID: invalid reference")
			}
		}
		hypotheses[h.ID] = true
	}
	if len(p.Probes) < 1 || len(p.Probes) > 12 {
		return packet, errors.New("RESEARCH_PROBES: 1..12 probes required")
	}
	ids := map[string]bool{}
	ops := map[string]Operation{}
	for _, probe := range p.Probes {
		if checkID(probe.ID) != nil || ids[probe.ID] || !boundedText(probe.Question, 1024) || !boundedText(probe.ExpectedInformation, 1024) || !boundedText(probe.Acceptance, 2048) || probe.Priority < 0 || probe.Priority > 100 {
			return packet, errors.New("RESEARCH_PROBE: invalid identity/question/acceptance")
		}
		ids[probe.ID] = true
		if probe.Effect != "read-only" {
			return packet, errors.New("RESEARCH_EFFECT: no external action or mutation in Diagnostic Sweep")
		}
		if len(probe.Discriminates) < 1 || len(probe.Discriminates) > 5 {
			return packet, errors.New("RESEARCH_DISCRIMINATION: bind probe to competing hypotheses")
		}
		seen := map[string]bool{}
		for _, h := range probe.Discriminates {
			if !hypotheses[h] || seen[h] {
				return packet, errors.New("RESEARCH_DISCRIMINATION: unknown or duplicate hypothesis")
			}
			seen[h] = true
		}
		if len(probe.Operations) < 1 {
			return packet, errors.New("RESEARCH_PROBE: empty probe")
		}
		for _, op := range probe.Operations {
			if _, yes := ops[op.ID]; yes {
				return packet, errors.New("RESEARCH_OPERATION: operation IDs must be unique across probes")
			}
			if op.Op == "check" {
				return packet, errors.New("RESEARCH_EFFECT: owner-approved checks are not assumed read-only")
			}
			switch op.Op {
			case "files", "search":
				if len(op.Paths) < 1 {
					return packet, errors.New("RESEARCH_SCOPE: search/list requires explicit paths")
				}
				for _, s := range op.Paths {
					if !underScope(s, r.PermissionScope.Paths) {
						return packet, errors.New("RESEARCH_SCOPE: operation escapes scope")
					}
				}
			case "read", "read_bytes", "metadata", "hash":
				if !underScope(op.Path, r.PermissionScope.Paths) {
					return packet, errors.New("RESEARCH_SCOPE: operation escapes scope")
				}
			case "read_matches":
				if op.From == "" {
					return packet, errors.New("RESEARCH_DEPENDENCY: read_matches needs a search")
				}
			case "inspect":
				if checkID(op.Artifact) != nil {
					return packet, errors.New("RESEARCH_ARTIFACT: invalid ID")
				}
			case "git_status", "git_diff":
				if !r.PermissionScope.AllowGit || !underScope(".", r.PermissionScope.Paths) {
					return packet, errors.New("RESEARCH_GIT: fixed Git diagnostics require explicit whole-root scope and allowGit")
				}
			default:
				return packet, errors.New("RESEARCH_OPERATION: unsupported operation")
			}
			ops[op.ID] = op
			packet.Operations = append(packet.Operations, op)
		}
	}
	for _, op := range packet.Operations {
		if op.Op == "read_matches" && ops[op.From].Op != "search" {
			return packet, errors.New("RESEARCH_DEPENDENCY: read_matches may only consume search evidence")
		}
	}
	priorities := map[string]int{}
	for _, pr := range p.Probes {
		for _, op := range pr.Operations {
			priorities[op.ID] = pr.Priority
		}
	}
	sort.SliceStable(packet.Operations, func(i, j int) bool { return priorities[packet.Operations[i].ID] < priorities[packet.Operations[j].ID] })
	if er := validatePacket(packet); er != nil {
		return packet, er
	}
	minimum := 1500 + len(p.Probes)*220 + len(packet.Operations)*620
	if r.Limits.OutputUTF8Bytes < minimum {
		return packet, fmt.Errorf("RESEARCH_OUTPUT_LIMIT: provenance requires at least %d UTF-8 bytes; no probes started", minimum)
	}
	// Exact lower bound: user-controlled IDs and questions may be far larger
	// than average metadata. Reject before I/O if even the irreducible report
	// cannot fit; reserve 1024 bytes for status and presentation. Counts include
	// JSON escaping and are not token estimates.
	skeleton := SweepReport{Schema: 1, SweepID: r.SweepID, InvestigationID: p.InvestigationID, TaskID: p.TaskID, GoalRevision: p.GoalRevision, PlanVersion: p.PlanVersion, State: "observed", SourceHash: rootHash, SourceCoverage: "complete", Probes: []ProbeObservation{}, EvidenceRefs: []EvidenceRef{}, Excerpts: []EvidenceExcerpt{}, Gaps: []string{}, UnknownEffects: []string{}, UntestedHypotheses: []string{}, NextSuggestedQuestions: []string{}, ReportArtifact: "a_" + strings.Repeat("a", 24), ReportSHA256: rootHash, Limit: r.Limits.OutputUTF8Bytes}
	for _, pr := range p.Probes {
		po := ProbeObservation{Question: pr.Question, ProbeID: pr.ID, State: "observed", Coverage: "complete", EvidenceIDs: []string{}}
		for _, op := range pr.Operations {
			eid := "ev_" + strings.Repeat("e", 24)
			po.EvidenceIDs = append(po.EvidenceIDs, eid)
			skeleton.EvidenceRefs = append(skeleton.EvidenceRefs, EvidenceRef{ID: eid, ProbeID: pr.ID, OperationID: op.ID, Kind: "observation", Locator: skeleton.ReportArtifact, SHA256: rootHash, ObservedAt: "2026-11-16T00:00:00.000000000Z", Coverage: "complete", SourceHash: rootHash, NoveltyKey: rootHash})
		}
		skeleton.Probes = append(skeleton.Probes, po)
	}
	if len(encoded(skeleton))+1024 > r.Limits.OutputUTF8Bytes {
		return packet, errors.New("RESEARCH_OUTPUT_LIMIT: irreducible question/evidence metadata does not fit; no probes started")
	}
	// No operation reads a user filename inferred from a claim. Only explicit
	// paths or ranges resolved by the existing search/read_matches runner.
	return packet, nil
}

func (e *Engine) captureSources(paths []string) SourceCapture {
	return e.captureSourcesContext(context.Background(), paths)
}
func (e *Engine) captureSourcesContext(ctx context.Context, paths []string) SourceCapture {
	c := SourceCapture{RootHash: digest([]byte(e.Root)), Files: []SourceVersion{}, Coverage: "complete", Gaps: []string{}}
	if ctx.Err() != nil {
		c.Coverage = "unknown"
		c.Gaps = append(c.Gaps, "source_capture_cancelled")
		c.Hash = digest(encoded(c.Files))
		return c
	}
	names, coverage, err := e.paths(paths, false)
	if err != nil {
		c.Coverage = "unknown"
		c.Gaps = append(c.Gaps, cut(err.Error(), 512))
	}
	if !coverage.Complete || coverage.Skipped > 0 {
		c.Coverage = weaker(c.Coverage, "partial")
		c.Gaps = append(c.Gaps, coverage.Reasons...)
	}
	remaining := e.Limits.ScanBytes
	for _, name := range names {
		if ctx.Err() != nil {
			c.Coverage = "unknown"
			c.Gaps = append(c.Gaps, "source_capture_cancelled")
			break
		}
		v := SourceVersion{Path: name}
		p, er := e.path(name)
		if er != nil {
			v.Problem = "unreadable source"
		} else {
			f, er := os.Open(p)
			if er != nil {
				v.Problem = "unreadable source"
			} else {
				before, er := f.Stat()
				if er != nil || !before.Mode().IsRegular() {
					v.Problem = "not a regular source"
				} else {
					v.Bytes = before.Size()
					v.ModifiedNS = before.ModTime().UnixNano()
					if v.Bytes > remaining {
						v.Problem = "source hash byte budget; not a complete snapshot"
					} else {
						// Existing metadata is not enough: a same-size rewrite must invalidate
						// a pinned source. This streaming hash has a finite per-sweep byte bound.
						seal, er := hashReader(&researchContextReader{ctx, f}, remaining)
						if er != nil {
							v.Problem = "source hash failed"
						} else {
							v.SHA256 = seal.SHA256
							remaining -= seal.Bytes
						}
						after, ae := f.Stat()
						if ae != nil || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
							v.Problem = "source changed while hashing"
						}
					}
				}
				f.Close()
			}
		}
		if v.Problem != "" {
			c.Coverage = weaker(c.Coverage, "partial")
			c.Gaps = append(c.Gaps, cut(name+": "+v.Problem, 512))
		}
		c.Files = append(c.Files, v)
	}
	c.Hash = digest(encoded(c.Files))
	return c
}
func verifyPins(c SourceCapture, pins []SourcePin) error {
	m := map[string]SourceVersion{}
	for _, v := range c.Files {
		m[v.Path] = v
	}
	for _, p := range pins {
		v, ok := m[p.Path]
		if !ok || v.Problem != "" || v.SHA256 != p.SHA256 {
			return fmt.Errorf("SOURCE_CHANGED: pinned source %s is missing, incomplete or changed", p.Path)
		}
	}
	return nil
}

// Read the already captured result, not rerun the tool. Verify same-size edits.
func (e *Engine) evidenceData(id string) ([]byte, Artifact, error) {
	f, a, er := e.Store.open(id, "data.json")
	if er != nil {
		return nil, a, er
	}
	defer f.Close()
	b, er := io.ReadAll(io.LimitReader(f, 2<<20+1))
	if er != nil || len(b) > 2<<20 {
		return nil, a, errors.New("evidence exceeds bounded inspection size")
	}
	if digest(b) != a.Files["data.json"].SHA256 {
		return nil, a, errors.New("evidence content hash mismatch")
	}
	return b, a, nil
}
func rawCoverage(v any) (string, bool) {
	coverage := "complete"
	negative := false
	var walk func(any)
	walk = func(x any) {
		switch q := x.(type) {
		case map[string]any:
			for k, val := range q {
				if (k == "complete" || k == "captureComplete" || k == "selectionComplete") && val == false {
					coverage = weaker(coverage, "partial")
				}
				if k == "sourceChangedDuringRead" && val == true {
					coverage = weaker(coverage, "unknown")
				}
				if k == "error" && val != "" {
					coverage = weaker(coverage, "partial")
				}
				if k == "skipped" {
					if n, ok := val.(float64); ok && n > 0 {
						coverage = weaker(coverage, "partial")
					}
				}
				if k == "matches" {
					if a, ok := val.([]any); ok && len(a) == 0 {
						negative = true
					}
				}
				walk(val)
			}
		case []any:
			for _, val := range q {
				walk(val)
			}
		}
	}
	walk(v)
	return coverage, negative
}
func weaker(a, b string) string {
	if a == "unknown" || b == "unknown" {
		return "unknown"
	}
	if a == "partial" || b == "partial" {
		return "partial"
	}
	return "complete"
}
func bindNovelty(op Operation, data any) string {
	// Identity, time, wording, new session and plan names are not new information.
	normalized := op
	normalized.ID = ""
	normalized.Depends = nil
	normalized.From = ""
	if normalized.Op == "search" || normalized.Op == "inspect" {
		normalized.Query = strings.ToLower(normalized.Query)
	}
	if len(normalized.Paths) > 0 {
		normalized.Paths = append([]string{}, normalized.Paths...)
		sort.Strings(normalized.Paths)
	}
	return digest(encoded(map[string]any{"operation": normalized, "observation": stripVolatile(data)}))
}
func stripVolatile(v any) any {
	switch x := v.(type) {
	case map[string]any:
		m := map[string]any{}
		for k, val := range x {
			switch k {
			case "created", "observedAt", "modifiedNS", "durationMs", "artifact", "id", "sourceChangedDuringRead":
				continue
			}
			if k == "query" {
				if q, ok := val.(string); ok {
					val = strings.ToLower(q)
				}
			}
			m[k] = stripVolatile(val)
		}
		return m
	case []any:
		arr := make([]any, len(x))
		for i, val := range x {
			arr[i] = stripVolatile(val)
		}
		return arr
	default:
		return x
	}
}

func (e *Engine) sweep(ctx context.Context, r SweepRequest) (SweepReport, error) {
	packet, er := validateResearch(r, digest([]byte(e.Root)))
	if er != nil {
		return SweepReport{}, er
	}
	unlock, er := lockFile(filepath.Join(e.Store.Root, "operations.lock"))
	if er != nil {
		return SweepReport{}, errors.New("another local packet is executing; do not create a duplicate")
	}
	defer unlock()
	cctx, cancel := context.WithTimeout(ctx, time.Duration(r.Limits.WallSeconds)*time.Second)
	defer cancel()
	started := time.Now()
	journalPath := filepath.Join(e.Store.Root, "packets", "sweep_"+r.SweepID+".json")
	fp := digest(encoded(map[string]any{"request": r, "root": e.Root, "version": Version, "limits": e.Limits}))
	j := sweepJournal{Fingerprint: fp, Request: r, Started: now()}
	resumed := false
	if er = loadJSON(journalPath, &j, 2<<20); er == nil {
		if j.Fingerprint != fp {
			return SweepReport{}, errors.New("SWEEP_ID_CONFLICT: same sweep ID has different plan/source/limits")
		}
		if j.Report != nil {
			data, _, err := e.evidenceData(j.Report.ReportArtifact)
			if err != nil || digest(data) != j.Report.ReportSHA256 {
				return SweepReport{}, errors.New("REPORT_INTEGRITY: saved report bytes differ")
			}
			var raw struct {
				Request SweepRequest `json:"request"`
				Report  SweepReport  `json:"report"`
			}
			if err = json.Unmarshal(data, &raw); err != nil || string(encoded(raw.Request)) != string(encoded(r)) {
				return SweepReport{}, errors.New("REPORT_INTEGRITY: saved request differs")
			}
			raw.Report.ReportArtifact = j.Report.ReportArtifact
			raw.Report.ReportSHA256 = j.Report.ReportSHA256
			expected, err := fitSweep(raw.Report, r.Limits.OutputUTF8Bytes)
			if err != nil || string(encoded(expected)) != string(encoded(j.Report)) {
				return SweepReport{}, errors.New("REPORT_INTEGRITY: journal summary differs from sealed observations")
			}
			expected.Replayed = true
			return fitSweep(expected, r.Limits.OutputUTF8Bytes)
		}
		resumed = true
	} else if !os.IsNotExist(er) {
		return SweepReport{}, er
	}
	if !resumed {
		j.Before = e.captureSourcesContext(cctx, r.PermissionScope.Paths)
		if er = verifyPins(j.Before, r.SourceSnapshot.Pins); er != nil {
			return SweepReport{}, er
		}
		if er = e.Store.free(int64(len(encoded(j))) + 65536); er != nil {
			return SweepReport{}, er
		}
		if er = atomicJSON(journalPath, j); er != nil {
			return SweepReport{}, er
		}
	}
	env, er := e.batchLocked(cctx, packet)
	if er != nil {
		return SweepReport{}, er
	}
	after := e.captureSourcesContext(cctx, r.PermissionScope.Paths)
	report := SweepReport{Schema: 1, SweepID: r.SweepID, InvestigationID: r.Plan.InvestigationID, TaskID: r.Plan.TaskID, GoalRevision: r.Plan.GoalRevision, PlanVersion: r.Plan.PlanVersion,
		State: "observed", SourceHash: j.Before.Hash, SourceCoverage: weaker(j.Before.Coverage, after.Coverage), Probes: []ProbeObservation{}, EvidenceRefs: []EvidenceRef{}, Excerpts: []EvidenceExcerpt{}, Gaps: append([]string{}, j.Before.Gaps...), UnknownEffects: []string{}, UntestedHypotheses: []string{}, NextSuggestedQuestions: []string{}, Limit: r.Limits.OutputUTF8Bytes, Resumed: resumed,
		Summary: "Local observations only; hypothesis decisions and acceptance require evidence-based evaluation. No model was called.", NextAction: "evaluate_once"}
	report.Gaps = append(report.Gaps, after.Gaps...)
	changed := j.Before.Hash != after.Hash
	if changed {
		report.Gaps = append(report.Gaps, "source_changed_during_sweep: do not combine these observations as one consistent snapshot")
		report.SourceCoverage = "unknown"
		report.NextAction = "reconcile_sources"
	}
	if cctx.Err() != nil {
		report.Gaps = append(report.Gaps, "deadline_or_interrupt: completed evidence preserved; no automatic retry")
		report.NextAction = "review_incomplete_probes"
	}
	resultByID := map[string]Result{}
	for _, out := range env.Results {
		resultByID[out.ID] = out
	}
	tested := map[string]bool{}
	full := map[string]any{"request": r, "before": j.Before, "after": after, "observations": map[string]any{}}
	for _, probe := range r.Plan.Probes {
		po := ProbeObservation{Question: probe.Question, ProbeID: probe.ID, State: "observed", Coverage: "complete", EvidenceIDs: []string{}}
		for _, op := range probe.Operations {
			out := resultByID[op.ID]
			var raw any
			var data []byte
			var a Artifact
			if out.Artifact != "" {
				a, er = e.Store.manifest(out.Artifact)
				if er == nil && a.Kind == "capture" {
					// A fixed Git process captures full stdout/stderr; not a semantic verdict.
					data = encoded(a)
					raw = a
				} else if er == nil {
					data, a, er = e.evidenceData(out.Artifact)
					if er == nil {
						er = json.Unmarshal(data, &raw)
					}
				}
			} else {
				raw = map[string]any{"state": out.State, "error": out.Text}
				data = encoded(raw)
				out.Artifact, er = e.Store.save("probe-outcome", data, out.Text)
				if er == nil {
					a, _ = e.Store.manifest(out.Artifact)
				}
			}
			cov, negative := rawCoverage(raw)
			if er != nil {
				cov = "unknown"
				report.Gaps = append(report.Gaps, op.ID+": evidence_unavailable_or_corrupt")
				po.State = "blocked"
			}
			if out.State != "completed" {
				cov = "unknown"
				po.State = "blocked"
			}
			if changed {
				cov = "unknown"
			}
			ref := EvidenceRef{ID: "ev_" + digest([]byte(r.SweepID + ":" + op.ID))[:24], ProbeID: probe.ID, OperationID: op.ID, Kind: "observation", Locator: out.Artifact, SHA256: digest(data), ObservedAt: a.Created, Coverage: cov, SourceHash: j.Before.Hash, NoveltyKey: bindNovelty(op, raw), Negative: negative}
			if op.Op == "read" || op.Op == "read_bytes" || op.Op == "read_matches" {
				ref.Kind = "file-span"
			}
			if op.Op == "inspect" {
				ref.Kind = "log-span"
			}
			if a.Kind == "capture" {
				ref.Kind = "test-run"
				ref.SHA256 = digest(encoded(a))
				if !a.Complete {
					cov = weaker(cov, "partial")
					ref.Coverage = cov
				}
			}
			po.Coverage = weaker(po.Coverage, cov)
			po.EvidenceIDs = append(po.EvidenceIDs, ref.ID)
			report.EvidenceRefs = append(report.EvidenceRefs, ref)
			if len(report.Excerpts) < 3 {
				report.Excerpts = append(report.Excerpts, EvidenceExcerpt{ref.ID, cut(out.Text, 768), out.OutputTruncated || len(out.Text) > 768})
			}
			full["observations"].(map[string]any)[op.ID] = map[string]any{"result": out, "evidence": ref}
		}
		if po.Coverage != "complete" {
			report.Gaps = append(report.Gaps, probe.ID+": coverage="+po.Coverage)
			report.NextSuggestedQuestions = append(report.NextSuggestedQuestions, "Resolve missing evidence for: "+cut(probe.Question, 256))
		}
		if po.State == "observed" && po.Coverage == "complete" {
			for _, h := range probe.Discriminates {
				tested[h] = true
			}
		}
		po.Summary = "Collected observations for: " + cut(probe.Question, 384) + ". This is not confirmation of a cause."
		report.Probes = append(report.Probes, po)
	}
	for _, h := range r.Plan.Hypotheses {
		if !tested[h.ID] {
			report.UntestedHypotheses = append(report.UntestedHypotheses, h.ID)
		}
	}
	if resumed {
		report.Gaps = append(report.Gaps, "resumed_saved_packet; original source snapshot retained")
	}
	if len(report.Gaps) > 0 {
		report.State = "partial"
	}
	if len(report.NextSuggestedQuestions) == 0 {
		report.NextSuggestedQuestions = append(report.NextSuggestedQuestions, "Compare the observations against the plan's competing predictions; choose one distinguishing next check if alternatives remain.")
	}
	report.DurationMS = time.Since(started).Milliseconds()
	full["report"] = report
	data := encoded(full)
	report.ReportArtifact, er = e.Store.save("diagnostic-sweep", data, report.Summary)
	if er != nil {
		return SweepReport{}, er
	}
	report.ReportSHA256 = digest(data)
	// The complete report and exact source/evidence are stored before trimming the
	// presentation. A crash here can recover the already executed local_batch.
	bounded, er := fitSweep(report, r.Limits.OutputUTF8Bytes)
	if er != nil {
		return SweepReport{}, fmt.Errorf("%w; full local report=%s sha256=%s; no operation is retried", er, report.ReportArtifact, report.ReportSHA256)
	}
	j.Report = &bounded
	if er = atomicJSON(journalPath, j); er != nil {
		return SweepReport{}, er
	}
	return bounded, nil
}
func fitSweep(r SweepReport, limit int) (SweepReport, error) {
	r.Limit = limit
	for attempt := 0; attempt < 256; attempt++ {
		for n := 0; n < 8; n++ {
			size := len(encoded(r))
			if r.Bytes == size {
				break
			}
			r.Bytes = size
		}
		if len(encoded(r)) <= limit {
			return r, nil
		}
		r.Truncated = true
		longest := -1
		for i := range r.Excerpts {
			if longest < 0 || len(r.Excerpts[i].Text) > len(r.Excerpts[longest].Text) {
				longest = i
			}
		}
		if longest >= 0 && len(r.Excerpts[longest].Text) > 0 {
			r.Excerpts[longest].Text = cut(r.Excerpts[longest].Text, len(r.Excerpts[longest].Text)-256)
			r.Excerpts[longest].Truncated = true
			continue
		}
		reduced := false
		for i := range r.Probes {
			if len(r.Probes[i].Summary) > 64 {
				r.Probes[i].Summary = cut(r.Probes[i].Summary, 64)
				reduced = true
			}
		}
		if reduced {
			continue
		}
		if len(r.NextSuggestedQuestions) > 1 {
			r.NextSuggestedQuestions = r.NextSuggestedQuestions[:1]
			continue
		}
		if len(r.Gaps) > 3 {
			r.Gaps = append(append([]string{}, r.Gaps[:2]...), "Additional gaps in full report artifact")
			continue
		}
		return r, errors.New("SWEEP_OUTPUT_LIMIT: evidence metadata cannot fit; read saved report in smaller ranges")
	}
	return r, errors.New("SWEEP_OUTPUT_LIMIT: failed to bound report")
}

// Deterministic ranking is advisory: a model/user supplies questions and
// hypotheses, never this function. We deliberately do not fabricate a cause.
func orderedQuestions(p ResearchPlan) []string {
	probes := append([]Probe{}, p.Probes...)
	sort.SliceStable(probes, func(i, j int) bool { return probes[i].Priority < probes[j].Priority })
	out := []string{}
	for _, probe := range probes {
		out = append(out, probe.Question)
	}
	return out
}

func hashReader(r io.Reader, limit int64) (FileSeal, error) {
	h := sha256.New()
	n, er := io.Copy(h, io.LimitReader(r, limit+1))
	if er != nil {
		return FileSeal{}, er
	}
	if n > limit {
		return FileSeal{}, errors.New("hash byte limit")
	}
	return FileSeal{Bytes: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

type researchContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *researchContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}
