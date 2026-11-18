export const CATALOG = [
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
export function id(prefix = 'id') { return `${prefix}_${crypto.randomUUID()}`; }
export function clone(value) { return structuredClone(value); }
export function bytes(text) { return new TextEncoder().encode(text).length; }
export function definition(kind) { return CATALOG.find(c => c.kind === kind); }
export function normalizeText(text) { return text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\t ]+$/g, '')).join('\n').replace(/\n*$/, '\n'); }
export class DomainError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DomainError';
    }
}
export function assert(condition, code, message) {
    if (!condition)
        throw new DomainError(code, message);
}
export function safePath(path) {
    assert(typeof path === 'string' && path.length > 0 && path.length <= 240, 'PATH', 'Путь должен содержать от 1 до 240 символов');
    assert(!/[\\:\u0000-\u001f]/u.test(path) && !path.startsWith('/'), 'PATH', 'Абсолютный, служебный или Windows-путь недопустим');
    for (const part of path.split('/')) {
        assert(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'PATH', 'Недопустимый сегмент пути');
        assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/[<>"|?*]/.test(part), 'PATH', 'Зарезервированное имя Windows');
    }
    return path;
}
export function validateFiles(files) {
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
export async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
