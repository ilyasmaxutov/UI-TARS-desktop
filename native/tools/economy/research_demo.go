package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Generated regression scenario, NOT an inference engine. The hypothesizer and
// evaluator are explicitly authored fixture inputs; all observations use real I/O.
func researchDemo(out string, large bool) error {
	if out == "" {
		return errors.New("research-demo requires --output <new directory>")
	}
	if er := os.Mkdir(out, 0700); er != nil {
		return er
	}
	root := filepath.Join(out, "fixture-project")
	if er := os.Mkdir(root, 0700); er != nil {
		return er
	}
	files := map[string]string{"host.log": "initialize=ok\nresume=accepted\ntransport=closed_after_write\n", "state.txt": "command_id=cmd-7\nstate=in_flight\n", "recent-turns.json": "{\"source\":\"explicit fixture readback, not real Codex\",\"items\":[{\"commandMarker\":\"cmd-7\",\"turnId\":\"turn-9\",\"status\":\"completed\"}]}\n"}
	for name, text := range files {
		if er := writeNew(filepath.Join(root, name), []byte(text)); er != nil {
			return er
		}
	}
	e, er := newEngine(root, filepath.Join(out, "private"))
	if er != nil {
		return er
	}
	size := 1 << 20
	if large {
		size = 100 << 20
	}
	exe, er := os.Executable()
	if er != nil {
		return er
	}
	log, er := e.capture(context.Background(), CheckSpec{Program: exe, Args: []string{"__fixture", fmt.Sprint(size)}, TimeoutSeconds: 120})
	if er != nil {
		return er
	}
	p := ResearchPlan{Schema: 1, TaskID: "fixture_task", InvestigationID: "resume_diagnosis", GoalRevision: 1, OriginalGoal: "Установить причину неопределённого resume, не отправляя команду повторно.", PlanVersion: 1, Question: "Команда не принята или подтверждение потеряно?", Scope: []string{"host.log", "state.txt", "recent-turns.json"}, StopRules: []string{"No mutation or external request; this is an offline fixture", "Stop if readback is ambiguous; a missing record does not authorize retry"}, Budget: ResearchBudget{6, 30, 24576, 3}, Hypotheses: []Hypothesis{{ID: "ack_lost", Claim: "Получатель принял команду, потерян ACK", Predicts: []string{"В readback есть исходный commandMarker"}, State: "open"}, {ID: "not_accepted", Claim: "Команда не была принята", Predicts: []string{"Авторитетная завершённая сверка исключает применение"}, State: "open"}}, Probes: []Probe{
		{ID: "transport", Question: "Что записано до обрыва?", Discriminates: []string{"ack_lost", "not_accepted"}, Effect: "read-only", Priority: 0, ExpectedInformation: "Порядок приёма и обрыва", Acceptance: "Точные строки, не диагноз", Operations: []Operation{{ID: "host", Op: "read", Path: "host.log", Lines: 20}}},
		{ID: "local_state", Question: "Что известно локально?", Discriminates: []string{"ack_lost", "not_accepted"}, Effect: "read-only", Priority: 1, ExpectedInformation: "Неизвестный внешний исход", Acceptance: "in_flight не доказывает результат", Operations: []Operation{{ID: "state", Op: "read", Path: "state.txt", Lines: 20}}},
		{ID: "captured_output", Question: "Есть ли ошибка в середине большого сохранённого вывода?", Discriminates: []string{"ack_lost", "not_accepted"}, Effect: "read-only", Priority: 2, ExpectedInformation: "Найти точный фрагмент без перезапуска", Acceptance: "Ссылка на захваченный лог, не вывод о провайдере", Operations: []Operation{{ID: "middle", Op: "inspect", Artifact: log.ID, Stream: "stdout.log", Query: "DISTINCT_MIDDLE_EVIDENCE", Lines: 20}}},
	}}
	r := SweepRequest{SweepID: "initial", Plan: p, SourceSnapshot: SourceExpectation{RootHash: digest([]byte(e.Root)), Pins: []SourcePin{}}, Limits: SweepLimits{24576, 30}, PermissionScope: SweepPermission{Paths: p.Scope, Effect: "read-only"}}
	first, er := e.sweep(context.Background(), r)
	if er != nil {
		return er
	}
	fileJSON(filepath.Join(out, "initial.request.json"), r)
	fileJSON(filepath.Join(out, "initial.report.json"), first)
	// This transition is scripted by the test author, not a claimed model decision.
	p.PlanVersion = 2
	p.Question = "Есть ли исходный cmd-7 в доступной readback-фикстуре?"
	p.Probes = []Probe{{ID: "authoritative_readback", Question: p.Question, Discriminates: []string{"ack_lost", "not_accepted"}, Effect: "read-only", Priority: 0, ExpectedInformation: "Один исходный ID и точный turnId", Acceptance: "Совпадение в fixture; не живая гарантия", Operations: []Operation{{ID: "readback", Op: "read", Path: "recent-turns.json", Lines: 20}}}}
	r.Plan = p
	r.SweepID = "readback"
	second, er := e.sweep(context.Background(), r)
	if er != nil {
		return er
	}
	fileJSON(filepath.Join(out, "readback.request.json"), r)
	fileJSON(filepath.Join(out, "readback.report.json"), second)
	reopen, er := newEngine(root, e.Store.Root)
	if er != nil {
		return er
	}
	replayed, er := reopen.sweep(context.Background(), r)
	if er != nil {
		return er
	}
	var found bool
	for _, x := range first.Excerpts {
		if strings.Contains(x.Text, "DISTINCT_MIDDLE_EVIDENCE") {
			found = true
		}
	}
	if !found || !replayed.Replayed || second.ReportSHA256 != replayed.ReportSHA256 {
		return errors.New("fixture observation/replay failed")
	}
	for name, text := range files {
		b, er := os.ReadFile(filepath.Join(root, name))
		if er != nil || string(b) != text {
			return errors.New("fixture source changed")
		}
	}
	finding := map[string]any{"id": "fixture_interpretation", "kind": "inferred", "author": "agent", "assertion": "В искусственной readback-записи присутствует cmd-7/turn-9. Это различает заданные альтернативы только для данного стенда.", "scope": "generated fixture files", "evidenceIds": []string{second.EvidenceRefs[0].ID}, "counterEvidenceIds": []string{}, "limitations": []string{"Переход и интерпретация заданы автором теста; ни модель, ни настоящий Codex не вызывались."}, "nextCheck": "Повторить read-only сверку на разрешённой живой сессии; не повторять исходную мутацию."}
	cp := map[string]any{"schema": 1, "sequence": 4, "plan": p, "reports": []SweepReport{first, second}, "findings": []any{finding}, "status": "review", "nextAction": "Inspect fixture evidence; live root-cause diagnosis remains untested"}
	if er = fileJSON(filepath.Join(out, "checkpoint.json"), cp); er != nil {
		return er
	}
	result := map[string]any{"version": Version, "platform": runtime.GOOS + "/" + runtime.GOARCH, "fixture": true, "modelCalls": 0, "observedTokens": nil, "sweeps": 2, "operations": 4, "initialReplyBytes": len(encoded(first)), "nextReplyBytes": len(encoded(second)), "capturedBytes": log.Files["stdout.log"].Bytes, "capturedSHA256": log.Files["stdout.log"].SHA256, "captureComplete": log.Complete, "middleFound": found, "restartReplayedSameReceipt": replayed.Replayed, "sourcesUnchanged": true, "abAgentExperiment": false, "note": "Real file I/O and captured process output; scripted planning/evaluation. No token-savings claim."}
	if er = fileJSON(filepath.Join(out, "report.json"), result); er != nil {
		return er
	}
	printJSON(result)
	return nil
}

var _ = json.Valid
