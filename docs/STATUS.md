# Состояние реализации · 0.5

Продолжение `3967b46` без новой кодовой базы. Подробности: [инкремент](INCREMENT_0_5.md), [использование](RESEARCH_RUNBOOK.md), [проверки](../verification/research-0.5/REPORT.md).

| Компонент | Фактически сделано | Открыто |
|---|---|---|
| Diagnostic Sweep | Linux и Windows тесты, реальное I/O, existing local_batch, ограничение ответа и provenance | Реальный агент |
| ResearchPlan/policy | 10 контрактов, goal binding, зависимости, альтернативы, стоп-правила; TS/Go tested | Смысловое качество гипотез |
| Diagnosis-first | Embedded в MCP initialize и source Codex instructions | Соблюдение всем внутренним Codex, model A/B |
| TaskStore | Rust/SQLite v4, 37 core/recovery тестов на Linux и Windows; checked INTEGER boundary | Сквозная пользовательская сессия |
| Desk trace | Сборка, pure view/DOM-stub, безопасный локальный импорт | Браузер/UX/Windows и реальные события |
| Capture/packets | Старые и новые Go/race тесты сохранены | Полный context ceiling Codex |
| Native transport | Windows Rust/Tauri собраны; 9 host-тестов, самопроверка бинарника | Живой App Server и GUI |

W0, W5, W6, W7 остаются открыты. Частичные W1–W4 не означают прохождение G1/G2/G3 или принятие всей PF. Запросы к моделям не выполнялись. Старые отчёты 0.3/0.4 сохранены.

## Продолжение с сохранёнными результатами

Хост автоматически подключает память TaskStore к `thread/start`/`thread/resume`; собственный пакет ограничен 12 288 байт. UI показывает его размер и содержание, позволяет открыть новый тред той же задачи и вернуться к прежним сессиям. Параметры остаются в прежнем durable outbox; неподтверждённая отправка не пересобирается и не повторяется. Добавлены проверки настоящего stdio-транспорта и CLI-проба установленного Codex без `turn/start`.

Linux Codex 0.167.0-alpha.4 прошёл initialize; восемь форм запросов соответствуют локальной схеме. Полный сценарий метаданных на этом Linux остановился на ограничении bwrap. Windows CI дополнен независимой проверкой закреплённого Codex 0.170.0. [Фактические результаты и границы](../verification/continuation-0.5/REPORT.md).

Обнаруженные остатки: MCP выполняет sweep до TaskStore admission, унаследованные MCP не отключаются добавлением локального сервера, native-сохранение смысловых выводов не подключено. Уменьшение размера собственного пакета не выдано за измеренное уменьшение всего модельного контекста.

## Windows-сборка выполнена

18 ноября все четыре задания [GitHub Actions](https://github.com/ilyasmaxutov/UI-TARS-desktop/actions/runs/44271721879) прошли. Собраны desktop, host и economy helper; два служебных EXE реально запущены в режиме самопроверки. 367 Node-тестов, 46 Rust-тестов на Windows, Go-тесты на Linux/Windows. Исправлены 17 SQL conversion errors и CRLF-преобразование байтов хешированных образцов.

[Комплект Windows x64](https://github.com/ilyasmaxutov/UI-TARS-desktop/actions/runs/44271721879/artifacts/14413531161) · [Проверки и манифест](../verification/runtime-native/REPORT.md).

`native/Cargo.lock` совпадает с lockfile успешной целевой сборки. Основа остаётся Codex App Server, TaskStore, Assistant Desk и прежние локальные инструменты. Новый backend инференса не добавлен. Измерений «300%» и запуска на пользовательском GPU нет.

GUI и реальный модельный ход не запускались. Полная пользовательская и изоляционная приёмка остаются открытыми; наличие компилируемого клиента и metadata-пробы не закрывает эти требования.
