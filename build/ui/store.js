import { assert, clone, LIMITS, validateFiles } from '../core/model.js';
import { validateDocument } from '../core/graph.js';
export function validateState(v) {
    assert(v && typeof v === 'object', 'STATE', 'Некорректный архив');
    const s = v;
    assert(Number.isSafeInteger(s.revision) && s.revision >= 0 && (s.theme === 'dark' || s.theme === 'light'), 'STATE', 'Некорректная редакция или тема');
    assert(s.schema === 1 && Array.isArray(s.projects) && s.projects.length > 0 && s.projects.length <= 32 && typeof s.activeProject === 'string' && Array.isArray(s.runs) && s.runs.length <= LIMITS.runs, 'STATE', 'Некорректная структура');
    for (const p of s.projects) {
        assert(typeof p.id === 'string' && typeof p.title === 'string' && Array.isArray(p.files), 'STATE', 'Некорректный проект');
        validateDocument(p.document);
        assert(p.document.projectId === p.id, 'STATE', 'Документ другого проекта');
        validateFiles(p.files);
    }
    assert(new Set(s.projects.map(p => p.id)).size === s.projects.length && s.projects.some(p => p.id === s.activeProject), 'STATE', 'Неизвестный или повторный ID проекта');
}
export const native = window.__TAURI__?.core ?? null;
export class Store {
    db = null;
    memory = null;
    async open() {
        if (native)
            return;
        this.db = await new Promise((resolve, reject) => { const r = indexedDB.open('platform-studio-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    }
    async read() {
        if (native)
            return native.invoke('load_state');
        if (!this.db)
            return this.memory;
        return new Promise((resolve, reject) => { const tx = this.db.transaction('state', 'readonly'); const q = tx.objectStore('state').get('current'); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => reject(q.error); });
    }
    async save(state, expected) {
        validateState(state);
        assert(new TextEncoder().encode(JSON.stringify(state)).byteLength <= 32 * 1024 * 1024, 'STORE_LIMIT', 'Состояние превысило 32 МиБ. Экспортируйте проект.');
        if (native) {
            await native.invoke('save_state', { state, expected });
            return;
        }
        if (!this.db) {
            if (this.memory)
                assert(this.memory.revision === expected, 'CONFLICT', 'Состояние изменено в другом окне');
            this.memory = clone(state);
            return;
        }
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction('state', 'readwrite');
            const store = tx.objectStore('state');
            const q = store.get('current');
            let conflict = false;
            q.onsuccess = () => {
                const old = q.result;
                if (old && old.revision !== expected) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                store.put(clone(state), 'current');
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(new Error(conflict ? 'CONFLICT: состояние изменено в другом окне. Экспортируйте текущую работу и перезагрузите документ.' : 'Не удалось сохранить данные'));
        });
    }
}
