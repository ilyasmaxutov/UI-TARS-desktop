/** Non-idempotent external effects. Deliberately not a weakening of built-in StartOutbox. */
import { assert, canonical, clone, sha256 } from '../core/model.js';
const IMMUTABLE = (x) => ({ id: x.id, taskId: x.taskId, sessionId: x.sessionId,
    goalRevision: x.goalRevision, generation: x.generation, method: x.method, params: x.params,
    expectedThreadId: x.expectedThreadId, expectedTurnId: x.expectedTurnId, marker: x.marker, exactInput: x.exactInput });
export async function intentFingerprint(x) { return sha256(canonical(IMMUTABLE(x))); }
export function markedInput(commandId, text) {
    assert(/^[A-Za-z0-9_-]{1,128}$/.test(commandId) && text.trim().length > 0 && text.length <= 65536, 'INPUT', 'Неверное поручение');
    const marker = `[PlatformStudio command ${commandId}]`;
    return { marker, exactInput: `${text}\n\n${marker}` };
}
export function matchReadback(intent, readback) {
    if (!intent.expectedThreadId || intent.expectedThreadId !== readback.threadId)
        return null;
    if (intent.method === 'turn/interrupt') {
        const t = readback.turns.find(t => t.id === intent.expectedTurnId);
        return t?.status === 'interrupted' ? t.id : null;
    }
    if (!['turn/start', 'turn/steer'].includes(intent.method) || !intent.exactInput || !intent.marker)
        return null;
    const candidates = readback.turns.filter(turn => (intent.method !== 'turn/steer' || turn.id === intent.expectedTurnId)
        && turn.items.some(item => item.type === 'userMessage'
            && item.content?.some(c => c.type === 'text' && c.text === intent.exactInput)));
    // An assistant echo, approximate text, timestamps, empty page and multiple matches prove nothing.
    return candidates.length === 1 ? candidates[0].id : null;
}
export function confirmedRemoteId(intent, response) {
    if (intent.method === 'thread/start' || intent.method === 'thread/resume') {
        const t = response.thread;
        assert(typeof t?.id === 'string' && !!t.id, 'RECEIPT', 'Нет ID треда');
        assert(!intent.expectedThreadId || t.id === intent.expectedThreadId, 'RECEIPT', 'Ответ другого треда');
        return t.id;
    }
    if (intent.method === 'turn/interrupt')
        return intent.expectedTurnId; // Receipt only, not proof of termination.
    const id = intent.method === 'turn/start' ? response.turn?.id : response.turnId;
    assert(typeof id === 'string' && !!id, 'RECEIPT', 'Нет ID хода');
    assert(intent.method !== 'turn/steer' || id === intent.expectedTurnId, 'RECEIPT', 'Уточнение подтвердил другой ход');
    return id;
}
export class ExternalOutbox {
    repository;
    transport;
    constructor(repository, transport) {
        this.repository = repository;
        this.transport = transport;
    }
    async prepare(input) {
        const intent = { ...clone(input), fingerprint: '', state: 'prepared', revision: 0, attempts: 0, remoteId: null, reason: null };
        intent.fingerprint = await intentFingerprint(intent);
        const existing = await this.repository.get(intent.id);
        if (existing) {
            assert(existing.fingerprint === intent.fingerprint, 'ID_CONFLICT', 'Повторный ID изменил поручение');
            return existing;
        }
        await this.repository.insert(intent);
        return clone(intent);
    }
    async read(id) {
        const intent = await this.repository.get(id);
        assert(intent, 'COMMAND', 'Нет команды');
        assert(intent.fingerprint === await intentFingerprint(intent), 'COMMAND_CHANGED', 'Команда изменена');
        return intent;
    }
    async update(old, patch) {
        const next = { ...old, ...patch, revision: old.revision + 1 };
        await this.repository.replace(next, old.revision);
        return next;
    }
    async send(id) {
        let intent = await this.read(id);
        if (intent.state === 'confirmed')
            return intent;
        assert(intent.state === 'prepared' && intent.attempts === 0, 'RECONCILE_REQUIRED', 'Отправка могла состояться; повтор запрещён');
        // CAS COMMIT precedes any transport write, including its first byte.
        intent = await this.update(intent, { state: 'in_flight', attempts: 1, reason: null });
        try {
            const response = await this.transport.dispatch(clone(intent));
            return await this.update(intent, { state: 'confirmed', remoteId: confirmedRemoteId(intent, response) });
        }
        catch (e) {
            try {
                await this.update(intent, { state: 'unverified_outcome', reason: String(e).slice(0, 1000) });
            }
            catch { /* durable in_flight is sufficient for recovery */ }
            throw e;
        }
    }
    async reconcile(id) {
        const intent = await this.read(id);
        if (intent.state === 'confirmed' || intent.state === 'prepared' || intent.state === 'rejected')
            return intent;
        const proof = await this.transport.read(clone(intent)); // Read only: never dispatch or resume a model turn.
        const match = matchReadback(intent, proof);
        return this.update(intent, match ? { state: 'confirmed', remoteId: match, reason: 'observed_in_thread' }
            : { state: 'unknown_needs_user_decision', reason: 'Однозначное подтверждение отсутствует. Пустая выборка не доказывает отсутствие эффекта.' });
    }
}
