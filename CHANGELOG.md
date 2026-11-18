## 2026-11-18 — Task continuation and observed protocol behavior

- Connect actual TaskStore continuation to Codex thread/start and thread/resume, with a 12 KiB UTF-8 cap, exact goal/stops, evidence provenance, bounded saved observations, explicit omissions, and no extra model call.
- Add read-only capsule preview, explicit new-context action, prior-session selection and lost-ACK recovery to Assistant Desk; preserve drafts and task budgets.
- Check unresolved/active task sessions before new dispatch, including unresolved commands older than the latest 1000 command records. Preserve frozen outbox parameters across checkpoint changes.
- Add real native-child stdio tests for fragmented UTF-8, late ACK, post-dispatch process death and completion-before-ACK ordering.
- Correct the actual Codex 0.170.0 Windows precondition: a newly created idle thread has no materialized turn history before its first message. Strict readback handling keeps unknown commands unresolved; arbitrary RPC errors still fail.
- Use the actual package version in initialize. Add reproducible metadata-only Codex CLI probes and an official pinned Windows Codex CI job; protocol assertions fail rather than masquerading as environment unavailability.
- Linux Codex 0.167.0-alpha.4 initialized without a model request; thread creation was unavailable because of the environment's bwrap restriction. No sandbox bypass.
- Keep MCP pre-execution admission, inherited MCP filtering, native semantic Finding persistence and complete Windows/user/GPU acceptance explicitly open. See verification/continuation-0.5/REPORT.md.

## 2026-11-18 — Existing runtime built on Windows

- Published the existing source to `studio/native-ci` without changing legacy main; exact imported tree matches `c7b6e05`.
- Fixed 17 native Rust/SQLite u64 conversion compile errors with checked signed SQL boundaries; overflow cannot mutate the database.
- Fixed Windows checkout line endings for hash-pinned fixtures using `.gitattributes`.
- Actual GitHub run `44271721879`: all four jobs passed; compiled desktop/host/economy x64 executables, host and economy offline self-tests passed.
- 367 Node tests and 46 Rust tests passed on Windows; Go tests passed on Linux and Windows. Native Linux Rust tests/self-test also passed.
- Added the exact Windows Cargo.lock (SHA256 `682d81ce9c3f7d10e458c57b241cf39007c15f7b3f4923f8b8ea2b3b6f0d955c`), npm lock, delivery evidence and current usage links.
- No new inference backend is included. GUI, live Codex session, user GPU performance and containment acceptance remain open.

## 0.5 maintenance · native delivery and safe publication

- Continue `8df259d`, preserving the real 0.4 baseline and every existing test file.
- Desktop now opens host-backed `assistant.html`; native metadata version matches 0.5.0.
- Windows build now compiles and packages desktop + host + economy together, validates all file hashes/PE headers, and invokes explicit offline self-tests. CI uploads the full package, lockfile candidate and build log. No GUI or provider calls are added.
- Added offline `studio-host --selftest` source: fresh temporary store, reopened unknown command and duplicate-send refusal; native compilation/execution remains pending.
- Added fixed-target publication command: real Git history, reviewed staging ancestry only, no force/main write, readback after a single push. Seven real local bare-repository cases passed, including remote race and unrelated work refusal.
- Local validation: 367 Node tests; 107 Go top-level tests (10 additional subcases), race detector and vet. Windows test executable cross-compiles; not executed.
- Remote GitHub source branch remains unchanged. This session exposes only read-side GitHub methods and container Git cannot resolve github.com. No published commit or Actions run claimed.

## 0.5 · implementation / local testing — 2026-11-16

Diagnostic Sweep reuses local_batch and the existing artifact store. Added read-only research contracts, task checkpoints, trace view, embedded diagnosis-first procedure and regression tests. Fixed empty-search, recovered dependency-integrity and transient journal-rename accounting defects. Added preflight rejection of oversized mandatory report metadata. Windows EXE cross-built; native Rust/Windows/live Codex and model A/B remain open. See verification/research-0.5/REPORT.md.

# Изменения

## Спецификация 0.5 · 2026-11-16 (только ТЗ; версия приложения остаётся 0.4)

- Из экспорта `result.json` просмотрены 394 Telegram-сообщения, отобраны архитектурно значимые материалы; отобранные внешние механизмы сопоставлены с первичными проектами. Сам Telegram-экспорт в репозиторий не добавлен.
- Добавлено ТЗ на диагностику через гипотезы/различающие проверки/основание выводов, пакет `Diagnostic Sweep` поверх Go economy и checkpoint в существующем TaskStore; Code Mode — только сменяемый адаптер.
- Поставлено задание реализатору, добавлены открытые work items `R05-01..03`. Ничего из этих требований в коде не реализовано.
- Повторены доступные Linux-проверки исходной 0.4: `npm run verify` 305/305, `go test -race -count=1 -v ./...` — 65/65, без гонок (обычный Go test тоже OK). Windows, Rust/Tauri и живой Codex в этом инкременте не запускались.

## 0.4.0 — 2026-11-11

- Продолжение 33291c9, старые 305 проверок сохранены.
- Собран stdlib-only Windows x64 помощник локальных пакетов и захвата логов; Python/Node/Rust не нужны для его запуска.
- Добавлены local_batch/context_pack, устойчивые packet IDs, ограничение полного ответа, инспекция байтов/строк/совпадений и объявленные check-команды.
- Профиль существующего Codex на один запуск, без изменения глобального config и без чтения credentials. Native Rust-стыковка написана, не собрана.
- Опциональный HTTP/SSE request gate испытан на локальном получателе; не внедрён как прозрачный подписочный маршрут. Не заявлен общий hard-token ceiling Codex.
- Испытан реальный лог 100 МиБ, пакет20 чтений, restart/unknown/duplicate/limits. Внешние модели не вызывались.


## 0.2 · 8 ноября 2026

- Воспроизведено 86/86 исходных тестов. Теперь 133/133, включая 47 новых.
- Исправлена проверка только первого артефакта: все выходы, исходные критерии и exact-result acceptance receipt.
- Добавлены TypeScript outbox, отдельный IndexedDB repository, read-only get_command, восстановление неизвестного исхода и повтор с прежним ID. Native protocol 2 сохраняет хэш точных bytes запроса.
- Написаны SQLite v2 migrations, durable cancel, terminal/acceptance fences и повторное чтение артефактов. Rust-код не собран.
- В UI добавлены вкладки результатов, повторная проверка снимка и очередь восстановления; GUI не запускался.
- Выполнен отдельный CLI crash/reopen опыт и реальный файловый маршрут. SQL исполнялся на dev SQLite, не целевом WAL.
- Написаны 12 новых Rust-тестов (26 всего), общий golden binding и Verify-Native.ps1. Полный набор npm-тестов включён в Build-Windows.ps1.
- G1/G2/G3 и полные PF не приняты. Никаких внешних моделей, платных вызовов, Computer Use или GUI/dev-server.

## 0.1 · 8 ноября 2026

- Создан локальный репозиторий реализации, не очередная редакция ТЗ.
- Добавлены semantic document, multi-sheet views, редактор с версиями/CAS/undo и типизированный DAG preflight.
- Реализованы встроенные операции с фактическим содержимым, финальные критерии, манифесты SHA-256 и экспорт новых копий.
- Добавлены рабочий HTML/TypeScript интерфейс, Web Worker и отдельные профили браузер/нативный мост.
- Добавлены pure-core правила бюджета, no-progress, retry, generations и ограниченных очередей. Не выданы за включённый production scheduler.
- Подготовлены Rust core, SQLite host, Windows IPC и Tauri-оболочка. Нативный код не собран на текущем стенде.
- Исправлены сохранение исходного снимка для исторического diff, повторное использование goal revision после undo, незавершённые задачи при конкурентной отмене, shape ответа native folder picker, подмена авторитетного native acceptance состоянием UI и ложный адресат общего composer.
- Добавлены CLI-проверки, production worker test, файловый маршрут, Windows build script без автозапуска и явная матрица незакрытых функций.
- Не запускались GUI, браузеры, dev-server, платные модели, Codex или внешние беседы.

## 0.3.0 — 2026-11-10

- Continue Studio 0.2 and preserve Desk source/tests in the same repository.
- Add mounted directory contracts without widening the original text import.
- Add task/session SQL migration v3 and an external-command state machine separate from built-in Run.
- Persist the send fence before external dispatch; add exact readback reconciliation and pre-dispatch cancellation tombstones.
- Add native App Server transport source and allowlisted Tauri operations.
- Add a host-backed assistant UI; keep all scenario controls in a separate regression file.
- Adapt live envelopes to the existing Desk telemetry analyzer; label clock/coverage limitations.
- Verify a test-child crash after acceptance but before ACK without a duplicate mutation.
- Rust/Windows/live Codex remain uncompiled or untested; no release binary or gate acceptance.

## 0.5 CI source identity guard (2026-11-18)

- Added `scripts/verify-source.mjs` to fail closed if the CI checkout is an old UI-TARS fork or a partial staging tree, rather than reporting a misleading green Windows toolchain probe.
- Added three positive/negative tests for the source identity gate; 351 Node tests and 107 Go tests passed on Linux (`go test -race`).
- Added explicit `studio-host` binary build to the Windows Rust CI job after core/host tests. Windows runner result is **not yet available**: this source snapshot has not been pushed to a GitHub branch.
- The workflow-generated `Cargo.lock` is a candidate, not a reviewed pinned lock. Windows Server 2025 compilation is not Windows 11 GUI acceptance. No model or external provider was invoked.
