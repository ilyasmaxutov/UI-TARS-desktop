import { assert, bytes, canonical, CATALOG, clone, definition, Document, FileData, id, Kind, LIMITS, Project, safePath, validateFiles } from '../core/model.js';
import { compile, createDocument, Editor, TemplateName, validateDocument } from '../core/graph.js';
import { Artifact, diff, Run, validateArtifact, verify } from '../core/runtime.js';
import { acceptResult, acceptedResultValid, inspectResult, mergeProjection } from '../core/review.js';
import { StartIntent, StartOutbox, pendingIntent } from '../core/outbox.js';
import { IndexedIntentRepository } from './command-store.js';
import { supervisorContract } from '../core/codex.js';
import { native, SavedState, Store, validateState } from './store.js';
declare global {
    interface Window {
        __STUDIO_WORKER__: string;
    }
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const esc = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({
    plus: '<path d="M12 5v14M5 12h14"/>', play: '<path d="m8 5 11 7-11 7Z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
    arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', check: '<path d="m5 12 4 4L19 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    file: '<path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 12h8M8 16h5"/>', settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
    link: '<path d="m9 15 6-6M8 17l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M16 7l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0"/>',
    undo: '<path d="M4 10h10a6 6 0 0 1 0 12M4 10l5-5M4 10l5 5"/>', spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>', split: '<path d="M4 12h5m0 0 5-6h6M9 12l5 6h6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
}[name] ?? '<circle cx="12" cy="12" r="7"/>')}</svg>`;
const stateLabels: Record<string, string> = { queued: 'В очереди', running: 'В работе', completed: 'Выполнено', failed: 'Ошибка', cancelled: 'Отменено', review: 'Нужна оценка', interrupted: 'Прервано' };
const opIcon = (kind: string) => kind.startsWith('source') ? 'folder' : kind.startsWith('verify') ? 'shield' : kind.startsWith('result') ? 'file' : kind.startsWith('agent') ? 'spark' : 'split';
let state: SavedState;
let editor: Editor;
const store = new Store();
let selected: string | null = null;
let mode: 'canvas' | 'result' | 'history' = 'canvas';
let worker: Worker | null = null;
let busy = false;
let currentRun: Run | null = null;
let sourceAtRun: FileData[] = [];
let connectFrom: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let dirty = false;
let persistenceFailed = false;
let persistedRevision = 0;
let paletteFilter = '';
let lastPreviewFile = 0;
let lastArtifact = 0;
const intentRepository = new IndexedIntentRepository();
let outbox: StartOutbox | null = null;
let intents: StartIntent[] = [];
let commandBusy = false;
let quiet = false;
let nativeTimer: ReturnType<typeof setTimeout> | null = null;
const active = () => state.projects.find(p => p.id === state.activeProject)!;
const workspace = () => editor.document.workspaces.find(w => w.id === active().selectedWorkspace) ?? editor.document.workspaces[0]!;
const sheet = () => workspace().sheets.find(s => s.id === active().selectedSheet) ?? workspace().sheets[0]!;
const node = () => editor.document.nodes.find(n => n.id === selected);
const run = () => currentRun ?? state.runs.find(r => r.id === active().selectedRun) ?? null;
function toast(text: string, error = false): void { const box = $('#toast'); box.textContent = text; box.classList.toggle('error', error); box.classList.add('show'); setTimeout(() => box.classList.remove('show'), 6000); }
function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function protect(fn: () => void | Promise<void>): void { void Promise.resolve().then(fn).catch(e => toast(errorMessage(e), true)); }
function status(text: string, bad = false): void { $('#save-state').textContent = text; $('#save-state').classList.toggle('bad', bad); }
function changed(renderAll = true): void { active().document = clone(editor.document); dirty = true; if (saveTimer)
    clearTimeout(saveTimer); status('Сохраняется…'); saveTimer = setTimeout(() => void persist(), 300); if (renderAll)
    render(); }
async function persist(): Promise<void> {
    if (saving || !dirty || persistenceFailed)
        return;
    saving = true;
    dirty = false;
    const snapshot = clone(state);
    snapshot.revision = persistedRevision + 1;
    try {
        await store.save(snapshot, persistedRevision);
        persistedRevision = snapshot.revision;
        state.revision = persistedRevision;
        status('Сохранено локально');
    }
    catch (e) {
        persistenceFailed = true;
        dirty = true;
        status('Не сохранено · экспортируйте проект', true);
        toast(errorMessage(e), true);
    }
    finally {
        saving = false;
        if (dirty && !persistenceFailed)
            void persist();
    }
}
function initialProject(title = 'Пример · отчёт по проекту', template: TemplateName = 'report'): Project {
    const projectId = id('project'), document = createDocument(projectId, title, template);
    return { id: projectId, title, document, files: [], selectedWorkspace: document.workspaces[0]!.id, selectedSheet: document.workspaces[0]!.sheets[0]!.id, selectedRun: null };
}
async function boot(): Promise<void> {
    try {
        await store.open();
        const saved = await store.read();
        if (saved) {
            validateState(saved);
            state = saved;
            persistedRevision = saved.revision;
        }
    }
    catch (e) {
        persistenceFailed = true;
        toast('Хранилище недоступно: ' + errorMessage(e) + '. Сохраните работу экспортом.', true);
    }
    if (!state!) {
        const p = initialProject();
        p.files = [{ path: 'README.md', content: '# Небольшой проект\r\n\r\nТекст для проверки локальной обработки.   \r\n' }, { path: 'config.json', content: '{\n  "theme": "dark",\n  "language": "ru"\n}\n' }];
        state = { schema: 1, revision: 0, projects: [p], activeProject: p.id, runs: [], theme: 'dark' };
        dirty = true;
    }
    for (const r of state.runs)
        if (!native && r.state === 'running') {
            r.state = 'interrupted';
            r.error = 'Работа вкладки прервалась. Автоматический повтор не выполнялся.';
            dirty = true;
        }
    editor = new Editor(active().document);
    document.documentElement.dataset['theme'] = state.theme;
    bind();
    render();
    if (!persistedRevision)
        fit();
    if (dirty)
        void persist();
    else
        status('Сохранено локально');
    $('#profile-label').textContent = native ? 'Нативный профиль · встроенные операции' : 'Локальная вкладка · без агента';
    if (native) {
        try {
            await intentRepository.open();
            outbox = new StartOutbox(intentRepository, {
                capabilities: () => native!.invoke('capabilities'),
                lookup: commandId => native!.invoke('get_command', { commandId }),
                start: (commandId, document, files) => native!.invoke('start_run', { commandId, specJson: canonical({ document, files }) })
            });
            await refreshIntents();
        } catch (error) { toast('Новые нативные запуски заблокированы: ' + errorMessage(error), true); }
        const live = state.runs.find(r => r.documentId === editor.document.id && r.state === 'running');
        if (live) {
            busy = true;
            updateRun(live);
            pollNative(live.id);
        }
    }
    $('#profile-note').textContent = native ? 'Внешний код закрыт до приёмки изоляции' : 'Работа прекращается при закрытии этой вкладки';
}
function render(): void { renderSidebar(); renderHeader(); renderCanvas(); renderInspector(); renderResult(); renderHistory(); renderComposer(); }
function renderSidebar(): void {
    $('#project-list').innerHTML = state.projects.map(p => `<button class="project-row ${p.id === state.activeProject ? 'active' : ''}" data-project="${esc(p.id)}">${icon('folder')}<span>${esc(p.title)}</span></button>`).join('');
    $('#space-list').innerHTML = editor.document.workspaces.map(w => `<button class="space-row ${w.id === workspace().id ? 'active' : ''}" data-space="${esc(w.id)}"><span class="space-dot"></span><span>${esc(w.title)}</span><small>${w.sheets.length}</small></button>`).join('');
    $('#source-count').textContent = String(active().files.length);
    $('#recent-runs').innerHTML = state.runs.filter(r => r.documentId === editor.document.id).slice(-5).reverse().map(r => `<button class="run-row" data-run="${esc(r.id)}"><i class="state-dot ${r.state}"></i><span>${stateLabels[r.state] ?? r.state}</span><small>v${r.revision}</small></button>`).join('') || '<p class="muted small">Запусков пока нет</p>';
}
function renderHeader(): void {
    $('#project-title').textContent = active().title;
    $('#workspace-title').textContent = workspace().title;
    $('#sheet-tabs').innerHTML = workspace().sheets.map(s => `<button class="sheet-tab ${s.id === sheet().id ? 'active' : ''}" data-sheet="${esc(s.id)}">${icon('grid')}${esc(s.title)}</button>`).join('') + `<button class="icon-button" data-action="add-sheet" title="Новый лист" aria-label="Новый лист">${icon('plus')}</button>`;
    $('#graph-version').textContent = `Черновик v${editor.document.revision}`;
    for (const b of document.querySelectorAll<HTMLElement>('[data-mode]'))
        b.classList.toggle('active', b.dataset['mode'] === mode);
    const b = $<HTMLButtonElement>('#run-button');
    b.disabled = commandBusy;
    b.innerHTML = icon(busy ? 'stop' : 'play') + (busy ? 'Остановить' : 'Начать');
    if (!busy && intents.some(i => pendingIntent(i) && i.document.id === editor.document.id)) b.innerHTML = icon('clock') + 'Сверить запуск';
    $('#canvas-view').classList.toggle('hidden', mode !== 'canvas');
    $('#result-view').classList.toggle('hidden', mode !== 'result');
    $('#history-view').classList.toggle('hidden', mode !== 'history');
}
function renderCanvas(): void {
    const s = sheet(), r = run();
    const diagnostics = compile(editor.document).diagnostics;
    $('#canvas-nodes').innerHTML = s.views.map(v => {
        const n = editor.document.nodes.find(n => n.id === v.nodeId)!;
        const def = definition(n.kind)!;
        const runtime = r?.nodes[n.id];
        const problem = diagnostics.find(x => x.nodeId === n.id);
        const preview = r?.previews[n.id] ?? (n.kind === 'source.files' ? `${active().files.length} файлов в снимке` : n.kind === 'source.text' ? String(n.params['text'] ?? '') : n.kind === 'note' ? String(n.params['text'] ?? '') : def.description);
        return `<article class="node ${selected === n.id ? 'selected' : ''} ${!def.available ? 'unavailable' : ''} ${runtime ?? ''}" data-node="${esc(n.id)}" data-view="${esc(v.id)}" style="left:${v.x}px;top:${v.y}px" tabindex="0" role="group" aria-label="${esc(n.title)}">
      <div class="node-top" data-drag="${esc(v.id)}"><span class="node-symbol ${n.kind.split('.')[0]}">${icon(opIcon(n.kind))}</span><span class="node-category">${esc(def.category)}</span><span class="node-ellipsis">···</span></div>
      <h3>${esc(n.title)}</h3><p class="node-preview">${esc(preview.slice(0, 125))}</p>
      <div class="node-bottom"><span class="node-status ${problem && !runtime ? 'warning' : ''}">${runtime ? `<i class="state-dot ${runtime}"></i>${stateLabels[runtime]}` : problem ? 'Требует настройки' : n.kind === 'note' ? 'Не исполняется' : 'Готов к запуску'}</span><span class="node-type">${def.output ?? 'note'}</span></div>
      ${def.input ? `<button class="port input" data-port-in="${esc(n.id)}" title="Вход · ${def.input}" aria-label="Соединить вход ${esc(n.title)}"></button>` : ''}
      ${def.output ? `<button class="port output ${connectFrom === n.id ? 'connecting' : ''}" data-port-out="${esc(n.id)}" title="Выход · ${def.output}" aria-label="Соединить выход ${esc(n.title)}"></button>` : ''}
      </article>`;
    }).join('');
    const views = new Map(s.views.map(v => [v.nodeId, v]));
    let svg = '';
    for (const edge of editor.document.edges) {
        const a = views.get(edge.source), b = views.get(edge.target);
        if (a && b) {
            const x1 = a.x + 264, y1 = a.y + 92, x2 = b.x, y2 = b.y + 92, dx = Math.max(60, Math.abs(x2 - x1) * .5);
            svg += `<g class="edge ${r?.nodes[edge.target] === 'running' ? 'flowing' : ''}" data-edge="${esc(edge.id)}"><path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/><circle cx="${x2}" cy="${y2}" r="3"/></g>`;
        }
    }
    $('#canvas-edges').innerHTML = svg;
    $('#canvas-empty').classList.toggle('hidden', s.views.length > 0);
    const visible = new Set(s.views.map(v => v.nodeId));
    const cross = editor.document.edges.filter(e => visible.has(e.source) !== visible.has(e.target));
    $('#cross-links').innerHTML = cross.length ? `<span>${cross.length} межлистовых связей</span>` + cross.map(e => { const other = visible.has(e.source) ? e.target : e.source; return `<button data-locate="${esc(other)}">${icon('link')}${esc(editor.document.nodes.find(n => n.id === other)?.title ?? 'Узел')}</button>`; }).join('') : '';
    $('#canvas-hint').textContent = connectFrom ? 'Выберите вход другого узла · Esc — отменить' : 'Перемещение: фон или средняя кнопка · масштаб: Ctrl + колесо · Ctrl + K — действия';
    updateTransform();
}
function updateTransform(): void { const p = sheet().viewport; $('#canvas-world').style.transform = `translate(${p.x}px,${p.y}px) scale(${p.zoom})`; $('#zoom-label').textContent = `${Math.round(p.zoom * 100)}%`; $('#canvas-surface').style.backgroundPosition = `${p.x}px ${p.y}px`; $('#canvas-surface').style.backgroundSize = `${24 * p.zoom}px ${24 * p.zoom}px`; }
function fit(): void {
    const v = sheet().views;
    if (!v.length)
        return;
    const surface = $('#canvas-surface');
    const minX = Math.min(...v.map(v => v.x)), minY = Math.min(...v.map(v => v.y)), maxX = Math.max(...v.map(v => v.x + 264)), maxY = Math.max(...v.map(v => v.y + 184));
    const z = Math.max(.2, Math.min(.95, (surface.clientWidth - 100) / (maxX - minX), (surface.clientHeight - 240) / (maxY - minY)));
    sheet().viewport = { x: (surface.clientWidth - (maxX - minX) * z) / 2 - minX * z, y: Math.max(60, (surface.clientHeight - 160 - (maxY - minY) * z) / 2 - minY * z), zoom: z };
    updateTransform();
    changed(false);
}
function renderInspector(): void {
    const n = node();
    $('#inspector').classList.toggle('hidden', !n);
    if (!n)
        return;
    const d = definition(n.kind)!;
    const diagnostics = compile(editor.document).diagnostics.filter(x => x.nodeId === n.id);
    const r = run();
    let params = '';
    for (const [key, value] of Object.entries(n.params)) {
        const label: Record<string, string> = { text: 'Содержимое', find: 'Найти точную строку', replace: 'Заменить на', path: 'Путь результата', match: 'Путь содержит', readPolicy: 'Правило чтения' };
        params += `<label class="field-label">${label[key] ?? esc(key)}${key === 'text' ? `<textarea data-param="${esc(key)}" rows="5">${esc(value)}</textarea>` : `<input data-param="${esc(key)}" value="${esc(value)}" ${key === 'readPolicy' ? 'readonly' : ''}>`}</label>`;
    }
    const criteria = n.kind === 'verify.files' ? `<div class="section-label">Критерии цели · v${editor.document.goal.revision}</div>${editor.document.goal.obligations.map(c => `<div class="criterion"><b>${esc(c.description)}</b><small>${esc(c.kind)} · ${esc(c.path)}</small><button class="text-button danger" data-remove-check="${esc(c.id)}">Удалить критерий</button></div>`).join('')}<button class="secondary full" data-action="add-check">${icon('plus')}Добавить критерий</button>` : '';
    const incoming = editor.document.edges.filter(e => e.target === n.id);
    const sources = editor.document.nodes.filter(x => x.id !== n.id && definition(x.kind)?.output === d.input);
    const connection = d.input ? `<div class="section-label">Входящие связи</div>${incoming.map(e => `<div class="connection-row"><button data-locate="${esc(e.source)}">${esc(editor.document.nodes.find(x => x.id === e.source)?.title ?? e.source)}</button><button class="icon-button" data-remove-edge="${esc(e.id)}" title="Удалить связь">${icon('x')}</button></div>`).join('')}<div class="connect-form"><select id="source-select" aria-label="Источник для соединения"><option value="">Выберите источник</option>${sources.map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}</select><button class="icon-button" data-action="connect-select" aria-label="Подключить источник">${icon('plus')}</button></div>` : '';
    $('#inspector-body').innerHTML = `<span class="eyebrow">${esc(d.category)}</span><label class="field-label">Название<input id="node-title" value="${esc(n.title)}"></label><p class="muted">${esc(d.description)}</p>
    ${diagnostics.map(d => `<div class="notice warning">${esc(d.message)}</div>`).join('')}${params}${criteria}${connection}
    <div class="section-label">Представление</div><label class="field-label">Показать на другом листе<select id="reference-sheet"><option value="">Выберите лист…</option>${editor.document.workspaces.flatMap(w => w.sheets.filter(s => s.id !== sheet().id).map(s => `<option value="${esc(w.id + '|' + s.id)}">${esc(w.title + ' / ' + s.title)}</option>`)).join('')}</select></label>
    <div class="section-label">Последний результат узла</div><pre class="mini-preview">${esc(r?.previews[n.id] ?? 'Ещё не исполнялся')}</pre>
    ${n.kind === 'agent.codex' ? `<button class="secondary full" data-action="contract">Посмотреть контракт руководителя</button>` : ''}
    <button class="text-button danger" data-action="remove-node">Удалить узел и его связи</button>`;
}
function renderComposer(): void { const input = $<HTMLTextAreaElement>('#goal-input'); if (document.activeElement !== input)
    input.value = editor.document.goal.original; $('#goal-target').textContent = 'Цель всей работы'; $('#goal-revision').textContent = `Цель v${editor.document.goal.revision}`; }
function renderResult(): void {
    const r = run();
    if (!r) {
        $('#result-body').innerHTML = `<div class="empty-state">${icon('file')}<h2>Здесь появится результат</h2><p>Сначала импортируйте файлы и запустите конструкцию.<br>Статус узла сам по себе не считается результатом.</p><button class="secondary" data-action="show-canvas">Перейти к конструкции</button></div>`;
        return;
    }
    lastArtifact = Math.min(lastArtifact, Math.max(0, r.artifacts.length - 1));
    const a = r.artifacts[lastArtifact];
    if (!a) {
        $('#result-body').innerHTML = `<div class="empty-state">${icon(r.state === 'running' ? 'clock' : 'shield')}<span class="eyebrow">Запуск v${r.revision}</span><h2>${stateLabels[r.state] ?? r.state}</h2><p>${esc(r.error ?? 'Выполняются локальные операции. Изменения оригиналов не производятся.')}</p><button class="secondary" data-mode="history">Открыть историю</button></div>`;
        return;
    }
    lastPreviewFile = Math.min(lastPreviewFile, a.files.length - 1);
    const f = a.files[Math.max(0, lastPreviewFile)]!;
    const base = r.inputs ?? [];
    const changes = diff(base, a.files);
    const c = changes.find(c => c.path === f.path);
    $('#result-body').innerHTML = `<div class="result-heading"><div><span class="eyebrow">Реальный артефакт · v${r.revision}</span><h2>${r.accepted && r.acceptance ? 'Этот снимок принят владельцем' : 'Результат готов к оценке'}</h2><p class="muted">${a.files.length} файл(ов) · ${a.findings.length} локальных проверок · исходники не перезаписаны</p></div><div class="result-actions"><button class="secondary" data-action="inspect-result">Перепроверить</button><button class="secondary" data-action="export-artifact">${icon('download')}Экспорт пакета</button>${native ? '<button class="secondary" data-action="native-export">В отдельную папку</button>' : ''}<button class="primary" data-action="accept" ${r.accepted && r.acceptance ? 'disabled' : ''}>${icon('check')}${r.accepted && r.acceptance ? 'Принято' : 'Принять этот снимок'}</button></div></div>
    <div class="artifact-tabs" role="navigation" aria-label="Артефакты запуска">
    ${r.artifacts.map((item,index) => `<button class="secondary ${index === lastArtifact ? 'active' : ''}" data-artifact="${index}">Результат ${index+1} · ${item.files.length} файл(ов)</button>`).join('')}</div><div class="notice">Проверки вычислены программой. Это не независимая OS-среда и не доказательство смыслового выполнения любой задачи.</div>
    <div class="result-layout"><aside class="file-list">${a.files.map((f, i) => `<button class="${i === lastPreviewFile ? 'active' : ''}" data-preview="${i}">${icon('file')}${esc(f.path)}</button>`).join('')}<div class="section-label">Критерии</div>${a.findings.map(f => `<div class="finding">${icon(f.passed ? 'check' : 'x')}<span>${esc(f.description)}</span></div>`).join('')}</aside>
    <section class="file-preview"><div class="preview-bar"><span>${esc(f.path)}</span><span class="pill">${esc(c?.status ?? 'result')}</span><button class="text-button" data-action="download-file">Сохранить файл</button></div>${c?.status === 'modified' ? `<div class="diff-columns"><div><div class="diff-heading">Исходная копия</div><pre>${esc(c.before)}</pre></div><div><div class="diff-heading">Предложенный результат</div><pre>${esc(f.content)}</pre></div></div>` : `<pre>${esc(f.content)}</pre>`}</section></div>
    <details class="evidence"><summary>Происхождение и границы проверки</summary><dl><dt>SHA-256 манифеста</dt><dd>${esc(a.hash)}</dd><dt>Цель / конструкция</dt><dd>v${a.goalRevision} / v${a.graphRevision}</dd><dt>Профиль</dt><dd>${esc(r.profile)}</dd><dt>Привязка решения владельца</dt><dd>${esc(r.acceptance?.bindingHash ?? 'Ещё не принято; старые принятия 0.1 требуют повторной проверки')}</dd><dt>Публикация в исходную папку</dt><dd>Не выполнялась. Доступен экспорт отдельного предложения.</dd></dl></details>`;
}
function renderHistory(): void {
    const r = run();
    $('#history-body').innerHTML = `<div class="result-heading"><div><span class="eyebrow">Факты исполнения</span><h2>История работы</h2><p class="muted">${r ? 'Конструкция v' + r.revision + ' · ' + esc(r.profile) : 'Выберите запуск или начните работу'}</p></div></div>${r ? `<div class="timeline">${r.events.map(e => `<div class="timeline-row"><time>${new Date(e.at).toLocaleTimeString('ru')}</time><i class="timeline-dot ${e.kind.includes('failed') ? 'failed' : ''}"></i><div><b>${esc(e.nodeId ? editor.document.nodes.find(n => n.id === e.nodeId)?.title ?? 'Узел' : e.kind)}</b><p>${esc(e.message)}</p><small>${esc(e.kind)} · #${e.seq}</small></div>${e.nodeId ? `<button class="text-button" data-locate="${esc(e.nodeId)}">На канвасе</button>` : ''}</div>`).join('')}</div>` : ''}`;
}
function showModal(title: string, body: string): void { $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; $<HTMLDialogElement>('#modal').showModal(); }
function closeModal(): void { $<HTMLDialogElement>('#modal').close(); }
function palette(): void { paletteFilter = ''; showModal('Добавить действие', `<label class="search-field">${icon('search')}<input id="palette-search" placeholder="Найти действие…" autofocus></label><div id="palette-items"></div>`); renderPalette(); setTimeout(() => $<HTMLInputElement>('#palette-search').focus(), 0); }
function renderPalette(): void { $('#palette-items').innerHTML = CATALOG.filter(c => (c.label + ' ' + c.description).toLowerCase().includes(paletteFilter)).map(c => `<button class="palette-item" data-add-kind="${esc(c.kind)}"><span class="palette-symbol">${icon(opIcon(c.kind))}</span><span><b>${esc(c.label)}</b><small>${esc(c.description)}</small></span>${!c.available ? '<span class="pill">Заблокирован</span>' : icon('plus')}</button>`).join(''); }
function newProjectDialog(): void { showModal('Новая работа', `<label class="field-label">Название<input id="new-title" value="Новая работа"></label><div class="template-grid"><button class="template-card" data-template="report">${icon('file')}<b>Отчёт по проекту</b><span>Файлы → отчёт → проверка → результат</span></button><button class="template-card" data-template="normalize">${icon('split')}<b>Нормализация текстов</b><span>Чистая копия и сравнение изменений</span></button><button class="template-card" data-template="empty">${icon('plus')}<b>Пустая конструкция</b><span>Собрать работу самостоятельно</span></button><button class="template-card" data-template="agent">${icon('spark')}<b>Команда с Codex</b><span>Конструкция доступна; исполнение заблокировано</span></button></div>`); }
function criteriaDialog(): void { showModal('Добавить обязательство цели', `<p class="muted">Изменение создаёт новую редакцию цели. Уже начатый запуск сохранит прежние критерии.</p><label class="field-label">Описание<input id="check-desc" placeholder="Например, в отчёте есть все файлы"></label><label class="field-label">Условие<select id="check-kind"><option value="nonempty">Файл не пуст</option><option value="file_exists">Файл существует</option><option value="contains">Содержит текст</option><option value="not_contains">Не содержит текст</option><option value="valid_json">Корректный JSON</option><option value="normalized">Нормализованные строки</option></select></label><label class="field-label">Путь или * для всех<input id="check-path" value="*"></label><label class="field-label">Искомый текст<input id="check-value"></label><button class="primary full" data-action="save-check">Добавить критерий</button>`); }
function settingsDialog(): void { showModal('Профиль работы и ограничения', `<div class="profile-card">${icon('shield')}<div><h3>Только встроенные операции</h3><p>Нет shell, Python, eval, внешних запросов и запуска приложений. Импортированные данные не исполняются.</p></div></div><label class="field-label">Конкурентность<select id="parallelism"><option value="normal" ${!quiet ? 'selected' : ''}>До двух независимых операций</option><option value="quiet" ${quiet ? 'selected' : ''}>Одна операция за раз</option></select></label><dl class="settings-dl"><dt>Один текстовый файл</dt><dd>До 1 МиБ</dd><dt>Исходный набор</dt><dd>До 8 МиБ / 256 файлов</dd><dt>GPU / доля CPU / RAM ОС</dt><dd>Не выделяются; гарантия не заявлена</dd><dt>Фоновое исполнение</dt><dd>${native ? 'Требует сборки и проверки независимого хоста' : 'В пределах жизни вкладки; закрытие прервёт работу'}</dd><dt>Платные обращения</dt><dd>Не выполняются</dd><dt>Codex / внешние беседы</dt><dd>Недоступны; не заменены симуляцией</dd></dl><button class="secondary full" data-action="contract">Рабочий контракт руководителя</button>`); }
async function importFiles(list: FileList): Promise<void> {
    assert(list.length <= LIMITS.files, 'LIMIT', 'Максимум 256 файлов за импорт');
    const files: FileData[] = [];
    let total = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const f of Array.from(list)) {
        total += f.size;
        assert(f.size <= LIMITS.fileBytes && total <= LIMITS.totalBytes, 'LIMIT', 'Превышен предел файла / набора');
        const path = safePath((f as File & {
            webkitRelativePath: string;
        }).webkitRelativePath || f.name);
        let content: string;
        try {
            content = decoder.decode(await f.arrayBuffer());
        }
        catch {
            throw new Error('Набор не импортирован. Не UTF-8: ' + path);
        }
        files.push({ path, content });
    }
    validateFiles(files);
    active().files = files;
    changed();
    toast(`Импортирована копия ${files.length} файлов. Оригиналы не изменяются.`);
}
function saveGoal(): void { const text = $<HTMLTextAreaElement>('#goal-input').value; editor.commit(d => { d.goal.original = text; d.goal.revision++; }); changed(); toast('Цель сохранена. Автоматическое ИИ-планирование ещё не подключено.'); }
function updateRun(value: Run, finish = false): void {
    const previous = state.runs.find(r => r.id === value.id) ?? null;
    value = mergeProjection(previous, value);
    const owner = state.projects.find(p => p.document.id === value.documentId);
    assert(owner, 'PROJECT', 'Ответ не связан с сохранённым проектом');
    owner.selectedRun = value.id;
    currentRun = value.documentId === editor.document.id ? value : currentRun;
    const i = state.runs.findIndex(r => r.id === value.id);
    if (i < 0)
        state.runs.push(clone(value));
    else
        state.runs[i] = clone(value);
    if (state.runs.length > LIMITS.runs)
        state.runs.splice(0, state.runs.length - LIMITS.runs);
    dirty = true;
    if (finish) {
        busy = false;
        worker?.terminate();
        worker = null;
        if (nativeTimer)
            clearInterval(nativeTimer);
        nativeTimer = null;
        void persist();
        render();
        toast(value.state === 'review' ? 'Результат предъявлен. Откройте его и проверьте.' : value.error ?? stateLabels[value.state] ?? value.state, value.state === 'failed');
    }
    else {
        if (!saveTimer)
            saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, 300);
        renderCanvas();
        renderHeader();
        renderHistory();
        renderSidebar();
        if (mode === 'result')
            renderResult();
    }
}
function pollNative(runId: string): void {
    if (nativeTimer)
        clearTimeout(nativeTimer);
    nativeTimer = setTimeout(() => { void (async () => { try {
        const value = await native!.invoke<Run>('get_run', { runId });
        updateRun(value, value.state !== 'running');
        if (value.state === 'running')
            pollNative(runId);
    }
    catch (e) {
        status('Нет связи с хостом · исход неизвестен', true);
        toast(errorMessage(e), true);
        nativeTimer = setTimeout(() => pollNative(runId), 1500);
    } })(); }, 250);
}
async function refreshIntents(): Promise<void> {
    intents = await intentRepository.list();
    const pending = intents.filter(pendingIntent).length;
    $('#command-count').textContent = String(pending);
    $('#command-count').classList.toggle('attention-count', pending > 0);
    if (state) renderHeader();
}
async function commandsDialog(): Promise<void> {
    if (!native || !outbox) {
        showModal('Доставка команд', '<p>Устойчивые команды доступны в нативной ветке. Автономная HTML-студия работает только в открытой вкладке.</p>'); return;
    }
    await refreshIntents();
    const labels = { prepared: 'Сохранена, ещё не отправлена', sending: 'Отправка начата; ответ не закреплён', unknown: 'Нужно сверить исход', confirmed: 'Хост подтвердил запуск' };
    showModal('Команды и восстановление', '<p class="muted">Сверка только читает состояние. Повтор использует исходный ID и неизменённое поручение: новый запуск вместо потерянного ответа не создаётся.</p>' +
        ([...intents].reverse().map(i => '<section class="command-card"><strong>' + esc(i.document.title) + '</strong><p>' + labels[i.state] + '</p><small>' + esc(i.id) + ' · попыток доставки: ' + i.attempts + '</small>' +
            (i.lastError ? '<p class="notice warning">' + esc(i.lastError) + '</p>' : '') +
            '<div class="result-actions"><button class="secondary" data-reconcile="' + esc(i.id) + '">Сверить с хостом</button>' +
            (i.state !== 'confirmed' ? '<button class="primary" data-resend="' + esc(i.id) + '">Доставить ту же команду</button>' : '') + '</div></section>').join('') || '<p>Команд пока нет</p>'));
}
async function deliverIntent(commandId: string, send: boolean): Promise<void> {
    assert(outbox, 'OUTBOX', 'Хранилище команд недоступно');
    assert(!commandBusy, 'BUSY', 'Другая команда ещё обрабатывается');
    const intent = intents.find(i => i.id === commandId) ?? await intentRepository.get(commandId);
    assert(intent, 'INTENT', 'Неизвестная команда');
    assert(!busy || currentRun?.documentId === intent.document.id, 'BUSY', 'Сначала завершите выбранную работу');
    if (state.activeProject !== intent.projectId) switchProject(intent.projectId);
    commandBusy = true; renderHeader();
    try {
        const result = send ? await outbox.send(commandId) : await outbox.reconcile(commandId);
        if (result) {
            closeModal(); busy = result.state === 'running';
            updateRun(result, result.state !== 'running');
            if (result.state === 'running') pollNative(result.id);
        } else toast('Запуск пока не подтверждён. Автоматической повторной отправки не было.', true);
    } finally { commandBusy = false; await refreshIntents(); }
}
async function ensureDraftSaved(): Promise<void> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    for (let attempt = 0; attempt < 100 && saving; attempt++) await new Promise<void>(resolve => setTimeout(resolve, 50));
    await persist();
    assert(!saving && !dirty && !persistenceFailed, 'PERSISTENCE', 'Сначала сохраните проект. Новый запуск не отправлен');
}
async function start(): Promise<void> {
    assert(!commandBusy, 'BUSY', 'Команда уже обрабатывается');
    if (busy) {
        if (native && currentRun) {
            commandBusy = true; renderHeader();
            try {
                await native.invoke('cancel_run', { runId: currentRun.id });
                const observed = await native.invoke<Run>('get_run', { runId: currentRun.id });
                updateRun(observed, observed.state !== 'running');
            } finally { commandBusy = false; renderHeader(); }
        }
        else
            worker?.postMessage({ type: 'cancel' });
        toast('Запрос отмены передан. Ожидается подтверждение прекращения.');
        return;
    }
    if (native && intents.some(i => pendingIntent(i) && i.document.id === editor.document.id)) { await commandsDialog(); return; }
    if ($<HTMLTextAreaElement>('#goal-input').value !== editor.document.goal.original)
        saveGoal();
    const plan = compile(editor.document);
    if (plan.diagnostics.length) {
        showModal('Конструкция ещё не готова', `<p class="muted">Никакие операции не запускались.</p>${plan.diagnostics.map(d => `<button class="diagnostic" ${d.nodeId ? `data-locate="${esc(d.nodeId)}"` : ''}><b>${esc(d.code)}</b><span>${esc(d.message)}</span></button>`).join('')}`);
        return;
    }
    if (editor.document.nodes.some(n => n.kind === 'source.files') && !active().files.length) {
        toast('Сначала выберите файлы проекта', true);
        return;
    }
    sourceAtRun = clone(active().files);
    currentRun = null;
    busy = true;
    renderHeader();
    if (native) {
        busy = false;
        assert(outbox, 'OUTBOX', 'Устойчивое хранилище команд недоступно; запуск запрещён');
        commandBusy = true; renderHeader();
        let intent: StartIntent;
        try {
            await ensureDraftSaved();
            intent = await outbox.prepare(clone(editor.document), sourceAtRun);
            await refreshIntents();
        } finally { commandBusy = false; renderHeader(); }
        await deliverIntent(intent.id, true);
        return;
    }
    const blob = new Blob([window.__STUDIO_WORKER__], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
        worker = new Worker(url);
    }
    catch (e) {
        busy = false;
        renderHeader();
        throw e;
    }
    finally {
        URL.revokeObjectURL(url);
    }
    worker.onmessage = (event: MessageEvent<{
        type: string;
        run?: Run;
        message?: string;
    }>) => { if (event.data.run)
        updateRun(event.data.run, event.data.type === 'done');
    else if (event.data.type === 'error') {
        busy = false;
        worker?.terminate();
        worker = null;
        renderHeader();
        toast(event.data.message ?? 'Ошибка исполнителя', true);
    } };
    worker.onerror = () => { busy = false; if (currentRun) {
        currentRun.state = 'interrupted';
        currentRun.error = 'Исполнитель прервался. Автоматического повтора нет.';
        updateRun(currentRun, true);
    }
    else {
        renderHeader();
        toast('Не удалось создать локального исполнителя', true);
    } };
    worker.postMessage({ type: 'run', document: clone(editor.document), files: sourceAtRun, concurrency: quiet ? 1 : 2 });
}
function download(name: string, text: string, type = 'application/json'): void { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function locate(nodeId: string): void { for (const w of editor.document.workspaces)
    for (const s of w.sheets) {
        const v = s.views.find(v => v.nodeId === nodeId);
        if (v) {
            active().selectedWorkspace = w.id;
            active().selectedSheet = s.id;
            selected = nodeId;
            mode = 'canvas';
            closeModal();
            render();
            const area = $('#canvas-surface');
            s.viewport = { x: area.clientWidth / 2 - v.x * .85 - 132 * .85, y: 100 - v.y * .85, zoom: .85 };
            updateTransform();
            changed(false);
            return;
        }
    } toast('Узел не показан ни на одном листе', true); }
function switchProject(projectId: string): void { assert(!busy, 'BUSY', 'Сначала дождитесь результата или отмените запуск в этом профиле'); active().document = clone(editor.document); state.activeProject = projectId; editor = new Editor(active().document); currentRun = null; selected = null; mode = 'canvas'; changed(); }
function bind(): void {
    document.addEventListener('click', event => protect(async () => {
        const target = event.target as Element;
        const b = target.closest<HTMLElement>('button,[data-mode]');
        if (!b)
            return;
        const d = b.dataset;
        if (d['reconcile']) { await deliverIntent(d['reconcile'], false); return; }
        if (d['resend']) { await deliverIntent(d['resend'], true); return; }
        if (d['artifact'] !== undefined) { lastArtifact = Number(d['artifact']); lastPreviewFile = 0; renderResult(); return; }
        if (d['project']) {
            switchProject(d['project']);
            return;
        }
        if (d['space']) {
            active().selectedWorkspace = d['space'];
            active().selectedSheet = workspace().sheets[0]!.id;
            selected = null;
            changed();
            return;
        }
        if (d['sheet']) {
            active().selectedSheet = d['sheet'];
            selected = null;
            changed();
            return;
        }
        if (d['mode']) {
            mode = d['mode'] as typeof mode;
            renderHeader();
            renderResult();
            renderHistory();
            return;
        }
        if (d['run']) {
            assert(!busy, 'BUSY', 'Дождитесь текущего запуска');
            active().selectedRun = d['run'];
            currentRun = null;
            mode = 'result';
            changed();
            return;
        }
        if (d['locate']) {
            locate(d['locate']);
            return;
        }
        if (d['addKind']) {
            const view = sheet().viewport;
            const area = $('#canvas-surface');
            selected = editor.add(d['addKind'] as Kind, workspace().id, sheet().id, (area.clientWidth / 2 - view.x) / view.zoom - 132, (180 - view.y) / view.zoom);
            closeModal();
            changed();
            return;
        }
        if (d['template']) {
            assert(!busy, 'BUSY', 'Сначала завершите запуск');
            const title = $<HTMLInputElement>('#new-title').value.trim() || 'Новая работа';
            const p = initialProject(title, d['template'] as TemplateName);
            p.files = clone(active().files);
            state.projects.push(p);
            closeModal();
            switchProject(p.id);
            fit();
            return;
        }
        if (d['portOut']) {
            connectFrom = d['portOut'];
            renderCanvas();
            return;
        }
        if (d['portIn']) {
            if (connectFrom) {
                editor.connect(connectFrom, d['portIn']);
                connectFrom = null;
                changed();
            }
            else
                toast('Сначала выберите выход источника');
            return;
        }
        if (d['removeEdge']) {
            editor.commit(doc => { doc.edges = doc.edges.filter(e => e.id !== d['removeEdge']); });
            changed();
            return;
        }
        if (d['removeCheck']) {
            editor.commit(doc => { doc.goal.obligations = doc.goal.obligations.filter(o => o.id !== d['removeCheck']); doc.goal.revision++; });
            changed();
            return;
        }
        if (d['preview']) {
            lastPreviewFile = Number(d['preview']);
            renderResult();
            return;
        }
        const action = d['action'];
        switch (action) {
            case 'commands':
                await commandsDialog();
                break;
            case 'new-project':
                newProjectDialog();
                break;
            case 'add-node':
                palette();
                break;
            case 'add-sheet':
                showModal('Новый лист', '<label class="field-label">Название<input id="new-sheet-title" value="Проверка и результат"></label><button class="primary full" data-action="save-sheet">Создать лист</button>');
                break;
            case 'save-sheet': {
                const title = $<HTMLInputElement>('#new-sheet-title').value.trim() || 'Новый лист';
                const sid = id('sheet');
                editor.commit(doc => { doc.workspaces.find(w => w.id === workspace().id)!.sheets.push({ id: sid, title, views: [], viewport: { x: 100, y: 100, zoom: 1 } }); });
                active().selectedSheet = sid;
                closeModal();
                selected = null;
                changed();
                break;
            }
            case 'new-space':
                showModal('Новое пространство', '<label class="field-label">Название<input id="new-space-title" value="Новая задача"></label><button class="primary full" data-action="save-space">Создать пространство</button>');
                break;
            case 'save-space': {
                const wid = id('space'), sid = id('sheet'), title = $<HTMLInputElement>('#new-space-title').value.trim() || 'Пространство';
                editor.commit(doc => doc.workspaces.push({ id: wid, title, sheets: [{ id: sid, title: 'Конструкция', views: [], viewport: { x: 60, y: 100, zoom: 1 } }] }));
                active().selectedWorkspace = wid;
                active().selectedSheet = sid;
                selected = null;
                closeModal();
                changed();
                break;
            }
            case 'files':
                $<HTMLInputElement>('#file-input').click();
                break;
            case 'folder':
                if (native) {
                    const result = await native.invoke<{
                        name: string;
                        files: FileData[];
                    } | null>('choose_folder');
                    if (result) {
                        validateFiles(result.files);
                        active().files = result.files;
                        changed();
                    }
                }
                else
                    $<HTMLInputElement>('#folder-input').click();
                break;
            case 'show-sources':
                showModal('Исходные копии файлов', `<p class="muted">Читается только выбранная копия. Исходники не перезаписываются.</p>${active().files.map(f => `<details class="source-detail"><summary>${esc(f.path)} <small>${bytes(f.content)} Б</small></summary><pre>${esc(f.content.slice(0, 10000))}</pre></details>`).join('') || '<p>Сначала импортируйте файлы.</p>'}<button class="secondary full" data-action="files">Выбрать файлы</button>`);
                break;
            case 'goal-save':
                saveGoal();
                break;
            case 'run':
                await start();
                break;
            case 'preflight': {
                const p = compile(editor.document);
                showModal('Проверка конструкции', p.diagnostics.length ? p.diagnostics.map(d => `<div class="notice warning">${esc(d.message)}</div>`).join('') : `<div class="notice success">${p.order.length} операций, ${p.layers.length} уровней зависимостей. Типы и порядок согласованы. Это не проверка фактического результата.</div>`);
                break;
            }
            case 'fit':
                fit();
                break;
            case 'zoom-in':
                sheet().viewport.zoom = Math.min(2, sheet().viewport.zoom + .1);
                updateTransform();
                changed(false);
                break;
            case 'zoom-out':
                sheet().viewport.zoom = Math.max(.2, sheet().viewport.zoom - .1);
                updateTransform();
                changed(false);
                break;
            case 'undo':
                editor.undo();
                changed();
                break;
            case 'redo':
                editor.redo();
                changed();
                break;
            case 'close-inspector':
                selected = null;
                render();
                break;
            case 'close-modal':
                closeModal();
                break;
            case 'settings':
                settingsDialog();
                break;
            case 'theme':
                state.theme = state.theme === 'dark' ? 'light' : 'dark';
                document.documentElement.dataset['theme'] = state.theme;
                changed(false);
                break;
            case 'remove-node':
                if (selected) {
                    editor.remove(selected);
                    selected = null;
                    changed();
                }
                break;
            case 'connect-select': {
                const source = $<HTMLSelectElement>('#source-select').value;
                assert(source && selected, 'INPUT', 'Выберите источник');
                editor.connect(source, selected);
                changed();
                break;
            }
            case 'add-check':
                criteriaDialog();
                break;
            case 'save-check': {
                const path = $<HTMLInputElement>('#check-path').value;
                if (path !== '*')
                    safePath(path);
                const kind = $<HTMLSelectElement>('#check-kind').value as 'contains';
                const value = $<HTMLInputElement>('#check-value').value;
                const description = $<HTMLInputElement>('#check-desc').value.trim() || kind;
                editor.commit(doc => { doc.goal.obligations.push({ id: id('obligation'), path, kind, value, description }); doc.goal.revision++; });
                closeModal();
                changed();
                break;
            }
            case 'export-project':
                download(`${active().title.replace(/[^\p{L}\p{N}_-]/gu, '_')}.studio.json`, JSON.stringify({ format: 'platform-studio-project-v1', project: { ...active(), document: editor.document, selectedRun: null } }, null, 2));
                break;
            case 'import-project':
                $<HTMLInputElement>('#project-input').click();
                break;
            case 'export-artifact': {
                const r = run(), a = r?.artifacts[lastArtifact];
                assert(a && await validateArtifact(a), 'ARTIFACT', 'Артефакт не прошёл повторную проверку');
                download('result.artifact.json', JSON.stringify({ format: 'platform-studio-artifact-v1', artifact: a, acceptedByOwner: await acceptedResultValid(r!), acceptance: r!.acceptance ?? null, publication: 'not-applied-to-original' }, null, 2));
                break;
            }
            case 'native-export': {
                const r = run();
                assert(native && r && await acceptedResultValid(r), 'ACCEPTANCE', 'Сначала примите проверенный снимок');
                const binding = (await inspectResult(r)).bindingHash;
                const result = await native.invoke<{
                    path: string;
                } | null>('export_proposal', { runId: r.id, expectedBinding: binding, artifactHash: r.artifacts[lastArtifact]!.hash });
                if (result)
                    toast('Отдельная папка результата: ' + result.path);
                break;
            }
            case 'download-file': {
                const a = run()?.artifacts[lastArtifact];
                assert(a && await validateArtifact(a), 'ARTIFACT', 'Артефакт повреждён');
                const f = a.files[lastPreviewFile]!;
                download(f.path.split('/').at(-1)!, f.content, 'text/plain;charset=utf-8');
                break;
            }
            case 'inspect-result': {
                const r = run(); assert(r, 'RUN', 'Нет запуска');
                const checked = await inspectResult(clone(r));
                showModal('Повторная проверка снимка', '<div class="notice success">Перечитаны все ' + checked.artifactHashes.length + ' артефакт(ов). Их хэши, редакции и критерии совпали.</div>' +
                    '<p>Это детерминированная проверка встроенных критериев, не оценка скрытых рассуждений и не независимая среда ОС.</p><pre>' + esc(checked.bindingHash) + '</pre>' +
                    checked.findings.map(f => '<h3>' + esc(f.artifactHash.slice(0,12)) + '</h3>' + f.checks.map(c => '<p>✓ ' + esc(c.description) + '</p>').join('')).join(''));
                break;
            }
            case 'accept': {
                const r = run(); assert(r, 'RUN', 'Нет запуска');
                const snapshot = clone(r), checked = await inspectResult(snapshot);
                let accepted: Run;
                if (native) accepted = await native.invoke<Run>('accept_run', { runId: r.id, expectedBinding: checked.bindingHash });
                else accepted = await acceptResult(snapshot, checked.bindingHash);
                updateRun(accepted);
                try { await ensureDraftSaved(); }
                catch (error) {
                    if (!native) {
                        const index = state.runs.findIndex(x => x.id === snapshot.id);
                        if (index >= 0) state.runs[index] = snapshot;
                        currentRun = snapshot; dirty = true;
                    }
                    renderResult(); throw error;
                }
                renderResult();
                toast('Принят именно этот снимок. Исходная папка не изменялась.');
                break;
            }
            case 'show-canvas':
                mode = 'canvas';
                render();
                break;
            case 'contract':
                showModal('Контракт руководителя · ещё не отправлен', `<p class="muted">Английские рабочие инструкции и неизменённый оригинал запроса. Права не выдаются этим текстом.</p><pre class="contract">${esc(supervisorContract(editor.document.goal))}</pre>`);
                break;
            case 'help':
                showModal('Локальная студия · инкремент 0.2', `<p>Это работающий редактор с реальными встроенными преобразованиями, не подключённый ИИ.</p><ol><li>Выберите файлы или воспользуйтесь примером.</li><li>Измените задачу, узлы, параметры и критерии.</li><li>Нажмите «Начать» и откройте результат.</li><li>Проверьте содержимое и экспортируйте отдельную копию.</li></ol><p>Ctrl+K — добавить действие. Ctrl+Z / Ctrl+Shift+Z — отменить/вернуть правку. Delete — удалить узел. Порты соединяются последовательными кликами; есть выбор источника в инспекторе.</p><div class="notice warning">Нет гарантий Windows-изоляции, независимого проверяющего, внешних бесед и фонового агента. Эти функции не подменены анимацией.</div>`);
                break;
        }
    }));
    document.addEventListener('change', event => protect(async () => {
        const el = event.target as HTMLInputElement;
        const n = node();
        if (el.dataset['param'] && n) {
            const key = el.dataset['param'];
            editor.commit(doc => { doc.nodes.find(x => x.id === n.id)!.params[key] = el.value; });
            changed();
        }
        if (el.id === 'node-title' && n) {
            editor.commit(doc => { doc.nodes.find(x => x.id === n.id)!.title = el.value; });
            changed();
        }
        if (el.id === 'reference-sheet' && n && el.value) {
            const [w, s] = el.value.split('|');
            editor.reference(n.id, w!, s!);
            changed();
            toast('Добавлено представление того же узла, не второй исполнитель');
        }
        if (el.id === 'parallelism')
            quiet = el.value === 'quiet';
        if ((el.id === 'file-input' || el.id === 'folder-input') && el.files) {
            await importFiles(el.files);
            el.value = '';
        }
        if (el.id === 'project-input' && el.files?.[0]) {
            assert(!busy, 'BUSY', 'Сначала завершите запуск');
            const f = el.files[0];
            assert(f.size <= 16 * 1024 * 1024, 'LIMIT', 'Архив слишком велик');
            const data = JSON.parse(await f.text()) as {
                format: string;
                project: Project;
            };
            assert(data.format === 'platform-studio-project-v1', 'FORMAT', 'Неизвестный формат');
            validateDocument(data.project.document);
            validateFiles(data.project.files);
            const p = clone(data.project);
            p.id = id('project');
            p.document.id = id('doc');
            p.document.projectId = p.id;
            p.selectedRun = null;
            p.selectedWorkspace = p.document.workspaces[0]!.id;
            p.selectedSheet = p.document.workspaces[0]!.sheets[0]!.id;
            state.projects.push(p);
            switchProject(p.id);
            el.value = '';
            toast('Проект импортирован без запусков и полномочий');
        }
    }));
    document.addEventListener('input', event => { const e = event.target as HTMLInputElement; if (e.id === 'palette-search') {
        paletteFilter = e.value.toLowerCase();
        renderPalette();
    } });
    document.addEventListener('keydown', event => protect(() => {
        const input = (event.target as Element).closest('input,textarea,select');
        if (event.key === 'Escape') {
            connectFrom = null;
            renderCanvas();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            palette();
            return;
        }
        if (input)
            return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            event.shiftKey ? editor.redo() : editor.undo();
            changed();
        }
        if (event.key === 'Delete' && selected) {
            editor.remove(selected);
            selected = null;
            changed();
        }
        if (selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            const step = event.shiftKey ? 20 : 5;
            editor.commit(doc => { for (const w of doc.workspaces)
                for (const s of w.sheets)
                    if (s.id === sheet().id) {
                        const v = s.views.find(v => v.nodeId === selected);
                        if (v) {
                            v.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
                            v.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
                        }
                    } });
            changed();
        }
    }));
    const surface = $('#canvas-surface');
    surface.addEventListener('wheel', event => {
        const e = event as WheelEvent;
        e.preventDefault();
        const p = sheet().viewport;
        if (e.ctrlKey || e.metaKey) {
            const rect = surface.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, z = Math.max(.2, Math.min(2, p.zoom * Math.exp(-e.deltaY * .002)));
            p.x = x - (x - p.x) * z / p.zoom;
            p.y = y - (y - p.y) * z / p.zoom;
            p.zoom = z;
        }
        else {
            p.x -= e.deltaX;
            p.y -= e.deltaY;
        }
        updateTransform();
        changed(false);
    }, { passive: false });
    surface.addEventListener('pointerdown', event => {
        const e = event as PointerEvent;
        const target = e.target as Element;
        if (target.closest('button'))
            return;
        const article = target.closest<HTMLElement>('[data-node]');
        if (article) {
            selected = article.dataset['node']!;
            renderInspector();
            renderComposer();
            for (const el of document.querySelectorAll('[data-node]'))
                el.classList.toggle('selected', (el as HTMLElement).dataset['node'] === selected);
        }
        else {
            selected = null;
            renderInspector();
            renderComposer();
        }
        const drag = target.closest<HTMLElement>('[data-drag]');
        const view = drag ? sheet().views.find(v => v.id === drag.dataset['drag']) : undefined;
        if (article && !view && e.button !== 1)
            return;
        const start = { x: e.clientX, y: e.clientY, px: sheet().viewport.x, py: sheet().viewport.y, vx: view?.x ?? 0, vy: view?.y ?? 0 };
        const original = clone(editor.document);
        let moved = false;
        surface.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => { const dx = ev.clientX - start.x, dy = ev.clientY - start.y; moved = moved || Math.abs(dx) + Math.abs(dy) > 2; if (view) {
            view.x = start.vx + dx / sheet().viewport.zoom;
            view.y = start.vy + dy / sheet().viewport.zoom;
            renderCanvas();
        }
        else {
            sheet().viewport.x = start.px + dx;
            sheet().viewport.y = start.py + dy;
            updateTransform();
        } };
        const end = () => { surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerup', end); surface.removeEventListener('pointercancel', end); if (moved && view) {
            const x = view.x, y = view.y, vid = view.id;
            editor.document = original;
            editor.commit(d => { for (const w of d.workspaces)
                for (const s of w.sheets) {
                    const v = s.views.find(v => v.id === vid);
                    if (v) {
                        v.x = x;
                        v.y = y;
                    }
                } });
            changed();
        }
        else if (moved)
            changed(false); };
        surface.addEventListener('pointermove', move);
        surface.addEventListener('pointerup', end);
        surface.addEventListener('pointercancel', end);
    });
    window.addEventListener('beforeunload', event => { if (commandBusy || (busy && !native) || dirty || saving) {
        event.preventDefault();
        event.returnValue = '';
    } });
}
void boot().catch(e => { document.body.textContent = 'Не удалось открыть студию: ' + errorMessage(e); });
