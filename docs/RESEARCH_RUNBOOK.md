# Использование диагностического инкремента 0.5

## Windows helper (без сборки всей Studio)

Windows EXE cross-compiled из этих исходников. На Windows в текущем стенде не запускался, не подписан. Необходим установленный Codex только для команды launch.

В PowerShell из распакованной папки:

```powershell
.\studio-economy.exe selftest
.\studio-economy.exe research-demo --output "$PWD\research-check"
```

Вторая команда создаёт НОВУЮ папку, генерирует искусственный случай потери ACK, захватывает 100 МиБ stdout дочернего fixture-процесса, выполняет два диагностических пакета и проверяет повторное чтение результата. Нужны около 110 МиБ диска. Существующая папка не перезаписывается. Сеть и модель не вызываются. Не использовать реальный проект как output.

Файлы `initial.report.json`, `readback.report.json`, `report.json`, `checkpoint.json` содержат реальные результаты локального выполнения. Гипотезы, переход к следующей проверке и итоговая интерпретация сценария заданы автором теста, не моделью.

Открой `assistant.html` вручную → «Исследование» → «Открыть контрольную точку» → `research-check\checkpoint.json`. Импорт ничего не исполняет, не записывает данные в TaskStore и не удостоверяет происхождение JSON. Полные артефакты находятся в `research-check\private`; 100 МиБ сырья не встраиваются в интерфейс.

Для работы установленного Codex с настоящим проектом используется прежний путь:

```powershell
.\studio-economy.exe launch --project 'C:\Dev\MyProject'
```

Теперь тот же локальный MCP предоставляет `diagnostic_sweep` и подключённую diagnosis-first процедуру. Это начинает обычную пользовательскую сессию Codex; дальнейшие модельные обращения расходуют его квоту. Ничего подобного не запускалось при разработке этой поставки. Установленная версия Codex и effective configuration должны поддерживать профиль; глобальная конфигурация не переписывается.

## Контракт разработчика

```powershell
.\studio-economy.exe research-source --project 'C:\Dev\MyProject'
.\studio-economy.exe sweep-preflight --project 'C:\Dev\MyProject' --input '.\request.json'
.\studio-economy.exe sweep --project 'C:\Dev\MyProject' --input '.\request.json'
```

Plan использует **точный rootHash**, возвращённый research-source. 10 образцов request находятся в `fixtures/research/`: их нулевой rootHash — явный placeholder для тестового корня, а не разрешение произвольного пути. Pins должны соответствовать реальным файлам. Нет необходимости вручную создавать JSON в ежедневном пользовательском пути: его создаёт исполнитель. CLI нужен для повторяемых проверок.

Любой `check`, mutation/external, расширение scope, цикл и недостающая зависимость отклоняются до исполнения. Read-only sweep не делает исправление: после установления причины исполнитель использует существующий разрешённый путь изменения и проверки. Нет автоматически разрешённого shell.

Новый ID — новое наблюдение. Тот же ID — прежний снимок, даже после изменения источника. Нельзя менять параметры под прежним ID. Результат running/unknown не повторяется сам. При повреждении локального результата нужна диагностика, не новый ID для обхода.

## Воспроизвести проверки из полного source-архива

```powershell
npm run verify
Push-Location native/tools/economy
$env:GOPROXY='off'; $env:GOTOOLCHAIN='local'
go test -race -count=1 -v ./...
go vet ./...
go build -buildvcs=false -trimpath -o studio-economy.exe .
.\studio-economy.exe research-demo --output "$PWD\research-check"
Pop-Location
node tools/check-research.mjs native/tools/economy/research-check
```

Нужны уже подготовленные dev toolchain/dependencies; `npm run verify` ничего не устанавливает. `-race` требует подходящий C-компилятор. Пользователю собранного helper эти runtime не нужны. Русская GUI-приёмка не заменена Node DOM-stub.

## Native TaskStore

v4 добавляет одну append-only таблицу внутри той же БД и поднимает user_version до4. Перед нативным испытанием сделать обычную резервную копию state. Возврат к прежнему бинарнику после v4 не должен открывать новую БД: использовать совместимую сборку либо отдельную исходную копию. Автоматического rollback данных не заявлено.

Хост исполняет read-only helper с файловыми операциями; Git в этом конкретном RPC-маршруте запрещён до целевой проверки отмены дочернего дерева. Standalone sweep может использовать фиксированные Git-диагностики при явно заданном allowGit и whole-root scope. Это разные заявленные профили.

MCP-наблюдатель заносит в TaskStore только отчёт из фиксированного локального store с подходящей задачей/версией/хэшем. Потеря события: `research_reconcile` читает сохранённый sweep, не вызывает его повторно. Изменившаяся цель сохраняет прежнее происхождение. Это source-код до Rust/Windows-прогона.
