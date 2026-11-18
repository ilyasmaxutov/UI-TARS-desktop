# Основания и проверяемые источники

## Пользовательские документы

- Редакция 1.0: F01–F46, T01–T31, запрет Computer Use и обязательных Python/Java/PHP.
- Редакция 2.0 и G0: поэтапная приёмка основания, принудительная граница, реальные результаты, независимая проверка и неизвестные эффекты.
- Документация 3.0 и 3.1, предоставленная в разговоре: проекты/пространства/листы, 96 PF, J01–J12, P0–P8. Машиночитаемые исходные функции скопированы без замены критериев в REQUIREMENTS.json.

## Первичные материалы, проверенные при работе

- Rust stable releases: https://blog.rust-lang.org/releases/ — линия 1.99.1; не результат локальной сборки.
- rusqlite 0.41.1: https://docs.rs/rusqlite/latest/rusqlite/ — API/версия целевой зависимости, пакет не загружен в стенд.
- Tauri configuration: https://v2.tauri.app/reference/config/ — frontendDist, withGlobalTauri, CSP.
- Calling Rust: https://v2.tauri.app/develop/calling-rust/ — invoke и команды.
- Named pipe security: https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights — явная DACL и границы локального IPC.
- Win32 overlapped I/O: https://learn.microsoft.com/en-us/windows/win32/fileio/synchronous-and-asynchronous-i-o — время жизни OVERLAPPED, завершение/отмена.
- windows-sys 0.61.2: https://docs.rs/windows-sys/0.61.2/windows_sys/Win32/System/Pipes/fn.CreateNamedPipeW.html
- ReadFile: https://docs.rs/windows-sys/0.61.2/windows_sys/Win32/Storage/FileSystem/fn.ReadFile.html
- Security descriptor conversion: https://docs.rs/windows-sys/0.61.2/windows_sys/Win32/Security/Authorization/fn.ConvertStringSecurityDescriptorToSecurityDescriptorW.html
- Codex App Server: https://learn.chatgpt.com/docs/app-server — здесь использованы только форматы сообщений; реальное подключение не проводилось.

Документация внешней библиотеки не считается испытанием нашего приложения. Никакая библиотека не заявлена принятым sandbox только по её наличию в файле зависимостей.

## Дополнение 0.2

- https://www.sqlite.org/lang_transaction.html — IMMEDIATE/commit/rollback; не внешняя exactly-once транзакция.
- https://www.sqlite.org/isolation.html — локальная изоляция транзакций.
- https://www.w3.org/TR/IndexedDB-3/ — completion транзакции и durability hint; request success не равен commit.

Нативные pins из 0.1 здесь не разрешены и не подтверждены новой сборкой. Документация API не является доказательством работы нашей реализации.
