(()=>{'use strict';const __modules=Object.create(null);
__modules["core/model.js"] = (() => {
const CATALOG = [
    { kind: 'source.files', label: 'Файлы проекта', description: 'Зафиксированная копия выбранных текстовых файлов', input: null, output: 'files', available: true, category: 'Источники' },
    { kind: 'source.text', label: 'Текст', description: 'Текстовый источник без вызова модели', input: null, output: 'text', available: true, category: 'Источники' },
    { kind: 'files.filter', label: 'Выбрать файлы', description: 'Фильтр по расширению или части пути', input: 'files', output: 'files', available: true, category: 'Обработка' },
    { kind: 'files.normalize', label: 'Нормализовать текст', description: 'LF, удалить пробелы в конце строк, завершающий перевод строки', input: 'files', output: 'files', available: true, category: 'Обработка' },
    { kind: 'files.replace', label: 'Заменить в файлах', description: 'Буквальная замена; без регулярных выражений и выполнения кода', input: 'files', output: 'files', available: true, category: 'Обработка' },
    { kind: 'files.report', label: 'Отчёт по файлам', description: 'Настоящие пути, размеры, строки и SHA-256 каждого файла', input: 'files', output: 'text', available: true, category: 'Обработка' },
    { kind: 'text.replace', label: 'Заменить в тексте', description: 'Заменить точное вхождение', input: 'text', output: 'text', available: true, category: 'Обработка' },
    { kind: 'text.stats', label: 'Статистика текста', description: 'Посчитать строки, символы, слова и байты', input: 'text', output: 'text', available: true, category: 'Обработка' },
    { kind: 'text.to_file', label: 'Сохранить как файл', description: 'Создать файл результата в рабочем снимке', input: 'text', output: 'files', available: true, category: 'Результаты' },
    { kind: 'files.merge', label: 'Объединить наборы', description: 'Все входы один раз; конфликт содержимого останавливает узел', input: 'files', output: 'files', available: true, category: 'Конструкция' },
    { kind: 'verify.files', label: 'Проверить обязательства', description: 'Проверка по зафиксированной редакции цели', input: 'files', output: 'files', available: true, category: 'Проверка' },
    { kind: 'result.files', label: 'Предъявить результат', description: 'Запечатать манифест и показать реальные изменения', input: 'files', output: 'files', available: true, category: 'Результаты' },
    { kind: 'agent.codex', label: 'Роль · Codex', description: 'Заблокирован до приёмки Windows-изоляции и реального адаптера', input: 'files', output: 'files', available: false, category: 'Агенты' },
    { kind: 'note', label: 'Заметка', description: 'Аннотация; не является операцией исполнения', input: null, output: null, available: true, category: 'Конструкция' }
];
const LIMITS = Object.freeze({ nodes: 500, edges: 1000, files: 256, fileBytes: 1048576, totalBytes: 8388608, runs: 30, events: 4096, workspaces: 32, sheets: 64 });
function id(prefix = 'id') { return `${prefix}_${crypto.randomUUID()}`; }
function clone(value) { return structuredClone(value); }
function bytes(text) { return new TextEncoder().encode(text).length; }
function definition(kind) { return CATALOG.find(c => c.kind === kind); }
function normalizeText(text) { return text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\t ]+$/g, '')).join('\n').replace(/\n*$/, '\n'); }
class DomainError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DomainError';
    }
}
function assert(condition, code, message) {
    if (!condition)
        throw new DomainError(code, message);
}
function safePath(path) {
    assert(typeof path === 'string' && path.length > 0 && path.length <= 240, 'PATH', 'Путь должен содержать от 1 до 240 символов');
    assert(!/[\\:\u0000-\u001f]/u.test(path) && !path.startsWith('/'), 'PATH', 'Абсолютный, служебный или Windows-путь недопустим');
    for (const part of path.split('/')) {
        assert(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'PATH', 'Недопустимый сегмент пути');
        assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/[<>"|?*]/.test(part), 'PATH', 'Зарезервированное имя Windows');
    }
    return path;
}
function validateFiles(files) {
    assert(files.length <= LIMITS.files, 'LIMIT', 'Слишком много файлов');
    const names = new Set();
    let size = 0;
    for (const f of files) {
        safePath(f.path);
        const key = f.path.toLocaleLowerCase('en-US');
        assert(!names.has(key), 'PATH_COLLISION', `Повтор пути: ${f.path}`);
        names.add(key);
        assert(typeof f.content === 'string' && !f.content.includes('\0'), 'FORMAT', `Только текст UTF-8: ${f.path}`);
        const n = bytes(f.content);
        assert(n <= LIMITS.fileBytes, 'LIMIT', `Файл превышает 1 МиБ: ${f.path}`);
        size += n;
    }
    assert(size <= LIMITS.totalBytes, 'LIMIT', 'Набор превышает 8 МиБ');
}
async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function canonical(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

return {CATALOG,LIMITS,id,clone,bytes,definition,normalizeText,DomainError,assert,safePath,validateFiles,sha256,canonical};
})();
__modules["core/graph.js"] = (() => {
const { assert, bytes, CATALOG, clone, definition, id, LIMITS, safePath } = __modules["core/model.js"];
/** Pure preflight; never touches a filesystem, provider or model. */
function compile(doc) {
    const diagnostics = [];
    const active = doc.nodes.filter(n => n.kind !== 'note');
    const nodes = new Map(active.map(n => [n.id, n]));
    const degree = new Map(active.map(n => [n.id, 0]));
    if (active.length > LIMITS.nodes || doc.edges.length > LIMITS.edges)
        diagnostics.push({ code: 'GRAPH_LIMIT', message: 'Превышен предел размера конструкции' });
    if (new Set(doc.nodes.map(n => n.id)).size !== doc.nodes.length)
        diagnostics.push({ code: 'DUPLICATE_NODE', message: 'ID узлов повторяются' });
    if (new Set(doc.edges.map(e => e.id)).size !== doc.edges.length)
        diagnostics.push({ code: 'DUPLICATE_EDGE', message: 'ID связей повторяются' });
    const edgePairs = new Set();
    for (const edge of doc.edges) {
        const from = nodes.get(edge.source), to = nodes.get(edge.target);
        if (!from || !to) {
            diagnostics.push({ code: 'MISSING_NODE', edgeId: edge.id, message: 'Связь указывает на отсутствующий или неисполняемый узел' });
            continue;
        }
        const a = definition(from.kind), b = definition(to.kind);
        const pair = `${edge.source}:${edge.target}`;
        if (edgePairs.has(pair))
            diagnostics.push({ code: 'DUPLICATE_LINK', edgeId: edge.id, message: 'Связь уже существует' });
        edgePairs.add(pair);
        if (edge.sourcePort !== 'out' || edge.targetPort !== 'in')
            diagnostics.push({ code: 'PORT', edgeId: edge.id, message: 'Неизвестный именованный порт' });
        if (!a?.output || a.output !== b?.input)
            diagnostics.push({ code: 'TYPE', edgeId: edge.id, message: 'Типы портов несовместимы' });
        degree.set(to.id, (degree.get(to.id) ?? 0) + 1);
    }
    for (const node of active) {
        const def = definition(node.kind);
        const inputs = degree.get(node.id) ?? 0;
        if (!def?.available)
            diagnostics.push({ code: 'UNAVAILABLE', nodeId: node.id, message: node.kind === 'agent.codex' ? 'Codex заблокирован: Windows-профиль и живое подключение ещё не приняты' : 'Операция недоступна' });
        if (def?.input && inputs === 0)
            diagnostics.push({ code: 'INPUT', nodeId: node.id, message: 'Обязательный вход не подключён' });
        if (!def?.input && inputs > 0)
            diagnostics.push({ code: 'UNEXPECTED_INPUT', nodeId: node.id, message: 'У источника нет входа' });
        if (inputs > 1 && (node.kind !== 'files.merge' || node.params['readPolicy'] !== 'all-once'))
            diagnostics.push({ code: 'READ_POLICY', nodeId: node.id, message: 'Несколько входов требуют узла объединения с правилом «все один раз»' });
        if (node.kind === 'text.to_file') {
            try {
                safePath(String(node.params['path'] ?? ''));
            }
            catch {
                diagnostics.push({ code: 'PATH', nodeId: node.id, message: 'Нужен безопасный относительный путь файла' });
            }
        }
        if ((node.kind === 'text.replace' || node.kind === 'files.replace') && !String(node.params['find'] ?? ''))
            diagnostics.push({ code: 'PARAM', nodeId: node.id, message: 'Строка поиска не может быть пустой' });
        if (node.kind === 'verify.files' && doc.goal.obligations.length === 0)
            diagnostics.push({ code: 'CRITERIA', nodeId: node.id, message: 'В исходной цели нет проверяемых обязательств' });
        if (node.kind === 'result.files') {
            const upstream = doc.edges.filter(e => e.target === node.id);
            if (!upstream.every(e => nodes.get(e.source)?.kind === 'verify.files'))
                diagnostics.push({ code: 'UNVERIFIED_RESULT', nodeId: node.id, message: 'Результат должен получать данные непосредственно от проверки' });
        }
    }
    if (!active.some(n => n.kind === 'result.files'))
        diagnostics.push({ code: 'NO_RESULT', message: 'Добавьте узел предъявления результата' });
    const pending = new Set(active.map(n => n.id));
    const layers = [];
    const order = [];
    while (pending.size) {
        const ready = [...pending].filter(n => degree.get(n) === 0).sort();
        if (!ready.length) {
            diagnostics.push({ code: 'CYCLE', message: 'Обнаружен цикл. Ограниченные циклы в этом инкременте ещё не реализованы' });
            break;
        }
        layers.push(ready);
        for (const n of ready) {
            pending.delete(n);
            order.push(n);
            for (const e of doc.edges.filter(e => e.source === n))
                degree.set(e.target, (degree.get(e.target) ?? 1) - 1);
        }
    }
    // A quietly abandoned branch must not be reported as part of the accepted result.
    const useful = new Set(active.filter(n => n.kind === 'result.files').map(n => n.id));
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of doc.edges)
            if (useful.has(e.target) && !useful.has(e.source)) {
                useful.add(e.source);
                changed = true;
            }
    }
    for (const n of active)
        if (!useful.has(n.id))
            diagnostics.push({ code: 'UNUSED', nodeId: n.id, message: 'Ветка не ведёт к предъявляемому результату' });
    return { documentId: doc.id, revision: doc.revision, order, layers, diagnostics };
}
function defaultParams(kind) {
    switch (kind) {
        case 'source.text': return { text: 'Текст нового источника' };
        case 'files.filter': return { match: '.md' };
        case 'files.replace':
        case 'text.replace': return { find: 'TODO', replace: 'Готово' };
        case 'text.to_file': return { path: 'result.md' };
        case 'files.merge': return { readPolicy: 'all-once' };
        case 'note': return { text: 'Заметка не исполняется' };
        default: return {};
    }
}
class Editor {
    document;
    past = [];
    future = [];
    constructor(document) {
        this.document = document;
        this.document = clone(document);
    }
    commit(mutator, expected = this.document.revision) {
        assert(expected === this.document.revision, 'CONFLICT', 'Документ уже изменён. Сначала перечитайте текущую редакцию.');
        const next = clone(this.document);
        mutator(next);
        next.revision = this.document.revision + 1;
        validateDocument(next);
        this.past.push(this.document);
        if (this.past.length > 50)
            this.past.shift();
        this.future = [];
        this.document = next;
    }
    undo() {
        const old = this.past.pop();
        if (!old)
            return false;
        this.future.push(this.document);
        old.revision = this.document.revision + 1;
        old.goal.revision = this.document.goal.revision + 1;
        this.document = old;
        return true;
    }
    redo() {
        const next = this.future.pop();
        if (!next)
            return false;
        this.past.push(this.document);
        next.revision = this.document.revision + 1;
        next.goal.revision = this.document.goal.revision + 1;
        this.document = next;
        return true;
    }
    add(kind, workspaceId, sheetId, x = 160, y = 160) {
        const nodeId = id('node');
        this.commit(d => {
            assert(d.nodes.length < LIMITS.nodes, 'LIMIT', 'Достигнут предел узлов');
            const sheet = d.workspaces.find(w => w.id === workspaceId)?.sheets.find(s => s.id === sheetId);
            assert(sheet, 'SHEET', 'Лист не найден');
            d.nodes.push({ id: nodeId, kind, title: definition(kind)?.label ?? kind, params: defaultParams(kind) });
            sheet.views.push({ id: id('view'), nodeId, x, y });
        });
        return nodeId;
    }
    connect(source, target) {
        this.commit(d => {
            assert(source !== target, 'CYCLE', 'Нельзя соединить узел с собой');
            const a = d.nodes.find(n => n.id === source), b = d.nodes.find(n => n.id === target);
            assert(a && b, 'NODE', 'Узел не найден');
            const out = definition(a.kind)?.output;
            assert(out && out === definition(b.kind)?.input, 'TYPE', 'Типы портов несовместимы');
            assert(!d.edges.some(e => e.source === source && e.target === target), 'DUPLICATE', 'Связь уже существует');
            const edge = { id: id('edge'), source, target, sourcePort: 'out', targetPort: 'in' };
            d.edges.push(edge);
            assert(!compile(d).diagnostics.some(e => e.code === 'CYCLE'), 'CYCLE', 'Связь создаёт цикл');
        });
    }
    remove(nodeId) {
        this.commit(d => {
            d.nodes = d.nodes.filter(n => n.id !== nodeId);
            d.edges = d.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
            for (const w of d.workspaces)
                for (const s of w.sheets)
                    s.views = s.views.filter(v => v.nodeId !== nodeId);
        });
    }
    reference(nodeId, workspaceId, sheetId) {
        this.commit(d => {
            assert(d.nodes.some(n => n.id === nodeId), 'NODE', 'Нет такого узла');
            const sheet = d.workspaces.find(w => w.id === workspaceId)?.sheets.find(s => s.id === sheetId);
            assert(sheet, 'SHEET', 'Лист не найден');
            assert(!sheet.views.some(v => v.nodeId === nodeId), 'DUPLICATE', 'На этом листе узел уже виден');
            sheet.views.push({ id: id('view'), nodeId, x: 160, y: 140 });
        });
    }
}
/** Validates imported documents before they enter rendering or execution. */
function validateDocument(input) {
    assert(input && typeof input === 'object', 'SCHEMA', 'Нужен объект документа');
    const d = input;
    assert(d.schema === 1 && typeof d.id === 'string' && typeof d.projectId === 'string' && typeof d.title === 'string', 'SCHEMA', 'Неподдержанная схема');
    assert(Number.isSafeInteger(d.revision) && d.revision >= 1, 'SCHEMA', 'Некорректная редакция');
    assert(Array.isArray(d.nodes) && d.nodes.length <= LIMITS.nodes && Array.isArray(d.edges) && d.edges.length <= LIMITS.edges, 'SCHEMA', 'Некорректный граф');
    assert(d.goal && typeof d.goal.original === 'string' && bytes(d.goal.original) <= 65536 && Number.isSafeInteger(d.goal.revision) && d.goal.revision >= 1 && Array.isArray(d.goal.obligations) && d.goal.obligations.length <= 64, 'SCHEMA', 'Некорректная цель');
    const nodeIds = new Set();
    for (const n of d.nodes) {
        assert(typeof n.id === 'string' && n.id.length < 128 && !nodeIds.has(n.id), 'SCHEMA', 'ID узла повторяется или недопустим');
        nodeIds.add(n.id);
        assert(CATALOG.some(c => c.kind === n.kind) && typeof n.title === 'string' && n.title.length <= 512, 'SCHEMA', 'Некорректная операция');
        assert(n.params && typeof n.params === 'object' && !Array.isArray(n.params), 'SCHEMA', 'Некорректные параметры');
        assert(Object.entries(n.params).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && ['string', 'boolean', 'number'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))), 'SCHEMA', 'Недопустимое значение параметра');
        assert(bytes(JSON.stringify(n.params)) <= LIMITS.fileBytes, 'LIMIT', 'Параметры слишком большие');
    }
    const edgeIds = new Set();
    for (const e of d.edges) {
        assert(typeof e.id === 'string' && !edgeIds.has(e.id) && typeof e.source === 'string' && typeof e.target === 'string' && e.sourcePort === 'out' && e.targetPort === 'in', 'SCHEMA', 'Некорректная связь');
        edgeIds.add(e.id);
    }
    const ids = new Set();
    assert(Array.isArray(d.workspaces) && d.workspaces.length > 0 && d.workspaces.length <= LIMITS.workspaces, 'SCHEMA', 'Некорректные пространства');
    for (const w of d.workspaces) {
        assert(typeof w.id === 'string' && !ids.has(w.id) && typeof w.title === 'string' && Array.isArray(w.sheets) && w.sheets.length > 0 && w.sheets.length <= LIMITS.sheets, 'SCHEMA', 'Некорректное пространство');
        ids.add(w.id);
        for (const s of w.sheets) {
            assert(typeof s.id === 'string' && !ids.has(s.id) && typeof s.title === 'string' && Array.isArray(s.views) && s.views.length <= LIMITS.nodes, 'SCHEMA', 'Некорректный лист');
            ids.add(s.id);
            assert(s.viewport && Number.isFinite(s.viewport.x) && Number.isFinite(s.viewport.y) && Number.isFinite(s.viewport.zoom) && s.viewport.zoom >= .2 && s.viewport.zoom <= 2, 'SCHEMA', 'Некорректный масштаб');
            const shown = new Set();
            for (const v of s.views) {
                assert(typeof v.id === 'string' && !ids.has(v.id) && nodeIds.has(v.nodeId) && !shown.has(v.nodeId) && Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) < 100000 && Math.abs(v.y) < 100000, 'SCHEMA', 'Некорректное представление узла');
                ids.add(v.id);
                shown.add(v.nodeId);
            }
        }
    }
    const obligations = new Set();
    for (const c of d.goal.obligations) {
        assert(typeof c.id === 'string' && !obligations.has(c.id) && typeof c.description === 'string' && typeof c.path === 'string' && typeof c.value === 'string' && ['file_exists', 'contains', 'not_contains', 'valid_json', 'normalized', 'nonempty'].includes(c.kind), 'SCHEMA', 'Некорректное обязательство');
        obligations.add(c.id);
        if (c.path !== '*')
            safePath(c.path);
        if (c.kind === 'contains' || c.kind === 'not_contains')
            assert(c.value.length > 0, 'SCHEMA', 'Пустая строка не является проверяемым критерием');
    }
}
function createDocument(projectId, name, template = 'report') {
    const w = { id: id('space'), title: 'Основное пространство', sheets: [{ id: id('sheet'), title: 'Конструкция', views: [], viewport: { x: 60, y: 100, zoom: .85 } }] };
    const d = { schema: 1, id: id('doc'), projectId, title: name, revision: 1, goal: { original: '', revision: 1, obligations: [] }, nodes: [], edges: [], workspaces: [w] };
    const add = (kind, x, y, params = {}) => { const n = { id: id('node'), kind, title: definition(kind).label, params: { ...defaultParams(kind), ...params } }; d.nodes.push(n); w.sheets[0].views.push({ id: id('view'), nodeId: n.id, x, y }); return n; };
    const link = (a, b) => d.edges.push({ id: id('edge'), source: a.id, target: b.id, sourcePort: 'out', targetPort: 'in' });
    const check = (o) => d.goal.obligations.push({ ...o, id: id('obligation') });
    if (template === 'empty')
        return d;
    const a = add('source.files', 30, 160);
    if (template === 'report') {
        d.goal.original = 'Составить проверяемый отчёт по выбранным файлам: пути, объём, строки и хэши. Оригиналы не изменять.';
        const b = add('files.report', 350, 160), c = add('text.to_file', 670, 160, { path: 'project-report.md' }), v = add('verify.files', 990, 160), r = add('result.files', 1310, 160);
        link(a, b);
        link(b, c);
        link(c, v);
        link(v, r);
        check({ kind: 'contains', path: 'project-report.md', value: 'SHA-256', description: 'В отчёте есть хэши исходных файлов' });
        check({ kind: 'nonempty', path: 'project-report.md', value: '', description: 'Отчёт не пуст' });
    }
    else if (template === 'normalize') {
        d.goal.original = 'Нормализовать окончания строк и пробелы текстовых файлов. Сохранить исходники; предъявить изменённую копию.';
        const b = add('files.normalize', 350, 160), v = add('verify.files', 670, 160), r = add('result.files', 990, 160);
        link(a, b);
        link(b, v);
        link(v, r);
        check({ kind: 'normalized', path: '*', value: '', description: 'LF, без хвостовых пробелов, с завершающим переводом строки' });
    }
    else {
        d.goal.original = 'Поручить работу Codex; требуется проверенный Windows-профиль.';
        const b = add('agent.codex', 350, 160), v = add('verify.files', 670, 160), r = add('result.files', 990, 160);
        link(a, b);
        link(b, v);
        link(v, r);
        check({ kind: 'nonempty', path: '*', value: '', description: 'Предъявлены реальные файлы; семантическая приёмка ещё не настроена' });
    }
    return d;
}

return {compile,defaultParams,Editor,validateDocument,createDocument};
})();
__modules["core/runtime.js"] = (() => {
const { assert, bytes, canonical, clone, DomainError, id, LIMITS, normalizeText, safePath, sha256, validateFiles } = __modules["core/model.js"];
const { compile, validateDocument } = __modules["core/graph.js"];
function verify(files, checks) {
    return checks.map(c => {
        const selected = files.filter(f => c.path === '*' || f.path === c.path);
        let passed = selected.length > 0;
        if (passed)
            for (const f of selected) {
                switch (c.kind) {
                    case 'file_exists': break;
                    case 'contains':
                        passed = passed && f.content.includes(c.value);
                        break;
                    case 'not_contains':
                        passed = passed && !f.content.includes(c.value);
                        break;
                    case 'nonempty':
                        passed = passed && f.content.trim().length > 0;
                        break;
                    case 'normalized':
                        passed = passed && normalizeText(f.content) === f.content;
                        break;
                    case 'valid_json':
                        try {
                            JSON.parse(f.content);
                        }
                        catch {
                            passed = false;
                        }
                        break;
                    default: passed = false;
                }
            }
        return { obligationId: c.id, description: c.description, passed, detail: selected.length === 0 ? 'Ни один файл не соответствует пути' : `${selected.length} файл(ов) · ${passed ? 'условие выполнено' : 'условие не выполнено'}` };
    });
}
async function seal(files, doc, findings) {
    validateFiles(files);
    const manifest = [];
    for (const f of [...files].sort((a, b) => a.path < b.path ? -1 : 1))
        manifest.push({ path: f.path, hash: await sha256(f.content), bytes: bytes(f.content) });
    const hash = await sha256(canonical({ manifest, goalRevision: doc.goal.revision, graphRevision: doc.revision }));
    return { id: `sha256:${hash}`, files: clone([...files]), manifest, hash, goalRevision: doc.goal.revision, graphRevision: doc.revision, findings: clone(findings) };
}
async function validateArtifact(artifact) {
    try {
        validateFiles(artifact.files);
        const entries = [];
        for (const f of [...artifact.files].sort((a, b) => a.path < b.path ? -1 : 1))
            entries.push({ path: f.path, hash: await sha256(f.content), bytes: bytes(f.content) });
        return artifact.id === `sha256:${artifact.hash}` && canonical(entries) === canonical(artifact.manifest) && artifact.hash === await sha256(canonical({ manifest: entries, goalRevision: artifact.goalRevision, graphRevision: artifact.graphRevision }));
    }
    catch {
        return false;
    }
}
function diff(base, next) {
    const a = new Map(base.map(f => [f.path, f.content])), b = new Map(next.map(f => [f.path, f.content]));
    return [...new Set([...a.keys(), ...b.keys()])].sort().map(path => ({ path, status: !a.has(path) ? 'added' : !b.has(path) ? 'removed' : a.get(path) === b.get(path) ? 'unchanged' : 'modified', before: a.get(path) ?? null, after: b.get(path) ?? null }));
}
function publicationConflicts(base, current, next) {
    const original = new Map(base.map(f => [f.path, f.content]));
    const actual = new Map(current.map(f => [f.path, f.content]));
    return diff(base, next).filter(c => c.status !== 'unchanged' && actual.get(c.path) !== original.get(c.path) && (actual.get(c.path) ?? null) !== c.after).map(c => c.path);
}
async function operate(node, inputs, files, doc) {
    const first = inputs[0];
    let value;
    let findings = [];
    const p = node.params;
    const getFiles = () => { assert(first?.type === 'files', 'TYPE', 'Ожидался набор файлов'); return first.files; };
    const getText = () => { assert(first?.type === 'text', 'TYPE', 'Ожидался текст'); return first.text; };
    switch (node.kind) {
        case 'source.files':
            value = { type: 'files', files: clone(files) };
            break;
        case 'source.text':
            value = { type: 'text', text: String(p['text'] ?? '') };
            break;
        case 'files.filter': {
            const pattern = String(p['match'] ?? '');
            value = { type: 'files', files: getFiles().filter(f => f.path.includes(pattern)) };
            break;
        }
        case 'files.normalize':
            value = { type: 'files', files: getFiles().map(f => ({ ...f, content: normalizeText(f.content) })) };
            break;
        case 'files.replace': {
            const find = String(p['find'] ?? '');
            assert(find, 'PARAM', 'Пустой поиск');
            const replacement = String(p['replace'] ?? '');
            value = { type: 'files', files: getFiles().map(f => ({ ...f, content: replaceBounded(f.content, find, replacement) })) };
            break;
        }
        case 'text.replace': {
            const find = String(p['find'] ?? '');
            assert(find, 'PARAM', 'Пустой поиск');
            value = { type: 'text', text: replaceBounded(getText(), find, String(p['replace'] ?? '')) };
            break;
        }
        case 'text.stats': {
            const text = getText();
            value = { type: 'text', text: JSON.stringify({ lines: text ? text.split('\n').length : 0, characters: [...text].length, words: text.trim() ? text.trim().split(/\s+/u).length : 0, bytes: bytes(text) }, null, 2) };
            break;
        }
        case 'files.report': {
            const fs = getFiles();
            assert(fs.length, 'EMPTY', 'Для отчёта нужен хотя бы один файл');
            const rows = ['# Отчёт по проекту', '', '| Файл | Байт UTF-8 | Строк | SHA-256 |', '|---|---:|---:|---|'];
            for (const f of fs)
                rows.push(`| ${f.path.replaceAll('|', '\\|')} | ${bytes(f.content)} | ${f.content ? f.content.split('\n').length : 0} | ${await sha256(f.content)} |`);
            rows.push('', `Всего файлов: ${fs.length}`, '');
            value = { type: 'text', text: rows.join('\n') };
            break;
        }
        case 'text.to_file':
            value = { type: 'files', files: [{ path: safePath(String(p['path'] ?? '')), content: getText() }] };
            break;
        case 'files.merge': {
            assert(p['readPolicy'] === 'all-once', 'READ_POLICY', 'Не задано правило чтения');
            const map = new Map();
            for (const input of inputs) {
                assert(input.type === 'files', 'TYPE', 'Нужны файлы');
                for (const f of input.files) {
                    const old = map.get(f.path.toLowerCase());
                    assert(!old || old.path === f.path && old.content === f.content, 'MERGE_CONFLICT', `Конфликт содержимого: ${f.path}`);
                    map.set(f.path.toLowerCase(), f);
                }
            }
            value = { type: 'files', files: [...map.values()] };
            break;
        }
        case 'verify.files': {
            const fs = getFiles();
            findings = verify(fs, doc.goal.obligations);
            assert(findings.length > 0 && findings.every(f => f.passed), 'VERIFICATION', findings.filter(f => !f.passed).map(f => f.description + ': ' + f.detail).join('; ') || 'Нет обязательств');
            value = { type: 'files', files: fs };
            break;
        }
        case 'result.files':
            value = { type: 'files', files: getFiles() };
            assert(value.files.length, 'EMPTY', 'Пустой набор не является результатом');
            break;
        default: throw new DomainError('UNAVAILABLE', 'Операция не имеет принятого исполнителя');
    }
    if (value.type === 'files')
        validateFiles(value.files);
    else
        assert(bytes(value.text) <= LIMITS.fileBytes, 'LIMIT', 'Результат текста превышает 1 МиБ');
    return { value, findings };
}
function replaceBounded(text, find, replacement) {
    const count = text.split(find).length - 1;
    // Bound before allocation; UTF-8 check follows after replacement.
    assert(text.length + count * (replacement.length - find.length) <= LIMITS.fileBytes, 'LIMIT', 'Замена превысит допустимый размер');
    return text.replaceAll(find, replacement);
}
/** Executes only compiled, built-in pure operations; never evals code or starts a process. */
async function execute(document, sourceFiles, hooks = {}) {
    validateDocument(document);
    validateFiles(sourceFiles);
    const doc = clone(document), files = clone(sourceFiles), plan = compile(doc);
    assert(!plan.diagnostics.length, 'PREFLIGHT', plan.diagnostics.map(d => d.message).join('\n'));
    const run = { id: id('run'), documentId: doc.id, revision: doc.revision, goalRevision: doc.goal.revision, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, nodes: {}, previews: {}, events: [], artifacts: [], error: null, profile: hooks.profile ?? 'browser-local', inputHash: await sha256(canonical(files)), documentHash: await sha256(canonical(doc)), inputs: clone(files), goal: clone(doc.goal), accepted: false };
    for (const n of plan.order)
        run.nodes[n] = 'queued';
    let eventSeq = 0;
    const emit = (kind, message, nodeId = null) => {
        run.events.push({ seq: ++eventSeq, runId: run.id, at: new Date().toISOString(), kind, nodeId, message });
        if (run.events.length > LIMITS.events)
            run.events.shift();
        hooks.onUpdate?.(clone(run));
    };
    const outputs = new Map();
    const findingsByNode = new Map();
    let failure = null;
    let retainedOutputBytes = 0;
    const cancelled = () => {
        if (hooks.signal?.aborted)
            throw new DomainError('CANCELLED', 'Отменено владельцем');
    };
    const checkpoint = hooks.checkpoint ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
    const concurrency = Math.max(1, Math.min(4, hooks.concurrency ?? 2));
    emit('run.started', 'Зафиксированы цель, конструкция и входы');
    try {
        for (const layer of plan.layers) {
            cancelled();
            for (let start = 0; start < layer.length; start += concurrency) {
                const batch = layer.slice(start, start + concurrency);
                await Promise.all(batch.map(async (nodeId) => {
                    if (failure)
                        return;
                    const node = doc.nodes.find(n => n.id === nodeId);
                    try {
                        cancelled();
                        run.nodes[nodeId] = 'running';
                        emit('node.started', node.title, nodeId);
                        await checkpoint();
                        cancelled();
                        const incoming = doc.edges.filter(e => e.target === nodeId).sort((a, b) => a.id < b.id ? -1 : 1);
                        const inputs = incoming.map(e => { const v = outputs.get(e.source); assert(v, 'DEPENDENCY', 'Нет выхода зависимости'); return v; });
                        const result = await operate(node, inputs, files, doc);
                        cancelled();
                        retainedOutputBytes += result.value.type === 'text' ? bytes(result.value.text) : result.value.files.reduce((n, f) => n + bytes(f.content), 0);
                        assert(retainedOutputBytes <= 64 * 1024 * 1024, 'WORKING_SET', 'Логические выходы графа превысили 64 МиБ');
                        outputs.set(nodeId, result.value);
                        const inherited = incoming.flatMap(e => findingsByNode.get(e.source) ?? []);
                        findingsByNode.set(nodeId, result.findings.length ? result.findings : inherited);
                        run.previews[nodeId] = result.value.type === 'text' ? result.value.text.slice(0, 180) : `${result.value.files.length} файл(ов) · ${result.value.files.reduce((s, f) => s + bytes(f.content), 0).toLocaleString('ru')} Б`;
                        if (node.kind === 'result.files' && result.value.type === 'files') {
                            const checks = verify(result.value.files, doc.goal.obligations);
                            assert(checks.length && checks.every(f => f.passed), 'VERIFICATION', 'Финальный повтор проверки не пройден');
                            run.artifacts.push(await seal(result.value.files, doc, checks));
                            cancelled();
                        }
                        run.nodes[nodeId] = 'completed';
                        emit('node.completed', run.previews[nodeId] ?? 'Выполнено', nodeId);
                    }
                    catch (error) {
                        run.nodes[nodeId] = hooks.signal?.aborted ? 'cancelled' : 'failed';
                        const e = error instanceof Error ? error : new Error(String(error));
                        failure = e;
                        emit('node.failed', e.message, nodeId);
                    }
                }));
                if (failure)
                    throw failure;
            }
        }
        cancelled();
        assert(run.artifacts.length, 'EMPTY', 'Нет запечатанного результата');
        run.state = 'review';
        emit('run.review', 'Локальные проверки выполнены. Решение владельца ещё не принято.');
    }
    catch (error) {
        run.state = hooks.signal?.aborted ? 'cancelled' : 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.artifacts = [];
        for (const n of plan.order)
            if (run.nodes[n] === 'queued' || run.nodes[n] === 'running')
                run.nodes[n] = 'cancelled';
        emit(`run.${run.state}`, run.error);
    }
    run.finishedAt = new Date().toISOString();
    hooks.onUpdate?.(clone(run));
    return clone(run);
}

return {verify,seal,validateArtifact,diff,publicationConflicts,execute};
})();
__modules["ui/worker.js"] = (() => {
const { execute } = __modules["core/runtime.js"];
let controller = null;
self.onmessage = async (event) => {
    if (event.data.type === 'cancel') {
        controller?.abort();
        return;
    }
    if (event.data.type !== 'run' || !event.data.document || !event.data.files)
        return;
    if (controller) {
        self.postMessage({ type: 'error', message: 'Исполнитель уже занят' });
        return;
    }
    controller = new AbortController();
    try {
        const run = await execute(event.data.document, event.data.files, { signal: controller.signal, concurrency: event.data.concurrency ?? 2, onUpdate: run => self.postMessage({ type: 'update', run }) });
        self.postMessage({ type: 'done', run });
    }
    catch (error) {
        self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    finally {
        controller = null;
    }
};

return {};
})();
})();