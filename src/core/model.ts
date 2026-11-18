/** Shared, JSON-only contracts. Views do not own execution; a run freezes a revision. */
export type PortType = 'text' | 'files';
export type Kind = 'source.text' | 'source.files' | 'text.replace' | 'text.stats' | 'files.filter' | 'files.replace' | 'files.normalize' | 'files.report' | 'text.to_file' | 'files.merge' | 'verify.files' | 'result.files' | 'agent.codex' | 'note';
export type Params = Record<string, string | number | boolean>;
export interface NodeDef {
    id: string;
    kind: Kind;
    title: string;
    params: Params;
}
export interface Edge {
    id: string;
    source: string;
    target: string;
    sourcePort: 'out';
    targetPort: 'in';
}
export interface NodeView {
    id: string;
    nodeId: string;
    x: number;
    y: number;
}
export interface Sheet {
    id: string;
    title: string;
    views: NodeView[];
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}
export type CheckKind = 'file_exists' | 'contains' | 'not_contains' | 'valid_json' | 'normalized' | 'nonempty';
export interface Obligation {
    id: string;
    description: string;
    kind: CheckKind;
    path: string;
    value: string;
}
export interface Goal {
    original: string;
    revision: number;
    obligations: Obligation[];
}
export interface Workspace {
    id: string;
    title: string;
    sheets: Sheet[];
}
export interface Document {
    schema: 1;
    id: string;
    projectId: string;
    title: string;
    revision: number;
    goal: Goal;
    nodes: NodeDef[];
    edges: Edge[];
    workspaces: Workspace[];
}
export interface FileData {
    path: string;
    content: string;
}
export interface Project {
    id: string;
    title: string;
    document: Document;
    files: FileData[];
    selectedWorkspace: string;
    selectedSheet: string;
    selectedRun: string | null;
}
export interface CatalogItem {
    kind: Kind;
    label: string;
    description: string;
    input: PortType | null;
    output: PortType | null;
    available: boolean;
    category: string;
}
export const CATALOG: readonly CatalogItem[] = [
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
export const LIMITS = Object.freeze({ nodes: 500, edges: 1000, files: 256, fileBytes: 1048576, totalBytes: 8388608, runs: 30, events: 4096, workspaces: 32, sheets: 64 });
export function id(prefix = 'id'): string { return `${prefix}_${crypto.randomUUID()}`; }
export function clone<T>(value: T): T { return structuredClone(value); }
export function bytes(text: string): number { return new TextEncoder().encode(text).length; }
export function definition(kind: string): CatalogItem | undefined { return CATALOG.find(c => c.kind === kind); }
export function normalizeText(text: string): string { return text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\t ]+$/g, '')).join('\n').replace(/\n*$/, '\n'); }
export class DomainError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
export function assert(condition: unknown, code: string, message: string): asserts condition { if (!condition)
    throw new DomainError(code, message); }
export function safePath(path: string): string {
    assert(typeof path === 'string' && path.length > 0 && path.length <= 240, 'PATH', 'Путь должен содержать от 1 до 240 символов');
    assert(!/[\\:\u0000-\u001f]/u.test(path) && !path.startsWith('/'), 'PATH', 'Абсолютный, служебный или Windows-путь недопустим');
    for (const part of path.split('/')) {
        assert(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'PATH', 'Недопустимый сегмент пути');
        assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/[<>"|?*]/.test(part), 'PATH', 'Зарезервированное имя Windows');
    }
    return path;
}
export function validateFiles(files: readonly FileData[]): void {
    assert(files.length <= LIMITS.files, 'LIMIT', 'Слишком много файлов');
    const names = new Set<string>();
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
export async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Independent source binding used by task sessions; built-in FileData limits remain unchanged. */
export type WorkspaceBinding =
    | { kind: 'inline'; files: FileData[] }
    | { kind: 'mounted'; id: string; rootPath: string; access: 'read-only' | 'workspace-write'; gitHead?: string };
