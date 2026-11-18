/** Deterministic local reinspection. Not OS-isolated verification or semantic AI judgment. */
import { assert, canonical, clone, sha256, validateFiles, safePath } from './model.js';
import { validateArtifact, verify } from './runtime.js';
/** No timestamp, display label or self-reported finding is an authority. */
export async function resultBinding(run) {
    return sha256(canonical({
        schema: 1, runId: run.id, documentId: run.documentId,
        documentHash: run.documentHash, inputHash: run.inputHash, commandFingerprint: run.commandFingerprint ?? null,
        graphRevision: run.revision, goalRevision: run.goalRevision,
        goal: run.goal, artifactHashes: run.artifacts.map(a => a.hash)
    }));
}
export async function inspectResult(run) {
    assert(run.state === 'review', 'STATE', 'Запуск не предъявлен для оценки');
    assert(!run.cancelRequested, 'CANCELLED', 'Запрошена отмена; принятие запрещено');
    assert(run.goal && run.goal.revision === run.goalRevision && run.goal.obligations.length > 0, 'GOAL_BINDING', 'Цель или её редакция не соответствует запуску');
    const criterionIds = new Set();
    for (const check of run.goal.obligations) {
        assert(typeof check.id === 'string' && !criterionIds.has(check.id) && typeof check.value === 'string'
            && typeof check.description === 'string' && ['file_exists', 'contains', 'not_contains', 'nonempty', 'normalized', 'valid_json'].includes(check.kind), 'CRITERION', 'Повреждённый или неизвестный критерий');
        criterionIds.add(check.id);
        if (check.path !== '*')
            safePath(check.path);
        if (check.kind === 'contains' || check.kind === 'not_contains')
            assert(check.value.length > 0, 'CRITERION', 'Пустая проверочная строка');
    }
    assert(Number.isSafeInteger(run.revision) && run.revision > 0 && Number.isSafeInteger(run.goalRevision) && run.goalRevision > 0, 'REVISION', 'Повреждена редакция результата');
    assert(/^[0-9a-f]{64}$/.test(run.documentHash) && /^[0-9a-f]{64}$/.test(run.inputHash), 'HASH', 'Нет отпечатка исходных данных');
    validateFiles(run.inputs);
    // Native v0.1 used a different JSON field order. Native inputs are verified by the host against its spec.
    if (run.profile === 'browser-local')
        assert(await sha256(canonical(run.inputs)) === run.inputHash, 'INPUT_BINDING', 'Исходный снимок запуска изменён');
    const states = Object.values(run.nodes);
    assert(states.length > 0 && states.every(s => s === 'completed'), 'INCOMPLETE', 'Не все операции завершены');
    assert(run.artifacts.length > 0 && run.artifacts.length <= 500, 'EMPTY', 'Нет конечных артефактов');
    const findings = [];
    for (const a of run.artifacts) {
        assert(a.files.length > 0, 'EMPTY', 'Пустой набор файлов не является результатом');
        assert(a.goalRevision === run.goalRevision && a.graphRevision === run.revision, 'ARTIFACT_BINDING', 'Артефакт принадлежит другой редакции цели или конструкции');
        assert(await validateArtifact(a), 'ARTIFACT', 'Содержимое, манифест или ID артефакта изменены');
        const checks = verify(a.files, run.goal.obligations);
        assert(checks.length > 0 && checks.every(f => f.passed), 'VERIFICATION', checks.filter(f => !f.passed).map(f => f.description + ': ' + f.detail).join('; '));
        findings.push({ artifactHash: a.hash, checks });
    }
    return { runId: run.id, bindingHash: await resultBinding(run), artifactHashes: run.artifacts.map(a => a.hash),
        findings, inspectedAt: new Date().toISOString(), scope: 'builtin-criteria' };
}
export async function acceptResult(run, expectedBinding) {
    // Freeze before the first await: edits in the UI cannot replace inspected bytes mid-command.
    const snapshot = clone(run);
    const checked = await inspectResult(snapshot);
    assert(checked.bindingHash === expectedBinding, 'STALE_RESULT', 'Результат изменился после просмотра. Проверьте новую версию');
    if (snapshot.acceptance)
        assert(snapshot.acceptance.schema === 1 && snapshot.acceptance.actor === 'owner' && snapshot.acceptance.scope === 'builtin-criteria'
            && snapshot.acceptance.runId === snapshot.id && snapshot.acceptance.bindingHash === expectedBinding
            && canonical(snapshot.acceptance.artifactHashes) === canonical(checked.artifactHashes), 'ACCEPTANCE', 'Сохранённое решение принятия повреждено или относится к другому снимку');
    snapshot.accepted = true;
    snapshot.acceptance = snapshot.acceptance ?? { schema: 1, runId: snapshot.id,
        bindingHash: checked.bindingHash, artifactHashes: checked.artifactHashes,
        at: new Date().toISOString(), actor: 'owner', scope: 'builtin-criteria' };
    return snapshot;
}
export async function acceptedResultValid(run) {
    try {
        if (!run.accepted || !run.acceptance)
            return false;
        const receipt = run.acceptance;
        const checked = await inspectResult(run);
        return receipt.schema === 1 && receipt.actor === 'owner' && receipt.scope === 'builtin-criteria'
            && receipt.runId === run.id && receipt.bindingHash === checked.bindingHash
            && canonical(receipt.artifactHashes) === canonical(checked.artifactHashes);
    }
    catch {
        return false;
    }
}
/** Reject stale replies without mutating the newer cached projection. */
export function mergeProjection(previous, incoming) {
    if (!previous)
        return clone(incoming);
    assert(previous.id === incoming.id && previous.documentId === incoming.documentId, 'RUN_BINDING', 'Ответ относится к другому запуску');
    assert(previous.documentHash === incoming.documentHash && previous.inputHash === incoming.inputHash
        && (previous.commandFingerprint ?? null) === (incoming.commandFingerprint ?? null)
        && previous.revision === incoming.revision && previous.goalRevision === incoming.goalRevision
        && canonical(previous.goal) === canonical(incoming.goal), 'RUN_BINDING', 'Ответ изменил зафиксированную задачу');
    if (previous.state !== 'running' && incoming.state === 'running')
        return clone(previous);
    if (previous.state !== 'running') {
        assert(incoming.state === previous.state && canonical(incoming.artifacts) === canonical(previous.artifacts), 'TERMINAL_IMMUTABLE', 'Завершённый результат не может быть заменён ответом исполнителя');
        if (previous.accepted && !incoming.accepted)
            return clone(previous);
        if (previous.acceptance)
            assert(canonical(previous.acceptance) === canonical(incoming.acceptance ?? null), 'ACCEPTANCE_REWRITE', 'Сохранённое решение владельца нельзя переписать');
    }
    if (previous.cancelRequested && !incoming.cancelRequested && incoming.state === 'running')
        return clone(previous);
    const oldSeq = previous.events.at(-1)?.seq ?? 0, newSeq = incoming.events.at(-1)?.seq ?? 0;
    if (newSeq < oldSeq)
        return clone(previous);
    const overlap = new Map(previous.events.map(e => [e.seq, canonical(e)]));
    for (const event of incoming.events)
        assert(!overlap.has(event.seq) || overlap.get(event.seq) === canonical(event), 'EVENT_REWRITE', 'История событий переписана');
    return clone(incoming);
}
