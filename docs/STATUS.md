# Состояние реализации · 0.5

Продолжение `3967b46` без новой кодовой базы. Подробности: [инкремент](INCREMENT_0_5.md), [использование](RESEARCH_RUNBOOK.md), [проверки](../verification/research-0.5/REPORT.md).

| Компонент | Фактически сделано | Открыто |
|---|---|---|
| Diagnostic Sweep | Go/Linux реальное I/O, existing local_batch, ограничение ответа и provenance | Windows/реальный агент |
| ResearchPlan/policy | 10 контрактов, goal binding, зависимости, альтернативы, стоп-правила; TS/Go tested | Смысловое качество гипотез |
| Diagnosis-first | Embedded в MCP initialize и source Codex instructions | Соблюдение всем внутренним Codex, model A/B |
| TaskStore | Schema v4 actual SQL tested; Rust методы source | Rust/Windows/end-to-end |
| Desk trace | Сборка, pure view/DOM-stub, безопасный локальный импорт | Браузер/UX/Windows и реальные события |
| Capture/packets | Старые и новые Go/race тесты сохранены | Полный context ceiling Codex |
| Native transport | Прежняя стыковка и research event path source | Windows Rust/Tauri/App Server |

W0, W5, W6, W7 остаются открыты. Частичные W1–W4 не означают прохождение G1/G2/G3 или принятие всей PF. Сеть/модели не вызывались. Старые отчёты 0.3/0.4 сохранены.

## Native delivery maintenance

Desktop entrypoint and release packaging are corrected. The Windows workflow now invokes `scripts/Build-Windows.ps1 -ResolveDependencies`, including the helper, desktop, host, offline self-tests and byte-integrity validation. These target steps are source-only until Actions actually executes them.

`node scripts/publish-github.mjs` performs local preflight only; adding `--publish` performs one authorized Git push to the fixed `studio/native-ci` branch. It uses existing Git authentication and never asks for tokens, launches a browser, or force-pushes. Unknown or unrelated remote work blocks publication. Local bare-repository tests are not a GitHub run.

Current continuation has 367 passing Node tests and 107 passing top-level Go tests (plus 10 nested cases). No previous test was altered. Actual GitHub write, Windows native build, GUI and live Codex remain open.
