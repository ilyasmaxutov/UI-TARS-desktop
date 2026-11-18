import { assert, bytes, CATALOG, clone, definition, Document, Edge, id, Kind, LIMITS, NodeDef, NodeView, Obligation, Params, safePath, Workspace } from './model.js';
export interface Diagnostic {
    code: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
}
export interface Plan {
    documentId: string;
    revision: number;
    order: string[];
    layers: string[][];
    diagnostics: Diagnostic[];
}
/** Pure preflight; never touches a filesystem, provider or model. */
export function compile(doc: Document): Plan {
    const diagnostics: Diagnostic[] = [];
    const active = doc.nodes.filter(n => n.kind !== 'note');
    const nodes = new Map(active.map(n => [n.id, n]));
    const degree = new Map(active.map(n => [n.id, 0]));
    if (active.length > LIMITS.nodes || doc.edges.length > LIMITS.edges)
        diagnostics.push({ code: 'GRAPH_LIMIT', message: 'Превышен предел размера конструкции' });
    if (new Set(doc.nodes.map(n => n.id)).size !== doc.nodes.length)
        diagnostics.push({ code: 'DUPLICATE_NODE', message: 'ID узлов повторяются' });
    if (new Set(doc.edges.map(e => e.id)).size !== doc.edges.length)
        diagnostics.push({ code: 'DUPLICATE_EDGE', message: 'ID связей повторяются' });
    const edgePairs = new Set<string>();
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
    const layers: string[][] = [];
    const order: string[] = [];
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
export function defaultParams(kind: Kind): Params {
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
export class Editor {
    private past: Document[] = [];
    private future: Document[] = [];
    constructor(public document: Document) { this.document = clone(document); }
    commit(mutator: (d: Document) => void, expected = this.document.revision): void {
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
    undo(): boolean { const old = this.past.pop(); if (!old)
        return false; this.future.push(this.document); old.revision = this.document.revision + 1; old.goal.revision = this.document.goal.revision + 1; this.document = old; return true; }
    redo(): boolean { const next = this.future.pop(); if (!next)
        return false; this.past.push(this.document); next.revision = this.document.revision + 1; next.goal.revision = this.document.goal.revision + 1; this.document = next; return true; }
    add(kind: Kind, workspaceId: string, sheetId: string, x = 160, y = 160): string {
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
    connect(source: string, target: string): void {
        this.commit(d => {
            assert(source !== target, 'CYCLE', 'Нельзя соединить узел с собой');
            const a = d.nodes.find(n => n.id === source), b = d.nodes.find(n => n.id === target);
            assert(a && b, 'NODE', 'Узел не найден');
            const out = definition(a.kind)?.output;
            assert(out && out === definition(b.kind)?.input, 'TYPE', 'Типы портов несовместимы');
            assert(!d.edges.some(e => e.source === source && e.target === target), 'DUPLICATE', 'Связь уже существует');
            const edge: Edge = { id: id('edge'), source, target, sourcePort: 'out', targetPort: 'in' };
            d.edges.push(edge);
            assert(!compile(d).diagnostics.some(e => e.code === 'CYCLE'), 'CYCLE', 'Связь создаёт цикл');
        });
    }
    remove(nodeId: string): void { this.commit(d => { d.nodes = d.nodes.filter(n => n.id !== nodeId); d.edges = d.edges.filter(e => e.source !== nodeId && e.target !== nodeId); for (const w of d.workspaces)
        for (const s of w.sheets)
            s.views = s.views.filter(v => v.nodeId !== nodeId); }); }
    reference(nodeId: string, workspaceId: string, sheetId: string): void {
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
export function validateDocument(input: unknown): asserts input is Document {
    assert(input && typeof input === 'object', 'SCHEMA', 'Нужен объект документа');
    const d = input as Document;
    assert(d.schema === 1 && typeof d.id === 'string' && typeof d.projectId === 'string' && typeof d.title === 'string', 'SCHEMA', 'Неподдержанная схема');
    assert(Number.isSafeInteger(d.revision) && d.revision >= 1, 'SCHEMA', 'Некорректная редакция');
    assert(Array.isArray(d.nodes) && d.nodes.length <= LIMITS.nodes && Array.isArray(d.edges) && d.edges.length <= LIMITS.edges, 'SCHEMA', 'Некорректный граф');
    assert(d.goal && typeof d.goal.original === 'string' && bytes(d.goal.original) <= 65536 && Number.isSafeInteger(d.goal.revision) && d.goal.revision >= 1 && Array.isArray(d.goal.obligations) && d.goal.obligations.length <= 64, 'SCHEMA', 'Некорректная цель');
    const nodeIds = new Set<string>();
    for (const n of d.nodes) {
        assert(typeof n.id === 'string' && n.id.length < 128 && !nodeIds.has(n.id), 'SCHEMA', 'ID узла повторяется или недопустим');
        nodeIds.add(n.id);
        assert(CATALOG.some(c => c.kind === n.kind) && typeof n.title === 'string' && n.title.length <= 512, 'SCHEMA', 'Некорректная операция');
        assert(n.params && typeof n.params === 'object' && !Array.isArray(n.params), 'SCHEMA', 'Некорректные параметры');
        assert(Object.entries(n.params).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && ['string', 'boolean', 'number'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))), 'SCHEMA', 'Недопустимое значение параметра');
        assert(bytes(JSON.stringify(n.params)) <= LIMITS.fileBytes, 'LIMIT', 'Параметры слишком большие');
    }
    const edgeIds = new Set<string>();
    for (const e of d.edges) {
        assert(typeof e.id === 'string' && !edgeIds.has(e.id) && typeof e.source === 'string' && typeof e.target === 'string' && e.sourcePort === 'out' && e.targetPort === 'in', 'SCHEMA', 'Некорректная связь');
        edgeIds.add(e.id);
    }
    const ids = new Set<string>();
    assert(Array.isArray(d.workspaces) && d.workspaces.length > 0 && d.workspaces.length <= LIMITS.workspaces, 'SCHEMA', 'Некорректные пространства');
    for (const w of d.workspaces) {
        assert(typeof w.id === 'string' && !ids.has(w.id) && typeof w.title === 'string' && Array.isArray(w.sheets) && w.sheets.length > 0 && w.sheets.length <= LIMITS.sheets, 'SCHEMA', 'Некорректное пространство');
        ids.add(w.id);
        for (const s of w.sheets) {
            assert(typeof s.id === 'string' && !ids.has(s.id) && typeof s.title === 'string' && Array.isArray(s.views) && s.views.length <= LIMITS.nodes, 'SCHEMA', 'Некорректный лист');
            ids.add(s.id);
            assert(s.viewport && Number.isFinite(s.viewport.x) && Number.isFinite(s.viewport.y) && Number.isFinite(s.viewport.zoom) && s.viewport.zoom >= .2 && s.viewport.zoom <= 2, 'SCHEMA', 'Некорректный масштаб');
            const shown = new Set<string>();
            for (const v of s.views) {
                assert(typeof v.id === 'string' && !ids.has(v.id) && nodeIds.has(v.nodeId) && !shown.has(v.nodeId) && Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) < 100000 && Math.abs(v.y) < 100000, 'SCHEMA', 'Некорректное представление узла');
                ids.add(v.id);
                shown.add(v.nodeId);
            }
        }
    }
    const obligations = new Set<string>();
    for (const c of d.goal.obligations) {
        assert(typeof c.id === 'string' && !obligations.has(c.id) && typeof c.description === 'string' && typeof c.path === 'string' && typeof c.value === 'string' && ['file_exists', 'contains', 'not_contains', 'valid_json', 'normalized', 'nonempty'].includes(c.kind), 'SCHEMA', 'Некорректное обязательство');
        obligations.add(c.id);
        if (c.path !== '*')
            safePath(c.path);
        if (c.kind === 'contains' || c.kind === 'not_contains')
            assert(c.value.length > 0, 'SCHEMA', 'Пустая строка не является проверяемым критерием');
    }
}
export type TemplateName = 'report' | 'normalize' | 'empty' | 'agent';
export function createDocument(projectId: string, name: string, template: TemplateName = 'report'): Document {
    const w: Workspace = { id: id('space'), title: 'Основное пространство', sheets: [{ id: id('sheet'), title: 'Конструкция', views: [], viewport: { x: 60, y: 100, zoom: .85 } }] };
    const d: Document = { schema: 1, id: id('doc'), projectId, title: name, revision: 1, goal: { original: '', revision: 1, obligations: [] }, nodes: [], edges: [], workspaces: [w] };
    const add = (kind: Kind, x: number, y: number, params: Params = {}) => { const n: NodeDef = { id: id('node'), kind, title: definition(kind)!.label, params: { ...defaultParams(kind), ...params } }; d.nodes.push(n); w.sheets[0]!.views.push({ id: id('view'), nodeId: n.id, x, y }); return n; };
    const link = (a: NodeDef, b: NodeDef) => d.edges.push({ id: id('edge'), source: a.id, target: b.id, sourcePort: 'out', targetPort: 'in' });
    const check = (o: Omit<Obligation, 'id'>) => d.goal.obligations.push({ ...o, id: id('obligation') });
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
