import { assert, bytes, clone } from '../core/model.js';
/** Local durable outbox separate from editable UI state; no in-memory fallback. */
export class IndexedIntentRepository {
    db = null;
    async open() {
        if (this.db)
            return;
        this.db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('platform-studio-commands-v1', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('intents', { keyPath: 'id' });
            request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.db = null; }; resolve(request.result); };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Хранилище команд занято другой версией приложения'));
        });
    }
    transaction(mode) {
        assert(this.db, 'OUTBOX_UNAVAILABLE', 'Нет устойчивого хранилища команд; новый запуск запрещён');
        return this.db.transaction('intents', mode, { durability: 'strict' });
    }
    async get(id) {
        return new Promise((resolve, reject) => {
            const tx = this.transaction('readonly');
            let value = null;
            const req = tx.objectStore('intents').get(id);
            req.onsuccess = () => { value = req.result ?? null; };
            tx.oncomplete = () => resolve(value);
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Не удалось прочитать команду'));
        });
    }
    async list() {
        return new Promise((resolve, reject) => {
            const tx = this.transaction('readonly');
            let value = [];
            const req = tx.objectStore('intents').getAll();
            req.onsuccess = () => { value = req.result; };
            tx.oncomplete = () => resolve(value);
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Не удалось прочитать команды'));
        });
    }
    async insert(intent) {
        return new Promise((resolve, reject) => {
            const tx = this.transaction('readwrite'), store = tx.objectStore('intents');
            let message = '';
            const req = store.getAll();
            req.onsuccess = () => {
                const all = req.result;
                // Never discard pending commands. Confirmed records remain in host commands for deduplication.
                const keep = all.filter(x => x.state !== 'confirmed');
                const confirmed = all.filter(x => x.state === 'confirmed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                keep.push(...confirmed.slice(0, 31));
                if (keep.length >= 64 || bytes(JSON.stringify([...keep, intent])) > 64 * 1024 * 1024) {
                    message = 'Лимит очереди команд: сначала сверьте ожидающие результаты';
                    tx.abort();
                    return;
                }
                const kept = new Set(keep.map(x => x.id));
                for (const old of all)
                    if (!kept.has(old.id))
                        store.delete(old.id);
                store.add(clone(intent));
            };
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(new Error(message || tx.error?.message || 'Команда не сохранена; отправки не было'));
        });
    }
    async replace(intent, expectedRevision) {
        return new Promise((resolve, reject) => {
            const tx = this.transaction('readwrite'), store = tx.objectStore('intents');
            let conflict = false;
            const req = store.get(intent.id);
            req.onsuccess = () => {
                const old = req.result;
                if (!old || old.revision !== expectedRevision || intent.revision !== expectedRevision + 1
                    || old.fingerprint !== intent.fingerprint) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                store.put(clone(intent));
            };
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(new Error(conflict ? 'OUTBOX_CONFLICT: команда изменена другим окном; нужна сверка' : tx.error?.message || 'Не удалось записать состояние команды'));
        });
    }
}
