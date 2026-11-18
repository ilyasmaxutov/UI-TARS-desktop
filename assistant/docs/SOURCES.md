# Проверенные основания интеграции
Прочитано 9 ноября 2026 года. Эти ссылки подтверждают существование интерфейсов и полей, не испытание нашей реализации с установленной у пользователя версией. Ветки main не закреплены как состав поставки. Нет скопированной библиотеки Codex.

1. OpenAI / Codex App Server: https://learn.chatgpt.com/docs/app-server
   - initialize/initialized, thread/start/resume, turn/start/steer/interrupt.
   - expectedTurnId необходим для steer; изменение модели/среды не подменяется steer.
   - thread/tokenUsage/updated, item/*, commandExecution durationMs, turn/diff/updated.
2. OpenAI / Advanced Configuration: https://learn.chatgpt.com/docs/config-file/config-advanced
   - Opt-in OpenTelemetry: запросы, SSE/WS, инструменты и их длительности.
   - Наш пакет НЕ включает OTel collector и не меняет config.toml. Источник подробного запроса — отдельный будущий профиль, не автоматически полученные сведения из JSONL.
3. OpenAI protocol source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs
   - TokenUsage и TokenUsageRecord: usage, response_id, turn/thread totals.
   - TurnCompleteEvent: duration_ms и time_to_first_token_ms опциональны.
   - RateLimitSnapshot: часть окон может отсутствовать; отсутствие не означает ноль.
   - Накопительные счётчики и per-response записи нельзя складывать как два разных расхода.
4. Исходное ТЗ владельца 1.0/2.0 и G0 из текущей переписки:
   - исходная цель отделена от плана; неизвестный внешний эффект не повторяется автоматически;
   - Computer Use запрещён; названный сильный Windows-профиль требует приёмки;
   - пользователь уточнил разделение приложения-помощника и универсальной исполнительной площадки.

Новые решения дизайна и разрез продукта — авторская проработка по запросу, не результаты внешнего исследования удобства. Реальные журналы пользователя и установленная версия Codex не получены.
