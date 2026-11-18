const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function continuationAvailability(preview, session, commands, configured, pending) {
    if (pending)
        return { allowed: false, reason: 'Сначала разрешите сохранённую отправку.' };
    if (!preview)
        return { allowed: false, reason: 'Сначала нужно прочитать сохранённое состояние задачи.' };
    if (preview.unresolvedCommands || commands.some(c => ['thread/start', 'turn/start', 'turn/steer'].includes(c.method)
        && ['prepared', 'in_flight', 'unverified_outcome', 'unknown_needs_user_decision'].includes(c.state)))
        return { allowed: false, reason: 'В задаче есть отправка с неизвестным исходом. Откройте её сессию и выполните сверку.' };
    if (preview.activeSessions || preview.uncertainSessions || session && ['running', 'connecting', 'state_unknown'].includes(session.status))
        return { allowed: false, reason: 'Дождитесь завершения работы или остановите её и сверьте состояние.' };
    if (!configured)
        return { allowed: false, reason: 'Выберите установленный Codex на вкладке «Подключение».' };
    return { allowed: true, reason: 'Откроется новый тред с сохранёнными результатами. Поручение отправляется отдельно.' };
}
export function renderContinuationPreview(preview, error) {
    if (error)
        return `<p class="notice amber" role="status">${escape(error)}</p>`;
    if (!preview)
        return '<p class="muted">Сохранённое состояние ещё не прочитано.</p>';
    const skipped = preview.omissions.reports + preview.omissions.evidenceRefs + preview.omissions.hypotheses + preview.omissions.findings
        + (preview.omissions.observations ?? 0) + (preview.omissions.gaps ?? 0) + (preview.omissions.excerpts ?? 0);
    return `<p>Цель и ${preview.research.present ? 'сохранённое исследование' : 'условия задачи'} будут переданы автоматически.</p>
    <p><strong>${preview.utf8Bytes.toLocaleString('ru')} / ${preview.maxUtf8Bytes.toLocaleString('ru')} байт</strong> <span class="muted">пакет продолжения</span></p>
    ${preview.research.freshness && preview.research.freshness !== 'current' ? '<p class="notice amber">Цель изменилась. Прежнее исследование будет явно помечено как устаревшее.</p>' : ''}
    ${preview.research.status === 'blocked' ? '<p class="notice amber">Исследование остановлено по сохранённым условиям. Новый тред не сбрасывает ограничения задачи.</p>' : ''}
    ${preview.research.sourceFreshness === 'not-rechecked' ? '<p class="muted">Сохранённые наблюдения относятся к прежнему состоянию файлов. Их актуальность ещё нужно проверить.</p>' : ''}
    ${skipped ? '<p class="muted">Часть подробностей оставлена в локальных отчётах; в пакете указаны пропуски и ссылки на оригиналы.</p>' : ''}
    <details><summary>Что получит исполнитель</summary><pre class="continuation-data">${escape(preview.text)}</pre><p class="muted path">SHA-256: ${escape(preview.sha256)}</p></details>
    <p class="muted">Полные журналы остаются локально. Размер этого пакета не равен полному контексту Codex.</p>`;
}
