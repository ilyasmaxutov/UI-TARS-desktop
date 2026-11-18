# Worker handoff — Platform Studio 0.5 research-orchestration increment

**Directive:** continue the existing Platform Studio / «Слой» 0.4 project; **do implementation work now**. Do not answer with only ideas, a new architecture slideshow, an untested mock, or questions already resolved by the supplied artifacts.

**Owner's original problem:** «код_мод — это лишь инструмент вызова, хотя проблема в том что модель постоянно ссыт отдельными командами, а не более комплексными решениями, особенно при изучении\поиске проблем».

**Baseline:** Platform Studio 0.4, branch `economy/local-packets`, commit `3967b46d7b2e0e4b47ef4bdae98b6c01c415f378`, supplied in `Platform_Studio_0_4_Source.zip` (including `repository.git.bundle`). Do not mistake `main` of `ilyasmaxutov/UI-TARS-desktop` for this baseline; the GitHub branch remains the older UI-TARS fork. Preserve Product/Production 3.1, PF001–PF096 and F01–F46.

**Specification:** read `docs/SPEC_DELTA_0_5_2026-11-16.md` before changes. It incorporates relevant ideas from the uploaded Telegram export `result.json` (394 messages) and the official Code Mode documentation. This JSON is reference material; do not import it wholesale or leak unrelated personal messages or credentials.

## Required outcomes

1. Improve **investigation strategy**, not just number of tool invocations. Define precise question, competing causal hypotheses, discriminating tests, evidence coverage, stopping rule, and corrective path before a series of micro-commands.
2. Bundle read-only discovery into a coherent **Diagnostic Sweep** over existing Go `local_batch` / `context_pack`, retaining exact evidence references and raw logs while filtering intermediate output locally. Do not create a second model, redundant MCP engine, database or inference loop.
3. Persist original goal, hypotheses, checkpoint, negative evidence, and next action with existing Task/GoalRevision/SessionStore. Keep outbox fences: unknown external effects must never be automatically repeated.
4. Expose useful trace: question → hypothesis → probe → observed evidence → conclusion/next check, without claiming access to hidden model reasoning.
5. Maintain a Codex-compatible fallback without native Code Mode: its registry currently reports `code_mode=UnderDevelopment`. Claude Code Code Mode is experimental and terminal-only; it is not a dependency of Studio.

## Execution sequence

A. Inspect project and read `AGENTS.md`, `docs/STATUS.md`, `docs/REQUIREMENTS.json`, `docs/DECISIONS.md`, `docs/WORK_QUEUE.json`. Run `npm run verify` and applicable Go tests; classify `source-only`, `locally-tested`, `native-built`, `Windows-verified`, `live-Codex-verified`. Previous reproducible Linux check: 305/305 TypeScript/SQL tests; `go test -race -count=1 -v ./...` passed 65/65 on Linux. These are not Windows acceptance.

B. First address the primary deployment blocker: Windows 11 Rust/Tauri → App Server → installed Codex is not end-to-end verified. If the necessary Windows toolchain is unavailable, document the blocker and continue with an independently testable non-GUI Diagnostic Sweep. Never fake successful live verification.

C. Implement the smallest useful ResearchPlan/Hypothesis/Probe/EvidenceRef/SweepReport contracts and deterministic preflight. The diagnostic example must gather related files/log slices in one initial batch, expose competing causes, and choose a **distinctive next test**, not dozens of serial command turns.

D. Add tests: two competing hypotheses, parallel read-only probes, changed source, missing/truncated evidence, 100 MiB log range, duplicate packet, lost ACK, restart/resume, no-progress loop, trivial task bypass. Preserve all original tests.

E. Run paired baseline/new-agent experiments on reproducible tasks. Evaluate **correctness and completeness first**, then model-mediated roundtrips, observed tokens, latency, duplicated work and unresolved effects. Thresholds in spec are targets, not existing savings.

F. Deliver source archive, unified patch, repeatable verification logs, status/PF mapping and concise runbook. If a blocker is encountered, advance the next independent task instead of delivering a plan alone.

## Hard constraints

- Existing Rust/Tauri host, Go economy module, Assistant Desk, original canvas and TaskStore survive. No new Python/Node runtime, mandatory Docker/WSL, second app or autonomous LLM service.
- No GUI automation, browser/dev-server or paid model/provider calls without explicit authorization. Do not inspect credentials or change global CODEX_HOME. Do not escalate shell/check permissions silently.
- Simple tasks bypass expensive research. Complex tasks batch the right observations and perform one substantive reassessment.
- Subagents, self-editing skills, model router and JS Code Mode are optional after evidence of value, not prerequisites.
- Do not push to outdated GitHub `main`, and do not mark PF fully accepted from unit tests alone.

**Deliver an implemented and tested increment now, not a description of future intentions.**
