/** Pure view over persisted observations. No model calls, file fetching or inferred success. */
import { assert } from '../core/model.js';
import { validateResearchRequest } from './research.js';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = (items) => items.map(x => `<li>${esc(x)}</li>`).join('');
const label = (s) => ({ planning: 'Подготовка проверок', probing: 'Сбор свидетельств', evaluating: 'Оценка наблюдений', blocked: 'Нужно решение', review: 'Результат для оценки', open: 'Открыта', supported: 'Есть основания', weakened: 'Ослаблена', refuted: 'Опровергнута в указанной области', unresolved: 'Не разрешена', observed: 'Наблюдение', inferred: 'Вывод', hypothesis: 'Гипотеза', user: 'Владелец', agent: 'Исполнитель', evaluate_once: 'Сопоставить наблюдения с предсказаниями гипотез; выбрать исправление или одну различающую проверку.', collect_read_only_evidence: 'Собрать запланированные наблюдения без изменения проекта.', reconcile_sources: 'Сверить изменившиеся источники перед следующим выводом.', review_incomplete_probes: 'Разобрать неполные проверки; не повторять внешние действия.' }[String(s)] || String(s ?? ''));
const cov = (s) => ({ complete: 'Полное в указанной области', partial: 'Частичное', unknown: 'Не установлено' }[s] || 'Не установлено');
export function decodeResearchCheckpoint(text) {
    assert(new TextEncoder().encode(text).length <= 524288, 'RESEARCH_SIZE', 'Предел контрольной точки — 512 КиБ');
    const c = JSON.parse(text);
    assert(c?.schema === 1 && Number.isSafeInteger(c.sequence) && c.sequence > 0 && c.plan, 'RESEARCH_SCHEMA', 'Неверная контрольная точка');
    validateResearchRequest({ sweepId: 'import', plan: c.plan, sourceSnapshot: { rootHash: '0'.repeat(64), pins: [] }, limits: { outputUtf8Bytes: c.plan.budget.outputUtf8Bytes, wallSeconds: c.plan.budget.wallSeconds }, permissionScope: { paths: c.plan.scope, effect: 'read-only', allowGit: true } });
    assert(Array.isArray(c.reports) && c.reports.length <= 32 && Array.isArray(c.findings) && c.findings.length <= 64 && typeof c.nextAction === 'string', 'RESEARCH_SCHEMA', 'Неверные отчёты');
    for (const r of c.reports) {
        assert(r?.taskId === c.plan.taskId && r.investigationId === c.plan.investigationId && typeof r.sweepId === 'string' && Array.isArray(r.probes) && r.probes.length <= 12 && Array.isArray(r.evidenceRefs) && r.evidenceRefs.length <= 32 && Array.isArray(r.gaps) && Array.isArray(r.unknownEffects) && Array.isArray(r.excerpts), 'RESEARCH_SCHEMA', 'Чужой или повреждённый отчёт');
        for (const p of r.probes)
            assert(p && Array.isArray(p.evidenceIds), 'RESEARCH_SCHEMA', 'Неверные проверки');
    }
    for (const f of c.findings)
        assert(f && Array.isArray(f.evidenceIds) && Array.isArray(f.counterEvidenceIds) && Array.isArray(f.limitations), 'RESEARCH_SCHEMA', 'Неверные выводы');
    return c;
}
export function renderResearchTrace(c, origin, goalRevision) {
    if (!c)
        return '<section class="panel"><h2>Исследование</h2><p>Пока нет сохранённого диагностического плана. Простое чтение не требует гипотез. Для неизвестной причины исполнитель формирует различающие проверки и собирает их через diagnostic_sweep.</p><p class="muted">Этот экран ничего не запускает и не придумывает наблюдения.</p></section>';
    const p = c.plan;
    const stale = goalRevision !== undefined && p.goalRevision !== goalRevision;
    return `<section class="panel"><div class="row between"><div><div class="eyebrow">Цель v${p.goalRevision} · план v${p.planVersion} · точка ${c.sequence}</div><h2>${esc(p.question)}</h2></div><span class="badge">${esc(label(c.status))}</span></div>
 ${origin === 'import' ? '<p class="notice amber">Локально импортированный отчёт. Подлинность JSON и исходных файлов не удостоверена. Импорт не создаёт задачу и не отправляет запрос модели.</p>' : '<p class="muted">Контрольная точка TaskStore; исходные материалы находятся в локальном хранилище. Это наблюдения инструментов, не скрытые рассуждения модели.</p>'}
 ${stale ? '<p class="notice amber">Цель уже изменена. Эти свидетельства остаются у прежней редакции; новое выполнение не разрешено этим планом.</p>' : ''}
 <details><summary>Исходная цель и условия остановки</summary><p class="preserve">${esc(p.originalGoal)}</p><ul>${list(p.stopRules)}</ul><p>Предел: ${p.budget.maxSweeps} пакетов; без новых наблюдений: ${p.budget.maxNoProgress}; выход: ${p.budget.outputUtf8Bytes.toLocaleString('ru')} байт. Наблюдение токенов модели отдельно.</p></details></section>
 <section class="panel"><h2>Альтернативные объяснения</h2><div class="research-hypotheses">${p.hypotheses.map(h => `<article><span class="badge">${esc(label(h.state))}</span><h3>${esc(h.claim)}</h3><small>${esc(h.id)} · ожидаемое различие</small><ul>${list(h.predicts)}</ul></article>`).join('')}</div><p class="muted">Статус гипотезы — записанная оценка автора плана, а не автоматически установленная причина.</p></section>
 ${c.reports.map(r => `<section class="panel"><div class="row between"><h2>Пакет ${esc(r.sweepId)}</h2><span class="badge">${cov(r.sourceCoverage)}</span></div><p>${esc(r.summary)}</p><div class="research-meta">${Number(r.durationMs).toLocaleString('ru')} мс · ${Number(r.utf8Bytes).toLocaleString('ru')} байт ответа · вызовов модели локальным инструментом: ${esc(r.localModelCalls)} · токены модели: ${r.observedTokens == null ? 'не наблюдались' : esc(r.observedTokens)}</div>
 ${r.probes.map(o => { const original = p.probes.find(x => x.id === o.probeId); return `<article class="research-probe"><h3>${esc(o.question || original?.question || o.probeId)}</h3><p>${esc(o.summary)}</p><small>${cov(o.coverage)} · ${esc(label(o.state))} · различает: ${esc(original?.discriminates.join(', ') || 'прежняя версия плана')}</small>${o.evidenceIds.map(id => { const e = r.evidenceRefs.find(x => x.id === id); const quote = r.excerpts.find(x => x.evidenceId === id); return e ? `<details><summary>Свидетельство ${esc(id)}${e.negative ? ' · результат поиска пуст' : ''}</summary>${quote ? `<pre>${esc(quote.text)}</pre>` : '<p>Полный результат доступен локальному inspect по ID артефакта.</p>'}<p class="path"><b>Артефакт:</b> ${esc(e.locator)}<br><b>SHA-256:</b> ${esc(e.sha256)}<br>${cov(e.coverage)} · ${esc(e.observedAt)}</p></details>` : ''; }).join('')}</article>`; }).join('')}
 ${r.gaps.length || r.unknownEffects.length ? `<div class="notice amber"><b>Пробелы и неопределённость</b><ul>${list([...r.gaps, ...r.unknownEffects])}</ul></div>` : ''}
 <details><summary>Происхождение отчёта</summary><p class="path">${esc(r.reportArtifact)}<br>${esc(r.reportSha256)}<br>Источник: ${esc(r.sourceHash)}</p></details></section>`).join('')}
 <section class="panel"><h2>Выводы и контрдоказательства</h2>${c.findings.length ? c.findings.map(f => `<article class="research-probe"><span class="badge">${esc(label(f.kind))} · ${esc(label(f.author))}</span><p>${esc(f.assertion)}</p><small>Область: ${esc(f.scope)}</small><p class="muted">Основания: ${esc(f.evidenceIds.join(', '))}<br>Контрдоказательства: ${esc(f.counterEvidenceIds.join(', ') || 'не указаны')}</p><ul>${list(f.limitations)}</ul>${f.nextCheck ? `<p><b>Различающая проверка:</b> ${esc(f.nextCheck)}</p>` : ''}</article>`).join('') : '<p>Смысловой вывод ещё не записан. Успешное чтение или код 0 не устанавливает первопричину.</p>'}<h3>Следующее действие</h3><p class="preserve">${esc(label(c.nextAction))}</p></section>`;
}
