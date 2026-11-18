import type { AcceptanceReceipt } from './review.js';
import { assert, bytes, canonical, clone, Document, DomainError, FileData, Goal, id, LIMITS, NodeDef, normalizeText, Obligation, safePath, sha256, validateFiles } from './model.js';
import { compile, validateDocument } from './graph.js';
export type Value = {
    type: 'text';
    text: string;
} | {
    type: 'files';
    files: FileData[];
};
export interface Finding {
    obligationId: string;
    description: string;
    passed: boolean;
    detail: string;
}
export interface ManifestEntry {
    path: string;
    hash: string;
    bytes: number;
}
export interface Artifact {
    id: string;
    files: FileData[];
    manifest: ManifestEntry[];
    hash: string;
    goalRevision: number;
    graphRevision: number;
    findings: Finding[];
}
export interface RunEvent {
    seq: number;
    runId: string;
    at: string;
    kind: string;
    nodeId: string | null;
    message: string;
}
export type NodeState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Run {
    id: string;
    documentId: string;
    revision: number;
    goalRevision: number;
    state: 'running' | 'review' | 'failed' | 'cancelled' | 'interrupted';
    startedAt: string;
    finishedAt: string | null;
    nodes: Record<string, NodeState>;
    previews: Record<string, string>;
    events: RunEvent[];
    artifacts: Artifact[];
    error: string | null;
    profile: 'browser-local' | 'native-builtins';
    inputHash: string;
    documentHash: string;
    inputs: FileData[];
    goal: Goal;
    accepted: boolean;
    cancelRequested?: boolean;
    commandFingerprint?: string | null;
    acceptance?: AcceptanceReceipt | null;
}
export interface Change {
    path: string;
    status: 'added' | 'modified' | 'unchanged' | 'removed';
    before: string | null;
    after: string | null;
}
export interface RunHooks {
    signal?: AbortSignal;
    onUpdate?: (run: Run) => void;
    checkpoint?: () => Promise<void>;
    concurrency?: number;
    profile?: Run['profile'];
}
export function verify(files: readonly FileData[], checks: readonly Obligation[]): Finding[] {
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
export async function seal(files: readonly FileData[], doc: Document, findings: Finding[]): Promise<Artifact> {
    validateFiles(files);
    const manifest: ManifestEntry[] = [];
    for (const f of [...files].sort((a, b) => a.path < b.path ? -1 : 1))
        manifest.push({ path: f.path, hash: await sha256(f.content), bytes: bytes(f.content) });
    const hash = await sha256(canonical({ manifest, goalRevision: doc.goal.revision, graphRevision: doc.revision }));
    return { id: `sha256:${hash}`, files: clone([...files]), manifest, hash, goalRevision: doc.goal.revision, graphRevision: doc.revision, findings: clone(findings) };
}
export async function validateArtifact(artifact: Artifact): Promise<boolean> {
    try {
        validateFiles(artifact.files);
        const entries: ManifestEntry[] = [];
        for (const f of [...artifact.files].sort((a, b) => a.path < b.path ? -1 : 1))
            entries.push({ path: f.path, hash: await sha256(f.content), bytes: bytes(f.content) });
        return artifact.id === `sha256:${artifact.hash}` && canonical(entries) === canonical(artifact.manifest) && artifact.hash === await sha256(canonical({ manifest: entries, goalRevision: artifact.goalRevision, graphRevision: artifact.graphRevision }));
    }
    catch {
        return false;
    }
}
export function diff(base: readonly FileData[], next: readonly FileData[]): Change[] {
    const a = new Map(base.map(f => [f.path, f.content])), b = new Map(next.map(f => [f.path, f.content]));
    return [...new Set([...a.keys(), ...b.keys()])].sort().map(path => ({ path, status: !a.has(path) ? 'added' : !b.has(path) ? 'removed' : a.get(path) === b.get(path) ? 'unchanged' : 'modified', before: a.get(path) ?? null, after: b.get(path) ?? null }));
}
export function publicationConflicts(base: readonly FileData[], current: readonly FileData[], next: readonly FileData[]): string[] {
    const original = new Map(base.map(f => [f.path, f.content]));
    const actual = new Map(current.map(f => [f.path, f.content]));
    return diff(base, next).filter(c => c.status !== 'unchanged' && actual.get(c.path) !== original.get(c.path) && (actual.get(c.path) ?? null) !== c.after).map(c => c.path);
}
async function operate(node: NodeDef, inputs: Value[], files: FileData[], doc: Document): Promise<{
    value: Value;
    findings: Finding[];
}> {
    const first = inputs[0];
    let value: Value;
    let findings: Finding[] = [];
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
            const map = new Map<string, FileData>();
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
function replaceBounded(text: string, find: string, replacement: string): string {
    const count = text.split(find).length - 1;
    // Bound before allocation; UTF-8 check follows after replacement.
    assert(text.length + count * (replacement.length - find.length) <= LIMITS.fileBytes, 'LIMIT', 'Замена превысит допустимый размер');
    return text.replaceAll(find, replacement);
}
/** Executes only compiled, built-in pure operations; never evals code or starts a process. */
export async function execute(document: Document, sourceFiles: FileData[], hooks: RunHooks = {}): Promise<Run> {
    validateDocument(document);
    validateFiles(sourceFiles);
    const doc = clone(document), files = clone(sourceFiles), plan = compile(doc);
    assert(!plan.diagnostics.length, 'PREFLIGHT', plan.diagnostics.map(d => d.message).join('\n'));
    const run: Run = { id: id('run'), documentId: doc.id, revision: doc.revision, goalRevision: doc.goal.revision, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, nodes: {}, previews: {}, events: [], artifacts: [], error: null, profile: hooks.profile ?? 'browser-local', inputHash: await sha256(canonical(files)), documentHash: await sha256(canonical(doc)), inputs: clone(files), goal: clone(doc.goal), accepted: false };
    for (const n of plan.order)
        run.nodes[n] = 'queued';
    let eventSeq = 0;
    const emit = (kind: string, message: string, nodeId: string | null = null) => { run.events.push({ seq: ++eventSeq, runId: run.id, at: new Date().toISOString(), kind, nodeId, message }); if (run.events.length > LIMITS.events)
        run.events.shift(); hooks.onUpdate?.(clone(run)); };
    const outputs = new Map<string, Value>();
    const findingsByNode = new Map<string, Finding[]>();
    let failure: Error | null = null;
    let retainedOutputBytes = 0;
    const cancelled = () => { if (hooks.signal?.aborted)
        throw new DomainError('CANCELLED', 'Отменено владельцем'); };
    const checkpoint = hooks.checkpoint ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
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
                    const node = doc.nodes.find(n => n.id === nodeId)!;
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
