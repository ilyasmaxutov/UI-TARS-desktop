/** Persisted start intent. Transport loss never means that execution did not start. */
import { assert, bytes, canonical, clone, id, sha256, validateFiles } from './model.js';
import { validateDocument } from './graph.js';
export function pendingIntent(intent) { return intent.state !== 'confirmed'; }
export async function validateIntent(intent) {
    assert(intent.schema === 1 && /^[a-zA-Z0-9_-]{1,128}$/.test(intent.id)
        && Number.isSafeInteger(intent.revision) && intent.revision >= 0
        && Number.isSafeInteger(intent.attempts) && intent.attempts >= 0 && intent.attempts <= 100, 'INTENT', 'Повреждена запись команды');
    assert(['prepared', 'sending', 'unknown', 'confirmed'].includes(intent.state), 'INTENT', 'Неизвестное состояние команды');
    validateDocument(intent.document);
    validateFiles(intent.files);
    assert(intent.projectId === intent.document.projectId, 'INTENT', 'Команда другого проекта');
    assert(bytes(canonical({ document: intent.document, files: intent.files })) <= 24 * 1024 * 1024, 'INTENT_LIMIT', 'Команда превышает 24 МиБ');
    assert(intent.fingerprint === await sha256(canonical({ document: intent.document, files: intent.files })), 'INTENT_CHANGED', 'Зафиксированное поручение изменено');
    assert(intent.state !== 'confirmed' || !!intent.runId, 'INTENT', 'Нет ID подтверждённого запуска');
}
export class StartOutbox {
    repository;
    transport;
    inflight = new Map();
    constructor(repository, transport) {
        this.repository = repository;
        this.transport = transport;
    }
    async prepare(document, files) {
        const snapshot = clone({ document, files });
        const intent = { schema: 1, id: id('command'), revision: 0, projectId: document.projectId,
            createdAt: new Date().toISOString(), state: 'prepared', ...snapshot,
            fingerprint: await sha256(canonical(snapshot)), attempts: 0, runId: null, lastError: null };
        await validateIntent(intent);
        await this.repository.insert(intent); // No transport call is possible before durable insertion.
        return clone(intent);
    }
    single(id, work) {
        const old = this.inflight.get(id);
        if (old)
            return old;
        const promise = Promise.resolve().then(work).finally(() => this.inflight.delete(id));
        this.inflight.set(id, promise);
        return promise;
    }
    async read(id) {
        const intent = await this.repository.get(id);
        assert(intent, 'INTENT', 'Команда не найдена');
        await validateIntent(intent);
        return intent;
    }
    async set(intent, patch) {
        const next = { ...intent, ...patch, revision: intent.revision + 1 };
        await this.repository.replace(next, intent.revision);
        return next;
    }
    async receipt(intent, run) {
        assert(run.profile === 'native-builtins' && run.documentId === intent.document.id
            && run.revision === intent.document.revision && run.goalRevision === intent.document.goal.revision
            && canonical(run.goal) === canonical(intent.document.goal)
            && canonical(run.inputs) === canonical(intent.files), 'RECEIPT_BINDING', 'Хост подтвердил другую задачу');
        assert(run.commandFingerprint === intent.fingerprint, 'RECEIPT_BINDING', 'Отпечаток принятой команды не совпадает');
        if (intent.runId)
            assert(intent.runId === run.id, 'RECEIPT_BINDING', 'Один ID команды дал два запуска');
        if (intent.state !== 'confirmed')
            await this.set(intent, { state: 'confirmed', runId: run.id, lastError: null });
        return clone(run);
    }
    async reconcile(id) {
        return this.single(id, async () => {
            const intent = await this.read(id);
            const run = await this.transport.lookup(id); // A read, never an automatic dispatch.
            if (run)
                return this.receipt(intent, run);
            if (intent.state === 'confirmed')
                throw new Error('Подтверждённая команда отсутствует у хоста. Проверьте профиль/базу; повтор запрещён');
            if (intent.state !== 'prepared')
                await this.set(intent, { state: 'unknown', lastError: 'Хост пока не подтвердил запись. Безопасен только повтор с тем же ID в профиле durableCommands.' });
            return null;
        });
    }
    async send(id) {
        return this.single(id, async () => {
            let intent = await this.read(id);
            const capability = await this.transport.capabilities();
            assert(capability.protocol === 2 && capability.durableCommands === true, 'PROTOCOL', 'Хост не поддерживает устойчивые команды протокола 2. Исполнение не начато');
            // A confirmed command cannot be recreated in a different/empty host store.
            const existing = await this.transport.lookup(id);
            if (existing)
                return this.receipt(intent, existing);
            assert(intent.state !== 'confirmed', 'HOST_HISTORY_LOST', 'Хост утратил подтверждённую команду. Новый запуск запрещён');
            assert(intent.attempts < 100, 'ATTEMPTS', 'Лимит отправок этой команды исчерпан');
            intent = await this.set(intent, { state: 'sending', attempts: intent.attempts + 1, lastError: null });
            try {
                return await this.receipt(intent, await this.transport.start(id, clone(intent.document), clone(intent.files)));
            }
            catch (error) {
                // Even a lost client commit may follow a successful host commit. Never generate another ID here.
                try {
                    await this.set(intent, { state: 'unknown', lastError: String(error).slice(0, 1000) });
                }
                catch { /* Keep the durable 'sending' intent for recovery; do not hide the original error. */ }
                throw error;
            }
        });
    }
}
