import { assert, canonical, clone } from './model.js';
export class Budget {
    limit;
    reservations = new Map();
    constructor(limit, initial = []) {
        this.limit = limit;
        assert(Number.isSafeInteger(limit) && limit >= 0, 'BUDGET', 'Неверный лимит');
        assert(initial.length <= 10000, 'BUDGET', 'Слишком много резервов');
        for (const r of initial) {
            assert(typeof r.id === 'string' && !this.reservations.has(r.id) && Number.isSafeInteger(r.upper) && r.upper >= 0 && (r.confirmed === null || Number.isSafeInteger(r.confirmed) && r.confirmed >= 0 && r.confirmed <= r.upper), 'BUDGET', 'Повреждён резерв');
            this.reservations.set(r.id, clone(r));
        }
        assert(this.available >= 0, 'BUDGET', 'Резервы превышают бюджет');
    }
    get available() { return this.limit - [...this.reservations.values()].reduce((sum, r) => sum + (r.confirmed ?? r.upper), 0); }
    reserve(id, upper) {
        const old = this.reservations.get(id);
        if (old) {
            assert(old.upper === upper, 'ID_CONFLICT', 'Повторный ID изменил условия');
            return clone(old);
        }
        assert(this.reservations.size < 10000, 'BUDGET', 'Нужен архив резервов');
        assert(upper !== null && Number.isSafeInteger(upper) && upper >= 0, 'UNKNOWN_PRICE', 'Нет доказанной верхней цены');
        assert(upper <= this.available, 'BUDGET', 'Недостаточно бюджета');
        const r = { id, upper, estimate: null, confirmed: null };
        this.reservations.set(id, r);
        return clone(r);
    }
    estimate(id, value) { const r = this.reservations.get(id); assert(r, 'RESERVATION', 'Резерв не найден'); assert(Number.isSafeInteger(value) && value >= 0, 'BUDGET', 'Некорректная оценка'); r.estimate = value; }
    settle(id, confirmed) {
        const r = this.reservations.get(id);
        assert(r, 'RESERVATION', 'Резерв не найден');
        assert(Number.isSafeInteger(confirmed) && confirmed >= 0 && confirmed <= r.upper, 'PRICE_BREACH', 'Подтверждение вышло за верхнюю цену');
        if (r.confirmed !== null)
            assert(r.confirmed === confirmed, 'SETTLEMENT', 'Повторная сверка отличается');
        r.confirmed = confirmed;
    }
    snapshot() { return clone([...this.reservations.values()]); }
}
export function mayRetry(effect, currentGeneration, receiverGuaranteesKey) {
    if (effect.generation !== currentGeneration)
        return false;
    return effect.state === 'prepared' || effect.state === 'absent' || ((effect.state === 'unknown' || effect.state === 'dispatched') && effect.idempotencyKey !== null && receiverGuaranteesKey);
}
export function recordCycle(state, evidence, closed) {
    assert(state.noProgress < state.maxNoProgress, 'NO_PROGRESS', 'Исчерпан предел циклов без новых свидетельств');
    const fresh = evidence.some(e => !state.evidence.includes(e)) || closed.some(c => !state.closed.includes(c));
    return { maxNoProgress: state.maxNoProgress, noProgress: fresh ? 0 : state.noProgress + 1, evidence: [...new Set([...state.evidence, ...evidence])], closed: [...new Set([...state.closed, ...closed])] };
}
export function revoke(lease) { return { ...lease, state: lease.state === 'released' ? 'released' : 'revoked' }; }
export function release(lease, observedOwnerGeneration, observedReleased) {
    if (lease.state === 'released')
        return lease;
    return { ...lease, state: observedOwnerGeneration === lease.generation && observedReleased ? 'released' : 'quarantine' };
}
export class CommandLedger {
    records;
    pending = new Map();
    constructor(records = {}) { this.records = new Map(Object.entries(records)); }
    async apply(commandId, payload, fn) {
        const fingerprint = canonical(payload), existing = this.records.get(commandId), running = this.pending.get(commandId);
        if (existing) {
            assert(existing.fingerprint === fingerprint, 'ID_CONFLICT', 'Один ID использован для разных команд');
            return clone(existing.result);
        }
        if (running) {
            assert(running.fingerprint === fingerprint, 'ID_CONFLICT', 'Один ID использован для разных команд');
            return clone(await running.promise);
        }
        const promise = Promise.resolve().then(fn);
        this.pending.set(commandId, { fingerprint, promise });
        try {
            const result = await promise;
            this.records.set(commandId, { fingerprint, result: clone(result) });
            return result;
        }
        finally {
            this.pending.delete(commandId);
        }
    }
    snapshot() { return Object.fromEntries(this.records); }
}
export class BoundedQueue {
    maxItems;
    maxBytes;
    policy;
    items = [];
    used = 0;
    next = 1;
    dropped = [];
    droppedOmitted = 0;
    constructor(maxItems, maxBytes, policy) {
        this.maxItems = maxItems;
        this.maxBytes = maxBytes;
        this.policy = policy;
        assert(Number.isSafeInteger(maxItems) && maxItems > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'QUEUE_LIMIT', 'Неверный предел очереди');
    }
    push(value, size) {
        assert(size >= 0 && Number.isSafeInteger(size) && size <= this.maxBytes, 'FRAME_LIMIT', 'Кадр не помещается');
        const seq = this.next++;
        if (this.policy === 'latest')
            while (this.items.length && (this.items.length >= this.maxItems || this.used + size > this.maxBytes)) {
                const old = this.items.shift();
                this.used -= old.bytes;
                this.dropped.push(old.sequence);
                if (this.dropped.length > 1024) {
                    this.dropped.shift();
                    this.droppedOmitted++;
                }
            }
        assert(this.items.length < this.maxItems && this.used + size <= this.maxBytes, 'BACKPRESSURE', 'Очередь заполнена');
        this.items.push({ value, bytes: size, sequence: seq });
        this.used += size;
        return seq;
    }
    pop() {
        const item = this.items.shift();
        if (!item)
            return null;
        this.used -= item.bytes;
        return { value: item.value, sequence: item.sequence };
    }
    get byteLength() { return this.used; }
    get length() { return this.items.length; }
}
export function arrivalSample(events) {
    let latest;
    const out = [];
    for (const e of events) {
        if (e.type === 'value')
            latest = e.sample.value;
        else if (latest !== undefined)
            out.push([e.sample.value, latest]);
    }
    return out;
}
/** Finite event-time batch with explicit watermarks, not a claimed live audio engine. */
export function eventTimeSample(triggers, values, watermarks) {
    const bound = Math.min(...watermarks);
    const sorted = [...values].sort((a, b) => a.at - b.at || a.sequence - b.sequence);
    const out = [];
    for (const a of [...triggers].sort((a, b) => a.at - b.at || a.sequence - b.sequence)) {
        if (a.at >= bound)
            continue;
        const b = sorted.filter(v => v.at <= a.at).at(-1);
        if (b)
            out.push([a.value, b.value]);
    }
    return out;
}
